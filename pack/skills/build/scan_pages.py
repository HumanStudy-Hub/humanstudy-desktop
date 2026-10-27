#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# dependencies = ["pypdf", "pypdfium2"]
# ///
"""Read scanned PDF pages: render them as images and OCR them when Tesseract is installed.

    python .opencode/skills/build/scan_pages.py paper.pdf            # every page without a text layer
    python .opencode/skills/build/scan_pages.py paper.pdf --pages 4,7-9 --image   # images only, e.g. tables

For each page it writes `.humanstudy/pages/<pdf name>/page-NNN.png` and, for scanned pages with
Tesseract available, `page-NNN.txt` with the OCR text, then prints the text as `=== page N (ocr) ===`
blocks. `manifest.json` records the PDF's hash so check_quotes.py only uses OCR text of the same file.

OCR text is a reading aid, not a transcription: it confuses 0/O, 1/l, minus signs, decimals and
superscripts. Open the page image to confirm every number and every verbatim passage you take from an
OCR page. Without Tesseract, read the page images directly and mark quotes from them `unverified`.
Renders with pypdfium2 (in the HumanStudy runtime) or poppler's pdftoppm.
"""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_quotes import Pdf  # noqa: E402  same text reader as the quote check

DPI = 300


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pages_dir(pdf):
    """Where page images and OCR text of `pdf` live: <project>/.humanstudy/pages/<pdf stem>/."""
    pdf = Path(pdf).resolve()
    root = pdf.parent
    for parent in [pdf.parent] + list(pdf.parents):
        if (parent / "program.json").is_file() or (parent / ".humanstudy").is_dir():
            root = parent
            break
    rel = pdf.relative_to(root) if root in pdf.parents else Path(pdf.name)
    return root / ".humanstudy" / "pages" / str(rel.with_suffix("")).replace("/", "__").replace("\\", "__")


def render(pdf, number, target):
    try:
        import pypdfium2
        doc = pypdfium2.PdfDocument(str(pdf))
        try:
            doc[number - 1].render(scale=DPI / 72).to_pil().save(str(target))
        finally:
            doc.close()
        return True
    except ImportError:
        pass
    if shutil.which("pdftoppm"):
        stem = str(target)[:-4]
        run = subprocess.run(["pdftoppm", "-r", str(DPI), "-f", str(number), "-l", str(number), "-png",
                              "-singlefile", str(pdf), stem], capture_output=True)
        return run.returncode == 0 and target.is_file()
    return False


def ocr(image, language):
    exe = shutil.which("tesseract")
    if not exe:
        return None
    run = subprocess.run([exe, str(image), "stdout", "-l", language], capture_output=True)
    if run.returncode != 0:
        return None
    return run.stdout.decode("utf-8", "replace")


def parse_pages(spec, count):
    out = []
    for part in (spec or "").split(","):
        part = part.strip()
        if not part:
            continue
        a, _, b = part.partition("-")
        out += range(int(a), int(b or a) + 1)
    return [p for p in out if 1 <= p <= count]


def load_manifest(folder, digest):
    try:
        m = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        if m.get("sha256") == digest:
            return m
    except (OSError, ValueError):
        pass
    return {"sha256": digest, "pages": {}}


def ocr_text(pdf, number):
    """OCR text saved by this tool for page `number` of this exact PDF, or None."""
    folder = pages_dir(pdf)
    try:
        m = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
        if m.get("pages", {}).get(str(number), {}).get("mode") != "ocr" or m.get("sha256") != sha256(pdf):
            return None
        return (folder / ("page-%03d.txt" % number)).read_text(encoding="utf-8")
    except (OSError, ValueError):
        return None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf")
    ap.add_argument("--pages", help="pages to process, e.g. 3,5-7 (default: pages without a text layer)")
    ap.add_argument("--image", action="store_true", help="render images only, no OCR")
    ap.add_argument("--lang", default="eng", help="Tesseract language(s), e.g. eng+deu")
    a = ap.parse_args(argv)
    pdf = Path(a.pdf).resolve()
    if not pdf.is_file():
        print("error: no such file: %s" % a.pdf, file=sys.stderr)
        return 1
    texts = Pdf(pdf).load()
    try:
        import pypdf
        count = len(pypdf.PdfReader(str(pdf)).pages)
    except Exception:
        count = len(texts)
    scanned = [n for n in range(1, count + 1) if n > len(texts) or len(texts[n - 1].strip()) < 40]
    wanted = parse_pages(a.pages, count) if a.pages else scanned
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    if not wanted:
        print("=== every page of %s has a text layer; read it with hs-pdf pages or pdf_pages.py ===" % pdf.name)
        return 0
    folder = pages_dir(pdf)
    folder.mkdir(parents=True, exist_ok=True)
    digest = sha256(pdf)
    manifest = load_manifest(folder, digest)
    has_ocr = shutil.which("tesseract") is not None and not a.image
    failed = []
    for n in wanted:
        image = folder / ("page-%03d.png" % n)
        if not image.is_file() and not render(pdf, n, image):
            failed.append(n)
            continue
        entry = {"mode": "image", "image": image.name}
        text = ocr(image, a.lang) if has_ocr and n in scanned else None
        if text and len(text.strip()) >= 40:
            (folder / ("page-%03d.txt" % n)).write_text(text, encoding="utf-8")
            entry.update(mode="ocr", text="page-%03d.txt" % n)
            print("=== page %d (ocr: confirm numbers and quotes on %s) ===" % (n, image))
            print(text.strip())
        else:
            print("=== page %d (image: %s) ===" % (n, image))
        manifest["pages"][str(n)] = entry
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    note = []
    if scanned and not has_ocr and not a.image:
        note.append("Tesseract is not installed: read the page images and mark their quotes unverified")
    if failed:
        note.append("could not render pages " + ", ".join(map(str, failed)) + " (no pypdfium2 or pdftoppm)")
    print("=== %d page(s) of %s in %s%s ===" % (len(wanted) - len(failed), pdf.name, folder,
                                             "; " + "; ".join(note) if note else ""))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
