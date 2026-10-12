"""PDF text tools for the HumanStudy research runtime: poppler-compatible `pdftotext` and `pdfinfo`
shims (the subset the skills use) plus `hs-pdf`, which prints `=== page N ===` blocks.

Backed by pdfplumber (text) and pypdf (metadata, fallback). Installed into the runtime's
site-packages; bin/pdftotext, bin/pdfinfo and bin/hs-pdf call `python -m hs_pdf_tools <tool> ...`.
"""
from __future__ import annotations

import os
import sys

FLAGS = {  # poppler flags without a value; accepted and ignored unless handled below
    "-layout", "-raw", "-nopgbrk", "-q", "-table", "-simple", "-simple2", "-lineprinter", "-htmlmeta",
    "-bbox", "-bbox-layout", "-tsv", "-nodiag", "-meta", "-isodates", "-rawdates", "-struct",
    "-struct-text", "-js", "-custom-metadata", "-v", "-h", "-help", "--help",
}
VALUED = {  # poppler flags that take one value
    "-f", "-l", "-r", "-x", "-y", "-W", "-H", "-fixed", "-enc", "-eol", "-opw", "-upw", "-box", "-cfg",
}


class ToolError(Exception):
    pass


def _open_plumber(path: str, password: str | None = None):
    import pdfplumber

    if not os.path.isfile(path):
        raise ToolError(f"Error: Couldn't open file '{path}'.")
    try:
        return pdfplumber.open(path, password=password or "")
    except Exception as e:  # noqa: BLE001 - report any parser failure the way poppler does
        raise ToolError(f"Error: Couldn't read '{path}': {type(e).__name__}: {e}") from None


def page_text(pdf, index: int, layout: bool) -> str:
    """Text of one page (0-based). pdfplumber first, pypdf if pdfplumber chokes on the page."""
    try:
        t = pdf.pages[index].extract_text(layout=layout) or ""
    except Exception:  # noqa: BLE001
        t = ""
        try:
            from pypdf import PdfReader

            t = PdfReader(pdf.stream).pages[index].extract_text() or ""
        except Exception:  # noqa: BLE001
            pass
    # poppler does not pad lines with trailing blanks; a layout rendering of a blank page is just blanks.
    lines = [ln.rstrip() for ln in t.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    while lines and not lines[-1]:
        lines.pop()
    while lines and not lines[0]:
        lines.pop(0)
    return "\n".join(lines)


def _page_range(n: int, first: int | None, last: int | None) -> range:
    a = 1 if first is None else max(1, first)
    b = n if last in (None, 0) else min(n, last)
    return range(a - 1, max(a - 1, b))


def _write(data: str, dest: str | None) -> None:
    raw = data.encode("utf-8", errors="replace")
    if dest in (None, "-"):
        sys.stdout.flush()
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()
    else:
        with open(dest, "wb") as f:
            f.write(raw)


def parse_pdftotext_args(argv: list[str]) -> dict:
    """`pdftotext [options] PDF-file [text-file|-]` -> options dict. Raises ToolError on usage errors."""
    o: dict = {"layout": False, "first": None, "last": None, "nopgbrk": False, "pdf": None, "out": None, "pw": None}
    pos: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "-":  # a lone dash is the output stream, not a flag
            pos.append(a)
        elif a.startswith("-") and len(a) > 1:
            if a in FLAGS:
                if a == "-layout":
                    o["layout"] = True
                elif a == "-nopgbrk":
                    o["nopgbrk"] = True
                elif a in ("-h", "-help", "--help"):
                    o["help"] = True
            elif a in VALUED:
                if i + 1 >= len(argv):
                    raise ToolError(f"Error: option {a} needs a value")
                v = argv[i + 1]
                i += 1
                if a in ("-f", "-l"):
                    try:
                        o["first" if a == "-f" else "last"] = int(v)
                    except ValueError:
                        raise ToolError(f"Error: option {a} needs a number, got '{v}'") from None
                elif a in ("-opw", "-upw"):
                    o["pw"] = v
            else:
                raise ToolError(f"Error: unknown option {a}")
        else:
            pos.append(a)
        i += 1
    if o.get("help"):
        return o
    if not pos or len(pos) > 2:
        raise ToolError("Usage: pdftotext [-layout] [-f N] [-l N] [-nopgbrk] PDF-file [text-file | -]")
    o["pdf"] = pos[0]
    if len(pos) == 2:
        o["out"] = pos[1]
    else:
        root = pos[0][:-4] if pos[0].lower().endswith(".pdf") else pos[0]
        o["out"] = root + ".txt"
    return o


def pdftotext(argv: list[str]) -> int:
    o = parse_pdftotext_args(argv)
    if o.get("help"):
        print("Usage: pdftotext [-layout] [-f N] [-l N] [-nopgbrk] PDF-file [text-file | -]  (HumanStudy shim)")
        return 0
    with _open_plumber(o["pdf"], o["pw"]) as pdf:
        n = len(pdf.pages)
        pages = []
        for i in _page_range(n, o["first"], o["last"]):
            pages.append(page_text(pdf, i, o["layout"]) + "\n")  # poppler ends every page with a newline
        sep = "" if o["nopgbrk"] else "\f"
        _write("".join(p + sep for p in pages), o["out"])
    return 0


def pdfinfo(argv: list[str]) -> int:
    pos = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("-") and a != "-":
            if a in VALUED:
                i += 1
        else:
            pos.append(a)
        i += 1
    if len(pos) != 1:
        raise ToolError("Usage: pdfinfo [options] PDF-file")
    path = pos[0]
    if not os.path.isfile(path):
        raise ToolError(f"Error: Couldn't open file '{path}'.")
    from pypdf import PdfReader

    try:
        r = PdfReader(path)
        encrypted = r.is_encrypted
        if encrypted:
            try:
                r.decrypt("")
            except Exception:  # noqa: BLE001
                pass
        n = len(r.pages)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Error: Couldn't read '{path}': {type(e).__name__}: {e}") from None
    meta = r.metadata or {}
    out = []

    def field(label: str, value) -> None:
        if value not in (None, ""):
            out.append(f"{label + ':':<17}{value}")

    field("Title", meta.get("/Title"))
    field("Author", meta.get("/Author"))
    field("Creator", meta.get("/Creator"))
    field("Producer", meta.get("/Producer"))
    field("CreationDate", meta.get("/CreationDate"))
    field("Encrypted", "yes" if encrypted else "no")
    if n:
        b = r.pages[0].mediabox
        w, h = float(b.width), float(b.height)
        field("Page size", f"{w:g} x {h:g} pts")
    field("Pages", n)
    field("PDF version", (r.pdf_header or "").replace("%PDF-", "") or None)
    _write("\n".join(out) + "\n", "-")
    return 0


def hs_pdf(argv: list[str]) -> int:
    usage = (
        "Usage:\n"
        "  hs-pdf pages paper.pdf [--from N] [--to N] [--layout]   text, one '=== page N ===' block per page\n"
        "  hs-pdf info paper.pdf                                   page count and metadata\n"
    )
    if not argv or argv[0] in ("-h", "--help", "help"):
        sys.stdout.write(usage)
        return 0 if argv else 2
    cmd, rest = argv[0], argv[1:]
    if cmd == "info":
        return pdfinfo(rest)
    if cmd != "pages":
        raise ToolError(f"Error: unknown command '{cmd}'\n{usage}")
    path, first, last, layout = None, None, None, False
    i = 0
    while i < len(rest):
        a = rest[i]
        if a in ("--from", "--to", "-f", "-l"):
            if i + 1 >= len(rest):
                raise ToolError(f"Error: {a} needs a number")
            try:
                v = int(rest[i + 1])
            except ValueError:
                raise ToolError(f"Error: {a} needs a number") from None
            if a in ("--from", "-f"):
                first = v
            else:
                last = v
            i += 1
        elif a == "--layout":
            layout = True
        elif a.startswith("-"):
            raise ToolError(f"Error: unknown option {a}")
        elif path is None:
            path = a
        else:
            raise ToolError(usage)
        i += 1
    if path is None:
        raise ToolError(usage)
    blank = []
    chunks = []
    with _open_plumber(path) as pdf:
        n = len(pdf.pages)
        for i in _page_range(n, first, last):
            t = page_text(pdf, i, layout)
            if not t.strip():
                blank.append(i + 1)
            chunks.append(f"=== page {i + 1} ===\n{t}\n")
    _write("\n".join(chunks), "-")
    if blank:
        shown = ", ".join(map(str, blank[:20])) + (" ..." if len(blank) > 20 else "")
        sys.stderr.write(
            f"hs-pdf: no text on page(s) {shown}: scanned or image-only. OCR is not available in this runtime; "
            "say so to the researcher instead of guessing the content.\n"
        )
    return 0


TOOLS = {"pdftotext": pdftotext, "pdfinfo": pdfinfo, "hs-pdf": hs_pdf}


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] not in TOOLS:
        sys.stderr.write("usage: python -m hs_pdf_tools {pdftotext|pdfinfo|hs-pdf} ...\n")
        return 2
    try:
        return TOOLS[argv[0]](argv[1:])
    except ToolError as e:
        sys.stderr.write(str(e).rstrip() + "\n")
        return 1
    except BrokenPipeError:
        return 0


if __name__ == "__main__":
    sys.exit(main())
