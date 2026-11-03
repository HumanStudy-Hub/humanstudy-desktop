#!/usr/bin/env python3
"""Check that the paper's reported numbers are data, not only quoted text.

    python .opencode/skills/build/check_results.py program.json [--json report.json]

Prints every problem with a fix, then PASS or FAIL (exit 1). Four checks:

  table shape    a field whose value is a table ({"table", "page", "columns", "rows"}) is well formed:
                 every row has one cell per column, cells are as printed (text or number), an
                 unreadable cell is null and listed in "uncertain", a printed table (with a "table"
                 label) has origin verbatim, and it cites evidence
  quote only     a result node cites quotes holding numbers that no field (and no effects.json
                 entry) holds: transcribe them into fields or a table
  table quote    an evidence quote that reads like a numeric table (many numbers, few words) whose
                 numbers no table field or other field holds
  printed table  a page prints a table caption ("Table 2", "TABLE II") but no table field has that label
  skipped table  a printed table (its caption is on the page) marked missing although the page has a clean
                 text layer with table rows (three or more lines that are mostly numbers in the
                 column-aligned text): the stated reason ("scrambled", "unreadable") is not true, so
                 transcribe it

Numbers are compared as printed values; labels such as "Study 2", "Table 3", page numbers and years
are ignored. The checks are best effort: they find untranscribed numbers, they cannot prove that
every number is present. Standard library; the caption check reads the PDF like check_quotes.py.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_quotes import Pdf  # noqa: E402  same PDF reader as the quote check

NUM = re.compile(r"(?<![\w.])[-−–]?(?:\d+(?:\.\d+)?|\.\d+)(?![\w])")
LABEL = re.compile(r"\b(?:tables?|figs?\.?|figures?|stud(?:y|ies)|experiments?|exps?\.?|hypothes[ie]s|h|appendix|"
                   r"sections?|items?|questions?|q|footnotes?|notes?|waves?|rounds?|sessions?|blocks?|phases?|"
                   r"panels?|samples?|conditions?|groups?|stories|story|scenarios?|pp?\.|pages?|vol\.?|no\.)"
                   r"\s*(?:\d+[a-z]?|[ivx]+\b)(?:\s*(?:,|and|&|-|–)\s*\d+[a-z]?)*", re.I)
THOUSANDS = re.compile(r"(?<![\d.(])\d{1,3}(?:,\d{3})+(?![\d,])")
YEAR = re.compile(r"(?<![\d.])(?:19|20)\d\d(?![\d.])")
CAPTION = re.compile(r"^\s*(TABLE|Table)\s+([0-9]+[A-Za-z]?|[IVXL]+|[A-Z][0-9]*|S[0-9]+)\s*(?:[.:|—–-]|$)")
ROMAN = {"I": 1, "V": 5, "X": 10, "L": 50}
MIN_QUOTE_ONLY = 2       # unstructured numbers that make a result node a problem
TABLE_NUMBERS = 10       # numbers in a quote that, with TABLE_SHARE, make it read like a table
TABLE_SHARE = 0.3


def numbers(text):
    """Printed values in text, as floats, without labels, page numbers and years."""
    if not isinstance(text, str):
        return []
    text = THOUSANDS.sub(lambda m: m.group(0).replace(",", ""), text)  # 1,234 is one number
    text = YEAR.sub(" ", LABEL.sub(" ", text))
    out = []
    for m in NUM.findall(text):
        try:
            out.append(abs(float(m.replace("−", "-").replace("–", "-"))))
        except ValueError:
            pass
    return out


def walk(value, out):
    if isinstance(value, bool) or value is None:
        return
    if isinstance(value, (int, float)):
        out.append(abs(float(value)))
    elif isinstance(value, str):
        out.extend(numbers(value))
    elif isinstance(value, dict):
        for k, v in value.items():
            if k not in ("page", "row", "column"):
                walk(v, out)
    elif isinstance(value, list):
        for v in value:
            walk(v, out)


def is_table(value):
    return isinstance(value, dict) and isinstance(value.get("columns"), list) and isinstance(value.get("rows"), list)


def label_key(label):
    """'Table 2', 'TABLE II', 'table 2.' -> 'table 2'."""
    m = re.match(r"\s*table\s+([0-9]+[a-z]?|[ivxl]+|[a-z][0-9]*|s[0-9]+)\b", str(label or ""), re.I)
    if not m:
        return None
    tag = m.group(1).upper()
    if re.fullmatch(r"[IVXL]+", tag) and tag not in ("L",):
        total = 0
        for i, ch in enumerate(tag):
            v = ROMAN[ch]
            total += -v if i + 1 < len(tag) and ROMAN[tag[i + 1]] > v else v
        tag = str(total)
    return "table " + tag.lower()


SUPPLEMENT = re.compile(r"\b(?:supplementary|supplemental|online|appendix|see|in|cf\.?)\s*$", re.I)
GRID_ROWS = 3           # lines of >= 3 numbers that make a page's column-aligned text a readable table


def layout_page(pdf_path, number):
    """Column-aligned text of one page (pdfplumber layout, else pdftotext -layout); "" when unavailable."""
    try:
        import pdfplumber
        with pdfplumber.open(str(pdf_path)) as pdf:
            if 1 <= number <= len(pdf.pages):
                return pdf.pages[number - 1].extract_text(layout=True) or ""
    except Exception:
        pass
    if shutil.which("pdftotext"):
        try:
            run = subprocess.run(["pdftotext", "-layout", "-f", str(number), "-l", str(number), str(pdf_path), "-"],
                                 capture_output=True, timeout=60)
            if run.returncode == 0:
                return run.stdout.decode("utf-8", "replace")
        except (OSError, subprocess.SubprocessError):
            pass
    return ""


def grid_rows(text):
    """Lines that read like table rows: three or more printed numbers, and numbers at least half the tokens."""
    out = []
    for line in (text or "").splitlines():
        nums, tokens = NUM.findall(LABEL.sub(" ", line)), line.split()
        if len(nums) >= 3 and len(nums) >= 0.5 * len(tokens):
            out.append(line)
    return out


def table_problems(where, f):
    v, out = f["value"], []
    add = lambda msg, hint: out.append(("%s: %s" % (where, msg), hint))
    cols, rows = v["columns"], v["rows"]
    if not label_key(v.get("table")) and not str(v.get("title") or "").strip():
        add("table has no label", 'set "table" to the printed label (e.g. "Table 2"), or "title" for an unnumbered table')
    if not isinstance(v.get("page"), int):
        add("table has no page", 'set "page" to the physical PDF page the table is printed on')
    if f.get("state") == "missing":
        return out
    if not cols or not all(isinstance(c, str) for c in cols):
        add("columns must be the printed column headers (text)", "join stacked headers with ' / '")
    if not rows:
        add("table has no rows", "transcribe every printed row, or mark the field missing with an issue")
    uncertain = v.get("uncertain") or []
    if not isinstance(uncertain, list):
        add("uncertain must be a list of cells", 'write [{"row": 0, "column": 1, "reason": "..."}]')
        uncertain = []
    flagged = {(u.get("row"), u.get("column")) for u in uncertain if isinstance(u, dict)}
    for i, row in enumerate(rows):
        if not isinstance(row, list):
            add("row %d is not a list of cells" % i, "write each row as [row label, cell, cell, ...]")
            continue
        if cols and len(row) != len(cols):
            add("row %d has %d cells for %d columns" % (i, len(row), len(cols)),
                'one cell per column; a printed blank is "" and an unreadable cell is null')
        for j, cell in enumerate(row):
            if cell is not None and not isinstance(cell, (str, int, float)):
                add("row %d column %d is not a printed value" % (i, j), "cells hold text or numbers as printed")
            if cell is None and (i, j) not in flagged:
                add("row %d column %d is null but not listed in uncertain" % (i, j),
                    'add {"row": %d, "column": %d, "reason": "what can be seen"} to uncertain' % (i, j))
    for u in uncertain:
        if not (isinstance(u, dict) and isinstance(u.get("row"), int) and isinstance(u.get("column"), int)
                and 0 <= u["row"] < len(rows) and 0 <= u["column"] < max(len(cols), 1) and str(u.get("reason") or "").strip()):
            add("uncertain entry %s does not name a cell with a reason" % json.dumps(u)[:80],
                "row and column are 0-based indexes into rows and columns; give the reason")
    if label_key(v.get("table")) and f.get("origin") != "verbatim":
        add("printed %s has origin %r" % (v.get("table"), f.get("origin")),
            'a printed table is transcribed with origin "verbatim"; a table assembled from the text has no "table" label')
    if not f.get("evidenceIds"):
        add("table cites no evidence", "cite the evidence record that locates the table (its caption and page)")
    return out


def check(program_path):
    program_path = Path(program_path).resolve()
    root = program_path.parent
    p = json.loads(program_path.read_text(encoding="utf-8"))
    nodes = [n for n in p.get("nodes") or [] if isinstance(n, dict)]
    evidence = {e.get("id"): e for e in p.get("evidence") or [] if isinstance(e, dict)}
    out, info = [], []

    structured, tables = [], []   # numbers held by fields; (where, field) for table fields
    for n in nodes:
        for f in n.get("fields") or []:
            if not isinstance(f, dict):
                continue
            walk(f.get("value"), structured)
            if is_table(f.get("value")):
                tables.append(("%s.%s" % (n.get("id"), f.get("id")), f))
    for s in p.get("steps") or []:
        if isinstance(s, dict) and isinstance(s.get("rule"), dict):
            walk(s["rule"].get("value"), structured)
    try:
        effects = json.loads((root / "effects.json").read_text(encoding="utf-8"))
        for e in effects.get("effects") or []:
            walk(e.get("reported"), structured)
    except (OSError, ValueError, AttributeError):
        pass
    held = {round(x, 6) for x in structured}
    unheld = lambda xs: [x for x in xs if round(x, 6) not in held]

    for where, f in tables:
        out += table_problems(where, f)

    # quote only: result nodes whose cited quotes hold numbers no field holds
    for n in nodes:
        if n.get("kind") != "result":
            continue
        ids = list(n.get("evidenceIds") or []) + [i for f in n.get("fields") or [] if isinstance(f, dict) for i in f.get("evidenceIds") or []]
        ids = [i for i in dict.fromkeys(ids) if i in evidence]
        missing = sorted(set(unheld([x for i in ids for x in numbers(evidence[i].get("quote"))])))
        if len(missing) >= MIN_QUOTE_ONLY:
            shown = ", ".join(("%g" % x) for x in missing[:12]) + (" ..." if len(missing) > 12 else "")
            out.append(("%s: %d numbers appear only in evidence quotes (%s): %s" % (n.get("id"), len(missing), ", ".join(ids[:4]), shown),
                         "transcribe them into fields (n, M, SD, %, test statistics per group or item) or a table "
                         "field; a quote locates a number, it does not store it"))

    # table quote: quotes that read like a printed table, with numbers no field holds
    cited_by_table = {i for _, f in tables for i in f.get("evidenceIds") or []}
    for eid, e in evidence.items():
        quote = e.get("quote") if isinstance(e.get("quote"), str) else ""
        nums = numbers(quote)
        words = len(re.findall(r"[A-Za-z]{2,}", YEAR.sub(" ", LABEL.sub(" ", quote))))
        if len(nums) >= TABLE_NUMBERS and len(nums) / max(1, len(nums) + words) >= TABLE_SHARE:
            missing = unheld(nums)
            if eid not in cited_by_table and len(missing) >= MIN_QUOTE_ONLY:
                out.append(("%s (p. %s): quote reads like a printed table (%d numbers, %d not in any field)"
                            % (eid, (e.get("locator") or {}).get("page"), len(nums), len(missing)),
                            "transcribe the table cell by cell into a table field that cites this evidence"))

    # printed table: captions on the paper's pages with no table field of that label
    labels = {label_key((f.get("value") or {}).get("table")) for _, f in tables}
    paper = (p.get("source") or {}).get("filename")
    pdf_path = root / "paper.pdf" if (root / "paper.pdf").is_file() else (root / paper if paper else None)
    if pdf_path and pdf_path.is_file() and pdf_path.suffix.lower() == ".pdf":
        pages = Pdf(pdf_path).load()
        seen, blank = {}, []
        for number, text in enumerate(pages, 1):
            if len((text or "").strip()) < 40:
                blank.append(number)
                continue
            lines = (text or "").splitlines()
            for i, line in enumerate(lines):
                m = CAPTION.match(line)
                if m and i and SUPPLEMENT.search(lines[i - 1]):
                    m = None  # "... Supplementary\nTable 6.": a reference to a table outside the paper
                key = label_key("table " + m.group(2)) if m else None
                if key and key not in seen:
                    seen[key] = number
        for key, page in seen.items():
            if key not in labels:
                out.append(("p. %d prints %s, but no field holds it as a table" % (page, key.title()),
                            'transcribe it cell by cell: a field with value {"table": "%s", "page": %d, "columns": [...], '
                            '"rows": [[...]]} and origin verbatim (an empty table marked missing with an issue when it '
                            'cannot be read)' % (key.title(), page)))
        for where, f in tables:
            v = f.get("value") or {}
            page = v.get("page")
            if f.get("state") != "missing" or not isinstance(page, int) or not 1 <= page <= len(pages) or page in blank:
                continue
            printed_on = seen.get(label_key(v.get("table")))
            if printed_on is None or abs(printed_on - page) > 1:
                continue  # the paper does not print this table here (a supplementary table it only cites)
            rows = grid_rows(layout_page(pdf_path, page))
            if len(rows) >= GRID_ROWS:
                out.append(("%s: %s is marked missing, but p. %d has a clean text layer with %d table rows in its "
                            "column-aligned text (e.g. %r)" % (where, v.get("table") or "the table", page, len(rows),
                                                               re.sub(r"\s+", " ", rows[0]).strip()[:80]),
                            "read it with `hs-pdf pages paper.pdf --from %d --to %d --layout` and transcribe it cell by "
                            "cell; a cell you cannot place is null and listed in uncertain. Never state that a text "
                            "layer is scrambled without reading the column-aligned text" % (page, page)))
        if blank:
            info.append("pages without a text layer (scanned): %s; read their tables from the page images"
                        % ", ".join(map(str, blank[:30])))
        if not pages:
            info.append("no PDF reader available: printed table captions not checked")
    return {"problems": out, "info": info, "tables": len(tables)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("program", nargs="?", default="program.json")
    ap.add_argument("--json", help="write the report here")
    a = ap.parse_args(argv)
    try:
        report = check(a.program)
    except (OSError, ValueError, TypeError, AttributeError) as exc:
        print("FAIL %s: cannot read: %s" % (a.program, exc))
        return 1
    if a.json:
        Path(a.json).write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for msg, hint in report["problems"]:
        print("PROBLEM %s\n        fix: %s" % (msg, hint))
    for line in report["info"]:
        print("note    " + line)
    if report["problems"]:
        print("FAIL %d problem(s) in %s (%d table fields)" % (len(report["problems"]), a.program, report["tables"]))
        return 1
    print("PASS %s (%d table fields)" % (a.program, report["tables"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
