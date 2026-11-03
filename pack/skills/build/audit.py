#!/usr/bin/env python3
"""Run the audit book's automatic checks on built study folders and write audit.json.

    python .opencode/skills/build/audit.py <study> [<study> ...] [--out DIR] [--online] [--no-run] [--no-export]

A study folder holds program.json and, when built, effects.json, capabilities.json, package/<slug>/,
artifacts/ and sources/ (the paper PDF beside program.json or under sources/). Item metadata (check,
severity, evidence requirement) is read from audit-book.json next to this script.

Each item gets one result: pass, concern, fail or n/a. Every result other than pass and n/a carries
evidence (file and field, plus page or detail). Items that need a fresh agent or a researcher are
written as n/a with the note "needs agent" or "needs human"; items that are not about one study folder
(release, web and desktop surfaces) say so. An item checked "auto + agent" reports the automatic part
and says the rest is still needed ("covers": "auto part"). Nothing is guessed: a check that cannot
decide says why.

The replay package is exercised offline with a stub model that returns marked nonsense, on a copy of
the folder (participant independence, prompt leaks, arm balance, unparseable replies, refusals); the
agent export self-test also runs on that copy. --no-run skips both. --online resolves the DOI.

Writes <out>/<study-name>/audit.json (default: <study>/audit.json) and, for several folders,
<out>/batch-audit.json with the cross-study items. Exit 1 when any S1 item fails.
Standard library only (plus a PDF reader for page text, as check_quotes.py).
"""
import argparse
import logging
import hashlib
import json
import re
import shutil
import sys
import tempfile
import time
import traceback
import urllib.request
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
AGENT = HERE.parent / "export" / "agent"
EXPORT = HERE.parent / "export"
for p in (HERE, AGENT, EXPORT):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import capabilities  # noqa: E402
import check_program  # noqa: E402
import check_quotes  # noqa: E402
import check_verbatim  # noqa: E402
import sandbox_run  # noqa: E402

try:
    import effects_core  # noqa: E402
except ImportError:  # an install without the export skill
    effects_core = None

BOOK = "audit-book/0.1"
logging.getLogger("pypdf").setLevel(logging.ERROR)
DATA_EXT = {".csv", ".tsv", ".dta", ".sav", ".por", ".xlsx", ".xls", ".rds", ".rdata", ".rda", ".parquet",
            ".feather", ".sas7bdat", ".zsav"}
TEXT_EXT = {".json", ".py", ".md", ".txt", ".yml", ".yaml", ".csv", ".tsv", ".html", ".js", ".r", ".toml", ".cfg"}
PATHS = [("macOS home path", re.compile(r"/Users/[A-Za-z0-9._-]+/")),
         ("Linux home path", re.compile(r"/home/[a-z_][a-z0-9_-]*/")),
         ("Windows home path", re.compile(r"[A-Za-z]:\\{1,2}Users\\{1,2}[^\\\s\"']+"))]
SECRETS = [("Anthropic key", re.compile(r"sk-ant-[A-Za-z0-9_-]{16,}")),
           ("OpenRouter key", re.compile(r"sk-or-v1-[A-Za-z0-9]{20,}")),
           ("OpenAI-style key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9]{32,}")),
           ("GitHub token", re.compile(r"\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}")),
           ("AWS key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
           ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b")),
           ("private key", re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"))]
LEAK_WORDS = re.compile(r"\b(hypothes(?:is|es|ize[sd]?)|we predict(?:ed)?|predicted effect|expected effect|"
                        r"treatment group|control group|control condition|experimental condition|"
                        r"manipulation check|condition (?:id|label|name)|study (?:arm|label))\b", re.I)
PARSE_KEYS = ("valid", "parsed", "parse_ok", "parseOk", "ok", "error", "parse_error", "parseError", "unparsed",
              "invalid", "unparseable", "parse_failed", "parseFailed", "failed")
TOKEN = "QZX%04dQZX"
MAX_EVIDENCE = 12


# ---- helpers ----------------------------------------------------------------------------------------

def load_book(path=None):
    book = json.loads(Path(path or HERE / "audit-book.json").read_text(encoding="utf-8"))
    return book, {i["id"]: i for i in book["items"]}


def jload(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def norm_title(t):
    return re.sub(r"[^a-z0-9]+", " ", str(t or "").lower()).strip()


def norm_doi(d):
    d = str(d or "").strip().lower()
    d = re.sub(r"^(https?://(dx\.)?doi\.org/|doi:\s*)", "", d)
    return d or None


def short(items, n=MAX_EVIDENCE):
    items = list(dict.fromkeys(items))
    return "; ".join(items[:n]) + ("; +%d more" % (len(items) - n) if len(items) > n else "")


def text_of(value):
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, list):
        return " ".join(text_of(v) for v in value)
    if isinstance(value, dict):
        return " ".join(text_of(v) for v in value.values())
    return ""


def docx_text(path):
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
    except (OSError, KeyError, zipfile.BadZipFile):
        return None
    xml = re.sub(r"</w:p>", "\n", xml)
    return re.sub(r"<[^>]+>", "", xml)


class Sources:
    """Page texts of the files evidence cites: PDFs by page, other text files as one page."""

    def __init__(self, root):
        self.root, self.cache = root, {}

    def pages(self, rel):
        if rel in self.cache:
            return self.cache[rel]
        path = (self.root / rel).resolve()
        pages = None
        if path.is_file() and self.root in path.parents:
            suffix = path.suffix.lower()
            if suffix == ".pdf":
                pages = [check_quotes.normalise(t) for t in check_quotes.Pdf(path).load()] or None
            elif suffix == ".docx":
                t = docx_text(path)
                pages = [check_quotes.normalise(t)] if t else None
            elif suffix in (".txt", ".md", ".html", ".csv", ".tsv", ".json"):
                pages = [check_quotes.normalise(path.read_text(encoding="utf-8", errors="replace"))]
        self.cache[rel] = pages
        return pages


class Study:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.program = jload(self.root / "program.json")
        if not isinstance(self.program, dict):
            raise ValueError("%s: program.json is missing or invalid" % self.root)
        self.effects = jload(self.root / "effects.json")
        self.caps = jload(self.root / "capabilities.json")
        self.source = jload(self.root / "sources/SOURCE.json")
        self.package = capabilities._package(self.root)
        self.task = jload(self.package / "task/task.json") if self.package else None
        self.pstudy = jload(self.package / "study.json") if self.package else None
        self.meta = jload(self.package / "source/paper_metadata.json") if self.package else None
        self.hkey = jload(self.package / "human/key.json") if self.package else None
        self.hcheck = jload(self.root / "artifacts/replay/human-check.json")
        self.compare = jload(self.root / "artifacts/replay/replay-compare.json")
        failures = jload(self.root / "artifacts/failures.json")
        self.failures = failures if isinstance(failures, list) else []
        self.nodes = {n.get("id"): n for n in self.program.get("nodes", []) if isinstance(n, dict)}
        self.evidence = {e.get("id"): e for e in self.program.get("evidence", []) if isinstance(e, dict)}
        self.sources = Sources(self.root)
        src = self.program.get("source") or {}
        pdf = src.get("filename") or "paper.pdf"
        cands = [pdf, "paper.pdf", "sources/" + Path(pdf).name, "sources/paper.pdf"]
        self.pdf = next((c for c in cands if (self.root / c).is_file()), None)
        self._quotes = None

    def files(self):
        """The study's own files: not tool folders (.claude, .opencode, ...), caches, build logs or audit output."""
        out = []
        for p in self.root.rglob("*"):
            parts = p.relative_to(self.root).parts
            if not p.is_file() or any(x.startswith(".") and x != ".revision" for x in parts) \
                    or set(parts) & {"__pycache__", "node_modules", "exports"} or p.suffix == ".log" \
                    or p.name in ("audit.json", "batch-audit.json"):
                continue
            out.append(p)
        return sorted(out)

    def quotes(self):
        if self._quotes is None:
            self._quotes = check_quotes.check(self.root / "program.json")
        return self._quotes

    def ev_rel(self, e):
        return e.get("path") or self.pdf or "paper.pdf"


def R(result, evidence=None, note=None, details=None, covers=None):
    out = {"result": result, "evidence": evidence or None, "note": note or None}
    if details:
        out["details"] = details
    if covers:
        out["covers"] = covers
    return out


# ---- S: source intake -------------------------------------------------------------------------------

def resolve_doi(doi):
    req = urllib.request.Request("https://doi.org/" + doi, headers={"Accept": "application/vnd.citationstyles.csl+json",
                                                                   "User-Agent": "humanstudy-audit/0.1"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def check_S1(s, ctx):
    src = s.program.get("source") or {}
    dois = {"program.json#source.doi": src.get("doi"),
            "sources/SOURCE.json#paper.doi": ((s.source or {}).get("paper") or {}).get("doi"),
            "paper_metadata.json#doi": (s.meta or {}).get("doi")}
    dois = {k: norm_doi(v) for k, v in dois.items() if norm_doi(v)}
    titles = {"program.json#source.title": src.get("title"), "program.json#title": s.program.get("title"),
              "sources/SOURCE.json#paper.title": ((s.source or {}).get("paper") or {}).get("title"),
              "paper_metadata.json#title": (s.meta or {}).get("title")}
    titles = {k: norm_title(v) for k, v in titles.items() if norm_title(v)}
    if len(set(dois.values())) > 1:
        return R("fail", short("%s=%s" % kv for kv in dois.items()), "the study's files name different DOIs")
    t = sorted(set(titles.values()), key=len)
    if any(not (a in b) for i, a in enumerate(t) for b in t[i + 1:]):
        return R("concern", short("%s: %s" % kv for kv in titles.items()), "titles differ between the study's files")
    if not dois:
        return R("concern", "program.json#source.doi; sources/SOURCE.json#paper.doi",
                 "no DOI recorded, so the paper version cannot be confirmed")
    doi = next(iter(dois.values()))
    if not ctx.get("online"):
        return R("pass", None, "local records agree (DOI %s); DOI not resolved (run with --online)" % doi,
                 covers="local consistency")
    try:
        csl = resolve_doi(doi)
    except Exception as exc:  # network or unknown DOI
        return R("concern", "DOI %s" % doi, "DOI did not resolve: %s" % str(exc)[:120])
    remote = csl.get("title")
    remote = remote[0] if isinstance(remote, list) and remote else remote
    nr, nl = norm_title(remote), t[-1] if t else ""
    if nr and nl and not (nr in nl or nl in nr or nr[:40] == nl[:40]):
        return R("fail", "DOI %s resolves to %r; program.json#source.title is %r" % (doi, remote, src.get("title")),
                 "DOI and title name different papers")
    kind = csl.get("type")
    if kind == "posted-content" and src.get("venue") and "preprint" not in str(src.get("venue")).lower():
        return R("concern", "DOI %s is a preprint (%s); program.json#source.venue is %r" % (doi, kind, src.get("venue")),
                 "preprint and published versions may be confused")
    return R("pass", None, "DOI %s resolves to the same title (%s)" % (doi, kind or "type unknown"))


def check_S2(s, ctx):
    probs, ok = [], []
    pdf = (s.source or {}).get("pdf") or {}
    if s.pdf:
        actual = sha256(s.root / s.pdf)
        if not pdf.get("sha256"):
            probs.append(("fail", "sources/SOURCE.json#pdf.sha256 missing for %s" % s.pdf))
        elif pdf["sha256"] != actual:
            probs.append(("fail", "sources/SOURCE.json#pdf.sha256 %s… != sha256(%s) %s…" % (pdf["sha256"][:12], s.pdf, actual[:12])))
        else:
            ok.append("PDF hash matches")
    elif not pdf.get("sha256"):
        probs.append(("fail", "no source PDF and no sources/SOURCE.json#pdf.sha256"))
    cited = sorted({e.get("path") for e in s.evidence.values() if e.get("path")} - {s.pdf, "paper.pdf", None})
    for rel in cited:
        if not (s.root / rel).is_file():
            probs.append(("concern", "program.json#evidence path %s is not in the folder and has no recorded hash" % rel))
        else:
            probs.append(("concern", "%s is cited but sources/SOURCE.json records no hash for it" % rel))
    for f in (s.hkey or {}).get("files", []):
        if not f.get("sha256"):
            probs.append(("concern", "package/%s/human/key.json#files[%s].sha256 missing" % (s.package.name, f.get("path"))))
    if s.hkey:
        ok.append("%d human-data file hashes recorded" % len((s.hkey or {}).get("files", [])))
    if not probs:
        return R("pass", None, "; ".join(ok))
    worst = "fail" if any(p[0] == "fail" for p in probs) else "concern"
    return R(worst, short(p[1] for p in probs), "; ".join(ok) or None)


def check_S3(s, ctx):
    probs = []
    pdf = (s.source or {}).get("pdf") or {}
    if not s.source:
        probs.append("sources/SOURCE.json missing: no license record for the PDF")
    elif "license" not in pdf:
        probs.append("sources/SOURCE.json#pdf.license missing")
    if s.hkey:
        repo = s.hkey.get("repository") or {}
        if "license" not in repo:
            probs.append("package/%s/human/key.json#repository.license missing" % s.package.name)
        elif repo.get("license") is None and not repo.get("licenseEvidence"):
            probs.append("package/%s/human/key.json#repository.license is null without licenseEvidence" % s.package.name)
    author = jload(s.package / "analysis/author.json") if s.package else None
    if isinstance(author, dict) and "license" not in author:
        probs.append("package/%s/analysis/author.json#license missing" % s.package.name)
    note = "auto part: a license (or 'unknown') is recorded; needs human to confirm the terms"
    return R("concern" if probs else "pass", short(probs) if probs else None, note, covers="auto part")


def check_S5(s, ctx):
    if not s.pdf:
        return R("n/a", None, "no source PDF in the folder")
    raw = check_quotes.Pdf(s.root / s.pdf).load()
    if not raw:
        return R("concern", s.pdf, "no PDF reader could read the file")
    empty = [i + 1 for i, t in enumerate(raw) if len(check_quotes.normalise(t)) < 40]
    if not empty:
        return R("pass", None, "all %d pages have a text layer" % len(raw))
    cited = sorted({(e.get("locator") or {}).get("page") for e in s.evidence.values()
                    if (e.get("locator") or {}).get("page") in empty and s.ev_rel(e) == s.pdf})
    note = ("%d of %d pages have no text layer (scanned or image-only); cannot tell whether they were read as images"
            % (len(empty), len(raw)))
    if cited:
        note += "; evidence cites pages %s" % cited
    return R("concern", "%s pages %s" % (s.pdf, empty[:30]), note)


# ---- X: extraction fidelity -------------------------------------------------------------------------

def find_text(s, value, evidence_ids):
    """Compare a verbatim value with the pages its evidence cites: check_verbatim.py's comparison (the build
    check), so a table field is checked by title, headers, row labels, text cells and notes, not as one string.

    Returns (status, info): found, table_text_layer / close_unverified (accepted by the build check on a
    garbled text layer; a concern here), close, elsewhere, partial (added or reworded text), not_found, or
    unchecked (a cited file is not readable here)."""
    evidence = {eid: dict(e, path=s.ev_rel(e)) for eid, e in s.evidence.items() if isinstance(e, dict)}
    return check_verbatim.field_status(value, evidence, evidence_ids, s.sources, s.pdf or "paper.pdf")


def cited_windows(s, ids):
    """The text of the cited pages and their neighbours, one window per readable file (as check_verbatim)."""
    by_file, out = {}, []
    for eid in ids:
        e = s.evidence.get(eid)
        if isinstance(e, dict):
            by_file.setdefault(s.ev_rel(e), set()).add((e.get("locator") or {}).get("page"))
    for rel, pages in by_file.items():
        doc = s.sources.pages(rel)
        if not doc:
            continue
        nums = sorted(p for p in pages if isinstance(p, int) and 1 <= p <= len(doc))
        near = sorted({x for n in nums for x in (n - 1, n, n + 1) if 1 <= x <= len(doc)})
        out.append(" " + (" ".join(doc[p - 1] for p in near) if len(doc) > 1 and near else " ".join(doc)) + " ")
    return out


ADDED_HEADERS = {"panel"}  # build/SKILL.md: row groups or panels may become an added "Panel" column


def table_units(cell):
    """The parts of one table cell to find on the page, split as the text comparison splits them (stacked
    headers on " / ", long cells into sentences): text pieces as (words, True), searched as a substring;
    one- or two-character text and every number as (token, False), searched as a whole token (an estimate
    and its interval are often printed on different lines)."""
    out = []
    for piece in re.split(r"\s+/\s+", str(cell)):
        q = check_quotes.normalise(piece)
        if not q:
            continue
        if not re.search(r"[a-z]", q):
            out += [(check_quotes.normalise(n), False) for n in re.findall(r"\d*\.?\d+", piece)]
        elif len(q) < 3:
            out.append((q, False))
        else:
            out += [(x, True) for x in check_verbatim.segments(piece)]
    return out


def table_gaps(s, value, ids):
    """What the text comparison of a table leaves open, checked on the cited pages: every number and every
    one- or two-character cell as a whole token, and each row's cells (the header row too) within a short span
    of each other. Text pieces the text comparison could not find exactly are left to it (they are already a
    finding there), so a row is never flagged twice. Not decidable from a text layer, and so not checked:
    minus signs (normalised away), column order, which of two nearby rows a value or label belongs to,
    rows left out or repeated, and one-digit numbers (they are everywhere on a page).
    Returns (cells with a part not found, rows whose cells are not together, rows checked)."""
    windows = cited_windows(s, ids)
    if not windows:
        return [], [], 0

    def where(unit, w):
        q, sub = unit
        return [m.start() for m in re.finditer(re.escape(q) if sub else " %s%%? " % re.escape(q), w)]
    missing = [c for c in check_verbatim.table_cells(value)
               if any(not sub and not any(where((q, sub), w) for w in windows) for q, sub in table_units(c))]
    apart, checked = [], 0
    header = [c for c in (value.get("columns") or []) if check_quotes.normalise(str(c)) not in ADDED_HEADERS]
    for row in [header] + list(value.get("rows") or []):  # the header row counts as a row
        units = [u for c in check_verbatim.table_cells({"r": row}) for u in table_units(c)]
        if len(units) < 2:
            continue
        checked += 1
        span = 200 + sum(len(q) for q, _ in units)
        ok = False
        for w in windows:
            hits = [h for h in ((u, where(u, w)) for u in units) if h[1] or not h[0][1]]  # drop text it did not find
            hits = [h for _, h in hits]
            if len(hits) < 2:
                ok = ok or all(hits)
                continue
            if all(hits) and any(all(any(abs(p - a) <= span for p in h) for h in hits) for a in hits[0]):
                ok = True
                break
        if not ok:
            apart.append(" | ".join(str(c) for c in (row if isinstance(row, list) else [row]))[:80])
    return missing, apart, checked


def check_X1(s, ctx):
    found, problems, unchecked, tables = 0, [], [], 0
    for nid, n in s.nodes.items():
        for f in n.get("fields") or []:
            if f.get("origin") != "verbatim" or not text_of(f.get("value")).strip():
                continue
            where = "program.json#node:%s.%s" % (nid, f.get("id"))
            ids = f.get("evidenceIds") or n.get("evidenceIds") or []
            if not ids:
                problems.append(("concern", where + ": verbatim with no evidence"))
                continue
            status, info = find_text(s, f.get("value"), ids)
            pages = sorted({str((s.evidence.get(i) or {}).get("locator", {}).get("page")) for i in ids if i in s.evidence})
            if check_verbatim.is_table(f.get("value")) and status in ("found", "table_text_layer", "close"):
                # Text cells are matched one by one, anywhere on the cited pages; numbers, short cells and
                # which cells share a row are checked here. Column order is not verifiable from a text layer.
                missing, apart, rows = table_gaps(s, f.get("value"), ids)
                gaps = (["%d numeric or short cell(s) not on the page (%s)" % (len(missing), short(missing, 4))]
                        if missing else []) + \
                       (["%d of %d row(s) whose cells are not together on the page (%s)" % (len(apart), rows, short(apart, 3))]
                        if apart else [])
                if status != "found" or gaps:
                    problems.append(("concern", "%s: table (cited page(s) %s): %s; needs human: compare the table with "
                                     "the page image" % (where, ",".join(pages), "; ".join(
                                         ([info] if status != "found" and info else []) + gaps))))
                    continue
                found += 1
                tables += 1
            elif status == "found":
                found += 1
            elif status == "close_unverified":
                # the build check accepts this on a garbled text layer; the audit does not take that on trust
                problems.append(("concern", "%s: %s (cited page(s) %s); needs human: compare with the page image"
                                 % (where, info, ",".join(pages))))
            elif status == "unchecked":
                unchecked.append("%s (%s)" % (where, info) if info else where)
            elif status == "not_found":
                problems.append(("fail", "%s: not found on cited page(s) %s" % (where, ",".join(pages))))
            elif status == "partial":
                problems.append(("concern", "%s: %s (cited page(s) %s): added or reworded text in a verbatim field" % (where, info, ",".join(pages))))
            else:
                problems.append(("concern", "%s: %s (cited page(s) %s)" % (where, info, ",".join(pages))))
    total = found + len(problems) + len(unchecked)
    if not total:
        return R("concern", "program.json#nodes: no nonempty verbatim fields", "no verbatim fields were available to check against the source")
    note = "%d verbatim field(s): %d found word for word, %d problem(s), %d unchecked (cited file not readable here)" % (
        total, found, len(problems), len(unchecked))
    if tables:
        note += "; %d table(s) found cell by cell with each row's cells together (not verifiable from a text " \
                "layer: minus signs, column order, values swapped between neighbouring rows, left-out or repeated rows, " \
                "one-digit numbers)" % tables
    if problems:
        worst = "fail" if any(p[0] == "fail" for p in problems) else "concern"
        return R(worst, short(p[1] for p in problems), note, details=[p[1] for p in problems] + ["unchecked: " + u for u in unchecked])
    if unchecked:
        return R("concern", short(unchecked), note)
    return R("pass", None, note)


def check_X5(s, ctx):
    if s.effects is None or effects_core is None:
        return R("n/a", None, "no effects.json; needs agent for the reported statistics", covers="auto part")
    try:
        problems, warnings = effects_core.check(s.root, s.effects, s.program)
    except Exception as exc:
        return R("fail", "effects.json", "effects check crashed: %s" % exc)
    bad = [p for p in problems if "is not written in its cited quotes" in p]
    signs = [w for w in warnings if "check the sign" in w]
    status = {r["id"]: r for r in s.quotes()["results"]}
    unquoted = []
    for e in s.effects.get("effects") or []:
        for eid in ((e.get("reported") or {}).get("evidenceIds") or []):
            r = status.get(eid)
            if r and r["status"] == "not_found":
                unquoted.append("effects.json#effect:%s.reported cites %s, whose quote is not on p. %s" % (e.get("id"), eid, r.get("page")))
    note = "auto part: every reported number is written in its cited quote and the quote is on its page; needs agent for sign, inequality and df"
    if bad or unquoted:
        return R("fail", short(["effects.json: " + b for b in bad] + unquoted), note, covers="auto part")
    if signs:
        return R("concern", short("effects.json: " + w for w in signs), note, covers="auto part")
    return R("pass", None, note, covers="auto part")


def check_X7(s, ctx):
    rep = s.quotes()
    c = rep["counts"]
    total = sum(c.values())
    if not total:
        return R("n/a", None, "no quoted evidence with a page")
    bad = [r for r in rep["results"] if r["status"] in ("not_found", "other_page")]
    soft = [r for r in rep["results"] if r["status"] in ("close", "unchecked")]
    note = "%d quotes compared with their cited pages (all, not a sample of 10): %s" % (
        total, ", ".join("%d %s" % (v, k) for k, v in sorted(c.items())))
    fmt = lambda r: "program.json#evidence:%s p. %s %s%s" % (r["id"], r["page"], r["status"],
                                                            " (on p. %s)" % r["foundOn"] if r.get("foundOn") else
                                                            " (%s)" % r["reason"] if r.get("reason") else "")
    if bad:
        return R("fail", short(fmt(r) for r in bad), note, details=[fmt(r) for r in bad + soft])
    if soft:
        return R("concern", short(fmt(r) for r in soft), note)
    return R("pass", None, note)


# ---- P: procedure and participants (stub run) --------------------------------------------------------

def probe(root, n):
    """Run in a child process: drive the package with a stub model and report what it did."""
    import study_core
    out = {}
    try:
        st = study_core.Study(root)
    except Exception as exc:
        return {"error": "study_core could not load the study: %s" % exc}
    excluded = [a for item in ((st.caps or {}).get("run") or {}).get("excluded") or [] for a in item.get("arms") or []]
    if excluded:
        try:
            st._sessions(lambda p, *a, **k: "", 1, 1, excluded[:1])
            out["excludedRefused"] = False
        except study_core.Refusal:
            out["excludedRefused"] = True
        except Exception as exc:
            out["excludedRefused"] = "error: %s" % str(exc)[:200]
    calls = []

    def llm(prompt, *args, **kw):
        extra = " ".join(text_of(a) for a in args) + " " + " ".join(text_of(v) for v in kw.values())
        calls.append(str(prompt) + ("\n" + extra if extra.strip() else ""))
        return "Reply " + TOKEN % (len(calls) - 1) + " ."
    started = time.time()
    try:
        sessions = st._sessions(llm, 20261015, n, None)
    except study_core.Refusal as exc:
        out.update(refused=exc.reason, calls=len(calls))
        return out
    except BaseException as exc:  # adapter crashed on unparseable replies, or a bug
        out.update(error="".join(traceback.format_exception_only(type(exc), exc)).strip()[:400], calls=len(calls),
                   prompts=calls[:400])
        return out
    sessions = list(sessions or [])
    out.update(seconds=round(time.time() - started, 1), calls=len(calls), prompts=calls[:2000],
               sessions=[{k: v for k, v in s.items() if k not in ("prompt", "prompts", "transcript")}
                         if isinstance(s, dict) else {"_": text_of(s)} for s in sessions][:2000])
    return out


def probe_schema_problem(result):
    """The first field of a probe result with the wrong type, or None. The result is printed by the confined
    child, which package code shares, so every field is checked before a check reads it."""
    if not isinstance(result, dict):
        return "probe"
    for key in ("error", "refused"):
        if key in result and not isinstance(result[key], str):
            return key
    if "calls" in result and (isinstance(result["calls"], bool) or not isinstance(result["calls"], int)
                              or result["calls"] < 0):
        return "calls"
    if "excludedRefused" in result and not isinstance(result["excludedRefused"], (bool, str)):
        return "excludedRefused"
    if not isinstance(result.get("sessions", []), list) or not all(isinstance(x, dict) for x in result.get("sessions", [])):
        return "sessions"
    if not isinstance(result.get("prompts", []), list) or not all(isinstance(x, str) for x in result.get("prompts", [])):
        return "prompts"
    if "seconds" in result and (isinstance(result["seconds"], bool) or not isinstance(result["seconds"], (int, float))):
        return "seconds"
    return None


def run_probe(s, ctx):
    if "probe" in ctx:
        return ctx["probe"]
    if ctx.get("no_run") or not s.package:
        ctx["probe"] = None
        return None
    copy = ctx["copy"](fresh=True)
    # Package code is untrusted: it runs only in the confined child (no keys, no network, writes only in the
    # scratch folder; see sandbox_run.py), which prints the probe result as JSON.
    run = sandbox_run.run_python(Path(__file__).resolve(), ["--probe", str(copy), "--n", "2"], cwd=copy,
                                 work=copy.parent, timeout=ctx.get("timeout", 600))
    lines = [l for l in run.stdout.splitlines() if l.startswith("{\"probe\":")]
    if run.timed_out:
        ctx["probe"] = {"error": "stub run timed out"}
    else:
        try:
            result = json.loads(lines[-1])["probe"] if lines else None
            if not isinstance(result, dict):
                raise ValueError("probe result is not an object")
            bad = probe_schema_problem(result)
            # Fail closed: a malformed result is a probe error (not a refusal), so run=no and blocked studies
            # still fail as "not refused" instead of crashing a check into a concern.
            ctx["probe"] = {"error": "probe result is malformed: %s" % bad} if bad else result
            ctx["probe"]["owner"] = probe_owner(ctx["probe"])
        except (ValueError, TypeError, KeyError, RecursionError):
            # RecursionError: a package can print deeply nested JSON; it must not crash a check into a concern.
            ctx["probe"] = {"error": "probe produced no valid result (exit %s): %s" %
                            (run.returncode, (run.stderr or run.stdout)[-400:])}
    # Package code shares the probe interpreter and can modify or forge its output.
    # Attribution is derived here, but that transcript is never treated as proof of a pass.
    pr = ctx["probe"]
    pr.setdefault("owner", {})
    pr["untrusted"] = True
    return ctx["probe"]


def probe_owner(pr):
    """Which sessions carry each stub reply marker (participant index -> session indices)."""
    owner = {}
    for idx, sess in enumerate(pr.get("sessions") or []):
        for m in re.finditer(r"QZX(\d{4})QZX", json.dumps(sess, default=str)):
            owner.setdefault(int(m.group(1)), set()).add(idx)
    return {str(k): sorted(v) for k, v in owner.items()}


def calls_per_participant(pr):
    calls, sessions = pr.get("calls", 0), len(pr.get("sessions") or [])
    if not calls or not sessions or calls % sessions:
        return None
    return calls // sessions


def check_P1(s, ctx):
    if not s.package:
        return R("n/a", None, "no replay package")
    pr = run_probe(s, ctx)
    if pr is None:
        return R("n/a", None, "stub run skipped (--no-run)")
    if pr.get("refused"):
        return R("n/a", None, "the package refuses to run (%s); nothing to check" % pr["refused"][:160])
    if pr.get("error"):
        return R("concern", "package/%s/task/adapter.py" % s.package.name,
                 "the package could not be exercised with a stub model: %s" % pr["error"][:300])
    prompts = pr.get("prompts") or []
    if not prompts:
        return R("concern", "package/%s/task/adapter.py" % s.package.name, "run_sessions made no model calls")
    owner = {int(k): v for k, v in (pr.get("owner") or {}).items()}
    tok = re.compile(r"QZX(\d{4})QZX")
    seen = [[int(m.group(1)) for m in tok.finditer(p)] for p in prompts]
    # A participant's first prompt carries no earlier reply. When the reply-free prompts are exactly one per
    # session, they mark where each participant starts.
    starts = [i for i, t in enumerate(seen) if not t]
    by_start = len(starts) == len(pr.get("sessions") or []) and starts and starts[0] == 0
    cp = calls_per_participant(pr)
    leaks, method = [], "unattributed"
    for i, toks in enumerate(seen):
        start = max(x for x in starts if x <= i) if by_start else None
        for j in toks:
            if j in owner and i in owner:  # both calls traced to the session that kept the reply
                method = "traced through the replies kept in sessions"
                if min(owner[j]) != min(owner[i]):
                    leaks.append((j, i, "cross"))
            elif by_start:
                method = "attributed by each participant's reply-free first prompt"
                if j < start:
                    leaks.append((j, i, "cross"))
            elif cp is not None and j // cp != i // cp:
                leaks.append((j, i, "unknown"))  # only by assuming equal calls per participant
            elif cp is None:
                leaks.append((j, i, "unknown"))
    shared = sorted(j for j, v in owner.items() if len(v) > 1)
    cross = [l for l in leaks if l[2] == "cross"]
    note = "%d model calls for %d sessions (stub model, n=2 per arm); the model sees only the prompt text it is given" % (
        len(prompts), len(pr.get("sessions") or []))
    if cross:
        return R("fail", short("package/%s/task/adapter.py: reply to call %d appears in prompt %d" % (s.package.name, j, i) for j, i, _ in cross),
                 note + "; replies of one participant reach another (%s)" % method)
    if shared:
        return R("concern", short("reply %d is stored in sessions %s" % (j, owner[j]) for j in shared),
                 note + "; one reply is kept in several sessions; needs agent")
    if leaks:
        return R("concern", short("reply %d appears in prompt %d" % (j, i) for j, i, _ in leaks),
                 note + "; earlier replies reappear in later prompts and calls cannot be assigned to participants; needs agent")
    if not any(seen):
        return R("concern", "package/%s/task/adapter.py: no stub reply markers in later prompts" % s.package.name,
                 note + "; parsed or transformed answers may still be shared; needs agent review")
    return R("pass", None, note + "; earlier replies reappear only within the same participant (%s)" % method)


def check_P3(s, ctx):
    if not s.package:
        return R("n/a", None, "no replay package", covers="auto part")
    pr = run_probe(s, ctx)
    if not pr or pr.get("refused") or pr.get("error"):
        why = "stub run skipped" if pr is None else pr.get("refused") or pr.get("error")
        return R("n/a", None, "no prompts to scan (%s); needs agent" % str(why)[:160], covers="auto part")
    labels = set()
    for item in [s.program.get("id")] + [x.get("id") for x in s.program.get("studies", [])] + \
            task_arms(s.task) + [c for c in (s.task or {}).get("conditions") or [] if isinstance(c, str)] + \
            [nid for nid, n in s.nodes.items() if n.get("kind") in ("condition", "hypothesis")]:
        if isinstance(item, str) and len(item) >= 5 and re.search(r"[_\-:]|\d", item):
            labels.add(item)
    hyp_chunks = []
    for n in s.nodes.values():
        if n.get("kind") != "hypothesis":
            continue
        for f in n.get("fields") or []:
            words = check_quotes.normalise(text_of(f.get("value"))).split()
            hyp_chunks += [" ".join(words[k:k + 8]) for k in range(0, max(0, len(words) - 7), 4)]
    hits = []
    for i, p in enumerate(pr.get("prompts") or []):
        for m in LEAK_WORDS.finditer(p):
            hits.append("prompt %d: %r" % (i, m.group(0)))
        for lab in labels:
            if re.search(r"(?<![\w-])%s(?![\w-])" % re.escape(lab), p):
                hits.append("prompt %d: label %r" % (i, lab))
        np_ = check_quotes.normalise(p)
        for c in hyp_chunks:
            if c and c in np_:
                hits.append("prompt %d: hypothesis wording %r" % (i, c))
                break
    note = "auto part: %d prompts scanned for hypothesis wording, study labels and condition ids; needs agent for paraphrased leaks" % len(pr.get("prompts") or [])
    if hits:
        return R("concern", "package/%s/task/adapter.py: %s" % (s.package.name, short(hits, 8)), note, covers="auto part")
    return R("pass", None, note, covers="auto part")


def task_arms(task):
    """Arm ids declared in task/task.json: a list of ids or of {id|arm: ...} objects; anything else is not a list."""
    arms = (task or {}).get("arms")
    if not isinstance(arms, list):
        return []
    out = []
    for a in arms:
        if isinstance(a, dict):
            a = a.get("id") or a.get("arm") or a.get("name")
        if isinstance(a, (str, int)):
            out.append(str(a))
    return out


def arm_of(sess):
    for k in ("arm", "condition"):
        if isinstance(sess.get(k), (str, int)):
            return str(sess[k])
    return None


def check_P5(s, ctx):
    if not s.package:
        return R("n/a", None, "no replay package")
    pr = run_probe(s, ctx)
    if not pr or pr.get("refused") or pr.get("error"):
        return R("n/a", None, "no stub run (%s)" % str((pr or {}).get("refused") or (pr or {}).get("error") or "skipped")[:160])
    counts = {}
    for sess in pr.get("sessions") or []:
        a = arm_of(sess)
        counts[a] = counts.get(a, 0) + 1
    arms = task_arms(s.task)
    excluded = {str(a) for item in ((s.caps or {}).get("run") or {}).get("excluded") or [] for a in item.get("arms") or []}
    missing = [a for a in arms if a not in counts and a not in excluded]
    extra = [a for a in counts if arms and a not in arms]
    note = "sessions per arm with n=2: %s" % json.dumps(counts, sort_keys=True)
    if None in counts:
        return R("concern", "package/%s/task/adapter.py: %d session(s) without arm or condition" % (s.package.name, counts[None]), note)
    if missing or extra:
        return R("concern", "task/task.json#arms %s; missing in run: %s; not declared: %s" % (arms, missing, extra), note)
    if len(set(counts.values())) > 1:
        return R("concern", "package/%s: unequal arm sizes %s" % (s.package.name, counts),
                 note + "; check against the paper's assignment (needs agent if the design is unbalanced on purpose)")
    return R("pass", None, note)


def check_P6(s, ctx):
    if not s.package:
        return R("n/a", None, "no replay package")
    pr = run_probe(s, ctx)
    if pr is None:
        return R("n/a", None, "stub run skipped (--no-run)")
    if pr.get("refused"):
        return R("n/a", None, "the package refuses to run")
    if pr.get("error"):
        return R("fail", "package/%s/task/adapter.py" % s.package.name,
                 "an unparseable reply crashed the run instead of being counted: %s" % pr["error"][:300])
    sessions = pr.get("sessions") or []
    if pr.get("calls") and not sessions:
        return R("fail", "package/%s/task/adapter.py" % s.package.name, "%d unparseable replies, 0 sessions returned: replies were dropped" % pr["calls"])

    def marked(v, key=None):
        if key in PARSE_KEYS and v not in (None, "", [], {}):
            return True
        if isinstance(v, dict):
            return any(marked(x, k) for k, x in v.items())
        if isinstance(v, list):
            return any(marked(x) for x in v)
        return v is None
    flagged = sum(1 for sess in sessions if marked(sess))
    note = "all replies were unparseable stub text; %d of %d sessions mark it (a None value or a parse flag)" % (flagged, len(sessions))
    if flagged < len(sessions):
        return R("concern", "package/%s/task/adapter.py: %d session(s) carry no None/parse-failure marker after an unparseable reply"
                 % (s.package.name, len(sessions) - flagged), note + "; a reply may have been mapped to a default value")
    return R("pass", None, note)


def check_P7(s, ctx):
    blocking = [i.get("id") for i in s.program.get("issues", []) if i.get("severity") == "blocking"]
    ready = ((s.pstudy or {}).get("readiness") or {}).get("status")
    run = ((s.caps or {}).get("run") or {}).get("status")
    nonrun = [f for f in s.failures if f.get("pattern") in ("materials-not-public", "non-text-stimuli", "unsimulable-measure")]
    probs = []
    if not s.package:
        if run not in (None, "no"):
            probs.append(("fail", "capabilities.json#run.status=%s but no package exists" % run))
        return R(probs[0][0], probs[0][1]) if probs else R("n/a", None, "no replay package: nothing runs")
    if blocking and ready != "blocked":
        probs.append(("fail", "program.json blocking issues %s but study.json#readiness.status=%s" % (blocking, ready)))
    if blocking and run not in ("no", None):
        probs.append(("fail", "program.json blocking issues %s but capabilities.json#run.status=%s" % (blocking, run)))
    excluded = ((s.caps or {}).get("run") or {}).get("excluded") or []
    if nonrun and run == "yes" and not excluded:
        probs.append(("concern", "artifacts/failures.json lists %s but capabilities.json#run is yes with nothing excluded"
                      % ", ".join(sorted({f["pattern"] for f in nonrun}))))
    pr = run_probe(s, ctx)
    if pr is None:
        # --no-run: the static failures above stand; only the refusal itself is untested.
        probs.append(("concern", "package/%s/task/adapter.py: refusal behavior was not tested (--no-run)" % s.package.name))
    else:
        if pr.get("error"):
            probs.append(("concern", "package/%s/task/adapter.py: stub run failed: %s" % (s.package.name, str(pr["error"])[:300])))
        # A crash is not a refusal, and the package controls whether it crashes: keep the fail.
        if (blocking or ready == "blocked") and not pr.get("refused"):
            probs.append(("fail", "study is blocked but the stub run was not refused (%s calls)" % str(pr.get("calls", 0))[:20]))
        if not (blocking or ready == "blocked") and pr.get("refused"):
            probs.append(("concern", "study is not blocked but the run was refused: %s" % str(pr["refused"])[:160]))
        if "excludedRefused" in pr and not isinstance(pr["excludedRefused"], str) and pr["excludedRefused"] is not True:
            probs.append(("fail", "capabilities.json#run.excluded arms ran instead of being refused"))
    if probs:
        worst = "fail" if any(p[0] == "fail" for p in probs) else "concern"
        return R(worst, short(p[1] for p in probs))
    return R("pass", None, "readiness %s, run %s, %d blocking issue(s)%s" % (
        ready, run, len(blocking), ", stub run refused" if pr and pr.get("refused") else ""))


def check_P8(s, ctx):
    prof = ((s.caps or {}).get("profiles") or {}).get("status")
    pr = run_probe(s, ctx) if s.package else None
    if pr and pr.get("error"):
        return R("concern", "package/%s/task/adapter.py" % s.package.name, "profile use could not be checked: %s" % pr["error"][:300])
    with_profile = sum(1 for sess in (pr or {}).get("sessions") or [] if any(k in sess for k in ("profile", "persona")))
    if with_profile and prof != "yes":
        return R("concern", "capabilities.json#profiles=%s but %d session(s) carry a profile" % (prof, with_profile),
                 "profiles used without being declared")
    if prof in (None, "no") and not with_profile:
        return R("n/a", None, "no participant profiles are used")
    return R("concern", "capabilities.json#profiles and session profile fields",
             "profile use requires checking every session and a recorded deviation from the original study")


# ---- A: analysis and human data ---------------------------------------------------------------------

def check_A1(s, ctx):
    hm = (s.compare or {}).get("humanMatchesPaper")
    if not (isinstance(hm, list) and len(hm) == 2):
        return R("n/a", None, "no comparison of the package analysis on human data with the paper (no replay-compare.json)")
    if not hm[1]:
        return R("n/a", None, "no reported result could be compared with the human data")
    misses = [e for e in (s.compare or {}).get("effects") or [] if e.get("humanMatchesPaper") is False]
    sample = (s.hkey or {}).get("sample")
    ev = short("artifacts/replay/replay-compare.json#effects:%s human %s vs reported %s" % (e.get("id"), e.get("human"), e.get("reported")) for e in misses)
    note = "%d of %d reported results recovered from the human data (sample: %s)" % (hm[0], hm[1], sample or "unknown")
    if hm[0] == hm[1]:
        return R("pass", None, note)
    if sample == "original":
        return R("fail", ev or "artifacts/replay/replay-compare.json#humanMatchesPaper", note)
    return R("concern", ev or "artifacts/replay/replay-compare.json#humanMatchesPaper",
             note + "; the data may not be the original sample, so a mismatch is not proof of an error")


def check_A2(s, ctx):
    if not s.hcheck:
        return R("n/a", None, "no human data checked; needs agent for the paper's exclusion rule", covers="auto part")
    exc = s.hcheck.get("exclusions")
    if not exc:
        return R("concern", "artifacts/replay/human-check.json#exclusions", "no statement of the exclusions applied", covers="auto part")
    return R("concern", "artifacts/replay/human-check.json#exclusions", "exclusions are stated (%d sessions, %s valid); needs agent to compare application and counts with the paper"
             % (s.hcheck.get("sessions") or 0, s.hcheck.get("valid")), covers="auto part")


def check_A5(s, ctx):
    if not s.hcheck:
        return R("n/a", None, "no human data connected")
    nm = s.hcheck.get("notMapped")
    if nm is None:
        return R("concern", "artifacts/replay/human-check.json#notMapped", "the unmapped parts of the design are not listed")
    missing = ((s.caps or {}).get("humanData") or {}).get("missing")
    if missing is not None and len(missing) != len(nm):
        return R("concern", "human-check.json#notMapped has %d entries, capabilities.json#humanData.missing %d" % (len(nm), len(missing)),
                 "capabilities.json is stale; rerun capabilities.py")
    arms = set(map(str, s.hcheck.get("arms") or []))
    declared = set(task_arms(s.task))
    named = " ".join(text_of(x) for x in nm)
    uncovered = sorted(a for a in declared - arms if a not in named)
    if arms and uncovered:
        return R("concern", "task/task.json#arms %s not in human-check.json#arms and not in notMapped" % uncovered,
                 "arms without human data are not listed as not mapped")
    return R("pass", None, "%d unmapped part(s) listed" % len(nm))


def check_A6(s, ctx):
    data = [p for p in s.files() if p.suffix.lower() in DATA_EXT]
    probs = []
    for p in data:
        rel = p.relative_to(s.root).as_posix()
        probs.append(("fail" if rel.split("/")[0] in ("package", "artifacts", "sources") else "concern",
                      "%s is a data file inside the study folder" % rel))
    has_loader = bool(s.package and any((s.package / "human").glob("*.py")))
    if has_loader:
        if not s.hkey:
            probs.append(("concern", "package/%s/human/key.json missing: no source, version, hash or license key" % s.package.name))
        else:
            repo = s.hkey.get("repository") or {}
            for what, okv in (("repository.url", repo.get("url")), ("pinnedAt (version)", s.hkey.get("pinnedAt")),
                              ("files[].sha256", s.hkey.get("files") and all(f.get("sha256") for f in s.hkey["files"])),
                              ("repository.license", "license" in repo)):
                if not okv:
                    probs.append(("concern", "package/%s/human/key.json#%s missing" % (s.package.name, what)))
    if not probs:
        return R("pass" if has_loader else "n/a", None,
                 "no data files in the folder; the key records source, version, hashes and license" if has_loader
                 else "no human data connected and no data files in the folder")
    worst = "fail" if any(p[0] == "fail" for p in probs) else "concern"
    return R(worst, short(p[1] for p in probs))


def check_A7(s, ctx):
    effs = (s.compare or {}).get("effects")
    if not effs:
        return R("n/a", None, "no AI vs human comparison")
    probs = []
    if not (s.compare.get("agentN") and s.compare.get("humanSessions")):
        probs.append("replay-compare.json: agentN or humanSessions missing")
    for e in effs:
        lacks = [k for k, ok in (("uncertainty", any(k in e for k in ("agent_p", "agent_ci", "agent_se", "ci", "se", "p"))),
                                 ("direction", "agentAgrees" in e or "direction" in e)) if not ok]
        if lacks:
            probs.append("replay-compare.json#effects:%s lacks %s" % (e.get("id"), "/".join(lacks)))
    if probs:
        return R("concern", "artifacts/" + short(probs))
    return R("pass", None, "%d effects compared with n, p and direction agreement" % len(effs))


# ---- T: tools and agent export ----------------------------------------------------------------------

def run_export(s, ctx):
    if "export" in ctx:
        return ctx["export"]
    if ctx.get("no_export") or ctx.get("no_run"):
        ctx["export"] = None
        return None
    copy = ctx["copy"](fresh=True)
    out = copy / "exports" / "audit-agent"
    run = sandbox_run.run_python(EXPORT / "agent_package.py", ["--root", str(copy), "--output", str(out), "--mcp"],
                                 cwd=copy, work=copy.parent, timeout=ctx.get("timeout", 600))
    ctx["export"] = {"ok": run.returncode == 0 and out.is_dir(), "out": out,
                     "log": (run.stdout + run.stderr + ("\nFAIL timed out" if run.timed_out else ""))[-1500:]}
    return ctx["export"]


def check_T1(s, ctx):
    ex = run_export(s, ctx)
    if ex is None:
        return R("n/a", None, "export self-test skipped (--no-export / --no-run)")
    if not ex["ok"]:
        lines = [l.strip() for l in ex["log"].splitlines() if l.strip()]
        msg = next((l for l in lines if l.startswith("FAIL")), "")
        last = lines[-1] if lines else ""
        return R("fail", "agent_package.py --mcp: %s%s" % (msg[:200], (" ... " + last[:300]) if last and last != msg else ""),
                 "export self-test failed")
    oks = [l[5:] for l in ex["log"].splitlines() if l.startswith("ok   ")]
    return R("pass", None, "export self-test passed: " + "; ".join(oks)[:400])


def scan(root, patterns, files):
    hits = []
    for p in files:
        if p.suffix.lower() not in TEXT_EXT and p.suffix:
            continue
        try:
            lines = p.read_text(encoding="utf-8", errors="strict").splitlines()
        except (UnicodeDecodeError, OSError):
            continue
        for ln, line in enumerate(lines, 1):
            for name, rx in patterns:
                if rx.search(line):
                    hits.append("%s:%d (%s)" % (p.relative_to(root).as_posix(), ln, name))
    return hits


def check_T2(s, ctx):
    hits = scan(s.root, PATHS + SECRETS, s.files())
    ex = run_export(s, ctx)
    if ex and ex["ok"]:
        hits += ["export:" + h for h in scan(ex["out"], PATHS + SECRETS, [p for p in ex["out"].rglob("*") if p.is_file()])]
    note = "scanned study files%s for home paths and key patterns" % (" and the agent export" if ex and ex["ok"] else "")
    return R("fail", short(hits), note) if hits else R("pass", None, note)


def check_T3(s, ctx):
    probs = []
    groups = {}
    for p in s.files():
        groups.setdefault(sha256(p), []).append(p.relative_to(s.root).as_posix())
    dup = [g for g in groups.values() if len(g) > 1]
    for g in dup:
        probs.append(("concern", "same bytes: " + ", ".join(g)))
    ex = run_export(s, ctx)
    if ex and ex["ok"]:
        eg = {}
        for p in ex["out"].rglob("*"):
            if p.is_file() and p.name != "MANIFEST.json":
                eg.setdefault(sha256(p), []).append(p.relative_to(ex["out"]).as_posix())
        for g in eg.values():
            if len(g) > 1 and not all(Path(x).name in ("__init__.py",) for x in g):
                probs.append(("fail", "export duplicates: " + ", ".join(g)))
    if not probs:
        return R("pass", None, "no duplicated files in the study folder%s" % (" or its agent export" if ex and ex["ok"] else ""))
    worst = "fail" if any(p[0] == "fail" for p in probs) else "concern"
    return R(worst, short(p[1] for p in probs))


def check_T4(s, ctx):
    run = ((s.caps or {}).get("run") or {}).get("status")
    pr = run_probe(s, ctx) if s.package else None
    if pr is None and s.package:
        return R("n/a", None, "stub run skipped (--no-run)")
    if not s.package:
        return R("n/a", None, "no replay package: the tools have nothing to run")
    # Fail > concern > pass. A probe error or a non-Refusal exception is package-controlled, so it is
    # recorded as a concern but never hides a definite failure.
    probs = []
    if pr.get("error"):
        probs.append(("concern", "package/%s/task/adapter.py: stub run failed: %s" % (s.package.name, str(pr["error"])[:300])))
    if run == "no" and not pr.get("refused"):
        probs.append(("fail", "capabilities.json#run.status=no but the run was not refused (%s model calls%s)"
                      % (str(pr.get("calls", 0))[:20], ", then it crashed" if pr.get("error") else "")))
    if "excludedRefused" in pr:
        ex = pr["excludedRefused"]
        if isinstance(ex, str):
            probs.append(("concern", "capabilities.json#run.excluded: excluded-arm probe failed: %s" % ex[:300]))
        elif ex is not True:
            probs.append(("fail", "capabilities.json#run.excluded arms produced output"))
    if probs:
        worst = "fail" if any(p[0] == "fail" for p in probs) else "concern"
        return R(worst, short(p[1] for p in probs))
    tested = ["run refused" if pr.get("refused") else "run allowed (run=%s)" % run]
    if "excludedRefused" in pr:
        tested.append("excluded arms refused")
    return R("pass", None, "; ".join(tested))


# ---- C: publishing and catalog ----------------------------------------------------------------------

def catalog_entry(s):
    src = s.program.get("source") or {}
    paper = (s.source or {}).get("paper") or {}
    meta = s.meta or {}
    year = src.get("year") or paper.get("year") or meta.get("year") or next(
        (f.get("value") for n in s.nodes.values() if n.get("kind") == "overview" for f in n.get("fields") or []
         if f.get("id") == "year" and f.get("value")), None)
    desc = (s.pstudy or {}).get("overview") or next(
        (f.get("value") for n in s.nodes.values() if n.get("kind") == "overview" for f in n.get("fields") or []
         if f.get("id") == "summary" and f.get("value")), None)
    return {"title": src.get("title") or s.program.get("title") or paper.get("title"),
            "authors": src.get("authors") or meta.get("authors"), "year": year,
            "doi": src.get("doi") or paper.get("doi") or meta.get("doi"), "description": desc}


def check_C1(s, ctx):
    e = catalog_entry(s)
    missing = [k for k in ("title", "authors", "year", "description") if not e.get(k)]
    if missing:
        return R("fail", "program.json#source / sources/SOURCE.json#paper / paper_metadata.json: no %s" % ", ".join(missing))
    if not e.get("doi"):
        return R("concern", "program.json#source.doi, sources/SOURCE.json#paper.doi", "no DOI recorded")
    return R("pass", None, "title, authors, year, DOI and description present")


def check_C3(s, ctx):
    if ctx.get("no_run"):
        return R("n/a", None, "export skipped (--no-run)")
    import community
    copy = ctx["copy"]()
    out = copy / "audit-community.zip"
    try:
        community.export(copy, out)
        names = zipfile.ZipFile(out).namelist()
    except Exception as exc:
        return R("concern", "community.py export", "export failed: %s" % str(exc)[:200])
    lic = str(((s.source or {}).get("pdf") or {}).get("status") or "")
    bad = [n for n in names if n.lower().endswith(".pdf") and lic != "included"]
    bad += [n for n in names if Path(n).suffix.lower() in DATA_EXT]
    other = [n for n in names if n.startswith("sources/") and n != "sources/SOURCE.json" and n not in bad]
    if bad:
        return R("fail", "published by community.py: " + short(bad), "PDF or human data in the published files")
    if other:
        return R("concern", "published by community.py: " + short(other), "sources/ files published; check their license allows it")
    return R("pass", None, "%d files published by community.py; no PDF, data or unlicensed sources" % len(names))


def check_C4(s, ctx):
    if not s.caps:
        return R("fail", "capabilities.json missing", covers="auto part")
    probs = capabilities.validate(s.caps, s.failures)
    if probs:
        return R("fail", short("capabilities.json: " + p for p in probs), covers="auto part")
    out = []
    if s.caps.get("derivedFrom", {}).get("program") != sha256(s.root / "program.json"):
        out.append(("concern", "capabilities.json#derivedFrom.program is not the current program.json hash (stale)"))
    try:
        fresh = capabilities.build(s.root, previous=s.caps)
        for k in ("read", "run", "humanData", "authorCode"):
            if (fresh.get(k) or {}).get("status") != (s.caps.get(k) or {}).get("status"):
                out.append(("concern", "capabilities.json#%s.status=%s, recomputed %s" % (
                    k, (s.caps.get(k) or {}).get("status"), (fresh.get(k) or {}).get("status"))))
        if fresh["reproduced"].get("package") != (s.caps.get("reproduced") or {}).get("package"):
            out.append(("concern", "capabilities.json#reproduced.package=%s, recomputed %s" % (
                (s.caps.get("reproduced") or {}).get("package"), fresh["reproduced"].get("package"))))
    except SystemExit as exc:
        out.append(("concern", "capabilities could not be recomputed: %s" % exc))
    if s.caps.get("run", {}).get("status") in ("yes", "partial") and s.package and not ctx.get("no_run"):
        copy = ctx["copy"](fresh=True)
        pkg = copy / "package" / s.package.name
        run = sandbox_run.run_python(HERE / "check_package.py", [str(pkg)], cwd=copy, work=copy.parent,
                                     timeout=ctx.get("timeout", 600))
        if run.returncode != 0:
            msg = next((l for l in run.stdout.splitlines() if l.startswith("FAIL")), run.stdout[-200:])
            out.append(("fail", "capabilities.json#run.status=%s but check_package.py fails: %s" % (s.caps["run"]["status"], msg[:300])))
    note = "auto part: capabilities agree with the files; needs human for the line check behind a 'traceable' claim"
    if out:
        worst = "fail" if any(p[0] == "fail" for p in out) else "concern"
        return R(worst, short(p[1] for p in out), note, covers="auto part")
    return R("pass", None, note, covers="auto part")


# ---- R: runs ----------------------------------------------------------------------------------------

def check_R1(s, ctx):
    probs = ["program.json: " + m for m, _ in check_program.check(s.program)]
    if not probs:
        probs += ["program.json (--complete): " + m for m, _ in check_program.coverage_problems(s.program)]
    if s.effects is not None and effects_core is not None:
        try:
            ep, _ = effects_core.check(s.root, s.effects, s.program)
            probs += ["effects.json: " + p for p in ep]
        except Exception as exc:
            probs.append("effects.json: check crashed: %s" % exc)
    elif s.effects is None:
        probs.append("effects.json missing")
    if probs:
        return R("fail", short(probs), "%d problem(s) from check_program --complete, effects check" % len(probs), details=probs)
    return R("pass", None, "check_program --complete and the effects check pass on the saved files")


def check_R5(s, ctx):
    hits = scan(s.root, SECRETS, s.files())
    ex = run_export(s, ctx)
    if ex and ex["ok"]:
        hits += ["export:" + h for h in scan(ex["out"], SECRETS, [p for p in ex["out"].rglob("*") if p.is_file()])]
    return R("fail", short(hits), "secret pattern found (value not shown)") if hits else R("pass", None, "no key patterns in the study files")


CHECKS = {"S1": check_S1, "S2": check_S2, "S3": check_S3, "S5": check_S5, "X1": check_X1, "X5": check_X5,
          "X7": check_X7, "P1": check_P1, "P3": check_P3, "P5": check_P5, "P6": check_P6, "P7": check_P7,
          "P8": check_P8, "A1": check_A1, "A2": check_A2, "A5": check_A5, "A6": check_A6, "A7": check_A7,
          "T1": check_T1, "T2": check_T2, "T3": check_T3, "T4": check_T4, "C1": check_C1, "C3": check_C3,
          "C4": check_C4, "R1": check_R1, "R5": check_R5}
BATCH = {"C2"}
NOT_STUDY = {"T5": "repository CI", "C5": "the catalog manifest", "C6": "the website, snapshot and desktop library",
             "C7": "the web and desktop surfaces", "U1": "the desktop library", "U2": "the desktop app",
             "U3": "the desktop app", "R2": "the request transport logs", "R3": "the batch run records",
             "R4": "the release checklist"}
# auto items this script cannot decide from a folder, and why
UNDECIDED = {"X4": "needs agent (no Bench ground truth is read here)", "X9": "needs agent (instrument licensing)"}


def not_auto(item):
    m = item["methods"]
    if item["id"] in NOT_STUDY:
        return "not decidable from a study folder (needs %s)" % NOT_STUDY[item["id"]]
    if item["id"] in UNDECIDED:
        return UNDECIDED[item["id"]]
    if "agent" in m:
        return "needs agent"
    if "human" in m:
        return "needs human"
    return "not automated yet"


def audit_one(root, items, ctx_base):
    s = Study(root)
    work = {}

    def copy(fresh=False):
        """The scratch copy of the study; fresh=True gives a new one in its own folder, for each run of
        package code, so a process left over from one run cannot touch the next (see sandbox_run.py)."""
        if "tmp" not in work:
            base = Path(ctx_base["workdir"]) if ctx_base.get("workdir") else None
            if base:
                base.mkdir(parents=True, exist_ok=True)
            work["tmp"] = tempfile.mkdtemp(prefix="audit-", dir=str(base) if base else None)
        if fresh or "dir" not in work:
            dest = Path(tempfile.mkdtemp(prefix="run-" if fresh else "copy-", dir=work["tmp"])) / s.root.name
            sandbox_run.copy_tree(s.root, dest, ignore=shutil.ignore_patterns("__pycache__", ".git", "exports"))
            if fresh:
                return dest
            work["dir"] = dest
        return work["dir"]
    ctx = dict(ctx_base, copy=copy)
    results = []
    try:
        for item in items:
            iid = item["id"]
            if iid in CHECKS:
                try:
                    r = CHECKS[iid](s, ctx)
                    if iid in ("P1", "P3", "P5", "P6", "P7", "P8", "T4") and r["result"] in ("pass", "n/a") and (ctx.get("probe") or {}).get("untrusted"):
                        r = R("concern", "package/%s/task/adapter.py" % s.package.name,
                              "the stub transcript is produced in the same interpreter as package code and can be forged; independent review required")
                except Exception as exc:
                    r = R("concern", "audit.py", "the check crashed: %s" % "".join(
                        traceback.format_exception_only(type(exc), exc)).strip()[:300])
            elif iid in BATCH:
                r = R("n/a", None, "batch item: decided in batch-audit.json across the audited folders")
            else:
                r = R("n/a", None, not_auto(item))
            results.append(dict({"id": iid, "severity": item["severity"]}, **r))
    finally:
        if "tmp" in work and not ctx_base.get("keep"):
            shutil.rmtree(work["tmp"], ignore_errors=True)
    revision = (s.root / ".revision").read_text().strip() if (s.root / ".revision").is_file() else None
    counts = {}
    for r in results:
        counts[r["result"]] = counts.get(r["result"], 0) + 1
    return {"book": BOOK, "target": s.root.name + ("/revisions/" + revision if revision else ""),
            "program": {"id": s.program.get("id"), "sha256": sha256(s.root / "program.json")},
            "auditor": "auto:audit.py", "date": time.strftime("%Y-%m-%d"), "counts": counts,
            "items": results}, s


def batch_items(studies):
    """C2 across the audited folders: one paper, one entry."""
    keys = {}
    for s in studies:
        e = catalog_entry(s)
        for k in ("doi:" + (norm_doi(e.get("doi")) or ""), "title:" + norm_title(e.get("title"))):
            if not k.endswith(":"):
                keys.setdefault(k, []).append(s.root.name)
    dups = {k: v for k, v in keys.items() if len(v) > 1}
    if dups:
        r = R("fail", short("%s shared by %s" % (k, ", ".join(v)) for k, v in dups.items()),
              "within the audited folders; the catalog itself is not checked")
    else:
        r = R("pass", None, "%d folders, no shared DOI or title (the catalog itself is not checked)" % len(studies))
    return [dict({"id": "C2", "severity": "S2"}, **r)]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("studies", nargs="*")
    ap.add_argument("--out", help="write <out>/<study-name>/audit.json (default: <study>/audit.json)")
    ap.add_argument("--book", help="audit-book.json (default: next to this script)")
    ap.add_argument("--online", action="store_true", help="resolve DOIs (S1)")
    ap.add_argument("--no-run", action="store_true", help="do not run the package or the exports")
    ap.add_argument("--no-export", action="store_true", help="skip the agent export self-test (T1)")
    ap.add_argument("--workdir", help="where the scratch copy of each study goes (default: system temp)")
    ap.add_argument("--keep", action="store_true", help="keep the scratch copies")
    ap.add_argument("--only", help="comma-separated item ids")
    ap.add_argument("--timeout", type=int, default=600)
    ap.add_argument("--probe", help=argparse.SUPPRESS)
    ap.add_argument("--n", type=int, default=2, help=argparse.SUPPRESS)
    a = ap.parse_args(argv)
    if a.probe:
        print(json.dumps({"probe": probe(a.probe, a.n)}, ensure_ascii=False, default=str))
        return 0
    if not a.studies:
        ap.error("name at least one study folder")
    book, by_id = load_book(a.book)
    items = book["items"]
    if a.only:
        want = set(a.only.split(","))
        items = [i for i in items if i["id"] in want]
    ctx = {"online": a.online, "no_run": a.no_run, "no_export": a.no_export, "workdir": a.workdir,
           "keep": a.keep, "timeout": a.timeout}
    any_s1_fail, done = False, []
    for root in a.studies:
        try:
            report, s = audit_one(root, items, ctx)
        except ValueError as exc:
            print("SKIP %s" % exc, file=sys.stderr)
            continue
        done.append(s)
        dest = (Path(a.out) / s.root.name / "audit.json") if a.out else s.root / "audit.json"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        fails = [r for r in report["items"] if r["result"] == "fail"]
        any_s1_fail |= any(r["severity"] == "S1" for r in fails)
        print("%-40s %s  fail: %s" % (s.root.name, " ".join("%s %d" % kv for kv in sorted(report["counts"].items())),
                                      ", ".join(r["id"] for r in fails) or "-"))
    if len(done) > 1 and (not a.only or "C2" in a.only.split(",")):
        batch = {"book": BOOK, "target": [s.root.name for s in done], "auditor": "auto:audit.py",
                 "date": time.strftime("%Y-%m-%d"), "items": batch_items(done)}
        dest = Path(a.out or ".") / "batch-audit.json"
        dest.write_text(json.dumps(batch, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print("batch: C2 %s" % batch["items"][0]["result"])
    return 1 if any_s1_fail else 0


if __name__ == "__main__":
    sys.exit(main())
