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
  unchecked   the cited file has no text layer (scanned) or is not readable here; numbers-only values
  table text layer   a table field whose text cells mostly (>= 50%) match a garbled text layer: a note
  close unverified   close, and every evidence record it cites is marked `verification: "unverified"`
                     because the page's text layer is garbled (OCR): a note, to compare with the image

A piece that runs from one page onto the next is matched past the running head, page number or
footer between them.

Anything else (close, elsewhere, partial, not_found) is a problem (exit 1). Fix it by copying the exact printed words into
the field and citing the right page, or, when the field is a description, paraphrase or summary rather
than a transcription, by relabelling it `reported` (or `derived` with a derivation). Never invent text.
Standard library plus the PDF reader check_quotes.py uses.
"""
import argparse
import json
import re
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


def raw_pieces(value):
    if is_table(value):  # cell order in a PDF text layer is not the table's order: compare cell by cell
        cells = [value.get("title")] + list(value["columns"]) + [c for r in value["rows"] if isinstance(r, list) for c in r]
        notes = value.get("notes")
        cells += notes if isinstance(notes, list) else [notes]
        return [p for c in cells if isinstance(c, str) for p in re.split(r"\s+/\s+", c)]
    if isinstance(value, list):
        return [p for v in value for p in raw_pieces(v)]
    if isinstance(value, dict):
        return [p for v in value.values() for p in raw_pieces(v)]
    return re.split(r"\n+|;\s+|\s\|\s", text_of(value))


def segments(value):
    out = []
    for part in raw_pieces(value):
        pieces = re.split(r"(?<=[.?!])\s+(?=[A-Z“\"])", part) if len(part) > 300 else [part]
        out += [x for x in (check_quotes.normalise(p) for p in pieces) if len(x) >= 3]
    return [q for q in out if re.search(r"[a-z]", q)]


class Sources:
    def __init__(self, root):
        self.root, self.cache = root, {}

    def pages(self, rel):
        if rel not in self.cache:
            path, pages = (self.root / rel).resolve(), None
            if path.is_file() and self.root in path.parents:
                if path.suffix.lower() == ".pdf":
                    pages = [check_quotes.normalise(t) for t in check_quotes.Pdf(path).load()] or None
                elif path.suffix.lower() in (".txt", ".md", ".html", ".csv", ".tsv", ".json"):
                    pages = [check_quotes.normalise(path.read_text(encoding="utf-8", errors="replace"))]
            self.cache[rel] = pages
        return self.cache[rel]


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
            by_file.setdefault(e.get("path") or default, set()).add((e.get("locator") or {}).get("page"))
    windows, wholes, seams = [], [], []
    for rel, pages in by_file.items():
        doc = sources.pages(rel)
        if not doc:
            unreadable.append(rel)
            continue
        nums = sorted(p for p in pages if isinstance(p, int) and 1 <= p <= len(doc))
        if (nums and all(len(doc[n - 1]) < 40 for n in nums)) or sum(len(d) for d in doc) < 40:
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
        status, info, share = compare(segments(f.get("value")), evidence, ids, sources, default)
        if is_table(f.get("value")) and status in ("close", "elsewhere", "partial") and share >= TABLE_SHARE:
            # a text layer garbles table cells (OCR noise, cell order); the cells were read from the page
            # image, so most text cells agreeing is the check; a wrong or invented table still fails
            status, info = "table_text_layer", "%s; %d%% of text cells match the text layer" % (info, round(100 * share))
        elif status == "close" and all((evidence.get(i) or {}).get("verification") == "unverified" for i in ids):
            # a garbled text layer (OCR) misreads the printed words; the evidence says the text layer cannot verify them
            status, info = "close_unverified", info + "; its evidence is marked unverified (garbled text layer)"
        pages = sorted({str(((evidence.get(i) or {}).get("locator") or {}).get("page")) for i in ids if i in evidence})
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
    bad = [r for r in report["results"] if r["status"] not in ("found", "unchecked", "table_text_layer", "close_unverified")]
    for r in bad:
        print("PROBLEM %s (p. %s): %s: %s\n        fix: copy the exact printed words and cite their page, or relabel "
              "the field reported (derived with a derivation) if it is not a transcription; never invent text"
              % (r["field"], ",".join(r.get("pages") or []) or "?", r["status"], r["info"]))
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
