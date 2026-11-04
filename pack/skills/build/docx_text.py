#!/usr/bin/env python3
"""Text of a Word file (``.docx``), page by page, with its paragraph breaks kept; and the package check that
participant text carries no Word or Qualtrics export markup.

    python .opencode/skills/build/docx_text.py sources/open/<file>.docx [--json .humanstudy/tmp/<file>.json]
    python .opencode/skills/build/docx_text.py --check .        (the project folder; check_package.py runs it)

Read a survey's Word copy (a Qualtrics "Export Survey to Word" file, a materials document) with this before
transcribing from it. Joining Word's text runs by hand loses what separates them:

- a line break inside a paragraph (``<w:br/>``) becomes a new line, so "Scenario 1" and "In this study ..."
  stay apart;
- every paragraph and table cell is its own line;
- a page break (``<w:br w:type="page"/>``, a page-break-before paragraph) and the grey "Page Break" line a
  Qualtrics export prints between pages end the page. The marker itself is never text.

Lines a Qualtrics export adds around the survey ("Start of Block: ...", "End of Block: ...", "Display This
Question:", "Skip To: ...", "Standard: ... (n Questions)") are kept apart under ``export_lines``: they describe
the flow, not what participants read.

Printed as plain text: one paragraph per line, pages separated by ``--- page break ---``. ``--json`` writes
``{"pages": [[paragraph, ...], ...], "export_lines": [...]}``. Reading a file runs nothing in it. The reader
(``read``) follows HumanStudy-Bench's agent_pipeline/docx_text.py, hardened here: a word/document.xml over
50 MB uncompressed is refused, and an unclosed tag never makes reading slower than one pass over the file.
The check is the desktop's.

``--check`` (``problems(root, package)``) applies only when a ``.docx`` is under ``sources/``. Participant text
(``materials.json`` strings other than notes, reasons and source records, and the values of program.json
fields of origin ``verbatim``) must not carry export markup ("Page Break", "Start of Block:", "Display This
Question:", ...) and must not run two lines of a Word source together ("Scenario 1In this study"). Limits: it
reads materials and the program, not the adapter's own string literals; a run-together join is found only
when both lines are at least four characters long. A .docx it cannot read (not a zip, an unsupported
compression, an encrypted entry, too large) is one finding naming the file.
Standard library only (zipfile and regular expressions).
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import zipfile
from pathlib import Path
from typing import Dict, List

PAGE_SEPARATOR = "--- page break ---"
# The marker line a Qualtrics Word export prints at each page break.
PAGE_MARKER_RE = re.compile(r"^\s*Page Break\s*$")
# Qualtrics starts every block on a new page.
BLOCK_LINE_RE = re.compile(r"^\s*(Start of Block:|End of Block:)")
# Lines a Qualtrics Word export adds that no participant saw.
EXPORT_LINE_RE = re.compile(
    r"(?i)^\s*(start of block:|end of block:|display this question:|skip to:|carry forward|"
    r"standard:.*\(\d+ questions?\)\s*$|block:.*\(\d+ questions?\)\s*$|branch:|endsurvey:|"
    r"(new )?question separator\s*$)")
# Text a participant never saw that only a Word or Qualtrics export puts in a file. The package
# check refuses it in any participant-visible string.
EXPORT_ARTIFACT_RE = re.compile(
    r"(?<!\w)(Page Break|Start of Block:|End of Block:|Display This Question:|Skip To:|"
    r"This question was not displayed|End of Survey:|QuestionSeparator)(?!\w)")


# Attributes are read up to the next "<" as well as ">", so an unclosed tag never makes a match scan the rest
# of the file (each match stops at the next tag: reading is linear in the file's size).
TOKEN_RE = re.compile(
    r"<w:pPr\b[^<>]*?(?P<pprself>/)?>"                # paragraph properties: only a page break before counts
    r"|<w:p(?=[\s>/])[^<>]*?(?P<empty>/)?>|(?P<pend></w:p>)"
    r"|<w:t(?=[\s>])[^<>]*>(?P<text>[^<]*)</w:t>"
    r"|<w:(?P<brk>br|cr)\b(?P<brattrs>[^<>]*?)/?>|(?P<tab><w:tab\b[^<>]*?/?>)|(?P<hyphen><w:noBreakHyphen\b[^<>]*?/?>)",
    re.S)
PPR_END = "</w:pPr>"
# word/document.xml larger than this (uncompressed) is not read: no survey export comes near it.
MAX_DOCUMENT_BYTES = 50 * 1024 * 1024
PAGE_BEFORE_RE = re.compile(r"<w:pageBreakBefore\b(?![^>]*w:val=\"(?:0|false|off)\")")


def read(path: Path) -> Dict[str, List]:
    """``{"pages": [[paragraph, ...], ...], "export_lines": [...]}`` of a .docx file."""
    with zipfile.ZipFile(path) as archive:
        size = archive.getinfo("word/document.xml").file_size
        if size > MAX_DOCUMENT_BYTES:
            raise ValueError("word/document.xml is %d MB uncompressed (more than %d MB): not read"
                             % (size // 2**20, MAX_DOCUMENT_BYTES // 2**20))
        xml = archive.read("word/document.xml").decode("utf-8", "replace")
    # A text box is stored twice (mc:Choice and an mc:Fallback copy for old Word): read it once.
    xml = _drop_fallbacks(xml)
    pages: List[List[str]] = [[]]
    export_lines: List[str] = []
    current: List[str] = []

    def new_page() -> None:
        if pages[-1]:
            pages.append([])

    def end_paragraph() -> None:
        text = "".join(current)
        current.clear()
        for piece_number, piece in enumerate(text.split("\f")):
            if piece_number:
                new_page()
            for line in piece.split("\n"):
                line = line.replace("\u00a0", " ").rstrip()
                if PAGE_MARKER_RE.match(line):
                    new_page()
                elif EXPORT_LINE_RE.match(line):
                    export_lines.append(line.strip())
                    if BLOCK_LINE_RE.match(line):
                        new_page()
                elif line.strip():
                    pages[-1].append(line)

    pos, ppr_end = 0, -2          # ppr_end: the next "</w:pPr>" found so far (-1: none after it)
    while True:
        match = TOKEN_RE.search(xml, pos)
        if match is None:
            break
        pos = match.end()
        if match.group(0).startswith("<w:pPr"):
            if match.group("pprself"):
                continue
            if ppr_end != -1 and ppr_end < pos:
                ppr_end = xml.find(PPR_END, pos)
            if ppr_end == -1:
                continue             # never closed: read on as if it were empty
            if PAGE_BEFORE_RE.search(xml, pos, ppr_end):
                end_paragraph()
                new_page()
            pos = ppr_end + len(PPR_END)
        elif match.group("pend") is not None or match.group("empty"):
            end_paragraph()
        elif match.group(0).startswith("<w:p"):
            if current:
                end_paragraph()          # a paragraph inside another (a text box): its own line
        elif match.group("text") is not None:
            current.append(html.unescape(match.group("text")))
        elif match.group("brk"):
            current.append("\f" if re.search(r'w:type="page"', match.group("brattrs") or "") else "\n")
        elif match.group("tab"):
            current.append("\t")
        elif match.group("hyphen"):
            current.append("-")
    end_paragraph()
    if not pages[-1] and len(pages) > 1:
        pages.pop()
    return {"pages": pages, "export_lines": export_lines}


def _drop_fallbacks(xml: str) -> str:
    """xml without its <mc:Fallback>...</mc:Fallback> copies (a scan, so an unclosed one costs one pass)."""
    out, pos = [], 0
    while True:
        start = xml.find("<mc:Fallback", pos)
        while start != -1 and re.match(r"\w", xml[start + 12:start + 13]):
            start = xml.find("<mc:Fallback", start + 12)
        end = xml.find("</mc:Fallback>", start) if start != -1 else -1
        if end == -1:
            out.append(xml[pos:])
            return "".join(out)
        out.append(xml[pos:start])
        pos = end + len("</mc:Fallback>")


def plain_text(path: Path) -> str:
    """The file as text: one paragraph per line, pages separated by ``--- page break ---``."""
    return f"\n{PAGE_SEPARATOR}\n".join("\n".join(page) for page in read(path)["pages"])




# --------------------------------------------------------------------------- package check

TEXT_KEYS_RE = re.compile(r"(?i)(note|reason|comment|description|derivation|evidence|source|search|why|"
                          r"implementation|departure|impact|action|what$|file$|path$|locator|license|licence)")


def _visible_strings(value: object) -> List[str]:
    """Participant text in materials.json: every string except notes, reasons and source records."""
    if isinstance(value, dict):
        return [s for k, v in value.items() if not TEXT_KEYS_RE.search(str(k)) for s in _visible_strings(v)]
    if isinstance(value, list):
        return [s for v in value for s in _visible_strings(v)]
    return [value] if isinstance(value, str) else []


def _lost_breaks(lines: List[str]) -> List[str]:
    """The two neighbouring lines of a page run together with nothing between them ("Scenario 1In this")."""
    joins = []
    for first, second in zip(lines, lines[1:]):
        tail, head = first.rstrip()[-12:], second.lstrip()[:12]
        if len(tail.strip()) >= 4 and len(head.strip()) >= 4 and not tail[-1].isspace() and not head[0].isspace():
            joins.append(tail + head)
    return joins


def _load(path: Path) -> object:
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def word_sources(root: Path) -> List[Path]:
    """The .docx files under sources/ (open, private and researcher-supplied)."""
    base = Path(root) / "sources"
    return sorted(p for p in base.rglob("*") if p.is_file() and p.suffix.lower() == ".docx"
                  and not p.name.startswith((".", "~$"))) if base.is_dir() else []


def participant_texts(root: Path, package: Path | None = None) -> List[tuple]:
    """(where, text) of participant text: materials.json of each package, program.json verbatim field values."""
    root = Path(root)
    packages = [Path(package)] if package else sorted(p for p in (root / "package").glob("*") if p.is_dir())
    out = []
    for pkg in packages:
        rel = (pkg / "materials/materials.json")
        out += [("%s/materials/materials.json" % pkg.name, s) for s in _visible_strings(_load(rel))]
    program = _load(root / "program.json")
    nodes = program.get("nodes") if isinstance(program, dict) else None
    for node in nodes if isinstance(nodes, list) else []:
        fields = node.get("fields") if isinstance(node, dict) else None
        for field in fields if isinstance(fields, list) else []:
            if isinstance(field, dict) and field.get("origin") == "verbatim":
                where = "program.json %s.%s" % (node.get("id"), field.get("id"))
                value = field.get("value")
                out += [(where, s) for s in ([value] if isinstance(value, str) else _visible_strings(value))]
    return out


def problems(root: Path, package: Path | None = None) -> List[tuple]:
    """[(message, fix)]: export markup in participant text, and lines of a Word source run together."""
    root = Path(root).resolve()
    docs = word_sources(root)
    if not docs:
        return []
    texts = participant_texts(root, package)
    out = []
    marked = [(where, text, m) for where, text in texts for m in [EXPORT_ARTIFACT_RE.search(text)] if m]
    if marked:
        found = sorted({m.group(1) for _, text, _ in marked for m in EXPORT_ARTIFACT_RE.finditer(text)})
        where, text, m = marked[0]
        out.append(("participant text carries survey-export markup no participant saw (%s; e.g. %s: '...%s')"
                    % (", ".join("'%s'" % a for a in found[:4]), where, text[max(0, m.start() - 60):m.end()]),
                    "read Word copies with .opencode/skills/build/docx_text.py: a 'Page Break' line ends a page and "
                    "is never text, and 'Start of Block:' or 'Display This Question:' lines describe the flow"))
    joined = re.sub(r"[ \t]+", " ", "\n".join(text for _, text in texts))
    lost: List[tuple] = []
    unreadable: List[str] = []
    for path in docs:
        rel = path.relative_to(root).as_posix()
        try:
            pages = read(path)["pages"]
        except KeyError:
            continue                 # no word/document.xml: not a Word document, nothing to compare
        except Exception as exc:     # not a zip, an unsupported compression, an encrypted entry, too large ...
            unreadable.append("%s (%s: %s)" % (rel, type(exc).__name__, str(exc)[:120]))
            continue
        for page in pages:
            for join in _lost_breaks(page):
                if re.sub(r"[ \t]+", " ", join) in joined and not any(join == j for j, _ in lost):
                    lost.append((join, rel))
    if unreadable:
        out.append(("a Word source under sources/ cannot be read, so participant text taken from it is not checked: "
                    + "; ".join(unreadable[:3]),
                    "replace it with a copy Word or LibreOffice saves normally (File > Save As .docx), or remove it "
                    "from sources/ when nothing was taken from it"))
    if lost:
        out.append(("participant text runs two lines of a Word source together with nothing between them (%s)"
                    % "; ".join("'%s' from %s" % pair for pair in lost[:3]),
                    "keep the file's paragraph and line breaks: read it with .opencode/skills/build/docx_text.py "
                    "and copy each line as it prints"))
    return out


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("path", type=Path, help="a .docx file, or with --check the project folder")
    parser.add_argument("--json", type=Path, help="write pages and export lines as JSON here")
    parser.add_argument("--check", action="store_true", help="check participant text in the project")
    args = parser.parse_args(argv)
    if args.check:
        found = problems(args.path)
        for msg, fix in found:
            print("PROBLEM %s" % msg + ("\n        fix: %s" % fix if fix else ""))
        if found:
            print("FAIL %d problem(s) in text taken from Word files" % len(found))
            return 1
        print("PASS Word sources: no export markup or run-together lines in participant text")
        return 0
    try:
        record = read(args.path)
    except Exception as exc:
        print("cannot read %s: %s" % (args.path, exc), file=sys.stderr)
        return 1
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n{PAGE_SEPARATOR}\n".join("\n".join(page) for page in record["pages"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
