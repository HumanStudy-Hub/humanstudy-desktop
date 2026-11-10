"""Distribution tiers and link + hash rehydration (DESIGN §3.6). Standard library only.

A source's participant-facing text reaches users in one of three tiers:

    hosted  the source's licence allows commercial redistribution (CC-BY, CC0, public domain): the text ships
    link    reachable by URL / DOI (open or paywalled), not redistributable: the package ships the URL and, per item, a locator
            and the sha256 of the exact served text; the user's machine fetches the file and extracts each item
    user    gone: the user supplies the file; the same checks

One rule for every source: each item is verified by its own text_sha256; the file sha256 (stamped publisher PDFs
differ per download) is provenance only and never gates reading or serving.

This module holds the shared mechanics: the canonical text form and its restore operations, the text units of every
supported source format, `locate` (build time, on the builder's private copy of the source) and `rehydrate` (on the
user's machine). `hsenv.release.project` builds the distributable projection with them.

Determinism. A locator never stores character offsets into an extractor's output. It stores a unit range (PDF pages,
docx paragraphs, text lines, HTML blocks, QSF question fields), the length of the item in canonical form and the
restore operations that turn the canonical form back into the exact served text. Canonical form = NFC, then per
character NFKC with quote and hyphen folding, and every whitespace / soft-hyphen / zero-width character removed
(case and underscore runs are kept; a blank printed at another length is a short literal of a composed locator). So extractors that differ in spacing, line breaks, ligatures or curly quotes still
yield the same canonical stream; the sha256 of the restored text is the only test of success. Every format except
PDF is extracted by this module (one implementation on both sides, versioned in EXTRACTORS); PDF needs an extractor
the app supplies (`extractors={"pdf": fn(bytes) -> [page texts]}`).
"""
import hashlib
import html
import html.parser
import io
import json
import re
import unicodedata
import zipfile
import xml.etree.ElementTree as ET

TIERS = ("hosted", "link", "user")
PLACEHOLDER = "░"          # one per character of a held text in a projection (marked, same length)
WITHHELD = "withheld:"          # prefix of an operator string replaced because it quotes held text
FORMATS = ("pdf", "docx", "html", "qsf", "text")
# version of each built-in extractor; a locator records it, and an extractor's behaviour never changes under a version
EXTRACTORS = {"docx": "hsenv-docx/1", "html": "hsenv-html/1", "qsf": "hsenv-qsf/1", "text": "hsenv-text/1"}
MAX_UNITS = 8                   # widest unit window of one part (a text over at most 8 pages / paragraphs)
STATUSES = ("ok", "ok_image", "hash_mismatch", "source_unavailable", "needs_user_file", "requires_reading")
PDF_EXTRACTOR_FAMILY = "pypdfium2/"   # the one PDF extractor the app ships (maintainer decision)
REGION_DPI = (72, 600)               # accepted render resolutions of a region locator

_FOLD = {"‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
         "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
         "‐": "-", "‑": "-", "‒": "-", "−": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-",
         "\u02bc": "'"}
# compatibility forms NFKC may expand although they are letters: typographic ligatures only. Any other letter or
# digit is kept as it is (never folded), so restore ops can never carry a text's letters (fullwidth / halfwidth /
# presentation forms are not matched across forms; they fail as hash_mismatch, never leak)
_LIGATURES = frozenset("\ufb00\ufb01\ufb02\ufb03\ufb04\ufb05\ufb06")
_IGNORABLE = frozenset("­​‌‍⁠﻿")
# a hyphen followed by white space between letters: "experi-\nment", or "experi-  ment" from an extractor that
# joins lines with spaces. The dehyphenated stream is an extra candidate, never the only one; a wrong join cannot
# pass the text_sha256 check.
_HYPHEN_BREAK = re.compile(r"(?<=[^\W\d_])[-\u2010\u00ad]\s+(?=[^\W\d_])")


class DistributionError(ValueError):
    pass


def sha256(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode("utf-8")).hexdigest()


def text_sha256(text):
    """sha256 of the NFC-normalised exact served text (the per-item check)."""
    return sha256(unicodedata.normalize("NFC", text))


# ------------------------------------------------------------------------------------------- canonical form
_PIECES = {}


def _piece(ch):
    p = _PIECES.get(ch)
    if p is None:
        if ch.isspace() or ch in _IGNORABLE:
            p = ""
        elif ch in _FOLD:
            p = _FOLD[ch]
        elif (ch.isalnum() or unicodedata.category(ch).startswith("M")) and ch not in _LIGATURES:
            p = ch
        else:
            p = "".join(_FOLD.get(x, x) for x in unicodedata.normalize("NFKC", ch)
                        if not x.isspace() and x not in _IGNORABLE)
        if len(_PIECES) < 100000:
            _PIECES[ch] = p
    return p


def canon_only(text):
    """The canonical form alone (no restore ops): NFC; quote / hyphen / dash forms folded; NFKC for punctuation,
    symbols and typographic ligatures only (letters, digits and marks are kept); whitespace, soft hyphens and
    zero-width characters removed. Case is kept."""
    return "".join(map(_piece, unicodedata.normalize("NFC", text)))


def canon(text):
    """(canonical string, restore ops); restore(*canon(t)) == NFC(t). An op [i, n, s] replaces the n canonical
    characters at i with s (n = 0: an insertion). Ops hold only what the canonical form drops or folds — whitespace,
    quote and dash forms, compatibility characters — never a run of the text's own letters."""
    s = unicodedata.normalize("NFC", text)
    out, ops, ci = [], [], 0
    for ch in s:
        piece = _piece(ch)
        if piece != ch:
            if ops and ops[-1][0] + ops[-1][1] == ci:
                ops[-1][1] += len(piece)
                ops[-1][2] += ch
            else:
                ops.append([ci, len(piece), ch])
        out.append(piece)
        ci += len(piece)
    return "".join(out), ops


def restore(c, ops):
    res, pos = [], 0
    for i, n, s in ops:
        res.append(c[pos:i])
        res.append(s)
        pos = i + n
    res.append(c[pos:])
    return "".join(res)


class Scope:
    """The canonical streams of a source's units: `plain` (as extracted) and `dehyphenated` (a hyphen at a line end
    between letters removed, inside a unit or across a unit boundary). Both sides of rehydration use this one
    definition, so a window's stream is the same at build time and on the user's machine."""

    def __init__(self, us):
        self.units = us
        self.plain = [canon_only(u) for u in us]
        dh = [canon_only(_HYPHEN_BREAK.sub("", u)) for u in us]
        for i in range(len(us) - 1):   # "experi-" | "ment" on the next page / paragraph
            if re.search(r"[^\W\d_][-\u2010][ \t]*$", us[i]) and re.match(r"\s*[^\W\d_]", us[i + 1]) and dh[i]:
                dh[i] = dh[i][:-1]
        self.dehyph = dh
        self._full = {}

    def window(self, a, b):
        """Canonical streams of units a..b (inclusive), deduplicated."""
        a, b = max(0, a), min(len(self.units) - 1, b)
        if a > b:
            return []
        p = "".join(self.plain[a:b + 1])
        d = "".join(self.dehyph[a:b]) + (canon_only(_HYPHEN_BREAK.sub("", self.units[b])) if b >= a else "")
        return [p] if p == d else [p, d]

    def full(self, which):
        if which not in self._full:
            parts = self.plain if which == "plain" else self.dehyph
            offs, pos = [], 0
            for x in parts:
                offs.append(pos)
                pos += len(x)
            self._full[which] = ("".join(parts), offs)
        return self._full[which]

    def contains_unit(self, c):
        """c lies inside one unit (per-item sources: a part never spans a page, so stamps between pages cannot
        break it)."""
        return any(c in u for u in self.plain) or any(c in u for u in self.dehyph)

    def contains(self, c):
        return any(c in self.full(w)[0] for w in ("plain", "dehyph"))

    def span(self, c, hint=None, max_units=None):
        """The smallest unit window [a, b] holding c (nearest the hint unit among the first 64 occurrences)."""
        import bisect
        best = None
        for w in ("plain", "dehyph"):
            text, offs = self.full(w)
            i, k = text.find(c), 0
            while i >= 0 and k < 64:
                a = bisect.bisect_right(offs, i) - 1
                b = bisect.bisect_right(offs, i + len(c) - 1) - 1 if c else a
                key = (b - a, abs(a - hint) if hint is not None else 0, a)
                if best is None or key < best[0]:
                    best = (key, [a, b])
                i, k = text.find(c, i + 1), k + 1
        if best is None or (max_units and best[1][1] - best[1][0] + 1 > max_units):
            return None
        return best[1]


# ------------------------------------------------------------------------------------------- formats and units
def sniff(data):
    """The format of a source file from its bytes: pdf, docx, qsf, html or text."""
    if data[:5] == b"%PDF-":
        return "pdf"
    if data[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                if "word/document.xml" in z.namelist():
                    return "docx"
        except zipfile.BadZipFile:
            pass
        raise DistributionError("unsupported zip source (not a .docx)")
    head = data[:4096].decode("utf-8", "replace").lstrip("﻿ \t\r\n").lower()
    if head.startswith("{"):
        try:
            if "SurveyElements" in json.loads(data.decode("utf-8-sig")):
                return "qsf"
        except ValueError:
            pass
    if head.startswith(("<!doctype html", "<html")) or "<body" in head:
        return "html"
    return "text"


_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _docx_units(data):
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        root = ET.fromstring(z.read("word/document.xml"))
    units = []

    def walk(el, buf):
        tag = el.tag
        if tag == _W + "p":
            mine = []
            for ch in el:
                walk(ch, mine)
            units.append("".join(mine))   # a nested paragraph (text box) is its own unit, before its host
            return
        if tag == _W + "delText":
            return   # tracked deletion: not on the page
        if tag == _W + "t":
            buf.append(el.text or "")
        elif tag == _W + "tab":
            buf.append("\t")
        elif tag in (_W + "br", _W + "cr"):
            buf.append("\n")
        elif tag == _W + "noBreakHyphen":
            buf.append("-")
        for ch in el:
            walk(ch, buf)
    walk(root, [])
    return units


_BLOCK = frozenset("address article aside blockquote br caption dd div dl dt fieldset figcaption figure footer form h1 "
                   "h2 h3 h4 h5 h6 header hr label legend li main nav ol option p pre section summary table tbody td "
                   "tfoot th thead title tr ul".split())
_SKIP = frozenset(("script", "style", "noscript", "template", "head"))


class _Blocks(html.parser.HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.units, self.buf, self.skip = [], [], 0

    def flush(self):
        t = "".join(self.buf)
        if t.strip():
            self.units.append(t)
        self.buf = []

    def handle_starttag(self, tag, attrs):
        if tag in _SKIP:
            self.skip += 1
        elif tag in _BLOCK:
            self.flush()

    def handle_startendtag(self, tag, attrs):
        if tag in _BLOCK:
            self.flush()

    def handle_endtag(self, tag):
        if tag in _SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in _BLOCK:
            self.flush()

    def handle_data(self, d):
        if not self.skip:
            self.buf.append(d)


def _html_units(text):
    p = _Blocks()
    p.feed(text)
    p.close()
    p.flush()
    return p.units


def _qsf_units(data):
    """One unit per participant-facing field of each question, in file order: QuestionText, then every choice and
    answer Display (in ChoiceOrder / AnswerOrder when given, else key order). HTML is reduced to its text blocks."""
    d = json.loads(data.decode("utf-8-sig"))
    units = []

    def add(v):
        if isinstance(v, str) and v.strip():
            units.append("\n".join(_html_units(v)) if "<" in v else html.unescape(v))

    for el in d.get("SurveyElements") or []:
        if not isinstance(el, dict) or el.get("Element") != "SQ" or not isinstance(el.get("Payload"), dict):
            continue
        pl = el["Payload"]
        add(pl.get("QuestionText"))
        for key, order in (("Choices", "ChoiceOrder"), ("Answers", "AnswerOrder")):
            ch = pl.get(key)
            if isinstance(ch, dict):
                ks = [str(k) for k in pl.get(order) or []] or list(ch)
                for k in ks + [k for k in ch if k not in ks]:
                    if isinstance(ch.get(k), dict):
                        add(ch[k].get("Display"))
    return units


def units(fmt, data, extractors=None):
    """The ordered text units of a source file: PDF pages (from the injected extractor), docx paragraphs, HTML text
    blocks, QSF question fields, text lines."""
    if fmt in (extractors or {}):
        return [str(u) for u in extractors[fmt](data)]
    if fmt == "pdf":
        raise DistributionError("no PDF extractor: pass extractors={'pdf': fn(bytes) -> [page texts]}")
    if fmt == "docx":
        return _docx_units(data)
    if fmt == "qsf":
        return _qsf_units(data)
    text = data.decode("utf-8-sig") if isinstance(data, bytes) else data
    if fmt == "html":
        return _html_units(text)
    if fmt == "text":
        return text.splitlines()
    raise DistributionError("unknown source format %r" % (fmt,))


def extractor_name(fmt, extractors=None):
    fn = (extractors or {}).get(fmt)
    if fn is not None:
        return str(getattr(fn, "name", None) or getattr(fn, "__name__", "custom"))
    return EXTRACTORS.get(fmt, fmt)


def pdfium_extractor():
    """The fixed PDF extractor: pypdfium2's text page of every page (`get_text_range`), named with the exact
    pypdfium2 and PDFium versions. pypdfium2 is optional (hsenv's runtime is the standard library): ImportError when
    it is not installed. Builders self-test with it; rehydration refuses a locator written by another extractor."""
    import pypdfium2 as pdfium
    import pypdfium2.version as v

    def extract(data):
        doc = pdfium.PdfDocument(data)
        try:
            out = []
            for i in range(len(doc)):
                page = doc[i]
                tp = page.get_textpage()
                out.append(tp.get_text_range())
                tp.close()
                page.close()
            return out
        finally:
            doc.close()
    extract.name = "%s%s+pdfium/%s" % (PDF_EXTRACTOR_FAMILY, v.PYPDFIUM_INFO, v.PDFIUM_INFO)
    return extract


def region_locator(source, page, region):
    """A `region` locator (the app renders this part of the user's verified copy as an image), or None when the
    region is not well formed. region = {box: [x0, y0, x1, y1] page-relative (0-1, origin top left), dpi, page?}."""
    if not isinstance(region, dict):
        return None
    box, dpi, pg = region.get("box"), region.get("dpi", 150), region.get("page", page)
    if not (isinstance(box, list) and len(box) == 4 and all(isinstance(x, (int, float)) and not isinstance(x, bool)
                                                            and 0 <= x <= 1 for x in box)
            and box[0] < box[2] and box[1] < box[3]):
        return None
    if not (isinstance(dpi, int) and not isinstance(dpi, bool) and REGION_DPI[0] <= dpi <= REGION_DPI[1]):
        return None
    if not (isinstance(pg, int) and not isinstance(pg, bool) and pg >= 1):
        return None
    return {"format": "region", "source": source, "page": pg, "box": [float(x) for x in box], "dpi": dpi}


# ------------------------------------------------------------------------------------------- locate / find
ANCHOR_PART = 12                # shorter texts never count towards a page's anchor total
STAMP_TOLERANCE = 400           # canonical characters stamp lines may add before / after an anchor on its page
ANCHOR_MIN = 16                 # verified anchor text a page needs before a region of it is rendered
TOTAL_BUDGET = 4_000_000_000    # characters all searches of one rehydration may hash (tens of seconds at most)
STAMP_BUDGET = 400_000_000      # characters the stamp retry may hash in one rehydration (a few seconds)
MAX_HASH_WORK = 200_000_000   # characters hashed for one part in one window (about a second)
MAX_CANON = 100000         # longest canonical part `find` will search for (a crafted locator cannot ask for more)
MIN_PART = 8               # a source part of a composed text is at least this many canonical characters ...
MAX_LITERAL_SHARE = 0.2    # ... and literal characters (not in the source) are at most this share of the text


def _parts(c, scope, per_unit=False):
    """Greedy split of a canonical text into source parts (longest first) and short literals (characters the
    source does not have at that point, e.g. a blank of another length or a substituted amount); None when the text
    is not essentially in the source."""
    contains = scope.contains_unit if per_unit else scope.contains
    if contains(c):
        return [("src", c)]
    parts, i, lit, n_lit = [], 0, [], 0
    budget = max(2, MAX_LITERAL_SHARE * len(c))
    while i < len(c):
        if n_lit > budget:
            return None
        lo, hi = i, len(c)   # longest j with c[i:j] in the source (monotone: binary search)
        if i + MIN_PART > len(c) or not contains(c[i:i + MIN_PART]):
            hi = i   # no part of the minimum length starts here: one literal character
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if contains(c[i:mid]):
                lo = mid
            else:
                hi = mid - 1
        if lo - i >= MIN_PART:
            if lit:
                parts.append(("lit", "".join(lit)))
                lit = []
            parts.append(("src", c[i:lo]))
            i = lo
        else:
            if c[i].isalnum():
                return None   # a literal may only be punctuation / a blank: letters and digits never ship
            lit.append(c[i])
            n_lit += 1
            i += 1
    if lit:
        parts.append(("lit", "".join(lit)))
    n_lit = sum(len(x) for k, x in parts if k == "lit")
    if n_lit > max(2, MAX_LITERAL_SHARE * len(c)) or len(parts) > 2 * MAX_UNITS + 1:
        return None
    return parts


def make_locator(text, fmt, us, extractors=None, hint=None, scope=None, per_unit=False):
    """Build time: the locator of one held text in the builder's units, self-tested through `find`, or None.

    {format, extractor, parts: [{units: [a, b], canon_len, canon_sha256} | {literal}], restore[, pages]}
    A plain verbatim text is one part; a text composed from the source (cut, joined, a blank of another length) is
    several, with short literals between them."""
    scope = scope or Scope(us)
    c, ops = canon(text)
    if not c:
        return None
    ps = _parts(c, scope, per_unit)
    if ps is None:
        return None
    parts = []
    for kind, x in ps:
        if kind == "lit":
            parts.append({"literal": x})
            continue
        sp = scope.span(x, hint, MAX_UNITS)
        if sp is None:
            return None
        part = {"units": sp, "canon_len": len(x), "canon_sha256": sha256(x)}
        if sp[0] == sp[1]:   # unique: in no neighbouring unit (a page-anchor for regions only if unique)
            part["unique"] = not any(x in v for u in (sp[0] - 1, sp[0] + 1) if 0 <= u < len(us)
                                     for v in scope.window(u, u))
            v0 = next((v for v in scope.window(sp[0], sp[0]) if x in v), "")
            if v0:   # where it sits on its page: canonical characters before and after it (two numbers, no text)
                part["before"], part["after"] = v0.index(x), len(v0) - v0.index(x) - len(x)
        parts.append(part)
    loc = {"format": fmt, "extractor": extractor_name(fmt, extractors), "parts": parts, "restore": ops}
    if fmt == "pdf":
        src = [p["units"] for p in parts if "units" in p]
        loc["pages"] = [min(u[0] for u in src) + 1, max(u[1] for u in src) + 1]   # for people
    if per_unit:
        loc["per_unit"] = True
    if find(scope, loc, text_sha256(text), widen=0) is None:   # the user's path must recover it exactly
        return None
    return loc


def _same_place(part, pos):
    """The anchor sits where it sat on the builder's page: as many canonical characters before and after it, up to
    what stamp lines may add (never fewer, beyond a few). A reflowed edition moves it and fails."""
    b, a = part.get("before"), part.get("after")
    if not (isinstance(b, int) and isinstance(a, int)) or not pos:
        return False
    ub, ua = pos
    return b - 8 <= ub <= b + STAMP_TOLERANCE and a - 8 <= ua <= a + STAMP_TOLERANCE


def _unstamped(unit, max_block=3, max_lines=80):
    """Variants of one unit with a block of 1..max_block consecutive lines removed: a per-download stamp line
    (watermark, "downloaded by …") that the extractor placed inside an item."""
    lines = unit.split("\n")
    if len(lines) > max_lines:
        return
    for k in range(1, max_block + 1):
        for i in range(0, len(lines) - k + 1):
            yield "\n".join(lines[:i] + lines[i + k:])


def _scan_at(v, n, h, budget=None):
    """The offset of the canonical substring of length n of v whose sha256 is h, or None (budget: {"left": chars})."""
    work = (len(v) - n + 1) * n
    if work > MAX_HASH_WORK:
        return None
    if budget is not None:
        if budget["left"] < work:
            return None
        budget["left"] -= work
    for i in range(0, len(v) - n + 1):
        if sha256(v[i:i + n]) == h:
            return i
    return None


def _scan_stream(v, n, h, budget=None):
    i = _scan_at(v, n, h, budget)
    return None if i is None else v[i:i + n]


def find_ex(scope, loc, want_sha, widen=1, stamped=False, budget=None, stamp_units=None, total=None):
    """find(), returning (text or None, matched): matched lists, per source part, the unit (0-based) the part matched
    in this copy, or None for a part spanning several units or one that matched on more than one of the candidate
    units (the recorded unit and its neighbours): a repeated text cannot say which page it is on. Single-unit parts
    (every PDF part) are searched on every candidate unit. `total` ({"left": chars}) bounds all hashing.
    stamped: if a single-unit part is not found, retry each candidate unit without each block of 1-3 lines (a
    stamp line inside the item), only on units in `stamp_units` when given, spending `budget`."""
    if not isinstance(scope, Scope):
        scope = Scope(scope)
    parts = loc.get("parts")
    if not isinstance(parts, list) or not parts or len(parts) > 2 * MAX_UNITS + 1:
        return None, []
    got, matched, positions = [], [], []
    nunits = len(scope.units)
    for part in parts:
        if not isinstance(part, dict):
            return None, []
        if "literal" in part:
            if not isinstance(part["literal"], str) or any(ch.isalnum() for ch in part["literal"]):
                return None, []
            got.append(part["literal"])
            continue
        u, n, h = part.get("units"), part.get("canon_len"), part.get("canon_sha256")
        if not (isinstance(u, list) and len(u) == 2 and all(isinstance(x, int) and not isinstance(x, bool) for x in u)
                and 0 <= u[0] <= u[1] and u[1] - u[0] < MAX_UNITS and isinstance(n, int) and 0 < n <= MAX_CANON
                and isinstance(h, str)):
            return None, []
        a, b = u
        hit, where = None, None
        if a == b:
            cands = [x for x in [a] + [y for d in range(1, widen + 1) for y in (a - d, a + d)] if 0 <= x < nunits]
            hits = {}   # unit -> (text, chars before it, chars after it on that unit's canonical stream)
            for x in cands:
                for v in scope.window(x, x):
                    i = _scan_at(v, n, h, total)
                    if i is not None:
                        hits[x] = (v[i:i + n], i, len(v) - i - n)
                        break
            if not hits and stamped:
                for x in cands:
                    if stamp_units is not None and x not in stamp_units:
                        continue
                    found_x = None
                    for variant in _unstamped(scope.units[x]):
                        for v in {canon_only(variant), canon_only(_HYPHEN_BREAK.sub("", variant))}:
                            i = _scan_at(v, n, h, budget)
                            if i is not None:
                                found_x = (v[i:i + n], i, len(v) - i - n)
                                break
                        if found_x is not None:
                            break
                    if found_x is not None:
                        hits[x] = found_x
            if hits:
                hit = next(iter(hits.values()))[0]   # the same canonical text wherever it matched
                if len(hits) == 1:   # one candidate page matched: where, and the text around it there
                    where = next(iter(hits))
                    positions.append(hits[where][1:])
                else:
                    where = None     # ambiguous page: unknown
                    positions.append(None)
        else:
            for lo, hi in ((a, b), (a - widen, b + widen)) if widen else ((a, b),):
                for v in scope.window(lo, hi):
                    hit = _scan_stream(v, n, h, total)
                    if hit is not None:
                        break
                if hit is not None:
                    break
        if hit is None:
            return None, []
        if a != b:
            positions.append(None)
        got.append(hit)
        matched.append(where)
    ops = loc.get("restore") or []
    if not isinstance(ops, list) or not all(isinstance(x, list) and len(x) == 3 and isinstance(x[0], int)
                                            and isinstance(x[1], int) and isinstance(x[2], str) for x in ops):
        return None, []
    cand = restore("".join(got), [list(x) for x in ops])
    if text_sha256(cand) != want_sha:
        return None, []
    if isinstance(loc, dict) and isinstance(loc.get("_positions"), list):
        loc["_positions"][:] = positions   # (before, after) per source part, for the region guard
    return unicodedata.normalize("NFC", cand), matched


def find(scope, loc, want_sha, widen=1, stamped=False):
    """User's machine: the exact served text, or None. Each source part is the canonical substring of the recorded
    length, inside its unit window (then widened by `widen` units), whose sha256 is the part's canon_sha256;
    literals are taken as they are; the joined canonical text is restored with the recorded ops and accepted only if
    its NFC sha256 equals the item's text_sha256."""
    return find_ex(scope, loc, want_sha, widen, stamped)[0]


# ------------------------------------------------------------------------------------------- rehydrate
def _pointer(path):
    return [t.replace("~1", "/").replace("~0", "~") for t in path.split("/")[1:]]


def _get(doc, path):
    if not path.startswith("/"):
        raise ValueError("not a JSON pointer")
    for t in _pointer(path):
        doc = doc[int(t)] if isinstance(doc, list) else doc[t]
    return doc


def _set(doc, path, value):
    if not path.startswith("/"):
        raise ValueError("not a JSON pointer")
    toks = _pointer(path)
    for t in toks[:-1]:
        doc = doc[int(t)] if isinstance(doc, list) else doc[t]
    last = toks[-1]
    if isinstance(doc, list):
        doc[int(last)] = value
    else:
        doc[last] = value


def _image_position(doc, path):
    """Where an image-read text can become a rendered image: ('line', list, index) for an image's text line,
    ('dict', d) for a {text, cite} value, ('value', item) for a stage item's literal value; None elsewhere (option
    labels, prompts …: no image there)."""
    toks = _pointer(path)
    parent = _get(doc, "".join("/" + t.replace("~", "~0").replace("/", "~1") for t in toks[:-1])) if toks[:-1] else doc
    last = toks[-1]

    def image_at(k):   # the dict holding `lines` must be an image (it has a src)
        img = _get(doc, "".join("/" + t.replace("~", "~0").replace("/", "~1") for t in toks[:k]))
        return isinstance(img, dict) and isinstance(img.get("src"), str)
    if isinstance(parent, list) and len(toks) >= 2 and toks[-2] == "lines":
        if not image_at(len(toks) - 2):
            return None
        return ("line", parent, int(last))
    if isinstance(parent, dict) and last == "text" and len(toks) >= 3 and toks[-3] == "lines":
        if not image_at(len(toks) - 3):
            return None
        gp = _get(doc, "".join("/" + t.replace("~", "~0").replace("/", "~1") for t in toks[:-2]))
        return ("line", gp, int(toks[-2]))
    if isinstance(parent, dict) and last == "text" and toks[0] == "data":
        return ("dict", parent)
    if isinstance(parent, dict) and last == "value" and len(toks) == 5 and toks[0] == "stages" and toks[2] == "content":
        return ("value", parent)
    return None


def _place_images(out, slots, remaining):
    """Turn rendered image-read texts into images: a {text} value or an item value becomes {"src": regions/<id>.png};
    an image's own text line is dropped (the rendered picture carries it), unless an unresolved item still points
    into that list (then the line becomes empty, so no path shifts)."""
    pinned = [r for r in remaining.values() if isinstance(r, dict) and "/lines/" in str(r.get("path"))]
    drops = {}
    for hid, pos in slots:
        src = "regions/%s.png" % hid
        if pos[0] == "dict":
            d = pos[1]
            d.pop("text", None)
            d.pop("spans", None)
            d["src"] = src
        elif pos[0] == "value":
            pos[1]["value"] = {"src": src}
            pos[1].pop("spans", None)
        else:
            drops.setdefault(id(pos[1]), (pos[1], []))[1].append(pos[2])
    for lst, idx in drops.values():
        keep_shape = bool(pinned)   # conservative: drop lines only when no unresolved line remains anywhere
        for i in sorted(set(idx), reverse=True):
            if keep_shape:
                lst[i] = {"text": ""} if isinstance(lst[i], dict) else ""
            else:
                del lst[i]


def _safe_src(src):
    """An http(s) URL (the engine serves those as they are), or a relative path inside the study (no absolute
    path, drive, '..', backslash, NUL or other scheme)."""
    import posixpath
    if isinstance(src, str) and re.match(r"https?://[^\s\x00]+$", src, re.I):
        return True
    return bool(isinstance(src, str) and src and "\x00" not in src and "\\" not in src
                and not src.startswith(("/", "~")) and not re.match(r"^[A-Za-z]:", src)
                and ".." not in posixpath.normpath(src).split("/") and not re.match(r"^[a-z][a-z0-9+.-]*:", src, re.I))


_HELD_ID = re.compile(r"h[0-9]{1,9}")


def rehydrate(projection, fetch=None, files=None, extractors=None, items=None):
    """Rebuild the protocol from a projection on the user's machine.

    fetch       callable(url) -> bytes; the only network access (the app supplies it); any exception = unavailable
    files       {source key: bytes}: user-supplied source files
    items       {held id: bytes} a picture file (checked against its sha256); {held id: str} a reading of an
                image-read text (accepted only if it hashes to text_sha256). Separate from `files`, so a source
                key can never be taken for a held id.
    extractors  {"pdf": fn(bytes) -> [page texts]} and optional overrides

    Returns (protocol, report). report = {"items": {held id: {status, source, path, kind, detail?}},
    "sources": {key: {tier, status, file_sha256, matches_recorded_sha256}}, "complete": bool, "assets": {held id:
    bytes}, "renders": {held id: region + src}}. The file sha256 is provenance only; an item whose extracted text
    does not hash to its text_sha256 keeps its placeholder. Unresolved items stay in protocol["distribution"]["held"].
    """
    import copy
    files = {k: v for k, v in (files or {}).items() if isinstance(v, (bytes, bytearray))}
    supplied = dict(items or {})
    dist = projection.get("distribution") or {}
    held = dist.get("held") if isinstance(dist, dict) and isinstance(dist.get("held"), dict) else {}
    out = copy.deepcopy(projection)
    srcs = (projection.get("meta") or {}).get("sources") or {}
    srcs = srcs if isinstance(srcs, dict) else {}
    report_items, sources, cache, assets = {}, {}, {}, {}

    def distribution_of(key):
        v = srcs.get(key) if isinstance(key, str) else None
        d = v.get("distribution") if isinstance(v, dict) else None
        return d if isinstance(d, dict) else {"tier": "user"}

    def source_units(key, fmt_hint):
        """(Scope, None) or (None, (status, detail))."""
        if ("units", key) in cache:
            return cache[("units", key)]
        got, err = source_file(key)
        if err:
            res = (None, err)
        else:
            d = distribution_of(key)
            fmt = d.get("format") or fmt_hint or sniff(got)
            try:
                res = (Scope(units(fmt, got, extractors)), None)
                sources[key].update(format=fmt)
            except Exception as e:   # noqa: BLE001 - an unreadable source (no PDF extractor, broken zip)
                res = (None, ("source_unavailable", "cannot extract %s: %s" % (fmt, e)))
                sources[key].update(status="source_unavailable", detail=res[1][1])
        cache[("units", key)] = res
        return res

    def source_file(key):
        """(verified bytes, None) or (None, (status, detail))."""
        if key in cache:
            return cache[key]
        d = distribution_of(key)
        tier, want = d.get("tier"), d.get("sha256")
        # one rule for every source: the file sha256 is provenance only (publisher PDFs are stamped per download);
        # nothing is served unless the item's own text_sha256 verifies
        got, tried = None, []
        candidates = []
        if isinstance(files.get(key), (bytes, bytearray)):
            candidates.append(("file", lambda: bytes(files[key])))
        if tier == "link" and d.get("url") and fetch is not None:
            candidates.append(("fetch", lambda: fetch(d["url"])))
        for how, get in candidates:
            try:
                b = get()
            except Exception as e:   # noqa: BLE001 - the app's fetch may fail in any way: the source is unavailable
                tried.append("%s failed: %s" % (how, type(e).__name__))
                continue
            if not isinstance(b, (bytes, bytearray)):
                tried.append("%s returned no bytes" % how)
                continue
            got = bytes(b)
            break
        if got is None:
            if tier == "user":
                res = (None, ("needs_user_file", "; ".join(tried) or "supply the source file in files[%r]" % key))
            else:   # link: the download failed or no fetch was given; a user file in files[key] also works
                res = (None, ("source_unavailable", "; ".join(tried) or "no fetch given"))
            sources[key] = {"tier": tier, "status": res[1][0], "detail": res[1][1]}
        else:
            res = (got, None)
            sources[key] = {"tier": tier, "status": "ok", "file_sha256": sha256(got),
                            "matches_recorded_sha256": (sha256(got) == want) if isinstance(want, str) else None}
        cache[key] = res
        return res

    def slot(h):
        """The placeholder string a text item replaces (or the image dict), checked: a projection can only fill
        the positions it masked, never overwrite another field."""
        cur = _get(out, h["path"])
        if h.get("kind") == "image":
            if not (isinstance(cur, dict) and isinstance(cur.get("src"), str)):
                raise ValueError("image path does not name an image")
        elif not (isinstance(cur, str) and cur and set(cur) == {PLACEHOLDER} and len(cur) == h.get("length")):
            raise ValueError("path does not name a placeholder of the item's length")
        return cur

    def one(hid, h):
        rep = {"source": h.get("source"), "path": h.get("path"), "kind": h.get("kind", "text")}
        loc = h.get("locator") if isinstance(h.get("locator"), dict) else {}
        cur = slot(h)
        region = region_locator(h["source"], loc.get("page"), loc) if loc.get("format") == "region" else None

        def render(src):
            """ok_image: the region of the verified source file is rendered by the app as this image."""
            got, err = source_file(h["source"])
            if err:
                rep.update(status=err[0], detail=err[1])
                return False
            on_page = page_anchors.get((h["source"], region["page"]), [])
            # anchors: texts unique to their page and its neighbours, at least ANCHOR_PART characters each
            anchors = [x for x in on_page if x[5] and x[2] >= ANCHOR_PART]
            distinct = {x[4]: x for x in anchors}    # each distinct text counts once
            why = None
            if any(x[1] != "ok" for x in on_page):
                why = "a held text located on page %d did not verify in this copy" % region["page"]
            elif not anchors:
                why = ("no held text unique to page %d was located there at build time (no anchor; repeated "
                       "instructions cannot anchor a page)" % region["page"])
            elif sum(x[2] for x in distinct.values()) < ANCHOR_MIN or max(x[2] for x in anchors) < ANCHOR_MIN:
                why = "the verified anchor text on page %d is shorter than %d characters" % (region["page"], ANCHOR_MIN)
            elif len({x[3] for x in anchors}) != 1 or None in {x[3] for x in anchors}:
                why = "the anchors of page %d matched on no single page of this copy" % region["page"]
            if why:
                rep.update(status="needs_user_file", detail=why + ": the page is not trusted for a render")
                return False
            page = anchors[0][3] + 1   # the page of THIS copy where the anchors matched (a cover page shifts it)
            renders[hid] = dict(region, page=page, built_page=region["page"], src=src)
            rep["status"] = "ok_image"
            return True

        if h.get("kind") == "image":
            if not _safe_src(cur["src"]):
                rep.update(status="hash_mismatch", detail="unsafe image src %r" % (cur["src"],))
                return rep
            f = supplied.get(hid)
            if isinstance(f, (bytes, bytearray)) and isinstance(h.get("sha256"), str) and \
                    sha256(bytes(f)) == h["sha256"]:
                assets[hid] = bytes(f)   # keyed by held id; the image's src is in report.items
                rep.update(status="ok", src=cur["src"])
            elif isinstance(f, (bytes, bytearray)):
                rep.update(status="hash_mismatch", detail="image file sha256 differs")
            elif region is not None:
                render(cur["src"])
            else:
                rep.update(status="needs_user_file", detail="image of a non-hosted source without a region: "
                                                            "supply items[%r]" % hid)
            return rep
        want = h["text_sha256"]
        if loc.get("format") in ("image_reading", "region") or not loc.get("parts"):
            t = supplied.get(hid)
            if isinstance(t, str) and text_sha256(t) == want:   # a hash-checked reading: served as text
                _set(out, h["path"], unicodedata.normalize("NFC", t))
                rep["status"] = "ok"
            elif isinstance(t, str):
                rep.update(status="hash_mismatch", detail="supplied reading differs from the served text")
            elif region is not None:
                pos = _image_position(out, h["path"])
                pic = h["path"].rsplit("/lines/", 1)[0] if pos is not None and pos[0] == "line" else None
                if pic is not None and pictures.get(pic, "ok") not in ("ok", "ok_image"):
                    rep.update(status="requires_reading", detail="the picture this line is read from is not "
                                                                 "resolved (%s)" % pictures[pic])
                elif pos is None:
                    rep.update(status="requires_reading", detail="a region is known, but this position (%s) cannot "
                                                                 "show an image" % h["path"])
                elif render("regions/%s.png" % hid):
                    image_slots.append((hid, pos))
            else:
                rep.update(status="requires_reading",
                           detail="no region and no deterministic extraction; a reading supplied in items[%r] is "
                                  "accepted only if it hashes to text_sha256" % hid)
            return rep
        have = extractor_name(loc.get("format"), extractors)
        if loc.get("extractor") != have:
            rep.update(status="source_unavailable", detail="locator written by extractor %r; this app has %r" % (
                loc.get("extractor"), have))
            return rep
        us, err = source_units(h["source"], loc.get("format"))
        if err:
            rep.update(status=err[0], detail=err[1])
            return rep
        # the stamp retry only in phase 2 and only for a source with at least one item that matched plainly (a
        # wrong or tampered-everywhere file has none), within the rehydration's budget
        retry = phase == 2 and bool(matched_units.get(h["source"]))
        probe = dict(loc, _positions=[])
        t, matched = find_ex(us, probe, want, stamped=retry, budget=budget, total=total)
        if t is None:
            rep.update(status="hash_mismatch", detail="item not found in its unit windows %s" % (
                [p.get("units") for p in loc["parts"] if isinstance(p, dict) and "units" in p],))
        else:
            _set(out, h["path"], t)
            rep["status"] = "ok"
            rep["matched_units"] = matched
            rep["_positions"] = probe["_positions"]
            matched_units.setdefault(h["source"], set()).update(x for x in matched if x is not None)
        return rep

    def process(hid):
        h = held[hid]
        try:
            if not isinstance(hid, str) or not _HELD_ID.fullmatch(hid):
                raise ValueError("held id %r is not h<number>" % (hid,))
            if not isinstance(h, dict) or not isinstance(h.get("path"), str) or not isinstance(h.get("source"), str):
                raise ValueError("malformed held entry")
            if h.get("kind") != "image" and not isinstance(h.get("text_sha256"), str):
                raise ValueError("held text without text_sha256")
            rep = one(hid, h)
        except (KeyError, IndexError, ValueError, TypeError, AttributeError) as e:
            rep = {"source": h.get("source") if isinstance(h, dict) else None, "status": "hash_mismatch",
                   "path": h.get("path") if isinstance(h, dict) else None, "detail": "malformed: %s" % e}
        report_items[hid] = rep
        if isinstance(h, dict) and h.get("kind") == "image" and isinstance(h.get("path"), str):
            pictures[h["path"]] = rep["status"]
        if rep["status"] not in ("ok", "ok_image"):
            remaining[hid] = h
        else:
            remaining.pop(hid, None)

    remaining, renders, image_slots, pictures = {}, {}, [], {}
    matched_units, page_anchors = {}, {}
    budget = {"left": STAMP_BUDGET}   # characters the stamp retry may hash in one rehydration
    total = {"left": TOTAL_BUDGET}    # characters all searches together may hash

    def rank(k):   # located texts first (they verify pages), then pictures (before their own lines), then the rest
        e = held[k] if isinstance(held[k], dict) else {}
        lc = e.get("locator") if isinstance(e.get("locator"), dict) else {}
        return (0 if e.get("kind") != "image" and lc.get("parts") else 1 if e.get("kind") == "image" else 2, str(k))
    order = sorted(held, key=rank)
    texts = [k for k in order if rank(k)[0] == 0]
    # phase 1: every located text, plain search; phase 2: the stamp retry for the misses of sources where another item
    # matched (a wrong file has none), within the budget; phase 3: pictures and the rest
    phase = 1
    for hid in texts:
        process(hid)
    phase = 2
    for hid in [k for k in texts if report_items[k]["status"] == "hash_mismatch"
                and "not found" in report_items[k].get("detail", "")]:
        process(hid)
    for hid in texts:   # page anchors: which held texts sit on which build page, and where they matched here
        h, r = held[hid], report_items[hid]
        lc = h.get("locator") if isinstance(h, dict) and isinstance(h.get("locator"), dict) else {}
        if lc.get("format") != "pdf" or not isinstance(lc.get("parts"), list):
            continue
        src_parts = [p_ for p_ in lc["parts"] if isinstance(p_, dict) and isinstance(p_.get("units"), list)]
        for j, p_ in enumerate(src_parts):
            try:
                a, b = int(p_["units"][0]), int(p_["units"][1])
                if not (0 <= a <= b and b - a < MAX_UNITS):
                    continue
                q = r.get("matched_units", [None] * len(src_parts))[j] if r["status"] == "ok" else None
                pos = (r.get("_positions") or [None] * len(src_parts))[j] if r["status"] == "ok" else None
                if q is not None and not _same_place(p_, pos):
                    q = None   # matched, but not where it sat on its page (a reflowed edition): no anchor
                for u in range(a, b + 1):
                    # (hid, status, canon_len, matched unit, canon_sha256, unique at build time)
                    page_anchors.setdefault((h["source"], u + 1), []).append(
                        (hid, r["status"], int(p_.get("canon_len") or 0), q, p_.get("canon_sha256"),
                         p_.get("unique") is True))   # fail closed: an old / edited locator without it never anchors
            except (TypeError, ValueError, IndexError):
                continue
    phase = 3
    for hid in [k for k in order if k not in set(texts)]:
        process(hid)
    for r in report_items.values():
        if isinstance(r, dict):
            r.pop("_positions", None)
    _place_images(out, image_slots, remaining)
    if remaining:
        out["distribution"]["held"] = remaining
    else:
        out.pop("distribution", None)
    return out, {"items": report_items, "sources": sources, "complete": not remaining, "assets": assets,
                 "renders": renders,
                 "counts": {s: sum(1 for r in report_items.values() if r["status"] == s) for s in STATUSES}}


