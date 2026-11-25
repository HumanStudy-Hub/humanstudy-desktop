#!/usr/bin/env python3
"""Fill in a published study's original wording on this computer (hsenv link + hash rehydration, DESIGN §3.6).

A published protocol.json may hold placeholders where the participant-facing text comes from a source that cannot
be redistributed: `distribution.held` lists each such item with a locator and the hash of the exact text. This
helper restores them locally: it downloads link-tier sources from their URL, tries the files the researcher put in
the project for the rest (user tier, or a download that failed), and calls `hsenv.rehydrate`. Every item is checked
by its own text hash, so a wrong file can only leave an item unresolved, never put other text on screen.

The app's main process runs it from its own copy (never the project's), with the bundled engine on sys.path:

    python -I -B -X utf8 hs_original_text.py <engine dir> <project>/protocol.json <cache dir> [--file <path>]...
           [--fills <project>/sources/private/original-text-fills.json] [--allow-local] [--offline]

Three tiers, each labelled in the status: the exact text (its sha256 verified); approximate (the release carries an
`approx` fingerprint and the passage is located in the researcher's own PDF copy, hs_approx_text: may contain
reading errors); supplied (the project's fills file: text the researcher pasted, origin "user", or reconstructed by
the assistant with their agreement, origin "reconstructed"). Exact wins over approximate, approximate over a fill.

Nothing it reads, downloads or restores leaves this computer, and nothing is written into the project: downloads
and restored protocols go under <cache dir> (app storage). The restored protocol of a study version is cached as
<cache dir>/<sha256 of protocol.json>/protocol.json once every item is restored. It prints one JSON line: the
status the app turns into plain words (no text of the source in it).
"""
from __future__ import annotations

import copy
import hashlib
import ipaddress
import json
import os
import re
import socket
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_BYTES = 100 * 1024 * 1024        # largest source file read or downloaded
DOWNLOAD_TIMEOUT = 30                 # seconds a socket operation may wait
DOWNLOAD_DEADLINE = 90                # seconds one download may take in all (a trickling server is cut off)
DOWNLOADS_BUDGET = 150                # seconds all downloads of one check may take (the app stops the helper at 300)
RETRY_AFTER = 10 * 60                 # a failed download is not tried again for this long (seconds)
MAX_CANDIDATES = 12                   # project files tried per source
EXTENSIONS = {"pdf": (".pdf",), "html": (".html", ".htm", ".xhtml"), "text": (".txt", ".text", ".md", ".rmd", ".r"),
              "docx": (".docx",), "qsf": (".qsf", ".json")}
# Item statuses that count as restored for a run. "ok": the exact text (its sha256 verified). "approx": located in
# the researcher's own copy by the release's fingerprint (hs_approx_text), may contain reading errors. "user" /
# "reconstructed": supplied in the project's fills file (FILLS) by the researcher, or reconstructed by the assistant
# with the researcher's agreement. A held picture (or a region rendered as one) is not supported yet: it stays
# unresolved.
OK = ("ok", "approx", "user", "reconstructed")
LABELS = ("approx", "user", "reconstructed")   # restored, but not verified against the published text
FILLS = "sources/private/original-text-fills.json"   # per project, never published (sources/private/ stays local)
MAX_FILLS_BYTES = 2 * 1024 * 1024
MAX_FILL_CHARS = 200_000


def restored_ok(entry, item_report) -> bool:
    """A held text restored on this computer; pictures are never counted (the run could not show them)."""
    return isinstance(entry, dict) and entry.get("kind") != "image" and (item_report or {}).get("status") in OK
STATUS_VERSION = 2


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def held_of(protocol: dict) -> dict:
    dist = protocol.get("distribution") if isinstance(protocol, dict) else None
    held = dist.get("held") if isinstance(dist, dict) else None
    return held if isinstance(held, dict) else {}


def sources_of(protocol: dict) -> dict:
    s = (protocol.get("meta") or {}).get("sources") if isinstance(protocol.get("meta"), dict) else None
    return s if isinstance(s, dict) else {}


def distribution_of(protocol: dict, key: str) -> dict:
    v = sources_of(protocol).get(key)
    d = v.get("distribution") if isinstance(v, dict) else None
    return d if isinstance(d, dict) else {"tier": "user"}


def title_of(protocol: dict, key: str) -> str:
    """What the researcher calls the source: its title, citation or file name; else the study's title."""
    v = sources_of(protocol).get(key)
    if isinstance(v, dict):
        for k in ("title", "citation", "label"):
            if isinstance(v.get(k), str) and v[k].strip():
                return v[k].strip()[:200]
        if isinstance(v.get("file"), str) and v["file"].strip():
            return os.path.basename(v["file"].strip())[:200]
    elif isinstance(v, str) and v.strip():
        return os.path.basename(v.strip())[:200]
    meta = protocol.get("meta") if isinstance(protocol.get("meta"), dict) else {}
    for k in ("title", "citation"):
        if isinstance(meta.get(k), str) and meta[k].strip():
            return meta[k].strip()[:200]
    return key


def screen_of(path: str) -> str:
    """The screen an item sits on: its stage (/stages/<id>/...), else the item itself (data shown on screens)."""
    parts = path.split("/") if isinstance(path, str) else []
    if len(parts) > 2 and parts[1] == "stages":
        return "stage:" + parts[2]
    return "item:" + str(path)


# ------------------------------------------------------------------------------------------------ downloads
def _public_host(url: str) -> bool:
    """False for a URL whose host resolves to this computer or a private network (a study cannot make the app probe
    local services); True for a public host."""
    host = urllib.parse.urlsplit(url).hostname or ""
    try:
        infos = socket.getaddrinfo(host, None)
    except OSError:
        return False   # cannot resolve here: never handed to a proxy, which might reach an internal name
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if not ip.is_global or ip.is_multicast:
            return False
    return True


class ChangedOnline(OSError):
    """The last download of this URL restored none of the study's wording (its name reaches hsenv's report)."""


RESTORED_NONE = "the download restored none of the study's wording"


class _NoDowngrade(urllib.request.HTTPRedirectHandler):
    """No https -> http, no other scheme, and (unless local hosts are allowed, in tests) no redirect to this
    computer or a private network. A DNS answer that changes between this check and the connection is not caught."""
    allow_local = False

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not self.allow_local and not _public_host(newurl):
            raise urllib.error.HTTPError(newurl, code, "redirect to a local or private address refused", headers, fp)
        if urllib.parse.urlsplit(req.full_url).scheme == "https" and urllib.parse.urlsplit(newurl).scheme != "https":
            raise urllib.error.HTTPError(newurl, code, "redirect from https to http refused", headers, fp)
        if urllib.parse.urlsplit(newurl).scheme not in ("http", "https"):
            raise urllib.error.HTTPError(newurl, code, "redirect to another scheme refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def looks_like_html(data: bytes) -> bool:
    head = data[:2048].lstrip().lower()
    return head.startswith((b"<!doctype html", b"<html", b"<head", b"<body")) or b"<html" in head[:512]


def _socket_deadline(res, seconds: float) -> None:
    """Make the next socket read wait at most `seconds` (the time left of the download's deadline), so a server
    that sends a byte now and then cannot stretch a single read past the deadline."""
    for path in (("fp", "raw", "_sock"), ("fp", "_sock")):
        obj = res
        try:
            for name in path:
                obj = getattr(obj, name)
            obj.settimeout(max(0.05, seconds))
            return
        except (AttributeError, OSError):
            continue


def make_fetch(cache: Path, allow_local: bool = False, offline: bool = False, log: list | None = None,
               formats: dict | None = None):
    """fetch(url) -> bytes for hsenv.rehydrate: http(s) only, at most MAX_BYTES and DOWNLOAD_DEADLINE seconds (all
    downloads of one check together at most DOWNLOADS_BUDGET), cached under <cache>/downloads by URL; a failure is
    remembered for RETRY_AFTER seconds so a check that repeats does not hammer the publisher. A web page returned for a
    source that is not one (`formats`: url -> source format) is a sign-in or paywall page: a failed download."""
    root = cache / "downloads"
    started = time.monotonic()
    redirects = _NoDowngrade()
    redirects.allow_local = allow_local
    opener = urllib.request.build_opener(redirects)

    def fetch(url: str) -> bytes:
        key = sha256(url.encode("utf-8"))
        got, failed = root / key, root / (key + ".failed")
        if got.is_file():
            return got.read_bytes()
        if failed.is_file() and time.time() - failed.stat().st_mtime < RETRY_AFTER:
            why = failed.read_text(encoding="utf-8")[:200]
            raise (ChangedOnline if why == RESTORED_NONE else OSError)("download failed recently: " + why)
        if offline:
            raise OSError("offline")
        if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
            raise ValueError("only http(s) sources are downloaded")
        try:
            if not allow_local and not _public_host(url):
                raise ValueError("the source URL points to this computer or a private network")
            req = urllib.request.Request(url, headers={"User-Agent": "HumanStudyHub-desktop (original wording)",
                                                       "Accept": "*/*"})
            deadline = min(time.monotonic() + DOWNLOAD_DEADLINE, started + DOWNLOADS_BUDGET)
            if time.monotonic() >= deadline:
                raise TimeoutError("no time left for downloads in this check")
            chunks, size = [], 0
            with opener.open(req, timeout=max(0.1, min(DOWNLOAD_TIMEOUT, deadline - time.monotonic()))) as res:
                while True:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        raise TimeoutError("the download took longer than %d seconds" % DOWNLOAD_DEADLINE)
                    _socket_deadline(res, min(DOWNLOAD_TIMEOUT, left))
                    chunk = res.read1(64 * 1024)   # whatever has arrived: a trickling server cannot hold one read
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise ValueError("the source file is larger than %d MB" % (MAX_BYTES // 2 ** 20))
            data = b"".join(chunks)
            if (formats or {}).get(url) not in (None, "html") and looks_like_html(data):
                raise ValueError("the server returned a web page (a sign-in or paywall page), not the source file")
        except Exception as e:   # noqa: BLE001 - any failure: the source is unavailable for now
            root.mkdir(parents=True, exist_ok=True)
            failed.write_text("%s: %s" % (type(e).__name__, str(e)[:160]), encoding="utf-8")
            if log is not None:
                log.append({"url": url, "error": type(e).__name__})
            raise
        root.mkdir(parents=True, exist_ok=True)
        tmp = root / (key + ".%d.tmp" % os.getpid())
        tmp.write_bytes(data)
        os.replace(tmp, got)
        failed.unlink(missing_ok=True)
        return data
    return fetch


def forget_download(cache: Path, url: str, why: str) -> None:
    """Drop a download that restored nothing (a paywall or login page, a captive portal, a truncated file): it is
    asked for again after RETRY_AFTER instead of being kept for good."""
    root = cache / "downloads"
    key = sha256(url.encode("utf-8"))
    (root / key).unlink(missing_ok=True)
    root.mkdir(parents=True, exist_ok=True)
    (root / (key + ".failed")).write_text(why, encoding="utf-8")


# ------------------------------------------------------------------------------------------- project files
def candidates_for(fmt: str | None, files: list[Path], key: str, want: str | None) -> list[Path]:
    """The project files worth trying for one source, best first: named after the source, then the file the study
    was built from (same sha256), then every other file of the right format."""
    exts = EXTENSIONS.get(fmt or "", ())
    pool = [f for f in files if not exts or f.suffix.lower() in exts]
    named = [f for f in pool if f.stem.lower() == key.lower()]

    def same(f):
        data = read_file(f) if want is not None else None
        return data is not None and sha256(data) == want
    exact = [f for f in pool if f not in named and same(f)]
    rest = [f for f in pool if f not in named and f not in exact]
    return (named + exact + rest)[:MAX_CANDIDATES]


def read_file(path: Path) -> bytes | None:
    try:
        if not path.is_file() or path.stat().st_size > MAX_BYTES:
            return None
        return path.read_bytes()
    except OSError:
        return None


# ------------------------------------------------------------------------------------------------- restore
def pdf_extractors():
    """{"pdf": pypdfium2 extractor} when the runtime has pypdfium2, else {} (PDF sources then stay unresolved and the
    status says so)."""
    from hsenv import distribution as D
    try:
        return {"pdf": D.pdfium_extractor()}
    except ImportError:
        return {}


def only_source(projection: dict, key: str) -> dict:
    """The projection with only one source's held items (to try a file for that source cheaply)."""
    p = copy.deepcopy(projection)
    p["distribution"]["held"] = {h: e for h, e in held_of(projection).items() if isinstance(e, dict) and e.get("source") == key}
    return p


def restore(projection: dict, cache: Path, files: list[Path], allow_local=False, offline=False, fills=None):
    """-> (restored protocol or None, report, chosen files {source: path}, extractors, download log).

    Precedence per held text: the exact text (hsenv.rehydrate, or a fill of origin "user" whose sha256 is the
    recorded one), then the approximate text located in the researcher's copy (`approx` fingerprint), then a fill
    (`fills`: {held id: {"text", "origin"}}, already validated by load_fills)."""
    from hsenv import distribution as D
    extractors = pdf_extractors()
    log: list = []
    formats = {d["url"]: d.get("format") for d in (distribution_of(projection, k) for k in sources_of(projection))
               if d.get("tier") == "link" and isinstance(d.get("url"), str)}
    fetch = make_fetch(cache, allow_local=allow_local, offline=offline, log=log, formats=formats)
    out, report = D.rehydrate(projection, fetch=fetch, extractors=extractors)
    chosen: dict[str, Path] = {}
    supplied: dict[str, bytes] = {}
    held = held_of(projection)

    def ok_count(rep_, key):
        return sum(1 for h, e in held.items() if isinstance(e, dict) and e.get("source") == key
                   and restored_ok(e, rep_["items"].get(h)))
    # a link source whose download restored nothing is not kept (see forget_download)
    for key, src in (report.get("sources") or {}).items():
        d = distribution_of(projection, key)
        if d.get("tier") == "link" and src.get("status") == "ok" and isinstance(d.get("url"), str) \
                and src.get("matches_recorded_sha256") is not True and ok_count(report, key) == 0:
            forget_download(cache, d["url"], RESTORED_NONE)
    todo = sorted({e.get("source") for h, e in held.items()
                   if isinstance(e, dict) and isinstance(e.get("source"), str)
                   and not restored_ok(e, report["items"].get(h))})
    for key in todo:
        d = distribution_of(projection, key)
        want = d.get("sha256") if isinstance(d.get("sha256"), str) else None
        sub = only_source(projection, key)
        n_items = len(held_of(sub))
        # a file replaces the download only when it restores more of this source than the download did
        best, best_ok = None, ok_count(report, key)
        for path in candidates_for(d.get("format"), files, key, want):
            data = read_file(path)
            if data is None:
                continue
            _, rep = D.rehydrate(sub, files={key: data}, extractors=extractors)
            k = sum(1 for h, r in rep["items"].items() if restored_ok(held.get(h), r))
            if k > best_ok:
                best, best_ok = (path, data), k
            if k == n_items:
                break
        if best is not None:
            chosen[key], supplied[key] = best
    if supplied:
        out, report = D.rehydrate(projection, fetch=fetch, files=supplied, extractors=extractors)
    fill_in(projection, out, report, fills or {}, cache, files, chosen, supplied, extractors)
    complete = all(restored_ok(e, report["items"].get(h)) for h, e in held.items())
    report["complete"] = complete
    return (out if complete else None), report, chosen, extractors, log


def _approx_module():
    """hs_approx_text, from beside this file (the app runs the helper from its own scratch copy)."""
    import importlib.util
    here = Path(__file__).with_name("hs_approx_text.py")
    if here.is_file():
        spec = importlib.util.spec_from_file_location("hs_approx_text", here)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    import hs_approx_text   # noqa: F401 - tests put lib/ on sys.path
    return hs_approx_text


def _put(out: dict, entry: dict, text: str) -> bool:
    """Put `text` where the held item's placeholder stands; only a placeholder of the item's own length is ever
    replaced (a fill can never overwrite another field)."""
    from hsenv import distribution as D
    try:
        cur = D._get(out, entry["path"])
    except (KeyError, IndexError, ValueError, TypeError):
        return False
    if not (isinstance(cur, str) and cur and set(cur) == {D.PLACEHOLDER} and len(cur) == entry.get("length")):
        return False
    D._set(out, entry["path"], unicodedata.normalize("NFC", text))
    return True


def approx_pages(key: str, projection: dict, cache: Path, files: list[Path], chosen: dict, supplied: dict,
                 extractors: dict):
    """[(path or None, page texts)] of the PDF copies of one source on this computer, best first: the file chosen
    for the exact restore, the download, then the project's other PDF files."""
    if "pdf" not in extractors:
        return []
    d = distribution_of(projection, key)
    if d.get("format") not in (None, "pdf"):
        return []
    seen, out = set(), []
    cands: list = []
    if key in supplied:
        cands.append((chosen.get(key), supplied[key]))
    if d.get("tier") == "link" and isinstance(d.get("url"), str):
        got = cache / "downloads" / sha256(d["url"].encode("utf-8"))
        data = read_file(got) if got.is_file() else None
        if data is not None:
            cands.append((None, data))
    want = d.get("sha256") if isinstance(d.get("sha256"), str) else None
    for f in candidates_for("pdf", files, key, want):
        cands.append((f, None))
    for path, data in cands[:MAX_CANDIDATES + 2]:
        data = data if data is not None else read_file(path)
        if data is None or not data.startswith(b"%PDF") or sha256(data) in seen:
            continue
        seen.add(sha256(data))
        try:
            pages = extractors["pdf"](data)
        except Exception:   # noqa: BLE001 - an unreadable PDF: try the next copy
            continue
        if isinstance(pages, list) and pages:
            out.append((path, [p if isinstance(p, str) else "" for p in pages]))
    return out


def fill_in(projection: dict, out: dict, report: dict, fills: dict, cache: Path, files: list[Path], chosen: dict,
            supplied: dict, extractors: dict) -> None:
    """Restore what the exact pass left, in place (`out`, `report`): a user fill that hashes to the recorded text
    (exact), then the approximate text from the researcher's copy, then the fills file. Items stay unresolved when
    nothing applies."""
    from hsenv import distribution as D
    held = held_of(projection)
    items = report.setdefault("items", {})

    def todo():
        return [h for h, e in sorted(held.items()) if isinstance(e, dict) and e.get("kind") != "image"
                and isinstance(e.get("path"), str) and not restored_ok(e, items.get(h))]

    def mark(h, e, status, **extra):
        prev = items.get(h) or {}
        items[h] = dict({"source": e.get("source"), "path": e.get("path"), "kind": e.get("kind", "text"),
                         "status": status, "before": prev.get("status")}, **extra)
    # 1. a fill the researcher pasted that is exactly the published text: exact
    for h in todo():
        f, e = fills.get(h), held[h]
        if f and f["origin"] == "user" and isinstance(e.get("text_sha256"), str) \
                and D.text_sha256(f["text"]) == e["text_sha256"] and _put(out, e, f["text"]):
            mark(h, e, "ok", via="fill")
    # 2. approximate: located in the researcher's PDF copy of the same source by the release's fingerprint
    want = {}
    for h in todo():
        if isinstance(held[h].get("approx"), dict) and isinstance(held[h].get("source"), str):
            want.setdefault(held[h]["source"], []).append(h)
    if want:
        A = _approx_module()
        for key, hs in sorted(want.items()):
            best = None
            for path, pages in approx_pages(key, projection, cache, files, chosen, supplied, extractors):
                found = {}
                for h in hs:
                    try:
                        got = A.locate(pages, held[h]["approx"])
                    except Exception:   # noqa: BLE001 - a malformed fingerprint: not placed
                        got = None
                    if got and got[0].strip() and D.PLACEHOLDER not in got[0]:
                        found[h] = got
                if found and (best is None or len(found) > len(best[1])):
                    best = (path, found)
                if best and len(best[1]) == len(hs):
                    break
            if best is None:
                continue
            for h, (text, score) in best[1].items():
                if _put(out, held[h], text):
                    mark(h, held[h], "approx", score=score)
            if best[0] is not None and key not in chosen:
                chosen[key] = best[0]
    # 3. the fills file: what the researcher supplied, or what the assistant reconstructed with them
    for h in todo():
        f = fills.get(h)
        if f and _put(out, held[h], f["text"]):
            mark(h, held[h], f["origin"])
    remaining = {h: e for h, e in held.items() if not restored_ok(e, items.get(h))}
    if remaining:
        out.setdefault("distribution", copy.deepcopy(projection.get("distribution") or {}))["held"] = remaining
    else:
        out.pop("distribution", None)


def load_fills(path: Path | None, projection: dict) -> tuple[dict, list[dict], str | None]:
    """(valid fills {held id: {"text", "origin"}}, problems [{held, why}], sha256 of the file or None). The fills
    file (FILLS) is written by the assistant: {"<held id>": {"text": "...", "origin": "user" | "reconstructed",
    "note": "..."}}. A problem names the held id and why, never the text."""
    if path is None:
        return {}, [], None
    data = read_file(path)
    if data is None:
        return {}, [], None
    if len(data) > MAX_FILLS_BYTES:
        return {}, [{"held": None, "why": "the fills file is larger than 2 MB"}], sha256(data)
    try:
        raw = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {}, [{"held": None, "why": "the fills file is not valid JSON"}], sha256(data)
    if not isinstance(raw, dict):
        return {}, [{"held": None, "why": "the fills file must be a JSON object keyed by held id"}], sha256(data)
    held = held_of(projection)
    fills, problems = {}, []
    for h, v in raw.items():
        if not isinstance(h, str) or h.startswith("_"):
            continue   # "_comment" and the like
        why = None
        if h not in held or not isinstance(held[h], dict):
            why = "no held item has this id"
        elif held[h].get("kind") == "image":
            why = "this item is a picture; a text cannot fill it"
        elif not isinstance(v, dict) or not isinstance(v.get("text"), str) or not v["text"].strip():
            why = "text must be a non-empty string"
        elif v.get("origin") not in ("user", "reconstructed"):
            why = 'origin must be "user" or "reconstructed"'
        elif len(v["text"]) > MAX_FILL_CHARS:
            why = "text is longer than %d characters" % MAX_FILL_CHARS
        elif "\u2591" in v["text"]:
            why = "text contains placeholder characters"
        if why:
            problems.append({"held": h[:20], "why": why})
        else:
            fills[h] = {"text": v["text"], "origin": v["origin"]}
    return fills, problems, sha256(data)


def need_of(fmt: str | None, tier: str | None, statuses: list[dict], source_report: dict, had_file: bool,
            extractors: dict) -> str:
    """Why a source's items stay unresolved, as one plain reason the app words for the researcher."""
    if any(r.get("kind") == "image" or r.get("status") == "ok_image" for r in statuses):
        return "picture"           # a picture from the source: not shown by this version of the app yet
    details = " ".join(str(r.get("detail") or "") for r in statuses)
    kinds = {r.get("status") for r in statuses}
    if fmt == "pdf" and "pdf" not in extractors:
        return "pdf-reader"        # the runtime has no PDF reader (pypdfium2)
    if "locator written by extractor" in details:
        return "app-version"       # the study was published with another PDF reader version than this app's
    if kinds <= {"requires_reading"}:
        return "reading"           # text read from a picture: no file can fill it in automatically
    if had_file:
        return "wrong-file"        # the researcher's copy filled some screens, not all: another edition
    if tier == "link":
        # downloaded, but the text differs from the published study (the file changed online), or no download
        changed = source_report.get("status") == "ok" or "ChangedOnline" in str(source_report.get("detail") or "")
        return "changed-online" if changed else "download"
    return "file"


def status(projection: dict, report: dict, chosen: dict, extractors: dict, log: list,
           fill_problems: list | None = None, fills_file: bool = False) -> dict:
    """The status the app and the assistant read: counts, per-source needs, the labels of items restored without
    verification and the unresolved items (ids, paths, titles, lengths, why): never any text of a source or fill."""
    held = held_of(projection)
    st_of = lambda h: (report["items"].get(h) or {}).get("status")   # noqa: E731
    by_source: dict[str, list] = {}
    for h, e in held.items():
        if isinstance(e, dict) and isinstance(e.get("source"), str):
            by_source.setdefault(e["source"], []).append((h, e))
    sources = []
    for key in sorted(by_source):
        d = distribution_of(projection, key)
        fmt = d.get("format") if isinstance(d.get("format"), str) else None
        tier = d.get("tier") if d.get("tier") in ("link", "user", "hosted") else "user"
        items = by_source[key]
        unresolved = [(h, e) for h, e in items if not restored_ok(e, report["items"].get(h))]
        rec = {"key": key, "title": title_of(projection, key), "tier": tier, "format": fmt or "unknown",
               "items": len(items), "restored": len(items) - len(unresolved),
               **{lab: sum(1 for h, _ in items if st_of(h) == lab) for lab in LABELS},
               "screens": len({screen_of(e.get("path")) for _, e in unresolved}),
               "file": str(chosen[key]) if key in chosen else None}
        if tier == "link" and isinstance(d.get("url"), str):
            rec["url"] = d["url"]
        if unresolved:
            rec["need"] = need_of(fmt, tier, [report["items"].get(h, {}) for h, _ in unresolved],
                                  report.get("sources", {}).get(key) or {}, key in chosen, extractors)
        sources.append(rec)
    total = sum(s["items"] for s in sources)
    restored = sum(s["restored"] for s in sources)
    labels = {h: st_of(h) for h in sorted(held) if st_of(h) in LABELS}
    titles = {s["key"]: s["title"] for s in sources}
    unresolved = []
    for h, e in sorted(held.items()):
        if not isinstance(e, dict) or restored_ok(e, report["items"].get(h)):
            continue
        key = e.get("source") if isinstance(e.get("source"), str) else None
        d = distribution_of(projection, key) if key else {}
        fmt = d.get("format") if isinstance(d.get("format"), str) else None
        tier = d.get("tier") if d.get("tier") in ("link", "user", "hosted") else "user"
        unresolved.append({
            "held": h, "screen": screen_of(e.get("path")), "path": e.get("path") if isinstance(e.get("path"), str) else None,
            "source": key, "title": titles.get(key) or (title_of(projection, key) if key else None),
            "kind": "picture" if e.get("kind") == "image" else "text",
            "length": e.get("length") if isinstance(e.get("length"), int) else None,
            "need": need_of(fmt, tier, [report["items"].get(h, {})], report.get("sources", {}).get(key) or {},
                            key in chosen, extractors)})
    return {"version": STATUS_VERSION, "projection": True, "complete": bool(report.get("complete")),
            "items": total, "restored": restored,
            "exact": sum(1 for h, e in held.items() if isinstance(e, dict) and e.get("kind") != "image" and st_of(h) == "ok"),
            "approx": sum(1 for v in labels.values() if v == "approx"),
            "supplied": {"user": sum(1 for v in labels.values() if v == "user"),
                         "reconstructed": sum(1 for v in labels.values() if v == "reconstructed")},
            "labels": labels, "unresolved": unresolved,
            "fills": {"file": FILLS, "present": bool(fills_file), "problems": list(fill_problems or [])},
            "screens": len({screen_of(e.get("path")) for h, e in held.items()
                            if isinstance(e, dict) and not restored_ok(e, report["items"].get(h))}),
            "pdfReader": "pdf" in extractors, "sources": sources,
            "downloadsFailed": len(log)}


# ------------------------------------------------------------------------------- research-capture redaction index
PRIVATE_RUN = 40   # telemetry-core.ts PRIVATE_RUN: a run of 40 skeleton characters quoted from private material
MAX_SKELETON = 1_000_000   # characters of one text indexed (a very large file: its first million)
_M32 = 0xFFFFFFFF


INDEX_FORMAT = 2   # telemetry-core.ts INDEX_FORMAT: files are <name>.v2.bin; older ones are rebuilt
# telemetry-core.ts ENUMERATOR / INLINE_ENUMERATOR (the same patterns): a line's enumerator, bullet or heading, and the
# same enumerators mid-line, removed in a second form of every text
ENUMERATOR = re.compile(r"^\s*(?:[0-9]+\|\s?)?(?:#{1,6}\s*)?(?:\*\*)?(?:[-*•·]\s+|\(?(?:[a-z]{1,2}|item|no\.?|question|statement)?\s*[0-9]+[a-z]?\s*(?:[.):：]\s*|$)|\(?(?:[ivx]{1,5}|[a-z])\s*[.)]\s+|第\s*[0-9]+\s*[题问項项条]\s*[:：.、]?\s*)?(?:\*\*)?", re.I)
INLINE_ENUMERATOR = re.compile(r"(?:^|(?<=[\s,;]))(?:\((?:[ivx]{1,5}|[a-z]|[0-9]+)\)|(?:q|question|statement|item|s|a)\s*[0-9]+[a-z]?\s*[:.)]|第\s*[0-9]+\s*[题问項项条]\s*[:：.、]?)", re.I)


def strip_enumerators(text: str) -> str:
    """telemetry-core.ts stripEnumerators: lines split on \\n with a trailing \\r dropped (the app's /\\r?\\n/)."""
    return "\n".join(INLINE_ENUMERATOR.sub(" ", ENUMERATOR.sub("", line.rstrip("\r"), count=1))
                     for line in unicodedata.normalize("NFKC", text).split("\n"))   # NFKC first, as the app


def skeleton(text: str) -> list[int]:
    """NFKC, lower case, letters only (any script), as code points (telemetry-core.ts skeleton): digits are left
    out, so re-numbered items never break a run."""
    return [ord(ch) for ch in unicodedata.normalize("NFKC", text).lower() if unicodedata.category(ch)[0] == "L"]


def window_pairs(text: str) -> set[tuple[int, int]]:
    """(a, b) hash of every PRIVATE_RUN-long window of the text's skeleton (telemetry-core.ts windowHash), for the
    text as it is and with each line's enumerator removed (Q1:, (a), Item 3: insert letters between items)."""
    stripped = strip_enumerators(text)
    out = _windows(text)
    if stripped != text:
        out |= _windows(stripped)
    return out


def _windows(text: str) -> set[tuple[int, int]]:
    cps, out = skeleton(text)[:MAX_SKELETON], set()
    for i in range(len(cps) - PRIVATE_RUN + 1):
        a, b = 0x811C9DC5, 0x9747B28C
        for cp in cps[i:i + PRIVATE_RUN]:
            a = ((a ^ cp) * 0x01000193) & _M32
            b = ((b ^ cp) * 0x5BD1E995) & _M32
            b = (b ^ (b >> 15)) & _M32
        out.add((a, b))
    return out


def window_hashes(text: str) -> set[str]:
    return {"%08x%08x" % ab for ab in window_pairs(text)}


def _write_pairs(dest: Path, pairs) -> None:
    """Sorted big-endian (a, b) uint32 pairs, 8 bytes each: hashes only, never text."""
    import struct
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name("%s.%d.tmp" % (dest.name, os.getpid()))
    tmp.write_bytes(b"".join(struct.pack(">II", a, b) for a, b in sorted(pairs)))
    os.replace(tmp, dest)


def _read_pairs(path: Path) -> set[tuple[int, int]]:
    import struct
    data = path.read_bytes()
    return {struct.unpack_from(">II", data, i) for i in range(0, len(data) - len(data) % 8, 8)}


def file_text(data: bytes, extractors: dict) -> str:
    from hsenv import distribution as D
    try:
        return "\n".join(D.units(D.sniff(data), data, extractors))
    except Exception:   # noqa: BLE001 - an unreadable file: its raw text, if any
        return data.decode("utf-8", errors="ignore")


def file_windows(cache: Path, data: bytes, extractors: dict) -> set[tuple[int, int]]:
    """The windows of one file, kept by its sha256 (<cache>/windows/<sha>.bin): it is extracted only once."""
    dest = cache / "windows" / ("%s.v%d.bin" % (sha256(data), INDEX_FORMAT))
    if dest.is_file():
        return _read_pairs(dest)
    pairs = window_pairs(file_text(data, extractors))
    _write_pairs(dest, pairs)
    return pairs


def _is_private(f: Path) -> bool:
    parts = [x.lower() for x in f.parts]
    return any(parts[i] == "sources" and parts[i + 1] == "private" for i in range(len(parts) - 1))


def _strings(o, skip=()):
    if isinstance(o, str):
        yield o
    elif isinstance(o, dict):
        for k, v in o.items():
            if k not in skip:
                yield from _strings(v)
    elif isinstance(o, list):
        for v in o:
            yield from _strings(v)


def index_project(cache: Path, project: Path, projection: dict, files: list[Path], extractors: dict,
                  restored=None, received=None, fills=None) -> Path:
    """The redaction index of one project (<cache>/redact/<sha256 of its folder>.bin), which the app's research
    capture loads: every run of the researcher's private copies (files under sources/private/), of this study's
    downloads and of its restored wording, minus only what verifiably ships with the study, so quoting what the
    study itself shows is never redacted: the strings of the protocol.json as RECEIVED (`received`, the copy the app
    stored when it first saw the study, never the live file; its held list left out) and project files whose sha256
    is a hosted source's recorded sha256 in that received copy. Nothing written on this computer (sources/ outside
    private/, sources/researcher/, effects.json, the live protocol.json) ever counts as public: text copied out of
    sources/private/ stays private."""
    # cached windows of an older index format are dropped (they are rebuilt from the files when needed)
    for old in (cache / "windows").glob("*.bin") if (cache / "windows").is_dir() else []:
        if not old.name.endswith(".v%d.bin" % INDEX_FORMAT):
            old.unlink(missing_ok=True)
    private: set = set()
    for f in files:
        if _is_private(f):
            data = read_file(f)
            if data is not None:
                private |= file_windows(cache, data, extractors)
    for k in sources_of(projection):
        d = distribution_of(projection, k)
        if d.get("tier") == "link" and isinstance(d.get("url"), str):
            got = cache / "downloads" / sha256(d["url"].encode("utf-8"))
            data = read_file(got) if got.is_file() else None
            if data is not None:
                private |= file_windows(cache, data, extractors)
    held = held_of(projection)
    if restored is not None:
        texts = []
        for e in held.values():
            try:
                v = restored
                for part in e["path"].split("/")[1:]:
                    part = part.replace("~1", "/").replace("~0", "~")
                    v = v[int(part)] if isinstance(v, list) else v[part]
                if isinstance(v, str):
                    texts.append(v)
            except (KeyError, IndexError, ValueError, TypeError):
                continue
        private |= window_pairs("\n".join(texts))
    # what the researcher pasted into the fills file comes from their copy of a source: private like the copy
    user_fills = [f["text"] for f in (fills or {}).values() if f.get("origin") == "user"]
    if user_fills:
        private |= window_pairs("\n".join(user_fills))
    public: set = set()
    if isinstance(received, dict):
        public |= window_pairs("\n".join(_strings(received, skip=("distribution",))))
        hosted = {d.get("sha256") for d in (distribution_of(received, k) for k in sources_of(received))
                  if d.get("tier") == "hosted" and isinstance(d.get("sha256"), str)}
        for f in files:
            if _is_private(f) or "researcher" in [x.lower() for x in f.parts]:
                continue
            data = read_file(f)
            if data is not None and sha256(data) in hosted:
                public |= file_windows(cache, data, extractors)
    dest = cache / "redact" / ("%s.v%d.bin" % (sha256(str(project.resolve()).encode("utf-8")), INDEX_FORMAT))
    _write_pairs(dest, private - public)
    dest.with_name(dest.name[:-len(".v%d.bin" % INDEX_FORMAT)] + ".path").write_text(str(project.resolve()), encoding="utf-8")   # the app prunes stale indexes
    return dest


def main(argv: list[str]) -> int:
    args = list(argv)
    allow_local = "--allow-local" in args
    offline = "--offline" in args
    index_only = "--index-only" in args
    received = None
    if "--received" in args:
        i = args.index("--received")
        try:
            received = json.loads(Path(args[i + 1]).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            received = None
        del args[i:i + 2]
    args = [a for a in args if a not in ("--allow-local", "--offline", "--index-only")]
    fills_path = None
    if "--fills" in args:
        i = args.index("--fills")
        fills_path = Path(args[i + 1])
        del args[i:i + 2]
    files: list[Path] = []
    while "--file" in args:
        i = args.index("--file")
        files.append(Path(args[i + 1]))
        del args[i:i + 2]
    engine, protocol_path, cache = Path(args[0]), Path(args[1]), Path(args[2])
    sys.path.insert(0, str(engine))
    raw = protocol_path.read_bytes()
    projection = json.loads(raw)
    if not held_of(projection):
        print(json.dumps({"version": STATUS_VERSION, "projection": False}))
        return 0
    version = sha256(raw)
    here = cache / version
    done = here / "protocol.json"
    project = protocol_path.parent
    fills, fill_problems, fills_sha = load_fills(fills_path, projection)
    cached = None
    if done.is_file() and (here / "status.json").is_file():
        st = json.loads((here / "status.json").read_text(encoding="utf-8"))
        # a restore that used the fills file is reused only while that file is unchanged (and any restore only
        # while the fills file is as it was: a fill added or removed is applied on the next check)
        if st.get("complete") and st.get("restoredSha256") == sha256(done.read_bytes()) \
                and st.get("fillsSha256") == fills_sha and st.get("version") == STATUS_VERSION:
            cached = st
    # The index first, before any download: a copy the researcher just dropped is recognised by research capture
    # from now on, whatever the agent does with it while the downloads run.
    try:
        index_project(cache, project, projection, files, pdf_extractors(),
                      json.loads(done.read_text(encoding="utf-8")) if cached else None, received, fills)
    except Exception:   # noqa: BLE001 - the index is a safeguard; never stop the restore over it
        pass
    if index_only:
        print(json.dumps({"version": STATUS_VERSION, "projection": True, "indexed": True}))
        return 0
    if cached:
        print(json.dumps(dict(cached, restoredPath=str(done), cached=True)))
        return 0
    restored, report, chosen, extractors, log = restore(projection, cache, files, allow_local, offline, fills)
    try:   # again with what the downloads and the restore added
        index_project(cache, project, projection, files, extractors, restored, received, fills)
    except Exception:   # noqa: BLE001
        pass
    st = status(projection, report, chosen, extractors, log, fill_problems, fills_sha is not None)
    st["projectionSha256"] = version
    st["fillsSha256"] = fills_sha
    here.mkdir(parents=True, exist_ok=True)
    if restored is not None:
        # written as bytes: the sha256 recorded below is of exactly these bytes (a text-mode write would turn \n into
        # \r\n on Windows, and the cached copy would never match its record)
        data = (json.dumps(restored, ensure_ascii=False, indent=1) + "\n").encode("utf-8")
        tmp = here / ("protocol.json.%d.tmp" % os.getpid())
        tmp.write_bytes(data)
        os.replace(tmp, done)
        st["restoredSha256"] = sha256(data)
    else:
        done.unlink(missing_ok=True)
    tmp = here / ("status.json.%d.tmp" % os.getpid())
    tmp.write_bytes((json.dumps(st, ensure_ascii=False, indent=1) + "\n").encode("utf-8"))
    os.replace(tmp, here / "status.json")
    print(json.dumps(dict(st, restoredPath=str(done) if restored is not None else None)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
