#!/usr/bin/env python3
"""Fill in a published study's original wording on this computer (hsenv link + hash rehydration, DESIGN §3.6).

A published protocol.json may hold placeholders where the participant-facing text comes from a source that cannot
be redistributed: `distribution.held` lists each such item with a locator and the hash of the exact text. This
helper restores them locally: it downloads link-tier sources from their URL, tries the files the researcher put in
the project for the rest (user tier, or a download that failed), and calls `hsenv.rehydrate`. Every item is checked
by its own text hash, so a wrong file can only leave an item unresolved, never put other text on screen.

The app's main process runs it from its own copy (never the project's), with the bundled engine on sys.path:

    python -I -B -X utf8 hs_original_text.py <engine dir> <project>/protocol.json <cache dir> [--file <path>]...
           [--allow-local] [--offline]

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
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

MAX_BYTES = 100 * 1024 * 1024        # largest source file read or downloaded
DOWNLOAD_TIMEOUT = 60                 # seconds per download attempt
RETRY_AFTER = 10 * 60                 # a failed download is not tried again for this long (seconds)
MAX_CANDIDATES = 12                   # project files tried per source
EXTENSIONS = {"pdf": (".pdf",), "html": (".html", ".htm", ".xhtml"), "text": (".txt", ".text", ".md"),
              "docx": (".docx",), "qsf": (".qsf", ".json")}
OK = ("ok", "ok_image")
STATUS_VERSION = 1


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
        return True   # cannot resolve: the download itself fails and says so
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


class _NoDowngrade(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urllib.parse.urlsplit(req.full_url).scheme == "https" and urllib.parse.urlsplit(newurl).scheme != "https":
            raise urllib.error.HTTPError(newurl, code, "redirect from https to http refused", headers, fp)
        if urllib.parse.urlsplit(newurl).scheme not in ("http", "https"):
            raise urllib.error.HTTPError(newurl, code, "redirect to another scheme refused", headers, fp)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def make_fetch(cache: Path, allow_local: bool = False, offline: bool = False, log: list | None = None):
    """fetch(url) -> bytes for hsenv.rehydrate: http(s) only, at most MAX_BYTES, cached under <cache>/downloads by
    URL; a failure is remembered for RETRY_AFTER seconds so a check that repeats does not hammer the publisher."""
    root = cache / "downloads"
    opener = urllib.request.build_opener(_NoDowngrade)

    def fetch(url: str) -> bytes:
        key = sha256(url.encode("utf-8"))
        got, failed = root / key, root / (key + ".failed")
        if got.is_file():
            return got.read_bytes()
        if failed.is_file() and time.time() - failed.stat().st_mtime < RETRY_AFTER:
            raise OSError("download failed recently: " + failed.read_text(encoding="utf-8")[:200])
        if offline:
            raise OSError("offline")
        if urllib.parse.urlsplit(url).scheme not in ("http", "https"):
            raise ValueError("only http(s) sources are downloaded")
        try:
            if not allow_local and not _public_host(url):
                raise ValueError("the source URL points to this computer or a private network")
            req = urllib.request.Request(url, headers={"User-Agent": "HumanStudyHub-desktop (original wording)",
                                                       "Accept": "*/*"})
            with opener.open(req, timeout=DOWNLOAD_TIMEOUT) as res:
                data = res.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise ValueError("the source file is larger than %d MB" % (MAX_BYTES // 2 ** 20))
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


# ------------------------------------------------------------------------------------------- project files
def candidates_for(fmt: str | None, files: list[Path], key: str, want: str | None) -> list[Path]:
    """The project files worth trying for one source, best first: named after the source, then the file the study
    was built from (same sha256), then every other file of the right format."""
    exts = EXTENSIONS.get(fmt or "", ())
    pool = [f for f in files if not exts or f.suffix.lower() in exts]
    named = [f for f in pool if f.stem.lower() == key.lower()]

    def same(f):
        try:
            return want is not None and sha256(f.read_bytes()) == want
        except OSError:
            return False
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


def restore(projection: dict, cache: Path, files: list[Path], allow_local=False, offline=False):
    """-> (restored protocol or None, report, chosen files {source: path}, extractors, download log)."""
    from hsenv import distribution as D
    extractors = pdf_extractors()
    log: list = []
    fetch = make_fetch(cache, allow_local=allow_local, offline=offline, log=log)
    out, report = D.rehydrate(projection, fetch=fetch, extractors=extractors)
    chosen: dict[str, Path] = {}
    supplied: dict[str, bytes] = {}
    held = held_of(projection)
    todo = sorted({e.get("source") for h, e in held.items()
                   if isinstance(e, dict) and isinstance(e.get("source"), str)
                   and report["items"].get(h, {}).get("status") not in OK})
    for key in todo:
        d = distribution_of(projection, key)
        want = d.get("sha256") if isinstance(d.get("sha256"), str) else None
        sub = only_source(projection, key)
        n_items = len(held_of(sub))
        best, best_ok = None, 0
        for path in candidates_for(d.get("format"), files, key, want):
            data = read_file(path)
            if data is None:
                continue
            _, rep = D.rehydrate(sub, files={key: data}, extractors=extractors)
            k = sum(1 for r in rep["items"].values() if r.get("status") in OK)
            if k > best_ok:
                best, best_ok = (path, data), k
            if k == n_items:
                break
        if best is not None:
            chosen[key], supplied[key] = best
    if supplied:
        out, report = D.rehydrate(projection, fetch=fetch, files=supplied, extractors=extractors)
    return (out if report.get("complete") else None), report, chosen, extractors, log


def need_of(fmt: str | None, tier: str | None, statuses: list[dict], source_report: dict, had_file: bool,
            extractors: dict) -> str:
    """Why a source's items stay unresolved, as one plain reason the app words for the researcher."""
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
        return "changed-online" if source_report.get("status") == "ok" else "download"
    return "file"


def status(projection: dict, report: dict, chosen: dict, extractors: dict, log: list) -> dict:
    held = held_of(projection)
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
        unresolved = [(h, e) for h, e in items if report["items"].get(h, {}).get("status") not in OK]
        rec = {"key": key, "title": title_of(projection, key), "tier": tier, "format": fmt or "unknown",
               "items": len(items), "restored": len(items) - len(unresolved),
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
    return {"version": STATUS_VERSION, "projection": True, "complete": bool(report.get("complete")),
            "items": total, "restored": restored,
            "screens": len({screen_of(e.get("path")) for h, e in held.items()
                            if isinstance(e, dict) and report["items"].get(h, {}).get("status") not in OK}),
            "pdfReader": "pdf" in extractors, "sources": sources,
            "downloadsFailed": len(log)}


def main(argv: list[str]) -> int:
    args = list(argv)
    allow_local = "--allow-local" in args
    offline = "--offline" in args
    args = [a for a in args if a not in ("--allow-local", "--offline")]
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
    if done.is_file() and (here / "status.json").is_file():
        st = json.loads((here / "status.json").read_text(encoding="utf-8"))
        if st.get("complete") and st.get("restoredSha256") == sha256(done.read_bytes()):
            print(json.dumps(dict(st, restoredPath=str(done), cached=True)))
            return 0
    restored, report, chosen, extractors, log = restore(projection, cache, files, allow_local, offline)
    st = status(projection, report, chosen, extractors, log)
    st["projectionSha256"] = version
    here.mkdir(parents=True, exist_ok=True)
    if restored is not None:
        text = json.dumps(restored, ensure_ascii=False, indent=1) + "\n"
        tmp = here / ("protocol.json.%d.tmp" % os.getpid())
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, done)
        st["restoredSha256"] = sha256(text.encode("utf-8"))
    else:
        done.unlink(missing_ok=True)
    (here / "status.json").write_text(json.dumps(st, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(json.dumps(dict(st, restoredPath=str(done) if restored is not None else None)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
