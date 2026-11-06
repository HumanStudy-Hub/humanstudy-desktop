#!/usr/bin/env python3
"""Check that every field labelled `verbatim` holds the printed words of the pages its evidence cites.

    python .opencode/skills/build/check_verbatim.py program.json [--json report.json]

The same comparison as the audit's X1 check. Each verbatim value is split into pieces (list items, lines,
'; '-separated parts, sentences of long parts; for a table field its title, headers, row labels, text
cells and notes) and each piece is looked up in the cited pages (and their neighbours), after the
normalisation check_quotes.py uses:

  found       every piece is on the cited pages word for word
  close       every piece is there or nearly so: a slip or a reworded word
  elsewhere   found, but only on pages the field does not cite
  partial     some pieces are not in the source: added or reworded text
  not_found   no piece is in the source
  unchecked   the cited file is not readable here; numbers-only values
  reference   the value is a reference to a file ({"file": "sources/private/..."}) that keeps the text out of
              the program: nothing to compare
  image only  a cited PDF page has no text layer (a scanned page, a screenshot) and the evidence does not
              record `verification: "image-compared"` (the rendered page read again word by word): a problem
  opt out as anchor  a list in the value puts a Qualtrics slider's opt-out box ("Not Applicable", the
              export's Labels "NA" with Configuration.NotApplicable) among the scale's anchors: a problem
  table text layer   a table field whose text cells mostly (>= 50%) match a garbled text layer: a note
  close unverified   close, and every evidence record it cites is marked `verification: "unverified"`
                     because the page's text layer is garbled (OCR): a note, to compare with the image
  layout split       a word is split where the raw text layer prints it whole ("correspon dence" for
                     "correspondence", "l ateral"), or words are separated by runs of spaces: text copied
                     from the column-aligned (--layout) extraction. A problem whatever the match above;
                     every raw reader available (pypdf, pdfplumber, pdftotext without -layout) is consulted

A piece that runs from one page onto the next is matched past the running head, page number or
footer between them. Besides PDFs and text files, a Word file (.docx, docx_text.py's pages) and a Qualtrics
export (.qsf) are read: a survey is one page per question participants saw, in flow order (qsf_flow.py:
question text, options, rows, columns, slider anchors, opt-out box, validation message; HTML stripped,
whitespace normalised), and evidence that names a question id (locator {"pointer": "QID9"}) cites its page.

Anything else (close, elsewhere, partial, not_found) is a problem (exit 1). Fix it by copying the exact printed words into
the field and citing the right page, or, when the field is a description, paraphrase or summary rather
than a transcription, by relabelling it `reported` (or `derived` with a derivation). Never invent text.
Standard library plus the PDF reader check_quotes.py uses.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_quotes  # noqa: E402


TABLE_SHARE = 0.5   # share of a table's text cells that must match a noisy text layer


def text_of(value):
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    if isinstance(value, list):
        return " ".join(text_of(v) for v in value)
    if isinstance(value, dict):
        return " ".join(text_of(v) for v in value.values())
    return ""


def is_table(value):
    return isinstance(value, dict) and isinstance(value.get("columns"), list) and isinstance(value.get("rows"), list)


TABLE_META = ("table", "page", "uncertain")  # table keys that are not printed text
# keys of a transcribed item that name it rather than print it (a survey question id, a reply key, a type)
ID_KEYS = ("qid", "qsfId", "qsfTag", "tag", "key", "id", "type", "kind", "pointer", "file", "format", "min", "max",
           "minimum", "maximum", "step", "shuffle", "randomize", "required")


def table_cells(value):
    """Every printed cell of a table value as a string: title, headers (nested ones too), row cells (rows
    given as dicts too), notes, and any other key except TABLE_META, so nothing in a table goes unchecked."""
    def flat(v):
        if isinstance(v, str):
            return [v]
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return [str(v)]
        if isinstance(v, list):
            return [c for x in v for c in flat(x)]
        if isinstance(v, dict):
            return [c for x in v.values() for c in flat(x)]
        return []
    return [c for k, v in value.items() if k not in TABLE_META for c in flat(v)]


def raw_pieces(value):
    if is_table(value):  # cell order in a PDF text layer is not the table's order: compare cell by cell
        return [p for c in table_cells(value) for p in re.split(r"\s+/\s+", c)]
    if isinstance(value, list):
        return [p for v in value for p in raw_pieces(v)]
    if isinstance(value, dict):   # identifiers beside the text ({"qid": "QID7", "text": ...}) are not printed words
        return [p for k, v in value.items() if k not in ID_KEYS for p in raw_pieces(v)]
    return re.split(r"\n+|;\s+|\s\|\s", text_of(value))


def segments(value):
    out = []
    for part in raw_pieces(value):
        pieces = re.split(r"(?<=[.?!])\s+(?=[A-Z“\"])", part) if len(part) > 300 else [part]
        out += [x for x in (check_quotes.normalise(p) for p in pieces) if len(x) >= 3]
    return [q for q in out if re.search(r"[a-z]", q)]


def raw_layers(path):
    """Page texts of the raw (reading-order, not --layout) text layer from each other reader available."""
    out = []
    try:
        import pdfplumber
        with pdfplumber.open(str(path)) as pdf:
            out.append([p.extract_text() or "" for p in pdf.pages])
    except Exception:
        pass
    if shutil.which("pdftotext"):
        try:
            run = subprocess.run(["pdftotext", str(path), "-"], capture_output=True, timeout=120)
            if run.returncode == 0:
                out.append(run.stdout.decode("utf-8", "replace").split("\f"))
        except (OSError, subprocess.SubprocessError):
            pass
    return out


def merges_words(text):
    """True when a reader drops the spaces between words on these pages (many 16+ letter tokens)."""
    words = [w for w in text.split() if w.isalpha()]
    return len(words) >= 20 and sum(len(w) >= 16 for w in words) > 0.01 * len(words)


def splits(value, layers, pages):
    """[(as written, as printed)]: words of a verbatim value split where the raw text layer prints them whole.

    Only readers that keep word spaces on the cited pages count; a split is reported when at least one of
    them prints the word whole and fewer of them print it split ("l ateral" from one reader, "lateral"
    from the others). Table fields are not checked: their cells are read from the column-aligned text."""
    if is_table(value):
        return []
    raw = check_quotes.normalise(" ".join(p for p in raw_pieces(value) if isinstance(p, str)))
    plain = text_of(value).lower()
    toks, found = raw.split(), []
    texts = [" %s " % " ".join(layer[p - 1] for p in pages if 1 <= p <= len(layer)) for layer in layers]
    texts = [t for t in texts if t.strip() and not merges_words(t)]
    for a, b in zip(toks, toks[1:]):
        if not (a.isalpha() and b.isalpha()) or len(a) + len(b) < 5 or (a + " " + b, a + b) in found:
            continue
        if re.search(re.escape(a) + r"\s*[-\u2010\u2011\u2013/]\s*" + re.escape(b), plain):
            continue  # printed with a hyphen or slash ("re-evaluate"): not a split
        whole = sum(1 for t in texts if (" %s " % (a + b)) in t and (" %s %s " % (a, b)) not in t)
        split = sum(1 for t in texts if (" %s %s " % (a, b)) in t)
        if whole > split:   # a tie (one reader each way) is not evidence
            found.append((a + " " + b, a + b))
    return found


def wide_spaces(value):
    """Runs of spaces inside a line of a text value (column padding of a --layout extraction)."""
    if is_table(value):
        return []
    # two spaces after a full stop are a typing habit, not column padding
    return [m.group(0) for p in raw_pieces(value) if isinstance(p, str)
            for m in re.finditer(r"\S*[^\s.!?:;] {2,}\S+", p)]


class Sources:
    def __init__(self, root):
        self.root, self.cache, self.layer_cache = root, {}, {}
        self.qids, self.reports = {}, {}   # per .qsf: question id -> page, and the questions in page order

    def layers(self, rel):
        """Normalised page lists of every raw reader for one file (the primary reader first)."""
        if rel not in self.layer_cache:
            primary = self.pages(rel)
            path = (self.root / rel).resolve()
            extra = raw_layers(path) if primary and path.suffix.lower() == ".pdf" else []
            self.layer_cache[rel] = ([primary] if primary else []) + [[check_quotes.normalise(t) for t in layer]
                                                                       for layer in extra if layer]
        return self.layer_cache[rel]

    def pages(self, rel):
        if rel not in self.cache:
            path, pages = (self.root / rel).resolve(), None
            if path.is_file() and self.root in path.parents:
                suffix = path.suffix.lower()
                if suffix == ".pdf":
                    pages = [check_quotes.normalise(t) for t in check_quotes.Pdf(path).load()] or None
                elif suffix == ".qsf":
                    pages = self._qsf(rel, path)
                elif suffix == ".docx":
                    try:
                        import docx_text
                        pages = [check_quotes.normalise("\n".join(p)) for p in docx_text.read(path)["pages"]] or None
                    except Exception:  # noqa: BLE001  an unreadable Word file stays unchecked
                        pages = None
                elif suffix in (".txt", ".md", ".html", ".csv", ".tsv", ".json"):
                    pages = [check_quotes.normalise(path.read_text(encoding="utf-8", errors="replace"))]
            self.cache[rel] = pages
        return self.cache[rel]

    def _qsf(self, rel, path):
        """A survey export as one page per question participants saw, in flow order (qsf_flow.py): question
        text, options, rows, columns, slider anchors, the opt-out box and the validation message, HTML
        stripped. A question cited by id (locator {"pointer": "QID9"}) is that page."""
        try:
            import qsf_flow
            report = qsf_flow.read_qsf(path)
        except Exception:  # noqa: BLE001  not a survey export: unreadable here
            return None
        questions = [q for b in report["blocks"].values() for q in b["questions"]]
        if not questions:   # no survey flow: every question in the file
            data = qsf_flow.load_qsf(path)
            raw = qsf_flow._questions(data)
            questions = [qsf_flow._question(q, raw, []) for q in raw.values()]
        self.qids[rel] = {}
        pages = []
        for q in questions:
            self.qids[rel][q["qid"]] = len(pages) + 1
            self.reports.setdefault(rel, []).append(q)
            pages.append(check_quotes.normalise("\n".join(qsf_flow._record_texts(q))))
        return pages or None

    def locate(self, rel, locator):
        """The page a non-PDF locator names: a survey question id ("QID12") in any locator value."""
        if rel not in self.qids:
            self.pages(rel)
        ids = self.qids.get(rel) or {}
        for value in (locator or {}).values() if isinstance(locator, dict) else []:
            for qid in re.findall(r"QID\d+", str(value)):
                if qid in ids:
                    return ids[qid]
        return None


def across(q, seams):
    """q runs from one page onto the next, past a footer, running head or page number in between."""
    for tail, head in seams:
        for j in range(0, 11):
            left = " ".join(tail[:len(tail) - j])
            if not left or not any(left.endswith(q[:i]) for i in range(1, len(q))):
                continue
            for k in range(0, 16):
                if q in left + " " + " ".join(head[k:]):
                    return True
    return False


def compare(segs, evidence, ids, sources, default):
    """(status, info, share of pieces found exactly or nearly)."""
    if not segs:
        return "unchecked", "numbers only", 1.0
    by_file, unreadable = {}, []
    for eid in ids:
        e = evidence.get(eid)
        if e:
            rel, locator = e.get("path") or default, e.get("locator") or {}
            page = locator.get("page") if isinstance(locator, dict) else None
            if not isinstance(page, int) and hasattr(sources, "locate"):
                page = sources.locate(rel, locator)   # a survey question cited by id
            by_file.setdefault(rel, set()).add(page)
    windows, wholes, seams = [], [], []
    for rel, pages in by_file.items():
        doc = sources.pages(rel)
        if not doc:
            unreadable.append(rel)
            continue
        nums = sorted(p for p in pages if isinstance(p, int) and 1 <= p <= len(doc))
        if (str(rel).lower().endswith(".pdf") and nums and all(len(doc[n - 1]) < 40 for n in nums)) \
                or sum(len(d) for d in doc) < 40:
            unreadable.append("%s (no text layer on the cited page(s))" % rel)
            continue
        near = sorted({x for n in nums for x in (n - 1, n, n + 1) if 1 <= x <= len(doc)})
        windows.append(" ".join(doc[p - 1] for p in near) if len(doc) > 1 and near else " ".join(doc))
        seams += [(doc[p - 1].split()[-400:], doc[p].split()[:400]) for p in near if p < len(doc)]
        wholes.append(" ".join(doc))
    if not windows:
        return "unchecked", "cited file(s) not readable here: " + ", ".join(unreadable), 0.0
    exact = close = elsewhere = 0
    for q in segs:
        if any(q in w for w in windows) or across(q, seams):
            exact += 1
        elif max(check_quotes.match(q, w) if len(q) < 6000 else 0.0 for w in windows) >= check_quotes.CLOSE:
            close += 1
        elif any(q in w for w in wholes):
            elsewhere += 1
    n = len(segs)
    share = (exact + close) / n
    if exact == n:
        return "found", None, share
    if exact + close == n:
        return "close", "%d of %d piece(s) only nearly verbatim" % (close, n), share
    if exact + close + elsewhere == n:
        return "elsewhere", "%d of %d piece(s) only on pages it does not cite" % (elsewhere, n), share
    if unreadable:
        return "unchecked", "%d of %d piece(s) not in the readable files; also cites %s" % (
            n - exact - close - elsewhere, n, ", ".join(unreadable)), share
    if exact + close + elsewhere:
        return "partial", "%d of %d piece(s) not in the source" % (n - exact - close - elsewhere, n), share
    return "not_found", "not on the cited page(s)", share


def field_status(value, evidence, ids, sources, default):
    """(status, info) of one verbatim value; shared with audit.py's X1 so both decide the same way."""
    status, info, share = compare(segments(value), evidence, ids, sources, default)
    if is_table(value) and status in ("close", "elsewhere", "partial") and share >= TABLE_SHARE:
        # a text layer garbles table cells (OCR noise, cell order); the cells were read from the page
        # image, so most text cells agreeing is the check; a wrong or invented table still fails
        status, info = "table_text_layer", "%s; %d%% of text cells match the text layer" % (info, round(100 * share))
    elif status == "close" and all((evidence.get(i) or {}).get("verification") == "unverified" for i in ids):
        # a garbled text layer (OCR) misreads the printed words; the evidence says the text layer cannot verify them
        status, info = "close_unverified", info + "; its evidence is marked unverified (garbled text layer)"
    return status, info


IMAGE_COMPARED = ("image-compared", "ocr")
REFERENCE_KEYS = {"file", "path", "locator", "section", "page", "pages", "note", "sha256"}


def image_compared(ids, evidence):
    """Every evidence record the field cites says its image-only page was compared with the words, word by word."""
    records = [evidence.get(i) or {} for i in ids]
    return bool(records) and all(str(e.get("verification", "")).lower() in IMAGE_COMPARED for e in records)


def cited_files(ids, evidence, default):
    return list(dict.fromkeys((evidence.get(i) or {}).get("path") or default for i in ids if i in evidence))


def opt_out_anchors(value, surveys):
    """A list in the value that puts a slider's opt-out box ("Not Applicable") among its anchors, as a message."""
    sliders = [q for questions in surveys for q in questions
               if isinstance(q.get("scale"), dict) and q["scale"].get("not_applicable")]
    if not sliders:
        return None

    def lists(v):
        if isinstance(v, list):
            yield v
            for x in v:
                yield from lists(x)
        elif isinstance(v, dict):
            for x in v.values():
                yield from lists(x)
    for item in lists(value):
        texts = {str(x).strip().casefold() for x in item if isinstance(x, str)}
        for q in sliders:
            na = q["scale"]["not_applicable"]
            if na.strip().casefold() in texts and texts & {str(x).strip().casefold() for x in q["scale"].get("labels") or []}:
                return ("%r is listed among the anchors, but in %s (%s) it is a separate opt-out box, not a point on "
                        "the scale (anchors: %s)" % (na, q.get("qid"), q.get("tag"), ", ".join(q["scale"].get("labels") or [])))
    return None


def check(program_path):
    program_path = Path(program_path).resolve()
    root = program_path.parent
    p = json.loads(program_path.read_text(encoding="utf-8"))
    evidence = {e.get("id"): e for e in p.get("evidence") or [] if isinstance(e, dict)}
    default = "paper.pdf" if (root / "paper.pdf").is_file() else ((p.get("source") or {}).get("filename") or "paper.pdf")
    sources, results = Sources(root), []
    fields = [(n.get("id"), f, n.get("evidenceIds")) for n in p.get("nodes") or [] if isinstance(n, dict)
              for f in n.get("fields") or [] if isinstance(f, dict)]
    fields += [(s.get("id"), s["rule"], s.get("evidenceIds")) for s in p.get("steps") or []
               if isinstance(s, dict) and isinstance(s.get("rule"), dict)]
    for owner, f, owner_ids in fields:
        if f.get("origin") != "verbatim" or not text_of(f.get("value")).strip():
            continue
        where = "%s.%s" % (owner, f.get("id"))
        ids = f.get("evidenceIds") or owner_ids or []
        if not ids:
            results.append({"field": where, "status": "no_evidence", "info": "verbatim with no evidence"})
            continue
        value = f.get("value")
        if isinstance(value, dict) and value.get("file") and set(value) <= REFERENCE_KEYS:
            # a reference to a file kept out of the program (found-private, researcher-supplied): no text to compare
            results.append({"field": where, "status": "reference", "info": "a reference to %s" % value.get("file")})
            continue
        status, info = field_status(f.get("value"), evidence, ids, sources, default)
        pages = sorted({str(((evidence.get(i) or {}).get("locator") or {}).get("page")) for i in ids if i in evidence})
        cited = {}
        for i in ids:
            e = evidence.get(i) or {}
            page = (e.get("locator") or {}).get("page")
            if isinstance(page, int):
                cited.setdefault(e.get("path") or default, set()).update((page - 1, page, page + 1))
        split = [x for rel, near in cited.items() for x in splits(f.get("value"), sources.layers(rel), sorted(near))]
        # column padding comes from a PDF's --layout extraction; a Word or survey file has its own spacing
        wide = wide_spaces(f.get("value")) if any(str(r).lower().endswith(".pdf")
                                                   for r in cited_files(ids, evidence, default)) else []
        if status != "unchecked" and (split or wide):
            status, info = "layout_split", "; ".join(
                ["%r is printed %r in the raw text layer" % x for x in split[:6]] +
                (["runs of spaces from a column-aligned extraction: %s" % ", ".join(repr(w) for w in wide[:3])] if wide else []))
        opt_out = opt_out_anchors(f.get("value"), [sources.reports.get(rel) or [] for rel in cited_files(ids, evidence, default)])
        if opt_out:
            status, info = "opt_out_as_anchor", opt_out
        elif status == "unchecked" and "no text layer" in (info or "") and not image_compared(ids, evidence):
            status = "image_only"
            info += ("; the words cannot be compared with a text layer: read the rendered page again word by word and "
                     "record it on each evidence record (\"verification\": \"image-compared\"), or relabel the field")
        results.append({"field": where, "status": status, "info": info, "pages": pages})
    counts = {}
    for r in results:
        counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {"counts": counts, "results": results}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("program", nargs="?", default="program.json")
    ap.add_argument("--json", help="write the full report here")
    a = ap.parse_args(argv)
    report = check(a.program)
    if a.json:
        Path(a.json).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    bad = [r for r in report["results"] if r["status"] not in ("found", "unchecked", "table_text_layer", "close_unverified",
                                                              "reference")]
    for r in bad:
        fix = ("copy the words from the raw text layer (`hs-pdf pages` without --layout) or the page image, one "
               "space between words; --layout output is for reading tables, never for verbatim text"
               if r["status"] == "layout_split" else
               "render the page (paper_tables.py --render), compare every word with the field, fix any slip and set "
               "the evidence's verification to image-compared; a page nobody compared is not verbatim"
               if r["status"] == "image_only" else
               "keep the slider's anchors as the survey numbers them and give the opt-out box its own key"
               if r["status"] == "opt_out_as_anchor" else
               "copy the exact printed words and cite their page, or relabel the field reported (derived with a "
               "derivation) if it is not a transcription; never invent text")
        print("PROBLEM %s (p. %s): %s: %s\n        fix: %s"
              % (r["field"], ",".join(r.get("pages") or []) or "?", r["status"].replace("_", " "), r["info"], fix))
    for r in report["results"]:
        if r["status"] in ("unchecked", "table_text_layer", "close_unverified"):
            print("note    %s: %s (%s); compare it with the page image yourself" % (r["field"], r["status"].replace("_", " "), r["info"]))
    total = len(report["results"])
    summary = ", ".join("%d %s" % (v, k.replace("_", " ")) for k, v in sorted(report["counts"].items()))
    if bad:
        print("FAIL %d of %d verbatim field(s) are not the printed words (%s)" % (len(bad), total, summary))
        return 1
    print("PASS %d verbatim field(s) checked (%s)" % (total, summary or "none"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
