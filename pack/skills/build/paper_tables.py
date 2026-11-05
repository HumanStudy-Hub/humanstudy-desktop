#!/usr/bin/env python3
"""The paper's tables and the numbers its text layer gets wrong.

    python .opencode/skills/build/paper_tables.py paper.pdf [--render .humanstudy/tmp/pages]

Prints, as JSON:

  tables     every numbered table of this paper ("Table 3", never a supplementary "Table 3S" or
             "Table S3"), found from its caption or, when the caption is not in the text layer, from
             the sentences that mention it ("In Table 1 and 2, we summarized ..."). Each says on which
             page it is captioned or mentioned, how many table rows the text layer holds next to the
             caption, and `needs_page_image`: a table of results whose numbers the text layer does not
             give (drawn as vector graphics or an image). Such a table can only be read from the
             rendered page.
  sign_loss  numbers printed with a minus that the text layer loses: a minus at the end of a line
             ("95% CI [-" / "0.16, 0.54]") is easily read as a hyphen and dropped when the lines are
             joined, and a true minus (U+2212) split from its digits ("= − 0.011") is easy to miss.
             Check each on the rendered page and record the signed value.
  rendered   with --render <dir>: the PNG files written for the pages of those tables and numbers
             (pypdfium2 from the HumanStudy runtime; the pdftoppm command when pypdfium2 is absent).
             Open them and read the table or number from the picture.

supplement_inventory(pdf) lists the numbered tables ("Table S1") of a supplement PDF under sources/ with the
decimal values of their rows, for check_results.py's supplement check.

check_results.py (the readiness "results" check) uses the same functions: a table that needs the page
image must have a table field with its label (or be listed in sources/SOURCE.json `paperTables` as
`other` or `not-in-paper`), and a sign_loss number recorded only without its minus fails unless the
page was checked. Limits: best effort on the text layer (pdfplumber words, else pdftotext -layout);
it cannot see a table that neither a caption nor a sentence names. Standard library plus pdfplumber,
pypdf and pypdfium2 (all in the runtime).
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

# A caption: "Table 3", "Table 3." or "Table 3: ..." or "TABLE 3 Means ...", never a sentence such as
# "Table 3 presents the means" (a mention that starts a line). Also "Table 1 | Design", "Table 1 – Means".
CAPTION_RE = re.compile(r"(?:^\s*|\s{2,})(?:Table|TABLE)[ \t]+(\d{1,2})(?![\dSs])"
                        r"(?:\s*$|\s{3,}\S[^\n]*$|\s*[.:|–—-]\s*(\S[^\n]*)?$|\s{1,2}([A-Z(][^\n]*)$)")
# A mention of a supplementary or appendix table: not a table of this PDF's main text.
SUPPLEMENT_BEFORE_RE = re.compile(r"(?i)(supplement\w*|supplemen-|extended data|\bSI|\bS\d+|appendix|online)\s*$")
SUPPLEMENT_AFTER_RE = re.compile(r"(?i)^\s*(of|in)\s+(the\s+)?(S\d+\s+)?(online\s+)?(appendix|supplement\w*|SI\b|"
                                 r"electronic supplementary)")
RESULT_WORDS_RE = re.compile(r"(?i)result|statistic|descriptive|mean|summar|effect|test|estimate|frequenc|"
                             r"proportion|percent|odds|correlat|regression|anova|chi|choice|rate|compar")
# "Table 1", "Tables 1 and 2", "Table 3 and 4", "Tables 2-4"; never "Table 2S" or "Table S2".
MENTION_RE = re.compile(r"\b(?:Table|TABLE)s?\s+(\d{1,2})(?![\dSs])((?:\s*(?:,|and|&|to|-|–)\s*\d{1,2}(?![\dSs]))*)")
ELSEWHERE_RE = re.compile(r"(?i)\b(et al\.?|\(\d{4}\)|\d{4}[a-z]?\)|'s|’s)\s*$")
NUMBER_RE = r"(\d+(?:\.\d+)?|\.\d+)"
NUMERIC_CELL_RE = re.compile(r"^[\[(]?-?(?:\d+(?:\.\d+)?|\.\d+)%?[\])]?[,;*†‡]*$")
RESULT_CAPTION_RE = re.compile(
    r"(?i)(result|mean|descriptive|statistic|effect|correlat|regression|model|analys|frequenc|proportion|"
    r"percent|anova|test|estimate|coefficient|rating|sample|outcome|choice|score|response|comparison|summary)")
NON_RESULT_CAPTION_RE = re.compile(
    r"(?i)(power|sensitivity|taxonomy|methodolog|pre-?registration|procedure|material|stimul|wording|"
    r"instruction|hypothes[ie]s(?! and a comparison)|design\b|previous|prior\b|literature|meta-analy|deviation from|"
    r"changes to|analysis plan)")

_CACHE = {}


# --------------------------------------------------------------------------- reading the PDF

def _layout_from_words(page):
    """Column-aligned text of a pdfplumber page from its words, with the gaps of the printed page: a
    column gap stays two or more spaces (pdfplumber's own layout text squeezes gaps in dense pages)."""
    words = page.extract_words(x_tolerance=1.5, y_tolerance=2, keep_blank_chars=False)
    if not words:
        return ""
    widths = sorted((w["x1"] - w["x0"]) / max(1, len(w["text"])) for w in words if w["text"])
    cw = max(1.0, widths[len(widths) // 2] if widths else 5.0)
    rows = []
    for w in sorted(words, key=lambda w: (w["top"], w["x0"])):
        if rows and abs(w["top"] - rows[-1][0]) <= 2.5:
            rows[-1][1].append(w)
        else:
            rows.append([w["top"], [w]])
    # A column gap is wider than a word space: three typical word spaces (gaps narrower than the text height),
    # at least the text height. Scanned papers with an OCR layer space justified words widely.
    size = sorted(w["bottom"] - w["top"] for w in words)[len(words) // 2] or 10.0
    gaps = sorted(b["x0"] - a["x1"] for _, row in rows for a, b in zip(sorted(row, key=lambda w: w["x0"]),
                                                                       sorted(row, key=lambda w: w["x0"])[1:])
                  if 0 < b["x0"] - a["x1"] < size)
    space = gaps[len(gaps) // 2] if gaps else 0.3 * size
    column_gap = max(2.0 * cw, 3.0 * space, size)
    heights = sorted(b[0] - a[0] for a, b in zip(rows, rows[1:]))
    step = heights[len(heights) // 2] if heights else 12
    out, last_top = [], None
    for top, row in rows:
        if last_top is not None and top - last_top > 1.8 * max(step, 1):
            out.append("")
        last_top = top
        line, prev_x1 = "", None
        for w in sorted(row, key=lambda w: w["x0"]):
            col = int(round(w["x0"] / cw))
            if prev_x1 is None:
                line = " " * col
            else:
                gap = w["x0"] - prev_x1
                # a word space (even a wide one in justified text) stays one space; a column gap is two or more
                # spaces, padded to the word's column
                line += " " if gap < column_gap else " " * max(2, col - len(line))
            line += w["text"]
            prev_x1 = w["x1"]
        out.append(line.rstrip())
    return "\n".join(out)


def _pdftotext(pdf, layout):
    if not shutil.which("pdftotext"):
        return []
    try:
        run = subprocess.run(["pdftotext", "-q"] + (["-layout"] if layout else []) + [str(pdf), "-"],
                             capture_output=True, timeout=120)
    except (OSError, subprocess.SubprocessError):
        return []
    if run.returncode != 0:
        return []
    pages = run.stdout.decode("utf-8", "replace").split("\f")
    return pages[:-1] if pages and not pages[-1].strip() else pages


def page_texts(pdf, layout):
    """The text layer of each page: column-aligned (layout) or plain reading order. The plain text is
    what check_quotes.py reads; the layout text is built from pdfplumber's words (else pdftotext -layout)."""
    pdf = Path(pdf)
    try:
        stat = pdf.stat()
    except OSError:
        return []
    key = (str(pdf.resolve()), stat.st_mtime_ns, stat.st_size, bool(layout))
    if key in _CACHE:
        return _CACHE[key]
    pages = []
    if layout:
        try:
            import pdfplumber
            with pdfplumber.open(str(pdf)) as doc:
                pages = [_layout_from_words(p) for p in doc.pages]
        except Exception:
            pages = _pdftotext(pdf, True)
    else:
        try:
            import check_quotes
            pages = list(check_quotes.Pdf(pdf).load() or [])
        except Exception:
            pages = []
        if not pages:
            pages = _pdftotext(pdf, False)
    _CACHE[key] = pages
    return pages


def _references_start(pages):
    """Index of the page where the reference list begins (tables after it still count)."""
    for index in range(len(pages) - 1, -1, -1):
        if re.search(r"(?im)^\s*(references|bibliography|literature cited)\s*$", pages[index]) \
                and index >= len(pages) * 0.4:
            return index
    return len(pages)


# --------------------------------------------------------------------------- tables

def _table_row(line):
    """A line of a table's body: two or more numeric cells, and numbers outweigh words.
    Prose of a neighbouring column (a cell of four or more words) is not part of it."""
    cells = [c.strip() for c in re.split(r"\s{2,}", line.strip()) if c.strip()]
    cells = [c for c in cells if len(re.findall(r"[A-Za-z]{2,}", c)) < 4]
    tokens = [t.strip(",;*†‡") for c in cells for t in c.replace("–", "-").replace("−", "-").split()]
    numeric = [t for t in tokens if t and NUMERIC_CELL_RE.match(t)]
    words = [t for t in tokens if re.search(r"[A-Za-z]{3,}", t)]
    return len(numeric) >= 2 and len(numeric) >= len(words)


def _expand(first, rest):
    numbers = [int(first)]
    for joiner, value in re.findall(r"(,|and|&|to|-|–)\s*(\d{1,2})", rest):
        value = int(value)
        if joiner in ("to", "-", "–") and numbers and numbers[-1] < value <= numbers[-1] + 12:
            numbers += list(range(numbers[-1] + 1, value + 1))
        else:
            numbers.append(value)
    return [str(n) for n in numbers]


def table_inventory(pdf):
    """Every numbered table: caption page and text, pages that mention it, and how many table rows
    the text layer holds next to its caption (0 when it has none)."""
    layout = page_texts(pdf, layout=True)
    if not layout:
        return []
    end = _references_start(layout)
    tables = {}

    def entry(number):
        return tables.setdefault(number, {"table": number, "caption_page": None, "caption": "",
                                          "mentioned_on": [], "text_rows": 0, "mention_context": ""})

    for index, page in enumerate(layout):
        lines = page.splitlines()
        for at, line in enumerate(lines):
            caption = CAPTION_RE.search(line)
            if caption:
                table = entry(caption.group(1))
                # In a two-column page only the caption's column holds the table.
                column = caption.start(0) + len(caption.group(0)) - len(caption.group(0).lstrip())
                head = re.match(r"(?:Table|TABLE)[ \t]+\d{1,2}", line[column:])
                after = line[column + (head.end() if head else 0):]
                if len(after) - len(after.lstrip(" .:|–—-")) >= 8 or not after.strip(" .:|–—-"):
                    nxt = lines[at + 1][max(0, column - 2):] if at + 1 < len(lines) else ""
                    title = nxt.strip()  # the title is on the next line, in the caption's column
                else:
                    title = after.strip(" .:|–—-")
                title = re.split(r"\s{4,}", title)[0][:120]
                window = lines[max(0, at - 45):at] + lines[at + 1:at + 46]
                rows = sum(1 for row in window if _table_row(row[max(0, column - 4):]))
                # A sentence that starts a line ("Table 4. For men, ...") also looks like a caption:
                # keep the candidate with the most table rows next to it.
                if table["caption_page"] is None or rows > table["text_rows"]:
                    table["caption_page"], table["caption"], table["text_rows"] = index + 1, title, rows
            if index >= end:
                continue
            previous = lines[at - 1].rstrip() if at else ""
            for segment in re.split(r"\s{2,}", line):
                for match in MENTION_RE.finditer(segment):
                    before = segment[:match.start()].rstrip()
                    # "Supplemen-" / "tary Table 3" across a line break
                    if re.fullmatch(r"(?i)(tary|tal)?", before) and re.search(r"(?i)supplemen-?$|supplementary$|"
                                                                            r"extended data$|appendix$", previous):
                        continue
                    if ELSEWHERE_RE.search(before) or SUPPLEMENT_BEFORE_RE.search(before) \
                            or SUPPLEMENT_AFTER_RE.match(segment[match.end():]) or \
                            re.match(r"\s*(of|in|from)\s+[A-Z][a-z]+(\s+et al|\s*\(|\s+and\s+[A-Z])", segment[match.end():]):
                        continue
                    for number in _expand(match.group(1), match.group(2) or ""):
                        table = entry(number)
                        if index + 1 not in table["mentioned_on"]:
                            table["mentioned_on"].append(index + 1)
                        table["mention_context"] += " " + segment[max(0, match.start() - 80):match.end() + 120]
    out = []
    for number in sorted(tables, key=int):
        table = tables[number]
        table["text_layer"] = table["caption_page"] is not None and table["text_rows"] >= 3
        table["needs_page_image"] = needs_page_image(table)
        out.append(table)
    return out


def needs_page_image(table):
    """A table whose numbers the text layer cannot give: mentioned as results but never captioned in
    the text, or captioned as results with no table rows next to the caption."""
    if table.get("text_layer"):
        return False
    if table.get("caption_page") is None:
        return bool(RESULT_WORDS_RE.search(table.get("mention_context") or ""))
    caption = table.get("caption") or ""
    if NON_RESULT_CAPTION_RE.search(caption) and not re.search(r"(?i)result|effect|mean", caption):
        return False
    return bool(RESULT_CAPTION_RE.search(caption))


def pages_to_render(table):
    if table.get("caption_page"):
        return [table["caption_page"]]
    pages = []
    for page in table.get("mentioned_on") or []:
        pages += [page, page + 1]
    return sorted(set(pages))


def render_pages(pdf, pages, out_dir, dpi=150):
    """Write the pages as PNG files (pypdfium2, else pdftoppm); returns the files written."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    pages = sorted({int(p) for p in pages if int(p) >= 1})
    written = []
    try:
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(str(pdf))
        try:
            for page in pages:
                if page > len(doc):
                    continue
                target = out_dir / ("page-%02d.png" % page)
                doc[page - 1].render(scale=dpi / 72).to_pil().save(str(target))
                written.append(str(target))
        finally:
            doc.close()
        return written
    except ImportError:
        pass
    if not shutil.which("pdftoppm"):
        return written
    for page in pages:
        prefix = out_dir / ("page-%02d" % page)
        try:
            subprocess.run(["pdftoppm", "-q", "-r", str(dpi), "-png", "-singlefile", "-f", str(page), "-l", str(page),
                            str(pdf), str(prefix)], capture_output=True, timeout=120)
        except (OSError, subprocess.SubprocessError):
            continue
        if prefix.with_suffix(".png").is_file():
            written.append(str(prefix.with_suffix(".png")))
    return written


# --------------------------------------------------------------------------- supplement tables
# Numbered tables of a PDF under sources/ other than the paper ("Table S1. Descriptive statistics ...",
# "Supplementary Table 2"): a fetched or uploaded supplement's descriptive and result tables are results.

SUPPLEMENT_CAPTION_RE = re.compile(
    r"^\s*(?:(?:Supplementary|Supplemental|Online)\s+)?(?:Table|TABLE)\s+(S\s?\d{1,2}[A-Za-z]?|\d{1,2}[A-Za-z]?)"
    r"(?![\w])\s*[.:|–—-]?\s*(\S[^\n]*)?$")
DECIMAL_RE = re.compile(r"(?<![\w.])-?(?:\d+\.\d+|\.\d+)(?![\w])")


def supplement_pdfs(root, paper=None):
    """PDFs under sources/ (open, private, researcher) other than the paper itself."""
    root = Path(root)
    folder = root / "sources"
    if not folder.is_dir():
        return []
    paper = Path(paper).resolve() if paper else None
    return [p for p in sorted(folder.rglob("*.pdf")) if p.is_file() and not p.is_symlink()
            and (paper is None or p.resolve() != paper)]


def supplement_inventory(pdf):
    """Every numbered table of a supplement PDF: its id ("S1"), page, caption, the decimal values of the
    table rows the text layer holds under the caption, `text_layer` (six or more of them) and `result`."""
    tables, current = {}, None
    for index, page in enumerate(page_texts(pdf, layout=True)):
        lines = page.splitlines()
        for at, line in enumerate(lines):
            caption = SUPPLEMENT_CAPTION_RE.match(line)
            if caption:
                number = re.sub(r"\s+", "", caption.group(1)).upper()
                title = (caption.group(2) or "").strip()
                if not title and at + 1 < len(lines):
                    title = lines[at + 1].strip()
                current = tables.setdefault(number, {"table": number, "page": index + 1, "caption": title[:160],
                                                     "values": []})
                continue
            if current is not None and _table_row(line):
                current["values"] += DECIMAL_RE.findall(line.replace("−", "-").replace("–", "-"))
    out = []
    for table in tables.values():
        table["values"] = sorted(set(table["values"]))
        table["text_layer"] = len(table["values"]) >= 6
        caption = table["caption"]
        table["result"] = not (NON_RESULT_CAPTION_RE.search(caption) and not re.search(r"(?i)result|effect|mean",
                                                                                         caption)) \
            and bool(RESULT_CAPTION_RE.search(caption) or table["text_layer"])
        out.append(table)
    return out


# --------------------------------------------------------------------------- lost minus signs

def _squash(text):
    text = (text.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
            .replace(" ", " ").replace(" ", " ").replace(" ", " "))
    return re.sub(r"\s+", " ", text)


SPACE = r"[ \t   ]"
# A minus ending a line segment of the layout text, not after a letter or digit (so not "self-" or "1-").
LINE_END_MINUS_RE = re.compile(r"(?:^|(?<=[\[(=,:;<>])|(?<=\s))\s*[-−]$")
# A true minus split from its digits where a number starts ("= − 0.011", "[− 0.25"), never "n − 1".
SPLIT_MINUS_RE = re.compile(r"((?:^|[=(\[,:])" + SPACE + r"*)−" + SPACE + r"+" + NUMBER_RE, re.MULTILINE)


def _column_start(lines, column):
    """The text that starts the same column (within 3 characters of `column`) on the first following line that
    has one. Lines of the other column, which the layout text may interleave, are skipped."""
    for line in lines:
        for m in re.finditer(r"\S+(?: \S+)*", line):
            if abs(m.start() - column) <= 3 and (m.start() < 2 or not line[max(0, m.start() - 2):m.start()].strip()):
                return line[m.start():]
            if m.start() > column + 3:
                break
    return ""


def sign_loss(pdf):
    """Numbers printed with a minus that the text layer can read as positive.

    Each item: page, the value without its sign (`reads`), the signed value (`printed`), the context
    and how it was found: a minus that ends a line segment in the layout text (not after a letter, so
    not a hyphenated word) whose number continues the same column on the next line and follows it in
    the plain reading order, or a U+2212 minus separated from its digits where a number starts."""
    layout = page_texts(pdf, layout=True)
    plain = page_texts(pdf, layout=False)
    found, seen = [], set()
    end = _references_start(layout)
    for index, page in enumerate(layout[:end + 1]):
        raw = plain[index] if index < len(plain) else ""
        text = _squash(raw)
        lines = page.splitlines()
        if index == end:  # the reference list's own page: stop at its heading
            heading = next((i for i, l in enumerate(lines)
                            if re.match(r"(?i)\s*(references|bibliography|literature cited)\s*$", l)), len(lines))
            lines = lines[:heading]
        for at, line in enumerate(lines):
            for segment_match in re.finditer(r"\S+(?: \S+)*", line.rstrip()):
                segment, column = segment_match.group(0), segment_match.start()
                match = LINE_END_MINUS_RE.search(segment)
                if not match:
                    continue
                tail = _squash(segment[:match.start()]).rstrip()[-28:]
                # Not a DOI, page range or identifier split at a line end ("1099-" / "0984").
                if len(re.sub(r"\W", "", tail)) < 3 or re.search(r"/|\bdoi\b|\d$", tail, re.I):
                    continue
                start_of_next = _column_start(lines[at + 1:at + 4], column)
                number = re.match(NUMBER_RE + r"(?![\d])", start_of_next)
                if not number:
                    continue
                value = number.group(1)
                # The plain text continues with this number (with the minus kept or dropped): the two lines
                # belong together in reading order, not to two columns.
                if text and not re.search(re.escape(tail) + r" ?[-−]? ?" + re.escape(value) + r"(?![\d])", text):
                    continue
                key = (index + 1, value)
                if key not in seen:
                    seen.add(key)
                    found.append({"page": index + 1, "reads": value, "printed": "-" + value,
                                  "context": "%s-%s" % (tail, value), "how": "minus at a line end"})
        for hit in SPLIT_MINUS_RE.finditer(raw):
            value = hit.group(2)
            key = (index + 1, value)
            if key not in seen:
                seen.add(key)
                start = max(0, hit.start() - 24)
                found.append({"page": index + 1, "reads": value, "printed": "-" + value,
                              "context": _squash(raw[start:hit.end()]).strip(), "how": "minus split from its digits"})
    return found


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--render", type=Path, help="write the pages of tables without a text layer (and of numbers "
                        "with a lost minus) as PNG files here")
    args = parser.parse_args(argv)
    if not args.pdf.is_file():
        print("FAIL %s not found" % args.pdf)
        return 1
    tables = table_inventory(args.pdf)
    signs = sign_loss(args.pdf)
    report = {"tables": tables, "sign_loss": signs}
    if args.render:
        pages = [p for t in tables if t["needs_page_image"] for p in pages_to_render(t)] + [s["page"] for s in signs]
        report["rendered"] = render_pages(args.pdf, pages, args.render)
        if pages and not report["rendered"]:
            report["note"] = "no page renderer available (pypdfium2 or pdftoppm): open the PDF pages yourself"
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
