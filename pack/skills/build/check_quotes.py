#!/usr/bin/env python3
"""Check that every quoted source passage really appears on the page it cites.

    python .opencode/skills/build/check_quotes.py program.json [--json report.json]

For each evidence item with a quote and a page in a PDF, the page's text layer is compared with the
quote after normalising case, punctuation, line-break hyphens and spacing:

  found        the quote is on the cited page
  close        nearly verbatim on the cited page (OCR noise or a small transcription slip): reread it
  other_page   not on the cited page but on a nearby one: fix the page number
  not_found    not on the cited page or its neighbours: the quote or its page is wrong
  found_ocr    scanned page: the quote matches its OCR text (scan_pages.py) and every number in it does
  check_ocr    scanned page: the OCR text differs from the quote; open the page image and confirm it
  unchecked    a scanned page not yet OCRed, not a PDF, or no PDF reader

It also lists pages that report statistics (tables, test results) but that no evidence cites: an
experiment or table may have been missed there.

A model's own "verified" mark is not evidence; this check is mechanical and independent of it.
Exit code 1 when any quote is not_found or other_page. Standard library plus pypdf or pdfplumber
(both in the HumanStudy runtime) or the pdftotext command.
"""
import argparse
import difflib
import json
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

NEARBY = 2          # pages either side searched when the cited page does not hold the quote
CLOSE = 0.88        # share of the quote that must match in one stretch to count as close
SUBS = {"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
        "ﬁ": "fi", "ﬂ": "fl", "­": ""}


def normalise(text):
    text = unicodedata.normalize("NFKC", text or "")
    for a, b in SUBS.items():
        text = text.replace(a, b)
    text = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", text)  # hyphenated line breaks
    text = re.sub(r"[^\w%]+", " ", text.lower())
    return re.sub(r"\s+", " ", text).strip()


class Pdf:
    """Page texts of one PDF, loaded lazily with whatever reader is available."""

    def __init__(self, path):
        self.path, self.pages, self.reader = Path(path), None, None

    def load(self):
        if self.pages is not None:
            return self.pages
        self.pages = []
        try:
            import pypdf
            self.pages = [p.extract_text() or "" for p in pypdf.PdfReader(str(self.path)).pages]
            self.reader = "pypdf"
            return self.pages
        except Exception:
            pass
        try:
            import pdfplumber
            with pdfplumber.open(str(self.path)) as pdf:
                self.pages = [p.extract_text() or "" for p in pdf.pages]
            self.reader = "pdfplumber"
            return self.pages
        except Exception:
            pass
        if shutil.which("pdftotext"):
            run = subprocess.run(["pdftotext", "-layout", str(self.path), "-"], capture_output=True)
            if run.returncode == 0:
                self.pages = run.stdout.decode("utf-8", "replace").split("\f")
                self.reader = "pdftotext"
        return self.pages

    def page(self, number):
        pages = self.load()
        return normalise(pages[number - 1]) if 1 <= number <= len(pages) else ""


def match(quote, page):
    if not page:
        return 0.0
    if quote in page:
        return 1.0
    m = difflib.SequenceMatcher(None, quote, page, autojunk=False)
    # best single stretch, then extend: the share of the quote matched inside one window of the page
    best = m.find_longest_match(0, len(quote), 0, len(page))
    if best.size == 0:
        return 0.0
    start = max(0, best.b - best.a - 20)
    window = page[start:start + len(quote) + 40]
    blocks = difflib.SequenceMatcher(None, quote, window, autojunk=False).get_matching_blocks()
    return sum(b.size for b in blocks) / len(quote)  # share of the quote found, in order, in that window


NUMBER = re.compile(r"\d+(?:[.,]\d+)?")


def ocr_status(raw_quote, file, page):
    """Compare a quote on a scanned page with that page's OCR text, if scan_pages.py made one."""
    try:
        from scan_pages import ocr_text
    except ImportError:
        ocr_text = None
    text = ocr_text(file, page) if ocr_text else None
    if not text:
        return {"status": "unchecked", "reason": "scanned page: run scan_pages.py, then read its text and image"}
    quote, page_text = normalise(raw_quote), normalise(text)
    score = match(quote, page_text)
    words = quote.split()
    if score < CLOSE and len(words) >= 12:
        # OCR may interleave two columns line by line: compare word triples, in any order
        grams = lambda ws: {tuple(ws[i:i + 3]) for i in range(len(ws) - 2)}
        mine, theirs = grams(words), grams(page_text.split())
        score = max(score, len(mine & theirs) / len(mine) * CLOSE / 0.8)
    digits = re.sub(r"\s", "", text)
    wrong = [n for n in NUMBER.findall(raw_quote) if n not in digits]
    if score >= CLOSE and not wrong:
        return {"status": "found_ocr", "similarity": round(score, 3)}
    reason = "numbers not in the OCR text: " + ", ".join(wrong) if wrong else "OCR text differs"
    return {"status": "check_ocr", "similarity": round(score, 3), "reason": reason + "; confirm on the page image"}


STATS = re.compile(r"\b(?:[Ftrdzb]|chi2|χ2|χ²)\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\)\s*=|\bp\s*[<=>]\s*0?\.\d|"
                   r"\b(?:M|SD|SE)\s*=\s*-?\d|\bTable\s+\d+\b", re.I)


def uncited_pages(pdfs, cited):
    """Pages with statistics or tables that no evidence record cites."""
    out = []
    for file, pdf in pdfs.items():
        for number, text in enumerate(pdf.load() or [], 1):
            if (file, number) not in cited and len(STATS.findall(text or "")) >= 3:
                out.append({"path": file.name, "page": number, "hits": len(STATS.findall(text))})
    return out


LABELS = re.compile(r"\b(Experiment|Study|Studies|Experiments)\s+((?:[IVX]+|\d+)[a-z]?)\b")


def unnamed_studies(pdfs, program):
    """Experiment/Study labels the paper uses at least twice that nothing in the program names."""
    text = " ".join(json.dumps(program.get(k), ensure_ascii=False) for k in ("studies", "nodes", "steps"))
    named = {m.group(2).lower() for m in LABELS.finditer(text)}
    named |= {w.lower() for w in re.findall(r"\b(?:[IVX]+|\d+)[a-z]?\b", " ".join(
        str(st.get("title", "")) + " " + str(st.get("id", "")) for st in program.get("studies", [])))}
    seen = {}
    for pdf in pdfs.values():
        for page in pdf.load() or []:
            for m in LABELS.finditer(page or ""):
                seen[m.group(2)] = seen.get(m.group(2), 0) + 1
    return sorted((k for k, n in seen.items() if n >= 2 and k.lower() not in named),
                  key=lambda k: (len(k), k))


def check(program_path):
    program_path = Path(program_path).resolve()
    root = program_path.parent
    program = json.loads(program_path.read_text(encoding="utf-8"))
    default_pdf = program.get("source", {}).get("filename") or "paper.pdf"
    pdfs, results, cited = {}, [], set()
    main_pdf = (root / ("paper.pdf" if (root / "paper.pdf").is_file() else default_pdf)).resolve()
    if main_pdf.is_file() and main_pdf.suffix.lower() == ".pdf":
        pdfs[main_pdf] = Pdf(main_pdf)
    for e in program.get("evidence", []):
        quote, page = normalise(e.get("quote", "")), (e.get("locator") or {}).get("page")
        entry = {"id": e.get("id"), "page": page, "path": e.get("path")}
        path = e.get("path") or ("paper.pdf" if (root / "paper.pdf").is_file() else default_pdf)
        file = (root / path).resolve()
        if not quote or not page:
            continue  # nothing to compare: locators without quotes are checked by check_program
        if file.suffix.lower() != ".pdf" or root not in file.parents or not file.is_file():
            results.append(dict(entry, status="unchecked", reason="not a PDF in the project"))
            continue
        pdf = pdfs.setdefault(file, Pdf(file))
        cited.add((file, page))
        here = pdf.page(page)
        if not pdf.load():
            results.append(dict(entry, status="unchecked", reason="no PDF reader available"))
            continue
        if len(here) < 40:
            results.append(dict(entry, **ocr_status(e.get("quote", ""), file, page)))
            continue
        score = match(quote, here)
        if score >= 0.999:
            results.append(dict(entry, status="found"))
            continue
        nearby = [(match(quote, pdf.page(p)), p) for p in range(page - NEARBY, page + NEARBY + 1)
                  if p != page and pdf.page(p)]
        best_other = max(nearby, default=(0.0, None))
        if score >= CLOSE and score >= best_other[0]:
            results.append(dict(entry, status="close", similarity=round(score, 3)))
        elif best_other[0] >= CLOSE:
            results.append(dict(entry, status="other_page", foundOn=best_other[1], similarity=round(best_other[0], 3)))
        else:
            results.append(dict(entry, status="not_found", similarity=round(max(score, best_other[0]), 3)))
    counts = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    readers = sorted({p.reader for p in pdfs.values() if p.reader})
    return {"counts": counts, "reader": readers, "results": results, "uncitedStatPages": uncited_pages(pdfs, cited),
            "unnamedStudies": unnamed_studies(pdfs, program)}


def summary(report):
    order = ["found", "found_ocr", "close", "check_ocr", "other_page", "not_found", "unchecked"]
    total = sum(report["counts"].values())
    parts = ["%d %s" % (report["counts"][k], k.replace("_", " ")) for k in order if report["counts"].get(k)]
    return "%d quotes checked against their pages: %s" % (total, ", ".join(parts) or "none")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("program", nargs="?", default="program.json")
    ap.add_argument("--json", help="write the full report here")
    a = ap.parse_args(argv)
    report = check(a.program)
    if a.json:
        Path(a.json).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for r in report["results"]:
        if r["status"] not in ("found", "found_ocr"):
            extra = r.get("reason") or ("on p. %s" % r["foundOn"] if r.get("foundOn") else "similarity %s" % r.get("similarity"))
            print("%-10s %s (p. %s): %s" % (r["status"], r["id"], r["page"], extra))
    pages = report.get("uncitedStatPages") or []
    if pages:
        print("uncited pages that report statistics (check for a missed study, table or result): " +
              ", ".join("%s p. %d" % (p["path"], p["page"]) for p in pages))
    if report.get("unnamedStudies"):
        print("the paper names Experiment/Study " + ", ".join(report["unnamedStudies"]) +
              " but the program never does: model it, or say in the report why it is out of scope")
    print(summary(report))
    return 1 if report["counts"].get("not_found") or report["counts"].get("other_page") else 0


if __name__ == "__main__":
    sys.exit(main())
