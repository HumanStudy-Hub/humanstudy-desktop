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
  image table    a table of results that paper_tables.py finds (from its caption or, when the caption is
                 not in the text layer, from the sentences that mention it) with no rows in the text layer:
                 it is read from the rendered page, so a table field with its label must exist (a field
                 with state missing and an issue when it cannot be read), or sources/SOURCE.json
                 `paperTables` lists it as {"table": "1", "page": 10, "kind": "other" | "not-in-paper",
                 "what": "..."} (a design table; a supplementary table not in this PDF)
  sign loss      a number paper_tables.py lists under sign_loss (the page prints a minus the text layer
                 loses) recorded in a result field only without its minus, unless an evidence record for
                 that page has note "rendered page checked" or SOURCE.json `signChecks` lists
                 {"page", "value", "note": "rendered page checked"} (the page really prints it unsigned)
  impossible     values in result fields that cannot be printed: a CI whose lower limit is above its upper
                 one, an estimate outside its own CI, a p value outside 0-1 (usually a lost minus)

Numbers are compared as printed values; labels such as "Study 2", "Table 3", page numbers and years
are ignored. The checks are best effort: they find untranscribed numbers, they cannot prove that
every number is present. Standard library; the caption check reads the PDF like check_quotes.py, the image
table and sign checks with paper_tables.py (skipped, with a note, when it is not installed).
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

try:
    import paper_tables  # noqa: E402  tables without a text layer, lost minus signs
except ImportError:  # an older project folder without the helper
    paper_tables = None

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


FIGURE_CAPTION = re.compile(r"^\s*(?:FIGURE|Figure|FIG\.|Fig\.)\s*[0-9A-Z]")
# the column-aligned text may drop the space after "Table" ("TableA1")
LAYOUT_CAPTION = re.compile(r"^\s*(TABLE|Table)\s*([0-9]+[A-Za-z]?|[IVXL]+|[A-Z][0-9]*|S[0-9]+)\s*(?:[.:|—–-]|$|\s)")


def _starts(lines):
    return [i for i, l in enumerate(lines) if LAYOUT_CAPTION.match(l) or FIGURE_CAPTION.match(l)]


def table_section(text, key, following=""):
    """The lines of one table, never another table's rows.

    A page that prints only this table is read whole. On a page with several captions: when the first
    caption has table rows above it, captions sit below their tables and the table is the lines between
    the previous caption and its own; otherwise it is the lines from its caption to the next one, a
    caption at the foot of a page continuing on the next page (`following`) up to that page's first caption."""
    lines = (text or "").splitlines()
    starts = _starts(lines)
    own = [i for i in starts if LAYOUT_CAPTION.match(lines[i])
           and label_key("table " + LAYOUT_CAPTION.match(lines[i]).group(2)) == key]
    if not own:
        return "" if starts else text
    if len(starts) == 1:
        return text
    at = own[0]
    if len(grid_rows("\n".join(lines[:starts[0]]))) >= GRID_ROWS:   # captions below their tables
        before = [i for i in starts if i < at]
        return "\n".join(lines[(before[-1] + 1 if before else 0):at])
    stop = next((i for i in starts if i > at), None)
    if stop is not None:
        return "\n".join(lines[at:stop])
    nxt = (following or "").splitlines()
    return "\n".join(lines[at:] + nxt[:(_starts(nxt) or [len(nxt)])[0]])


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


# --------------------------------------------------------------------------- image tables, signs, impossible values

RENDER_HINT = ("run `python .opencode/skills/build/paper_tables.py paper.pdf --render .humanstudy/tmp/pages` and open "
               "the page images")
CI_KEY = re.compile(r"(?i)(^|[_\-.])(ci|ci\d{2}|conf(idence)?[_\- ]?int(erval)?)($|[_\-.])")
# Effect sizes a bare "ci" key in the same object most likely belongs to (not "value" or a mean).
ESTIMATE_KEYS = ("estimate", "d", "g", "h", "r", "f", "or", "rr", "b", "beta", "mean_diff", "mdiff",
                 "cohens_d", "cohens_h", "cohens_f", "hedges_g", "odds_ratio", "eta2", "eta_squared", "phi", "w", "v")
RATIO_KEYS = ("or", "rr", "odds_ratio", "risk_ratio", "hr")
CHECKED = "rendered page checked"


def source_record(root):
    try:
        data = json.loads((root / "sources/SOURCE.json").read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def image_tables(pdf_path, labels, already, record):
    """Tables of results with no text layer for their rows that no table field (or paperTables entry) covers."""
    out = []
    declared = {}
    for item in _lst(record.get("paperTables")):
        if isinstance(item, dict) and str(item.get("table", "")).strip():
            declared[label_key("table " + re.sub(r"(?i)^\s*table\s*", "", str(item["table"]).strip()))] = item
    for t in paper_tables.table_inventory(pdf_path):
        key = label_key("table " + t["table"])
        if not t["needs_page_image"] or key in labels or key in already:
            continue
        where = ("p. %d" % t["caption_page"] if t["caption_page"]
                 else "mentioned on p. " + ", ".join(map(str, t["mentioned_on"])))
        item = declared.get(key)
        if isinstance(item, dict) and item.get("kind") in ("other", "not-in-paper"):
            if len(re.findall(r"\w+", str(item.get("what", "")))) < 3:
                out.append(("sources/SOURCE.json paperTables %s: say in 'what' what the table holds" % key.title(),
                            "e.g. \"design of the four conditions, no results\" or \"in the supplement, not in this PDF\""))
            continue
        pages = paper_tables.pages_to_render(t)
        out.append(("%s (%s) has no rows in the PDF's text layer (drawn as graphics or an image), and no field holds "
                    "it as a table" % (key.title(), where),
                    "%s (pages %s), read the table from the picture and transcribe it cell by cell: a field with "
                    "value {\"table\": \"%s\", \"page\": <page>, \"columns\": [...], \"rows\": [[...]]}, origin verbatim, "
                    "evidence citing that page (a cell you cannot read is null and listed in uncertain; a table you "
                    "cannot read at all is state missing with an issue). Not a results table of this PDF: list it in "
                    "sources/SOURCE.json paperTables as {\"table\": \"%s\", \"page\": <page>, \"kind\": \"other\" | "
                    "\"not-in-paper\", \"what\": \"...\"}"
                    % (RENDER_HINT, ", ".join(map(str, pages)), key.title(), t["table"])))
    return out


def signed_numbers(value):
    """Every number in a value, with its sign (strings parsed as printed; U+2212 is a minus)."""
    out, stack = [], [value]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            stack.extend(v for k, v in item.items() if k not in ("page", "row", "column"))
        elif isinstance(item, list):
            stack.extend(item)
        elif isinstance(item, bool) or item is None:
            continue
        elif isinstance(item, (int, float)):
            out.append(float(item))
        elif isinstance(item, str):
            out += [float(t) for t in re.findall(r"(?<![\w.])-?(?:\d+\.\d+|\.\d+|\d+)", item.replace("−", "-"))]
    return out


def _same(x, printed):
    places = len(printed.split(".", 1)[1]) if "." in printed else 0
    return round(x, places) == round(float(printed), places)


def _dct(value):
    return value if isinstance(value, dict) else {}


def _lst(value):
    return value if isinstance(value, list) else []


def lost_signs(pdf_path, result_fields, evidence, record, paper_rel):
    recorded = [x for _, f in result_fields for x in signed_numbers(f.get("value"))]
    checked = {_dct(e.get("locator")).get("page") for e in evidence.values()
               if str(e.get("note", "")).strip().casefold() == CHECKED
               and (not e.get("path") or str(e.get("path")).removeprefix("./") == paper_rel)}
    checked = {c for c in checked if isinstance(c, int) and not isinstance(c, bool)}
    signed_checks = [c for c in _lst(record.get("signChecks")) if isinstance(c, dict)
                     and str(c.get("note", "")).strip().casefold() == CHECKED]
    lost = []
    for spot in paper_tables.sign_loss(pdf_path):
        reads = spot["reads"]
        if float(reads) == 0 or spot["page"] in checked:
            continue
        if any(c.get("page") == spot["page"] and (c.get("value") is None or _numeric(c.get("value"))
                                                  and _same(abs(float(c["value"])), reads)) for c in signed_checks):
            continue
        positive = any(x > 0 and _same(x, reads) for x in recorded)
        negative = any(x < 0 and _same(-x, reads) for x in recorded)
        if positive and not negative:
            lost.append("%s on p. %d (\"%s\")" % (spot["printed"], spot["page"], spot["context"]))
    if not lost:
        return []
    return [("the PDF prints %s with a minus sign that the text layer loses (a minus at a line end reads as a "
             "hyphen), and the result fields hold the number only without its sign" % "; ".join(lost[:6]),
             "%s, then record the value with the sign the page prints and set note \"rendered page checked\" on "
             "the evidence record for that page. When the page really prints it without a minus, add {\"page\": "
             "<page>, \"value\": <value>, \"note\": \"rendered page checked\"} to sources/SOURCE.json signChecks. "
             "Only after looking at the page" % RENDER_HINT)]


def _numeric(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _ci_pair(value):
    if isinstance(value, list) and len(value) == 2 and all(_numeric(x) for x in value):
        return float(value[0]), float(value[1])
    if isinstance(value, dict):
        lo = next((value[k] for k in ("lower", "lo", "low", "ll", "lcl") if k in value), None)
        hi = next((value[k] for k in ("upper", "hi", "high", "ul", "ucl") if k in value), None)
        if _numeric(lo) and _numeric(hi):
            return float(lo), float(hi)
    return None


def _outside(estimate, lo, hi, ratio=False):
    slack = 0.01 * abs(hi - lo) + 0.006
    if ratio and estimate > 0:
        import math  # a ratio may sit next to a CI on the log scale
        if lo - slack <= math.log(estimate) <= hi + slack:
            return False
    return estimate < lo - slack or estimate > hi + slack


def _impossible(name, value, out, depth=0):
    if depth > 8:
        return
    if isinstance(value, dict):
        cis = {k: _ci_pair(v) for k, v in value.items() if CI_KEY.search(str(k)) and _ci_pair(v)}
        for key, (lo, hi) in cis.items():
            if lo > hi + 1e-9:
                out.append("%s.%s = [%g, %g]: the lower limit is above the upper one" % (name, key, lo, hi))
                continue
            prefix = CI_KEY.split(str(key))[0].rstrip("_-.")
            candidates = [k for k, v in value.items() if _numeric(v)
                          and (k == prefix if prefix else str(k).lower() in ESTIMATE_KEYS)]
            if len(candidates) == 1 and _outside(float(value[candidates[0]]), lo, hi,
                                                 ratio=str(candidates[0]).lower() in RATIO_KEYS):
                out.append("%s: %s = %g lies outside its CI [%g, %g]" % (name, candidates[0], value[candidates[0]], lo, hi))
        for key, item in value.items():
            if isinstance(item, (dict, list)) and key not in cis:
                _impossible("%s.%s" % (name, key), item, out, depth + 1)
            if re.fullmatch(r"(?i)p(_value)?|pval", str(key)) and _numeric(item) and not 0 <= item <= 1:
                out.append("%s.%s = %g is not a probability" % (name, key, item))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            if isinstance(item, (dict, list)):
                _impossible("%s[%d]" % (name, index), item, out, depth + 1)


def impossible_values(result_fields):
    """CI lower > upper, an estimate outside its own CI, p outside 0-1 in result fields (not printed tables,
    whose cells are text as printed)."""
    found = []
    by_name = {where: f for where, f in result_fields}
    for where, f in result_fields:
        value = f.get("value")
        if is_table(value):
            continue
        if isinstance(value, dict):
            _impossible(where, value, found)
        if re.search(r"(?i)(^|[.\-_])p(-?value)?$", where) and _numeric(value) and not 0 <= value <= 1:
            found.append("%s = %g is not a probability" % (where, value))
        pair = _ci_pair(value)
        if pair is None:
            continue
        if pair[0] > pair[1] + 1e-9:
            found.append("%s = [%g, %g]: the lower limit is above the upper one" % (where, pair[0], pair[1]))
            continue
        base = re.sub(r"(?i)[_\-.]?ci\d{0,2}$", "", where)
        sibling = by_name.get(base) if base != where else None
        if sibling is not None and _numeric(sibling.get("value")) and _outside(float(sibling["value"]), *pair):
            found.append("%s = %g lies outside its CI %s [%g, %g]" % (base, sibling["value"], where, pair[0], pair[1]))
    return [("result fields hold impossible values: " + "; ".join(list(dict.fromkeys(found))[:6]),
             "a lost minus sign usually causes this: %s, check the number on the page and record it as printed"
             % RENDER_HINT)] if found else []


def check(program_path):
    program_path = Path(program_path).resolve()
    root = program_path.parent
    p = json.loads(program_path.read_text(encoding="utf-8"))
    # A malformed program never crashes the check: records of the wrong shape are left out (check_program.py
    # reports them), ids and evidence lists keep only strings.
    p = _dct(p)
    ids = lambda value: [i for i in _lst(value) if isinstance(i, str)]
    nodes = [dict(n, fields=[dict(f, evidenceIds=ids(f.get("evidenceIds"))) for f in _lst(n.get("fields"))
                             if isinstance(f, dict)], evidenceIds=ids(n.get("evidenceIds")))
             for n in _lst(p.get("nodes")) if isinstance(n, dict)]
    evidence = {e["id"]: e for e in _lst(p.get("evidence")) if isinstance(e, dict) and isinstance(e.get("id"), str)}
    out, info = [], []

    structured, tables = [], []   # numbers held by fields; (where, field) for table fields
    for n in nodes:
        for f in n.get("fields") or []:
            if not isinstance(f, dict):
                continue
            walk(f.get("value"), structured)
            if is_table(f.get("value")):
                tables.append(("%s.%s" % (n.get("id"), f.get("id")), f))
    for s in _lst(p.get("steps")):
        if isinstance(s, dict) and isinstance(s.get("rule"), dict):
            walk(s["rule"].get("value"), structured)
    try:
        effects = json.loads((root / "effects.json").read_text(encoding="utf-8"))
        for e in _lst(_dct(effects).get("effects")):
            walk(_dct(e).get("reported"), structured)
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    held = {round(x, 6) for x in structured}
    unheld = lambda xs: [x for x in xs if round(x, 6) not in held]

    for where, f in tables:
        out += table_problems(where, f)
    result_fields = [("%s.%s" % (n.get("id"), f.get("id")), f) for n in nodes if n.get("kind") == "result"
                     for f in n.get("fields") or [] if isinstance(f, dict)]
    out += impossible_values(result_fields)

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
                            % (eid, _dct(e.get("locator")).get("page"), len(nums), len(missing)),
                            "transcribe the table cell by cell into a table field that cites this evidence"))

    # printed table: captions on the paper's pages with no table field of that label
    labels = {label_key((f.get("value") or {}).get("table")) for _, f in tables}
    paper = _dct(p.get("source")).get("filename")
    paper = paper if isinstance(paper, str) and paper.strip() else None
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
            rows = grid_rows(table_section(layout_page(pdf_path, printed_on), label_key(v.get("table")),
                                          layout_page(pdf_path, printed_on + 1) if printed_on < len(pages) else ""))
            if len(rows) >= GRID_ROWS:
                out.append(("%s: %s is marked missing, but p. %d has a clean text layer with %d table rows in its "
                            "column-aligned text (e.g. %r)" % (where, v.get("table") or "the table", page, len(rows),
                                                               re.sub(r"\s+", " ", rows[0]).strip()[:80]),
                            "read it with `hs-pdf pages paper.pdf --from %d --to %d --layout` and transcribe it cell by "
                            "cell; a cell you cannot place is null and listed in uncertain. Never state that a text "
                            "layer is scrambled without reading the column-aligned text" % (printed_on, min(printed_on + 1, len(pages)))))
        if paper_tables is not None:
            record = source_record(root)
            already = {k for k in seen if k not in labels}   # reported above as a printed caption
            out += image_tables(pdf_path, labels, already, record)
            paper_rel = pdf_path.relative_to(root).as_posix() if root in pdf_path.parents else pdf_path.name
            out += lost_signs(pdf_path, result_fields, evidence, record, paper_rel)
        else:
            info.append("paper_tables.py is not installed: tables without a text layer and lost minus signs not checked")
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
