#!/usr/bin/env python3
"""Check that every quoted source passage really appears on the page it cites.

    python .opencode/skills/build/check_quotes.py program.json [--json report.json]

For each evidence item with a quote and a page in a PDF, the page's text layer is compared with the
quote after normalising case, punctuation, line-break hyphens and spacing:

  found        the quote is on the cited page
  close        nearly verbatim on the cited page (OCR noise or a small transcription slip): reread it
  other_page   not on the cited page but on a nearby one: fix the page number
  not_found    not on the cited page or its neighbours: the quote or its page is wrong
  unchecked    no text layer on that page (scanned image), the file is not a PDF, or no PDF reader

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


def check(program_path):
    program_path = Path(program_path).resolve()
    root = program_path.parent
    program = json.loads(program_path.read_text(encoding="utf-8"))
    default_pdf = program.get("source", {}).get("filename") or "paper.pdf"
    pdfs, results = {}, []
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
        here = pdf.page(page)
        if not pdf.load():
            results.append(dict(entry, status="unchecked", reason="no PDF reader available"))
            continue
        if len(here) < 40:
            results.append(dict(entry, status="unchecked", reason="no text layer on this page (scanned image)"))
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
    return {"counts": counts, "reader": readers, "results": results}


def summary(report):
    order = ["found", "close", "other_page", "not_found", "unchecked"]
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
        if r["status"] not in ("found",):
            extra = r.get("reason") or ("on p. %s" % r["foundOn"] if r.get("foundOn") else "similarity %s" % r.get("similarity"))
            print("%-10s %s (p. %s): %s" % (r["status"], r["id"], r["page"], extra))
    print(summary(report))
    return 1 if report["counts"].get("not_found") or report["counts"].get("other_page") else 0


if __name__ == "__main__":
    sys.exit(main())
