#!/usr/bin/env python3
"""Print a PDF's text page by page, with the physical page number to cite.

    python pdf_pages.py paper.pdf [--from N] [--to M]

Prints one `=== page N ===` block per page. Pages with no text layer are scanned images: there is no
OCR here, so say which pages could not be read instead of guessing. Uses pypdf, pdfplumber or the
pdftotext command, whichever is available.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "build"))
from check_quotes import Pdf  # noqa: E402  same reader as the quote check


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("--from", dest="first", type=int, default=1)
    ap.add_argument("--to", dest="last", type=int)
    a = ap.parse_args(argv)
    pages = Pdf(a.pdf).load()
    if not pages:
        print("error: no PDF reader available; install pypdf (pip install pypdf) or poppler's pdftotext",
              file=sys.stderr)
        return 1
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    empty = []
    for n in range(max(1, a.first), min(len(pages), a.last or len(pages)) + 1):
        text = pages[n - 1].strip()
        if len(text) < 40:
            empty.append(n)
        print("=== page %d ===" % n)
        print(text or "[no text layer: scanned page]")
    print("=== %d pages in %s%s ===" % (len(pages), Path(a.pdf).name,
                                        "; no text on pages " + ", ".join(map(str, empty)) if empty else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
