#!/usr/bin/env python3
"""Check that the paper's reported numbers are data, not only quoted text.

    python .opencode/skills/build/check_results.py program.json [--json report.json]

Prints every problem with a fix, then PASS or FAIL (exit 1). Checks:

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

  text results  the paper's text (from its first methods or results heading to a "References" heading): fails when
                more than half of its exact p values (six or more) or of its "x% vs y%", "n (x%)" and "k out of n"
                pairs are not recorded in a result field or effects.json `reported` (a statistic counts only with
                the p value printed after it), when the sample's sex or age is printed but no participants or
                result field holds it, and when a results paragraph prints four or more numbers none of which is
                recorded. Not counted: numbers after a citation, in a power analysis or a design probability
                governed by the words beside it ("with probability p = .8", "10 points with p = .25", "paid out
                with p = .8 or p = .2", "p = .3 of winning", "p = .5 in round 2" with no statistic before it in
                the sentence; never a bare "with"), a pair beside a chance word ("a 30% vs 70% chance") in a
                sentence not about what people chose or reported, a pair inside a printed quotation or in the
                project's participant text, a sex or age figure in a sentence that is not about the sample, rows of a table the text layer runs into the prose (and,
                on a page whose untranscribed table the printed-table check reports, number-dense passages), and
                numbers inside a sources/SOURCE.json `resultsNotRecorded` quote [{"page" (required), "quote"
                (exact text on that page), "reason"}]; a quote printing a test result (p =, <, >; t(df) =, F(..) =,
                chi-square(..) =, r(df) =; b, beta, d, z, OR or t = a number; a 95% CI) is refused unless the
                reason (text) names a power analysis, a design value or probability, a payoff, another study, a
                previous study's result, or a citation ("cited", "from Smith (2010)", "Smith et al.")
  abstract      every finding the abstract states is recorded: a result field or effect whose words carry it, or
                an entry of SOURCE.json `abstractResults` [{"claim" (the abstract's words), "recordedIn":
                ["<node>.<field>" | "effect:<id>"]} | {"claim", "notRecorded": "<why no statistic>"}]
  supplement    a PDF under sources/ other than the paper that prints numbered result tables ("Table S1"): each
                is a table field (value with "table" and "source": "<path>") holding its cells, or SOURCE.json
                `paperTables` lists it {"table": "S1", "source", "kind": "result", "recordedIn"} | kind "other"
                with "what"; {"source", "kind": "other", "what"} without "table" clears a whole file. A PDF under
                sources/private/ or sources/researcher/ is never exported: its tables are only listed (a
                reference entry {"table", "source", "page", "kind": "result"}), never required cell by cell

Numbers are compared as printed values; labels such as "Study 2", "Table 3", page numbers and years
are ignored. The checks are best effort: they find untranscribed numbers, they cannot prove that
every number is present. Older builds: image table, sign loss, impossible, text results, abstract and supplement
are problems only when the package checked (check(..., package=package/<slug>), as the readiness gate passes it;
from the command line, any package of the project) is built under the current contract (see contract.py);
otherwise they are printed as WARN lines and returned under "warnings", and the check still prints PASS. Standard
library; the caption check reads the PDF like check_quotes.py, the image table, sign, text, abstract and supplement
checks with paper_tables.py (skipped, with a note, when it is not installed).
"""
import argparse
import functools
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_quotes import Pdf  # noqa: E402  same PDF reader as the quote check (printed captions)
import contract  # noqa: E402  older packages get the newer rules as warnings

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


# --------------------------------------------------------------------------- results printed in the text
# Builds recorded the printed tables and dropped results the paper prints only in its text, the abstract's
# findings and the supplement's tables. Recorded means: a number in a result node's field, or in effects.json
# `reported` (sex and age also in a participants node).

P_EXACT = re.compile(r"(?<![\w.])[pP](?:'s)?\s*=\s*(0?\.\d+|1\.0+|\d\.\d+\s*[x×]\s*10\s*-\s*\d+)")
STAT_NUMBER = r"-?(?:\d+\.\d+|\.\d+|\d+)"
STATISTICS = [
    # coefficients and effect sizes: "coeff = 0.25", "b = -0.18", "OR = 4.30", "d = 0.42", "h = 0.71"
    ("estimate", re.compile(r"(?<![\w.])(?:coeff(?:icient)?|b|B|β|beta|estimate|OR|odds ratio|RR|d|g|h|r|ρ|rho|"
                            r"φ|phi|V|R2|R²|η2|η²|ηp2|ηp²|η\s*p\s*2)\s*=\s*(" + STAT_NUMBER + r")")),
    # t only with its df: a bare "t = 1" is usually a period or a design value
    ("test", re.compile(r"(?<![\w.])t\s*\(\s*\d+(?:\.\d+)?\s*\)\s*=\s*(" + STAT_NUMBER + r")")),
    ("test", re.compile(r"(?<![\w.])(?:z|U|W|H|Z)\s*(?:\(\s*\d+(?:\.\d+)?\s*\))?\s*=\s*(" + STAT_NUMBER + r")")),
    ("test", re.compile(r"(?<![\w.])F\s*\(\s*\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?\s*\)\s*=\s*(" + STAT_NUMBER + r")")),
    ("test", re.compile(r"(?:χ|χ2|χ²|chi-square|chi2|X2)\s*(?:2|²)?\s*\([^)=]{0,30}\)\s*=\s*(" + STAT_NUMBER + r")")),
    ("descriptive", re.compile(r"(?<![\w.])(?:M|SD|SE|S\.E\.|SEM|Mdn|mean|median|α|alpha)\s*=\s*(" + STAT_NUMBER + r")")),
    ("ci", re.compile(r"CI\s*[=:]?\s*[\[(]\s*(" + STAT_NUMBER + r")\s*[,;]\s*(" + STAT_NUMBER + r")\s*[\])]")),
    # "26% vs 18%", "45% versus 30%"; "12 out of the 16 options"; "85 (45.5%)"
    ("pair", re.compile(r"(\d+(?:\.\d+)?)\s?%\s*(?:vs\.?|versus|compared (?:with|to))\s*(\d+(?:\.\d+)?)\s?%")),
    ("pair", re.compile(r"(?<![\w.])(\d+)\s+out\s+of\s+(?:the\s+|all\s+)?(\d+)(?![\w.%])(?!\s+(?:\w+\s+)?"
                        r"(?:trials?|samples?|observations?|dividends?|rounds?|blocks?|algorithms?|models?|simulations?|"
                        r"draws?|times|runs?|iterations?|periods?)\b)")),
    ("pair", re.compile(r"(?<![\w.])(\d+)\s*\((\d+(?:\.\d+)?)\s?%\)")),
]
# the sample's make-up: "58 male / 222 female", "164 (52.7%) females", "59% males"; "mean age = 33.83",
# "Mage = 38.05, SD = 12.38"
SEX_STAT = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s?%?\s*(?:\(\s*(\d+(?:\.\d+)?)\s?%\s*\)\s*)?(?:were\s+|are\s+)?"
                      r"(?:male|female|men|women)s?\b")
AGE_STAT = re.compile(r"(?:(?i:mean|average)\s+age|\bM\s?age|\bage\s*\(?\s*M|\bMage)\s*(?:=|of|was|:)?\s*(\d+(?:\.\d+)?)"
                      r"(?:\s*(?:years|yrs)?\s*[,;(]?\s*(?:SD|s\.d\.)\s*=\s*(\d+(?:\.\d+)?))?")
# numbers just after these words are another study's result, a power analysis or a design value
NOT_OWN = re.compile(r"(?i)power|sensitivity|pilot|g\*power|meta-analy|previous (stud|research|work)|"
                     r"prior (stud|research|work)|et al\.?,? \(?\d{4}|\(\d{4}[a-z]?\)[^.]{0,60}(found|report|show)|"
                     r"\b(found|reported|showed) (that )?[^.]{0,40}\(\d{4}|"
                     r"et al\.?\s?\d{1,3}(?![\d.,]\d)")
# a design probability is governed directly by the words just before it: "(with) probability p = .3",
# "10 points with p = .25", "0 with p = .5", "paid out with p = .8"; never a bare "with" or a design word
# elsewhere in the sentence
DESIGN_P = re.compile(r"(?i)(?:(?:with|at)\s+(?:a\s+)?)?(?:probabilit(?:y|ies)(?: of)?|binomial,?)\s*$")
DESIGN_P_UNIT = re.compile(r"(?i)\d+(?:\.\d+)?\s*(?:points?|tokens?|ECU|cents?|dollars?|\$)\s+(?:with|at)\s*$")
DESIGN_P_NUMBER = re.compile(r"(?i)(?<![\w.=])\d+(?:\.\d+)?\s+(?:with|at)\s*$")
DESIGN_P_VERB = re.compile(r"(?i)\b(?:pays?|paid|pays? out|paid out|wins?|won|occurs?|occurred|drawn)\s+(?:with|at)\s*$")
# a statistic printed before the p in its sentence: the p is that test's
STAT_BEFORE = re.compile(r"(?<![\w.])(?:t|F|r|z|b|B|d|β|OR|χ2?|χ²|chi-square|chi2|X2)\s*(?:\([^)]{0,30}\))?\s*=|"
                         r"(?<![\w.])(?:t|F|r|χ2?|χ²|chi-square)\s*\(\s*\d")
# words after it: "p = .3 of winning"; and, with no statistic before it, "p = .5 in round 2"
DESIGN_P_OF = re.compile(r"(?i)^\s*of\s+(?:winning|losing|success|failure|a\s+(?:win|loss|gain|prize)|"
                         r"being\s+(?:drawn|chosen|selected|paid))")
DESIGN_P_AFTER = re.compile(r"(?i)^\s*,?\s*(?:in|on|for|at)\s+(?:each\s+|every\s+|the\s+)?(?:first\s+|second\s+|"
                            r"last\s+)?(?:rounds?|trials?|periods?|blocks?|games?|draws?)\b")
# "a 30% vs 70% chance", "50% vs 50% chances of winning": a design value, not a result ...
PAIR_CHANCE = re.compile(r"(?i)^\s*(?:chances?|probabilit\w*|odds|likelihood)\b|"
                         r"^\W*(?:[a-z]+\W+){0,3}?chances?\s+of\s+(?:winning|losing)\b")
# ... unless the sentence is about what people did ("62% vs 38% chance of choosing it was observed")
PAIR_OUTCOME = re.compile(r"(?i)\b(?:cho(?:se|sen|osing)|pick(?:ed|ing)|switch(?:ed|ing)|observed|reported|"
                          r"participants?|respondents?|subjects?|judged|rated|estimated)\b")
# the sample's make-up is the sample's only in a sentence about the people studied
SAMPLE_WORDS = re.compile(r"(?i)participants?|respondents?|subjects?|\bsamples?\b|students?|workers?|children|"
                          r"adults?|volunteers?|took part|participated|recruited|enrolled|(?<![\w.])[Nn]\s*=")
CITED = re.compile(r"\(\s*[A-Z][A-Za-z'’\-]+(?: et al\.?| (?:and|&) [A-Z][A-Za-z'’\-]+)?,? \d{4}[a-z]?\s*\)|"
                   r"[A-Z][A-Za-z'’\-]+(?: et al\.?| (?:and|&) [A-Z][A-Za-z'’\-]+)? \(\d{4}[a-z]?\)")
# where the paper's own empirical part begins
METHOD_HEADING = re.compile(
    r"(?im)^[ \t]*(?:\d+(?:\.\d+)*\.?[ \t]+)?(?:[A-Z][a-z]+[ \t]+){0,3}(?:methods?|design|procedures?|participants|"
    r"materials|(?:experiment|study)[ \t]+(?:\d|one|I\b)|results)\b[^\n]{0,50}$")
SECTION_HEADING = re.compile(r"^\s*\d+(?:\.\d+)*\.?\s+[A-Z][^.]{0,60}$")
REFERENCES = re.compile(r"(?im)^[ \t]*(?:(?:\d{1,2}|[IVX]{1,4})\.?[ \t]+)?(references(?:[ \t]+and[ \t]+notes)?|"
                        r"bibliography|literature[ \t]+cited|works[ \t]+cited)[ \t]*$")
ABSTRACT = re.compile(r"(?im)^\s*(abstract|summary)\b[.:]?\s*")
ABSTRACT_END = re.compile(r"(?im)^\s*(keywords?|key words|(?:1\.?\s+)?introduction|significance|public significance|"
                          r"jel)\b")
FINDING = re.compile(
    r"(?i)\b(we (?:also )?(?:find|found|show|showed|observe[ds]?|demonstrate[ds]?|replicat\w+)|results? "
    r"(?:show|showed|indicate[ds]?|reveal(?:ed)?|suggest(?:ed)?|support(?:ed)?)|(?:more|less) likely|"
    r"(?:positively|negatively) (?:correlated|related|associated)|correlat\w+ with|significant(?:ly)? (?:\w+ )?"
    r"(?:more|less|higher|lower|greater|smaller|larger|different|associated|correlated|related|effects?|"
    r"differences?|predict\w*|increase\w*|decrease\w*|interaction)|(?:higher|lower|greater|larger|smaller) than|"
    r"increased|decreased|(?:was|were) (?:not )?(?:replicated|found|observed)|"
    r"(?:associated|related) (?:with|to)|(?:less|more) (?:evident|common|frequent|often)|fail(?:ed)? to (?:find|replicate|observe)|"
    r"results? (?:also )?(?:suggest|support)|(?:found|find) (?:strong |weak |no |little |some )?(?:empirical )?"
    r"(?:support|evidence)|no (?:significant |reliable )?(?:effect|difference|evidence|association))\b")
# a sentence about earlier work, the method or the paper's aim, not one of its findings (unless it says "we found")
BACKGROUND = re.compile(r"(?i)\b(previous(?:ly)?|prior (?:work|research|stud\w+)|so far|literature|little is known|"
                        r"it is (?:thought|believed|known)|remains? (?:unclear|unknown)|has been|have been|"
                        r"in this (?:approach|paper|article|study)|we (?:use|define|propose|introduce|present|develop|"
                        r"apply|ask|employ)\b)")
OWN_FINDING = re.compile(r"(?i)\bwe (?:also )?(?:find|found|show|showed|observe[ds]?|demonstrate[ds]?)\b|\bresults? "
                         r"(?:show|showed|indicate[ds]?|reveal(?:ed)?)\b")
GENERIC = set("""participants subjects people result results finding findings found find show showed shows effect effects
significant significantly study studies experiment experiments evidence data analysis analyses paper human humans
using also however suggest suggests suggesting""".split())
ENUMERATION = re.compile(r"\((?:i{1,3}|iv|v|vi{1,3}|[1-9]|[a-f])\)\s+")
STOP = set("""a an the and or but nor of to in on at for with by from as is are was were be been being that this
these those than then it its we our us they their there here which who whom whose what when where how not no
both either neither each every all any some such more less most least very also only even just so too can could
may might will would shall should do does did done have has had having into onto over under between among about
across after before during while if whether because since though although via per vs versus i ii iii iv v vi""".split())
PASSAGE_MIN = 4   # numbers in a results passage before "none recorded" fails
P_SHARE = 0.5     # share of the text's exact p values (and of its pairs) that must be recorded
# a test result printed in a quote: a p value (=, <, >), t(df) =, F(df1, df2) =, chi-square(df) =, r(df) =,
# b / beta / d / z / OR / t = a number, a 95% CI
QUOTE_TEST = re.compile(r"(?<![\w.])[pP]\s*(?:=|<|>|≤|≥|<=|>=)\s*(?:0?\.\d+|1\.0+)|"
                        r"(?<![\w.])(?:b|β|d|z|OR|t)\s*=\s*-?(?:\d+(?:\.\d+)?|\.\d+)|95\s?%\s*CI|(?<![\w.])t\s*\(\s*\d[^)]{0,12}\)\s*=|"
                        r"(?<![\w.])F\s*\(\s*\d[^)]{0,20}\)\s*=|(?:χ|χ2|χ²|chi-square|chi2|X2)\s*(?:2|²)?\s*\([^)]{0,30}\)\s*=|"
                        r"(?<![\w.])r\s*\(\s*\d[^)]{0,12}\)\s*=")
# a reason that says the quoted test is not this paper's result
NOT_OWN_REASON = re.compile(r"(?i)design (?:value|probabilit)|pay-?offs?\b|power analys|sensitivity analys|"
                            r"meta-analy|another (?:study|paper|article|experiment)|"
                            r"(?:previous|earlier|prior|original|other) (?:study|paper|article)'s result|"
                            r"\bcit(?:ed|ation)\b|\bfrom [A-Z][A-Za-z'\-]+(?: et al\.?)? \(\d{4}[a-z]?\)|"
                            r"\b[A-Z][A-Za-z'\-]+ et al\b")
P_KEY = re.compile(r"(?i)^p$|^p[_\-. ]|[_\- ]p$|[_\- ]p[_\- ]|p_?val|pvalue|^p\d$|p_printed|^ptext$|^sig(nif\w*)?\.?$|"
                   r"^pr$|^pr\s*\(|^pr_|_sig$")
P_TEXT = re.compile(r"(?i)(?<![\w.])p(?:'s)?(?:\s*(?:=|<|>|≤|≥|<=|>=)|[\- ]values?\s*(?:=|<|>|:)?)\s*(0?\.\d+|1(?:\.0+)?)")
SEX_WORDS = re.compile(r"(?i)sex|gender|male|female|\bm[ae]n\b|wom[ae]n|girls?|boys?")
AGE_WORDS = re.compile(r"(?i)(?<![a-z])age(?![a-z])|_age|age_|years? old")
TOKEN = re.compile(r"-?(?:\d+\.\d+|\.\d+|\d+)")
COVERAGE_FIX = ("record each result the paper prints with its statistic, p value, SE and n in a result field (a "
                "table field built from the text when there are several), with state missing or an issue when the "
                "replay cannot compute it. A passage that holds no result of this paper (a payoff or design value, "
                "a power analysis, another study's result) goes in sources/SOURCE.json resultsNotRecorded as "
                "{\"page\": <page>, \"quote\": \"<its exact text>\", \"reason\": \"...\"}; never list a result there")


def _norm(text):
    text = (text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("–", "-")
            .replace("—", "-").replace("−", "-").replace(" ", " ").replace(" ", " ").replace(" ", " "))
    return re.sub(r"[ \t]+", " ", text.replace("­", ""))


def _dehyphen(text):
    return re.sub(r"(?<=[a-z])-\n(?=[a-z])", "", text)


def _flat(text):
    return re.sub(r"\s+", " ", _norm(_dehyphen(text))).strip().casefold()


def _squash(text):
    """Text without spaces or hyphens: text layers split words ("W e") and break them at soft hyphens."""
    return re.sub(r"[\s\-]+", "", _norm(text)).casefold()


def _snippet(text, limit=70):
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + " ..."


def _blocks(text):
    """Paragraphs of one page. pdftotext separates them with blank lines; pypdf (what check_quotes.py reads)
    does not, so a paragraph also ends at a heading and after a short line that ends a sentence."""
    lines = [l.strip() for l in text.splitlines()]
    full = sorted(len(l) for l in lines if len(l) >= 30)
    typical = full[len(full) // 2] if full else 80
    out, current = [], []
    for line in lines:
        if not line:
            if current:
                out.append(current)
            current = []
            continue
        heading = (len(line) < 70 and not line.endswith((".", ",", ";")) and
                   (METHOD_HEADING.match(line) or SECTION_HEADING.match(line)))
        if heading and current:
            out.append(current)
            current = []
        current.append(line)
        if heading or (re.search(r"[.!?:][)\"']?$", line) and len(line) < 0.8 * typical):
            out.append(current)
            current = []
    if current:
        out.append(current)
    return [re.sub(r"\s+", " ", " ".join(b)).strip() for b in out if " ".join(b).strip()]


def passages(pages):
    """Paragraph-sized passages of the paper's own empirical part (from the page of the first methods or
    results heading, before the references), with their page."""
    out, started = [], False
    for index, raw in enumerate(pages):
        text = _norm(_dehyphen(raw or ""))
        if not started:
            # the whole page of the first methods heading: the text layer may put it after its paragraphs
            heading = METHOD_HEADING.search(text) if index else None
            if heading is None:
                continue
            started = True
            # a references heading ends the empirical part only after it has begun (on this page, after the
            # heading), so a "References" line in the front matter cuts nothing
            refs = REFERENCES.search(text, heading.end())
        else:
            refs = REFERENCES.search(text)
        if refs:
            text = text[:refs.start()]
        out += [{"page": index + 1, "text": b} for b in _blocks(text)]
        if refs:
            break
    if not started:  # no heading found: every page after the first
        for index, raw in enumerate(pages[1:], start=1):
            out += [{"page": index + 1, "text": b} for b in _blocks(_norm(_dehyphen(raw or "")))]
    return out


def _own(text, start):
    """A number is the paper's own result unless the words just before it, in its sentence, cite another
    study or a power analysis."""
    before = text[max(0, start - 400):start]
    sentences = list(re.finditer(r"(?<!\bal)(?<!\be\.g)(?<!\bi\.e)\.\s+(?=[A-Z(])", before))
    if sentences:
        before = before[sentences[-1].end():]
    return not NOT_OWN.search(before) and not CITED.search(before[-60:])


PEOPLE = re.compile(r"(?i)participants?|subjects?|respondents?|people|persons?|children|adults|students|men\b|women|"
                    r"players?|chose|chosen|selected|answered|reported|preferred|agreed|judged|rated|guessed|correct")


def _design_p(text, m, previous_design=None):
    """A p = ... that is a design probability, governed directly by the words just before it ("with probability
    p = .3", "10 points with p = .25", "paid out with p = .8", "or p = .2" after one of those) or after it
    ("p = .3 of winning"; "p = .5 in round 2" when no statistic comes before it in the sentence)."""
    before = text[max(0, m.start() - 200):m.start()]
    stop = max(before.rfind(". "), before.rfind("; "))
    before = before[stop + 1:] if stop >= 0 else before
    stat = STAT_BEFORE.search(before)
    if DESIGN_P.search(before[-40:]) or DESIGN_P_UNIT.search(before[-40:]) or DESIGN_P_VERB.search(before[-40:]):
        return True
    if not stat and DESIGN_P_NUMBER.search(before[-40:]):
        return True
    # "with p = .80 or p = .20": the second is governed like the first
    if previous_design is not None and re.fullmatch(r"\s*,?\s*(?:or|and)?\s*", text[previous_design:m.start()]):
        return True
    if DESIGN_P_OF.match(text[m.end():m.end() + 40]):
        return True
    return not stat and bool(DESIGN_P_AFTER.match(text[m.end():m.end() + 40]))


def _quoted(text, at):
    """`at` is inside a quotation printed in the passage: double quotes, or single quotes opened after a colon."""
    for opener, closer in (('"', '"'), ("'", "'")):
        start = text.rfind(opener, max(0, at - 400), at)
        if start < 0 or (opener == "'" and not re.search(r":\s*$", text[max(0, start - 3):start])):
            continue
        if opener == '"' and text.count('"', max(0, at - 400), start) % 2:
            continue                  # that mark closes an earlier quotation
        if text.find(closer, at) >= 0:
            return True
    return False


def _around(text, start, end):
    """The sentence holding text[start:end] and the one before it."""
    left = text.rfind(". ", 0, start)
    left = text.rfind(". ", 0, left) if left > 0 else -1
    right = text.find(". ", end)
    return text[left + 1:right if right >= 0 else len(text)]


def _sentence(text, start, end):
    left = max(text.rfind(". ", 0, start), text.rfind("; ", 0, start))
    right = min([i for i in (text.find(". ", end), text.find("; ", end)) if i >= 0] or [len(text)])
    return text[left + 1:right]


def statistics_in(text):
    """Every result number in a passage: kind, value as printed, offset, and a group id for numbers printed
    together ("26% vs 18%")."""
    found, seen = [], set()
    design_end = None
    for m in P_EXACT.finditer(text):
        if _design_p(text, m, design_end):
            design_end = m.end()
            continue
        if "x" in m.group(1) or "×" in m.group(1):
            continue
        if _own(text, m.start()):
            found.append({"kind": "p", "value": m.group(1), "at": m.start(1), "group": None})
            seen.add(m.start(1))
    for kind, pattern in [("sex", SEX_STAT), ("age", AGE_STAT)] + STATISTICS:
        for m in pattern.finditer(text):
            if not _own(text, m.start()):
                continue
            # a coding ("gender (1 = female, 0 = male)") is not the sample's make-up
            if kind == "sex" and (m.group(1) in ("0", "1") or re.search(
                    r"(?i)(cod(ed|ing)|dummy|[=:]|\b[01]\s*[=:5]?)\s*$", text[max(0, m.start() - 14):m.start()])):
                continue
            # "4 out of 11 algorithms": an "out of" count is a result only in a sentence about people's answers
            if kind == "pair" and " out of " in m.group(0) and not PEOPLE.search(_sentence(text, m.start(), m.end())):
                continue
            # "in 2019 (45%)": a year, not a count
            if kind == "pair" and YEAR.fullmatch(m.group(1) or ""):
                continue
            # "a 30% vs 70% chance of winning": a design value
            if kind == "pair" and "%" in m.group(0) and PAIR_CHANCE.match(text[m.end():m.end() + 40]) and \
                    not PAIR_OUTCOME.search(_sentence(text, m.start(), m.end())):
                continue
            # "Participants read: 'Option A gives 30% vs 70% ...'": the instrument, quoted
            if kind == "pair" and _quoted(text, m.start()):
                continue
            # "the town's population is 48% male": the make-up of a sample only in a sentence about the sample
            if kind in ("sex", "age") and not SAMPLE_WORDS.search(_around(text, m.start(), m.end())):
                continue
            # a row of a table the text layer runs into the prose ("Choose A 64 (80%) Choose B 16 (20%)")
            window = text[max(0, m.start() - 50):m.end() + 50]
            if kind in ("pair", "descriptive") and len(TOKEN.findall(window)) >= 5 and \
                    len(TOKEN.findall(window)) >= len(re.findall(r"[A-Za-z]{3,}", window)) and "=" not in window:
                continue
            values = [(m.group(g), m.start(g)) for g in range(1, (pattern.groups or 0) + 1) if m.group(g) is not None]
            values = [(v, s) for v, s in values if s not in seen]
            if not values:
                continue
            group = "%s@%d" % (kind, m.start()) if len(values) > 1 else None
            for value, start in values:
                seen.add(start)
                found.append({"kind": kind, "value": value, "at": start, "group": group})
    return sorted(found, key=lambda s: s["at"])


def _add(keys, number):
    """A recorded number as printed at 0-4 decimals, and as a share or percentage (0.26 is the paper's 26%)."""
    if number != number or number in (float("inf"), float("-inf")):
        return
    for places in range(0, 5):
        keys.add("%.*f" % (places, abs(number)))
    if 0 < abs(number) <= 1:
        for places in range(0, 3):
            keys.add("%.*f" % (places, abs(number) * 100))
    if 1 < abs(number) <= 100:
        for places in range(0, 5):
            keys.add("%.*f" % (places, abs(number) / 100))


def _add_text(keys, text):
    for token in TOKEN.findall(_norm(text)):
        _add(keys, float(token))


def is_recorded(value, keys):
    value = value.strip()
    places = len(value.split(".", 1)[1]) if "." in value else 0
    try:
        return "%.*f" % (places, abs(float(value))) in keys
    except ValueError:
        return True


def _plain(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def recorded_values(program, effects, kinds=("result",)):
    """(context, value) of everything recorded: the fields of result nodes (context: field id and label) and
    each effects.json `reported` (context: the effect id)."""
    out = []
    for n in program.get("nodes") or []:
        if isinstance(n, dict) and n.get("kind") in kinds:
            for f in n.get("fields") or []:
                if isinstance(f, dict):
                    out.append(("%s %s" % (f.get("id", ""), f.get("label", "")), f.get("value")))
    for e in (effects or {}).get("effects") or []:
        if isinstance(e, dict) and isinstance(e.get("reported"), dict):
            out.append(("", {k: v for k, v in e["reported"].items() if k not in ("evidenceIds", "missing")}))
    return out


def recorded_keys(values):
    keys, stack = set(), [v for _, v in values]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            stack.extend(v for k, v in item.items() if k not in ("page", "row", "column", "evidenceIds"))
        elif isinstance(item, list):
            stack.extend(item)
        elif _plain(item):
            _add(keys, float(item))
        elif isinstance(item, str):
            _add_text(keys, item)
    return keys


def recorded_p_keys(values):
    """p values recorded: numbers under a p key ("p", "p_value", a table column "p"), and numbers after
    "p =" / "p <" in recorded strings."""
    keys, stack = set(), [(c.split(" ")[0], v) for c, v in values]
    while stack:
        key, item = stack.pop()
        if isinstance(item, dict):
            stack.extend((str(k), v) for k, v in item.items())
            # {"columns": ["", "b", "SE", "p"], "rows": [["x", "0.25", "0.1", ".048"]]}: a column names its cells
            columns, rows = item.get("columns"), item.get("rows")
            if isinstance(columns, list) and isinstance(rows, (list, dict)):
                for row in rows.values() if isinstance(rows, dict) else rows:
                    cells = row.get("cells", row.get("values")) if isinstance(row, dict) else row
                    if isinstance(cells, list) and len(cells) >= len(columns) - 1:
                        offset = len(cells) - len(columns)
                        for i, column in enumerate(columns):
                            if 0 <= i + offset < len(cells):
                                stack.append((str(column).split("/")[-1].strip(), cells[i + offset]))
        elif isinstance(item, list):
            stack.extend((key, v) for v in item)
        elif _plain(item):
            if P_KEY.search(key):
                _add(keys, float(item))
        elif isinstance(item, str):
            if P_KEY.search(key):
                for token in re.findall(r"(?:\d+\.\d+|\.\d+|\d+)", item):
                    _add(keys, float(token))
            for m in P_TEXT.finditer(_norm(item)):
                _add(keys, float(m.group(1)))
    return keys


def recorded_sample_keys(program, effects):
    """Numbers recorded about the sample's sex and age, in result or participants nodes: under a key, field id
    or label that names it, or in a string that does."""
    found = {"sex": set(), "age": set()}
    stack = list(recorded_values(program, None, kinds=("result", "participants")))
    while stack:
        context, item = stack.pop()
        if isinstance(item, dict):
            stack.extend(("%s %s" % (context, k), v) for k, v in item.items())
        elif isinstance(item, list):
            stack.extend((context, v) for v in item)
        elif _plain(item) or isinstance(item, str):
            text = item if isinstance(item, str) else ""
            numbers_ = [float(item)] if _plain(item) else [float(t) for t in TOKEN.findall(_norm(item))]
            for kind, words in (("sex", SEX_WORDS), ("age", AGE_WORDS)):
                if words.search(context) or words.search(text):
                    for x in numbers_:
                        _add(found[kind], x)
    return found


def recorded_groups(values):
    """Numbers recorded together: each object's own numbers (and its strings' numbers), each string's numbers,
    and an effect's cells. "26% vs 18%" or "164 (52.7%)" is recorded when both numbers sit in one of these."""
    groups, stack = [], [v for _, v in values]
    for _, v in values:
        if isinstance(v, dict) and isinstance(v.get("cells"), dict):
            groups.append(recorded_keys([("", v["cells"])]))   # the arms of one effect: "72% vs 28%"
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            group = set()
            _add_text(group, item)
            groups.append(group)
            continue
        if not isinstance(item, (dict, list)):
            continue
        group = set()
        for child in (item.values() if isinstance(item, dict) else item):
            if _plain(child):
                _add(group, float(child))
            elif isinstance(child, str):
                _add_text(group, child)
            elif isinstance(child, (dict, list)):
                stack.append(child)
        groups.append(group)
    return groups


def _skipped(record, pages):
    """resultsNotRecorded passages ([(page, flattened quote)]) whose quotes occur in the paper, and problems."""
    items = record.get("resultsNotRecorded")
    if items is None:
        return [], []
    if not isinstance(items, list):
        return [], [("sources/SOURCE.json resultsNotRecorded must be a list",
                     'write [{"page": 4, "quote": "<the passage as printed>", "reason": "..."}]')]
    whole = _flat(" ".join(pages))
    spans, problems = [], []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            problems.append(("sources/SOURCE.json resultsNotRecorded[%d] is not an object" % i,
                             'write {"page": 4, "quote": "<the passage as printed>", "reason": "..."}'))
            continue
        quote = _flat(str(item.get("quote", "")))
        page = item.get("page")
        reason = item.get("reason", "")
        if len(quote) < 12 or quote not in whole:
            problems.append(("sources/SOURCE.json resultsNotRecorded[%d]: the quote is not the passage's exact text in "
                             "the paper" % i, "copy the passage as printed (at least a few words)"))
        elif isinstance(page, bool) or not isinstance(page, int) or not 1 <= page <= len(pages) or \
                quote not in _flat((pages[page - 1] or "") + " " + (pages[page] or "" if page < len(pages) else "")):
            problems.append(("sources/SOURCE.json resultsNotRecorded[%d]: give the page the quote is printed on "
                             "(\"page\": <number>)" % i, "each entry names the one page whose passage it clears"))
        elif not isinstance(reason, str):
            problems.append(("sources/SOURCE.json resultsNotRecorded[%d]: the reason must be text" % i,
                             'write "reason": "<why the passage holds no result of this paper>"'))
        elif len(re.findall(r"\w+", reason)) < 3:
            problems.append(("sources/SOURCE.json resultsNotRecorded[%d]: no reason" % i,
                             "say why the passage holds no result of this paper (a payoff or design value, a power "
                             "analysis, another study's result)"))
        elif QUOTE_TEST.search(_plain_text(item.get("quote", ""))) and not NOT_OWN_REASON.search(reason):
            problems.append(("sources/SOURCE.json resultsNotRecorded[%d]: the quote prints a test result (%s), which is "
                             "this paper's result unless the reason says otherwise"
                             % (i, QUOTE_TEST.search(_plain_text(item.get("quote", ""))).group(0)),
                             "record the result; list the passage only when it is a power analysis, a design or payoff "
                             "value, another study's or paper's result, or a citation, and say which in the reason"))
        else:
            spans.append((page, quote))
    return spans, problems


def _plain_text(text):
    return re.sub(r"\s+", " ", _norm(_dehyphen(str(text))))


@functools.lru_cache(maxsize=256)
def _quote_pattern(quote):
    return re.compile(r"\s+".join(re.escape(w) for w in quote.split(" ")), re.I)


def _in_skipped(passage, stat, spans):
    """The statistic lies inside the printed span of a resultsNotRecorded quote on the passage's page (or the
    quote holds the whole passage)."""
    if not spans:
        return False
    text = passage["text"]
    at, end = stat["at"], stat["at"] + len(stat["value"])
    for page, quote in spans:
        if page != passage["page"]:
            continue
        if _flat(text) in quote:
            return True
        pattern = _quote_pattern(quote)
        if any(m.start() <= at and end <= m.end() for m in pattern.finditer(text)):
            return True
    return False


def _nonzero(value):
    try:
        return float(value) != 0
    except ValueError:
        return False


def text_coverage(pages, program, effects, spans, material="", table_pages=()):
    """The paper's text statistics, each marked recorded or not. material: participant text (flattened) the
    project holds; a pair printed in it is the instrument, not a result. table_pages: pages whose untranscribed
    table another check already reports; a table-like passage there is that table's rows, not counted twice."""
    values = recorded_values(program, effects)
    keys, p_keys, groups = recorded_keys(values), recorded_p_keys(values), recorded_groups(values)
    sample_keys = recorded_sample_keys(program, effects)
    report = {"p": [], "pairs": [], "sample": [], "passages": []}
    for passage in passages(pages):
        # a line of a table in the text layer ("53 (66%) 27 (34%)") is the table checks' business
        word_count = len(re.findall(r"[A-Za-z]{3,}", passage["text"]))
        if word_count < 5:
            continue
        if passage["page"] in table_pages and (len(TOKEN.findall(passage["text"])) * 3 >= word_count or
                                               CAPTION.search(passage["text"])):
            continue
        stats = [s for s in statistics_in(passage["text"]) if _nonzero(s["value"]) and not _in_skipped(passage, s, spans)]
        if material:
            stats = [s for s in stats if not (s["kind"] == "pair" and _in_material(passage["text"], s, stats, material))]
        if not stats:
            continue
        for s in stats:
            s["recorded"] = is_recorded(s["value"], p_keys if s["kind"] == "p" else sample_keys.get(s["kind"], keys))
            s["page"], s["context"] = passage["page"], _snippet(passage["text"][max(0, s["at"] - 30):s["at"] + 40])
        by_group = {}
        for s in stats:
            if s["group"] and s["kind"] not in sample_keys:
                by_group.setdefault(s["group"], []).append(s)
        for members in by_group.values():   # numbers printed together are recorded together
            together = any(all(is_recorded(m["value"], g) for m in members) for g in groups)
            for m in members:
                m["recorded"] = together
        # a statistic and the p value printed right after it ("coeff = 0.25, p = 0.048") are one result
        for first, second in zip(stats, stats[1:]):
            if first["kind"] not in ("p", "sex", "age", "pair") and second["kind"] == "p" \
                    and second["at"] - first["at"] <= 40 and not second["recorded"]:
                first["recorded"] = False
        report["p"] += [s for s in stats if s["kind"] == "p"]
        report["pairs"] += _one_per_group([s for s in stats if s["kind"] == "pair"])
        report["sample"] += _one_per_group([s for s in stats if s["kind"] in ("sex", "age")])
        report["passages"].append({"page": passage["page"], "text": passage["text"], "stats": stats})
    return report


def _in_material(text, stat, stats, material):
    """The pair (both its numbers, as printed together) is in the participant text the project holds."""
    members = [s for s in stats if s["group"] and s["group"] == stat["group"]] or [stat]
    start, last = members[0]["at"], members[-1]
    printed = _flat(text[start:last["at"] + len(last["value"]) + 1])
    return len(printed) >= 4 and printed in material


def material_text(root):
    """Participant text the project holds (materials.json, verbatim program fields), flattened."""
    try:
        from docx_text import participant_texts
        return _flat(" \n ".join(t for _, t in participant_texts(root)))
    except Exception:   # noqa: BLE001 - an unreadable record holds no material
        return ""


def _one_per_group(stats):
    seen, out = set(), []
    for s in stats:
        key = s["group"] or id(s)
        if key not in seen:
            seen.add(key)
            out.append(s)
    return out


def text_problems(report):
    out = []
    ps = report["p"]
    absent = [p for p in ps if not p["recorded"]]
    if len(ps) >= 6 and len(absent) > len(ps) * P_SHARE:
        out.append(("only %d of the %d exact p values the paper's text prints are recorded in result fields or "
                    "effects.json (missing e.g. %s)" % (len(ps) - len(absent), len(ps), ", ".join(
                        "p = %s (p. %d)" % (p["value"], p["page"]) for p in absent[:6])),
                    "record each text statistic with its p value (coefficient, test, effect size, SE, n), not only "
                    "the tables; " + COVERAGE_FIX))
    pairs = report["pairs"]
    absent = [p for p in pairs if not p["recorded"]]
    if len(pairs) >= 3 and len(absent) > len(pairs) * P_SHARE:
        out.append(("only %d of the %d counts and percentage comparisons the paper's text prints (\"26%% vs 18%%\", "
                    "\"12 out of 16\", \"85 (45.5%%)\") are recorded together in one result field (missing e.g. %s)"
                    % (len(pairs) - len(absent), len(pairs),
                       "; ".join("p. %d \"%s\"" % (p["page"], p["context"]) for p in absent[:5])),
                    "record each with both numbers in one field (or one effect's cells); " + COVERAGE_FIX))
    for kind, words in (("sex", "sex or gender"), ("age", "age")):
        printed = [s for s in report["sample"] if s["kind"] == kind]
        if printed and not any(s["recorded"] for s in printed):
            out.append(("the paper reports its sample's %s (%s) but no participants or result field records it"
                        % (words, "; ".join("p. %d \"%s\"" % (s["page"], s["context"]) for s in printed[:3])),
                        "record the sample's make-up per study (counts, percentages, mean and SD) in the participants "
                        "node's `characteristics` field or a result field, as printed"))
    dropped = []
    for passage in report["passages"]:
        stats = passage["stats"]
        if len(stats) >= PASSAGE_MIN and any(s["kind"] in ("p", "estimate", "test", "ci") for s in stats) \
                and not any(s["recorded"] for s in stats):
            dropped.append("p. %d \"%s\" (%d numbers, e.g. %s)" % (passage["page"], _snippet(passage["text"]),
                                                                   len(stats), ", ".join(s["value"] for s in stats[:5])))
    if dropped:
        out.append(("these results passages print numbers none of which is recorded in a result field or effects.json: "
                    + "; ".join(dropped[:6]) + ("; and %d more" % (len(dropped) - 6) if len(dropped) > 6 else ""),
                    COVERAGE_FIX))
    return out


def abstract_text(pages):
    """The abstract: after an 'Abstract' heading on the first two pages, up to the keywords or the
    introduction; else the longest paragraph of page 1 before them. Empty when it cannot be found."""
    for raw in pages[:2]:
        text = _norm(_dehyphen(raw or ""))
        start = ABSTRACT.search(text)
        if start is None:
            continue
        rest = text[start.end():]
        end = ABSTRACT_END.search(rest)
        body = re.sub(r"\s*\n\s*", " ", rest[:end.start()] if end else rest[:2500]).strip()
        if len(body.split()) >= 40:
            return body[:4000]
    if pages:
        text = _norm(_dehyphen(pages[0] or ""))
        end = ABSTRACT_END.search(text)
        if end is not None:
            longest = max(_blocks(text[:end.start()]) or [""], key=lambda b: len(b.split()))
            if len(longest.split()) >= 80:
                return longest[:4000]
    return ""


def _words(text):
    return {w for w in re.findall(r"[a-z][a-z'\-]+", text.casefold()) if w not in STOP and len(w) > 2}


def abstract_findings(abstract):
    """Each sentence of the abstract with a result cue, split at an enumeration ("(i) ..., (ii) ...")."""
    findings = []
    for sentence in re.split(r"(?<=[.!?])\s+(?=[A-Z(])", abstract):
        parts = [p for p in ENUMERATION.split(sentence) if p.strip()]
        if len(parts) > 1 and (not FINDING.search(parts[0]) or parts[0].rstrip().endswith(":")):
            parts = parts[1:]   # the lead-in ("We found three major results:") is not a finding of its own
        parts = [re.sub(r"(?i)[\s,;]+(?:and|or)$", "", p.strip(" ;,")) for p in parts]
        findings += [p for p in parts if FINDING.search(p) and len(_words(p)) >= 3
                     and (OWN_FINDING.search(p) or not BACKGROUND.search(p))]
    return findings


def _target_text(program, effects, name):
    """Words a recordedIn target carries ("<node id>.<field id>" or "effect:<id>"): ids, labels, values and
    the quotes of the evidence it cites; None when it does not exist."""
    evidence = {e.get("id"): e for e in program.get("evidence") or [] if isinstance(e, dict)}
    parts, cited = None, []
    if name.startswith("effect:"):
        for e in (effects or {}).get("effects") or []:
            if isinstance(e, dict) and e.get("id") == name[7:]:
                parts = [json.dumps({k: v for k, v in e.items() if k != "compute"}, ensure_ascii=False)]
                cited = list((e.get("reported") or {}).get("evidenceIds") or [])
    else:
        nodes = {n.get("id"): n for n in program.get("nodes") or [] if isinstance(n, dict)}
        for at in [m.start() for m in re.finditer(r"\.", name)]:
            node = nodes.get(name[:at])
            field = next((f for f in (node or {}).get("fields") or [] if isinstance(f, dict)
                          and f.get("id") == name[at + 1:]), None)
            if field is not None:
                parts = [str(node.get("id")), str(node.get("label", "")), str(field.get("id")),
                         str(field.get("label", "")), json.dumps(field.get("value"), ensure_ascii=False)]
                cited = list(field.get("evidenceIds") or [])
                break
    if parts is None:
        return None
    parts += [str((evidence.get(i) or {}).get("quote", "")) for i in cited]
    return re.sub(r"[_\-.]", " ", " ".join(parts))


def abstract_problems(pages, program, effects, record):
    abstract = abstract_text(pages)
    findings = abstract_findings(abstract) if abstract else []
    if not findings:
        return []
    claims = record.get("abstractResults")
    claims = [c for c in claims if isinstance(c, dict)] if isinstance(claims, list) else []
    out, uncovered = [], []
    common = set.intersection(*[_words(f) for f in findings]) if len(findings) > 1 else set()
    squashed = _squash(abstract)
    usable = [c for c in claims if _squash(str(c.get("claim", ""))) and _squash(str(c.get("claim", ""))) in squashed]
    unmatched = [str(c.get("claim", "")) for c in claims if c not in usable]
    if unmatched:
        out.append(("sources/SOURCE.json abstractResults claims that are not the abstract's own words: "
                    + "; ".join("\"%s\"" % _snippet(u, 60) for u in unmatched[:3]), "copy each claim from the abstract as printed"))
    # a finding whose distinctive words a result field or an effect carries is recorded without a claim
    targets_all = [_target_text(program, effects, "%s.%s" % (n.get("id"), f.get("id")))
                   for n in program.get("nodes") or [] if isinstance(n, dict) and n.get("kind") == "result"
                   for f in n.get("fields") or [] if isinstance(f, dict)]
    targets_all += [_target_text(program, effects, "effect:%s" % e.get("id"))
                    for e in (effects or {}).get("effects") or [] if isinstance(e, dict)]
    target_words = [_words(t) for t in targets_all if t]
    keys = recorded_keys(recorded_values(program, effects))
    for finding in findings:
        words = _words(finding)
        distinctive = (words - common - GENERIC) or (words - GENERIC) or words
        need = min(len(distinctive), max(3, -(-len(distinctive) // 4)))
        printed = [t for t in TOKEN.findall(_norm(finding)) if "." in t or not YEAR.fullmatch(t.lstrip("-"))]
        auto = any(len(distinctive & tw) >= need for tw in target_words) or \
            (len(printed) >= 2 and all(is_recorded(t, keys) for t in printed))
        best, best_score = None, 0.0
        for claim in usable:
            text = str(claim.get("claim", ""))
            shared = len(words & _words(text))
            score = 3.0 if _squash(finding) in _squash(text) else (
                shared / max(1, len(words | _words(text))) + shared / max(1, len(words)))
            if shared >= 0.6 * len(words) and score > best_score:
                best, best_score = claim, score
        if best is None:
            if not auto:
                uncovered.append(_snippet(finding, 90))
            continue
        targets = best.get("recordedIn")
        targets = [targets] if isinstance(targets, str) else targets if isinstance(targets, list) else []
        if not targets:
            if len(re.findall(r"\w+", str(best.get("notRecorded", "")))) < 4:
                out.append(("sources/SOURCE.json abstractResults \"%s\": neither recordedIn nor notRecorded"
                            % _snippet(finding, 60), "give recordedIn (the result fields or effects that hold it) or "
                            "notRecorded with the reason it holds no statistic"))
            continue
        texts = [_target_text(program, effects, str(t)) for t in targets]
        missing = [str(t) for t, text in zip(targets, texts) if text is None]
        if missing:
            out.append(("sources/SOURCE.json abstractResults \"%s\": recordedIn names what does not exist (%s)"
                        % (_snippet(finding, 60), ", ".join(missing[:3])),
                        "use \"<result node id>.<field id>\" or \"effect:<effect id>\""))
            continue
        if not distinctive & _words(" ".join(texts)):
            out.append(("sources/SOURCE.json abstractResults \"%s\": none of %s is about it (no word of '%s' in their "
                        "ids, labels, values or cited quotes)" % (_snippet(finding, 60), ", ".join(map(str, targets[:3])),
                                                                 ", ".join(sorted(distinctive)[:5])),
                        "name the field or effect that records this finding"))
    if uncovered:
        out.insert(0, ("the abstract states results that sources/SOURCE.json abstractResults does not map to what "
                       "records them: " + "; ".join("\"%s\"" % u for u in uncovered[:5]),
                       "record each result the abstract names (a result field or an effect; state missing with an "
                       "issue when the replay cannot compute it) and list every finding the abstract states as "
                       "{\"claim\": \"<the abstract's words>\", \"recordedIn\": [\"<result node id>.<field id>\" | "
                       "\"effect:<id>\"]} or {\"claim\": ..., \"notRecorded\": \"<why it holds no statistic>\"}"))
    return out


def _table_key(label):
    number = re.sub(r"(?i)^\s*(supplementary\s+|supplemental\s+|online\s+)?table\s*", "", str(label or "").strip())
    return re.sub(r"\s+", "", number).upper()


def supplement_problems(root, pdf_path, program, record):
    """A supplement PDF under sources/ prints numbered result tables: each is listed in paperTables with its
    `source` and recorded cell by cell (a table field), or kind other."""
    pdfs = paper_tables.supplement_pdfs(root, pdf_path)
    if not pdfs:
        return []
    declared = {}
    for item in record.get("paperTables") or []:
        if isinstance(item, dict):
            declared.setdefault(_table_key(item.get("table")), []).append(item)
    whole_file = {str(i.get("source", "")).strip().lstrip("./") for i in declared.get("", [])
                  if i.get("kind") == "other" and len(re.findall(r"\w+", str(i.get("what", "")))) >= 3}
    fields = {}
    for n in program.get("nodes") or []:
        for f in (n.get("fields") or []) if isinstance(n, dict) else []:
            if isinstance(f, dict):
                fields["%s.%s" % (n.get("id"), f.get("id"))] = f
    table_fields = {}
    for name, f in fields.items():
        if is_table(f.get("value")) and f["value"].get("table"):
            table_fields.setdefault(_table_key(f["value"]["table"]), []).append((name, f))
    source_of = lambda x: str(x.get("source", "")).strip().lstrip("./") if isinstance(x, dict) else ""
    out, unlisted, unlisted_private = [], {}, {}
    for pdf in pdfs:
        relative = pdf.relative_to(root).as_posix()
        if relative in whole_file:
            continue
        # a supplement without an open licence (sources/private/) or from the researcher (sources/researcher/) is
        # never exported, and neither may its text be through program.json: its tables are listed as references
        private = relative.startswith(("sources/private/", "sources/researcher/"))
        for table in paper_tables.supplement_inventory(pdf):
            if not table["result"]:
                continue
            number = table["table"]
            item = next((c for c in declared.get(number, []) if source_of(c) == relative), None)
            held = [(n, f) for n, f in table_fields.get(number, []) if source_of(f["value"]) == relative]
            if item is None and not held:
                if not number.startswith("S"):
                    continue   # "Table 2" of a supplement may be one of the paper's own: judged only when named
                item = next((c for c in declared.get(number, []) if not source_of(c)), None)
                held = [(n, f) for n, f in table_fields.get(number, []) if not source_of(f["value"])]
            label = "Table %s of %s (p. %d)" % (number, relative, table["page"])
            if item is None and not held:
                (unlisted_private if private else unlisted).setdefault(relative, []).append(
                    "Table %s (p. %d)" % (number, table["page"]))
                continue
            if private and (item is None or item.get("kind") != "other"):
                continue   # a reference: its cells stay in the file
            if item is not None and item.get("kind") == "other":
                if len(re.findall(r"\w+", str(item.get("what", "")))) < 3:
                    out.append(("sources/SOURCE.json paperTables %s: say in 'what' what the table holds" % label,
                                "e.g. \"wording of the items, no results\""))
                continue
            if item is not None and item.get("kind") not in (None, "result"):
                out.append(("sources/SOURCE.json paperTables %s: kind %r" % (label, item.get("kind")),
                            "the supplement is under sources/, so its tables are in the project: kind \"result\" "
                            "(recorded cell by cell) or \"other\" (no results)"))
                continue
            names = (item or {}).get("recordedIn")
            names = [names] if isinstance(names, str) else names if isinstance(names, list) else []
            targets = [fields[str(n)] for n in names if str(n) in fields] if names else [f for _, f in held]
            if not targets or (names and len(targets) < len(names)):
                out.append(("%s is listed but no table field holds it" % label,
                            "record it cell by cell in a table field {\"table\": \"Table %s\", \"source\": \"%s\", "
                            "\"page\": %d, \"columns\": [...], \"rows\": [[...]]} and name it in recordedIn "
                            "(\"<node id>.<field id>\")" % (number, relative, table["page"])))
                continue
            if not table["text_layer"]:
                continue   # read from the page image: the cells cannot be compared with the text layer
            keys = set()
            for f in targets:
                for x in signed_numbers(f.get("value")):
                    for places in range(0, 5):
                        keys.add("%.*f" % (places, abs(x)))
            absent = [v for v in table["values"] if not is_recorded(v, keys)]
            if len(absent) > len(table["values"]) / 2:
                out.append(("%s: the table field holds only %d of the table's %d numbers (missing e.g. %s)"
                            % (label, len(table["values"]) - len(absent), len(table["values"]), ", ".join(absent[:6])),
                            "transcribe every cell as printed"))
    if unlisted_private:
        out.insert(0, ("a supplement under sources/private/ or sources/researcher/ prints result tables sources/SOURCE.json "
                       "paperTables does not list: " + "; ".join(
                           "%s: %s" % (path, ", ".join(tables)) for path, tables in unlisted_private.items()),
                       "its text is never exported, so do not copy its cells into program.json: list each table as a "
                       "reference {\"table\": \"S1\", \"source\": \"<path>\", \"page\": <page>, \"kind\": \"result\"} "
                       "(kind \"other\" with \"what\" when it holds no results), and record in an issue that its "
                       "numbers stay in the researcher's copy"))
    if unlisted:
        out.insert(0, ("a supplement under sources/ prints result tables the project does not record: " + "; ".join(
            "%s: %s" % (path, ", ".join(tables)) for path, tables in unlisted.items()),
            "a supplement's descriptive and result tables (item means and SDs, correlations, regressions) are human "
            "results: record each cell by cell in a table field {\"table\": \"Table S1\", \"source\": \"<path>\", "
            "\"page\": <page>, ...} and list it in sources/SOURCE.json paperTables as {\"table\": \"S1\", \"source\": "
            "\"<path>\", \"page\": <page>, \"kind\": \"result\", \"recordedIn\": \"<node id>.<field id>\"}; a table "
            "with no results is kind \"other\" with \"what\"; a PDF that is not this paper's supplement is "
            "{\"source\": \"<path>\", \"kind\": \"other\", \"what\": \"...\"} without \"table\""))
    return out


def coverage_problems(root, pdf_path, program, effects, record, table_pages=()):
    """Results printed only in the text, the sample's make-up, the abstract's findings, supplement tables.
    table_pages: pages whose untranscribed table the printed-table check reports (not counted again here)."""
    pages = paper_tables.page_texts(pdf_path, layout=False)
    out = []
    if pages:
        spans, out = _skipped(record, pages)
        out += text_problems(text_coverage(pages, program, effects, spans, material_text(root), set(table_pages)))
        out += abstract_problems(pages, program, effects, record)
    out += supplement_problems(root, pdf_path, program, record)
    return out


def check(program_path, package=None):
    """The report for program.json. `package` (package/<slug>) decides whether the newer rules block (contract.py);
    without it (the command line) any current-contract package of the project makes them block."""
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
    out, info, warnings = [], [], []
    # rules added with the shared reply reader: problems for a current-contract project, warnings otherwise
    current = contract.current_contract(package) if package is not None else contract.project_current(root)
    newer = out if current else warnings

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
    effects = None
    try:
        effects = json.loads((root / "effects.json").read_text(encoding="utf-8"))
        for e in _lst(_dct(effects).get("effects")):
            walk(_dct(e).get("reported"), structured)
    except (OSError, ValueError, AttributeError, TypeError):
        pass
    # the coverage checks read effects.json too: a malformed file counts as no effects, malformed entries are left out
    effects = dict(effects, effects=[e for e in _lst(effects.get("effects")) if isinstance(e, dict)]) \
        if isinstance(effects, dict) else None
    held = {round(x, 6) for x in structured}
    unheld = lambda xs: [x for x in xs if round(x, 6) not in held]

    for where, f in tables:
        out += table_problems(where, f)
    result_fields = [("%s.%s" % (n.get("id"), f.get("id")), f) for n in nodes if n.get("kind") == "result"
                     for f in n.get("fields") or [] if isinstance(f, dict)]
    newer += impossible_values(result_fields)

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
            newer += image_tables(pdf_path, labels, already, record)
            paper_rel = pdf_path.relative_to(root).as_posix() if root in pdf_path.parents else pdf_path.name
            newer += lost_signs(pdf_path, result_fields, evidence, record, paper_rel)
            try:
                newer += coverage_problems(root, pdf_path, p, effects, record,
                                           {page for key, page in seen.items() if key not in labels})
            except Exception as exc:  # noqa: BLE001 - a malformed record is reported, not a crash
                newer.append(("results coverage could not run (%s: %s)" % (type(exc).__name__, str(exc)[:160]),
                              "fix the record it names (program.json, effects.json or sources/SOURCE.json)"))
        else:
            info.append("paper_tables.py is not installed: tables without a text layer and lost minus signs not checked")
        if blank:
            info.append("pages without a text layer (scanned): %s; read their tables from the page images"
                        % ", ".join(map(str, blank[:30])))
        if not pages:
            info.append("no PDF reader available: printed table captions not checked")
    return {"problems": out, "info": info, "tables": len(tables), "warnings": warnings}


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
    for msg, hint in report.get("warnings") or []:
        print("WARN    %s (older build: blocking once rebuilt with task/replies.py)\n        fix: %s" % (msg, hint))
    for line in report["info"]:
        print("note    " + line)
    if report["problems"]:
        print("FAIL %d problem(s) in %s (%d table fields)" % (len(report["problems"]), a.program, report["tables"]))
        return 1
    print("PASS %s (%d table fields)" % (a.program, report["tables"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
