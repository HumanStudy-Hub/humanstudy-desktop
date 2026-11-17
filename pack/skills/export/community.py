#!/usr/bin/env python3
"""Export public research assets with their exact community baseline; never chat or credentials."""
import argparse
import hashlib
import html
import json
import re
import sys
import unicodedata
import zipfile
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "build"))
import check_materials  # noqa: E402  (researcher-supplied and not-openly-licensed materials stay in the project)

PRIVATE = {
    ".env", ".git", ".opencode", ".humanstudy", "node_modules", "__pycache__", "threads", "conversations",
    "chat", "chats", "credentials", "account.json", "settings.json", "human-data", "runs",
    "original-text", "rehydrated", "restored", "researcher", "private", "quarantine",
}
RAW_NAMES = {"sessions", "records", "responses", "participant-data", "llm-usage", "progress", "run", "heartbeat", "stop"}
RAW_SUFFIXES = {".jsonl", ".ndjson", ".log"}
NESTED_ARCHIVES = {".zip", ".tar", ".gz", ".7z", ".rar", ".xz"}
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_ZIP_BYTES = 40 * 1024 * 1024
MAX_ENTRIES = 2000
TEXT_SUFFIXES = {".json", ".jsonl", ".md", ".txt", ".htm", ".html", ".csv", ".tsv", ".py", ".js", ".cjs", ".mjs",
                 ".ts", ".tsx", ".yaml", ".yml", ".toml", ".xml", ".svg", ".qsf"}
# The three share layers (owner decision 2026-11-16). Layer 1 "overview" is program.json, always shareable, with
# restricted wording withheld as "Get from source". Layer 2 "experiment" adds the protocol and its allowed materials,
# only for a Validated library study or a protocol whose checks passed. Layer 3 is the researcher's own results and
# materials (artifacts/), shared only when ticked. Private project sync is not sharing and never comes through here.
LAYERS = ("overview", "experiment")
TRIAL_OUTPUTS = {"results.html", "summary.json", "report.md", "summary.md"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}
OFFICE_SUFFIXES = {".docx", ".pptx", ".xlsx", ".odt", ".odp", ".ods", ".rtf"}
_INVISIBLE = re.compile(r"[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]")


def readable_forms(text):
    """The text as a reader sees it: HTML entities decoded (also when double-encoded), tags removed, NFKC, and
    invisible characters dropped. Restricted wording is matched on these forms as well as on the raw text."""
    out = [text]
    t = text
    for _ in range(3):
        u = html.unescape(t)
        if u == t:
            break
        t = u
    t = re.sub(r"<[^>]{0,2000}>", " ", t)
    t = _INVISIBLE.sub("", unicodedata.normalize("NFKC", t))
    if t != text:
        out.append(t)
    return out


# Keep this deterministic guard aligned with the Web pre-publication guard. Never echo a matched value.
_PUBLIC_SECRET = re.compile(
    r"\b(?:sk-[A-Za-z0-9_-]{12,}|hsk_[A-Za-z0-9_-]{8,}|(?:ghp|gho|github_pat|xox[abp])_[A-Za-z0-9_]{12,}"
    r"|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b"
    r"|\bAuthorization\s*:\s*Bearer\s+[^\s\"'<>]{8,}", re.I)
_PUBLIC_LOCAL_PATH = re.compile(
    r"(?<![\w:/])(?:file://[^\s]+|[A-Za-z]:[\\/](?![\\/])[^\s]+|\\\\[^\\\s]+\\[^\s]+"
    r"|(?:~?/Users/|~?/home/|/private/|/tmp/|/var/folders/|/vercel/sandbox/)[^\s]+)", re.I)


def public_text_problem(value):
    """Reject strong credential/local-path signatures, not author emails or ordinary citations."""
    if isinstance(value, dict):
        values = [*value.keys(), *value.values()]
    elif isinstance(value, list):
        values = value
    elif isinstance(value, str):
        if _PUBLIC_SECRET.search(value):
            return "a credential-like value"
        # Public URLs may legitimately contain /home/ or /Users/ in their path.
        without_urls = re.sub(r"https?://[^\s<>\"']+", "", value, flags=re.I)
        if _PUBLIC_LOCAL_PATH.search(without_urls):
            return "an absolute local path"
        return None
    else:
        return None
    return next((problem for item in values if (problem := public_text_problem(item))), None)


def private_payload(rel):
    parts = [part.rstrip(" .") for part in unicodedata.normalize("NFKC", rel).lower().split("/")]
    name = Path(parts[-1])
    if "simulations" in parts and not (parts[:2] == ["artifacts", "simulations"] and name.name in {"report.md", "summary.md"}):
        return True
    return (any(p in PRIVATE or p.startswith(".env.") for p in parts)
            or name.suffix in RAW_SUFFIXES or name.stem in RAW_NAMES and name.suffix in {".json", ".csv", ".tsv", ".txt"}
            or name.name.endswith(".annotations.json"))


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def optional_document(root, path):
    try:
        document = read_json(path) if safe_candidate(root, path) else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}
    return document if isinstance(document, dict) else {}


def source_licenses(root):
    record = check_materials.source_record(root)
    files = {check_materials.norm_rel(f["path"]): f for f in (record.get("files") or [])
             if isinstance(f, dict) and isinstance(f.get("path"), str)}
    pdf = record.get("pdf")
    if isinstance(pdf, dict) and isinstance(pdf.get("filename"), str):
        files.setdefault(check_materials.norm_rel(pdf["filename"]), pdf)
    return files


def safe_candidate(root, path):
    if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != root and parent.is_relative_to(root)):
        raise ValueError("Symlinks are not community research assets")
    if not path.resolve().is_relative_to(root):
        raise ValueError("Research assets must remain inside the project")
    return path.is_file()


def recorded_license(record):
    license = record.get("license")
    if record.get("private") is True or not isinstance(license, str) or not check_materials.OPEN_LICENSE.fullmatch(license):
        return None
    return license


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False, indent=2).encode("utf-8") + b"\n"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def paired_sources(protocol, licensed=None, layered=False):
    """{source key: file}. A contribution needs every source under sources/open/. A layered experiment share also
    accepts link and user sources anywhere in the project: their bytes build the "Get from source" locators and
    never ship."""
    sources = (protocol.get("meta") or {}).get("sources")
    if not isinstance(sources, dict) or not sources:
        raise ValueError("Paired contributions need declared public sources.")
    paths = {}
    for key, source in sources.items():
        name = source.get("file") if isinstance(source, dict) else None
        local = isinstance(name, str) and "\\" not in name and not name.startswith("/") and ":" not in name and not any(
            part in {"", ".", ".."} for part in name.split("/"))
        if layered and local and source_tier(source, (licensed or {}).get(name, {})) != "hosted":
            paths[key] = name
            continue
        if not local or not name.startswith("sources/open/") or private_payload(name):
            raise ValueError("Every paired source must be a public file under sources/open/.")
        paths[key] = name
    return paths


def source_tier(source, record):
    """The declared distribution tier, else hosted for an openly licensed sources/open/ file, link when a public URL
    or DOI is known, and user otherwise."""
    declared = source.get("distribution") or {}
    if declared.get("tier") in {"hosted", "link", "user"}:
        return declared["tier"]
    release, _, _ = projection_engine()
    name = source.get("file")
    if name.startswith("sources/open/") and not private_payload(name) and release.hosted_licence_ok(recorded_license(record)):
        return "hosted"
    return "link" if source_link(source, record) else "user"


def source_link(source, record):
    declared = source.get("distribution") or {}
    url = public_source_url(declared.get("url")) or public_source_url(record.get("url"))
    doi = normalized_doi(declared.get("doi") or record.get("doi"))
    out = {}
    if url:
        out["url"] = url
    if re.fullmatch(r"10\.\d{4,}/\S+", doi):
        out["doi"] = doi
    return out


def research_sources(program):
    source = program["source"]
    paths = [source.get("filename"), *(e.get("path") for e in program.get("evidence", []))]
    return {name for name in paths if isinstance(name, str) and name}


def normalized_title(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split()) if isinstance(value, str) else ""


def normalized_doi(value):
    if not isinstance(value, str):
        return ""
    value = value.strip().lower()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if value.startswith(prefix):
            return value[len(prefix):].strip()
    return value


def has_private_reference(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in {"file", "filename", "path", "src"} and isinstance(item, str):
                name = item.replace("\\", "/")
                if not name.startswith(("https://", "http://")) and (
                        name.startswith(("/", "file:")) or len(name) > 1 and name[1] == ":"
                        or ".." in name.split("/") or private_payload(name)):
                    return True
            if has_private_reference(item):
                return True
    elif isinstance(value, list):
        return any(has_private_reference(item) for item in value)
    return False


def projection_engine():
    # In an installed project the engine is beside skills/. The second path is for repository tests.
    here = Path(__file__).resolve()
    candidates = (here.parents[2] / "hsenv", here.parents[2] / "runtime/hsenv")
    engine = next((p for p in candidates if (p / "hsenv/release.py").is_file()), None)
    if engine is None:
        raise ValueError("Community export needs the current Desktop protocol engine.")
    sys.path.insert(0, str(engine))
    from hsenv import release, schema_check, distribution
    sys.path.pop(0)
    return release, schema_check, distribution


def public_source_url(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() in {"http", "https"} and parsed.hostname and not parsed.username and not parsed.password:
            return value
    except ValueError:
        pass
    return None


def public_source_credit(record, evidence, paper, name):
    """Carry the approved source credit with quoted Program text, without local manifest paths."""
    attribution = record.get("attribution")
    source_url = public_source_url(record.get("url")) or public_source_url(evidence.get("url"))
    if not source_url and name == paper.get("filename") and normalized_doi(paper.get("doi")):
        source_url = "https://doi.org/" + normalized_doi(paper["doi"])
    license = recorded_license(record)
    terms = public_source_url(record.get("licenseUrl"))
    cc = re.fullmatch(r"CC-BY-([1-4]\.0|2\.5)", license or "", re.I)
    if not terms and cc:
        terms = f"https://creativecommons.org/licenses/by/{cc[1]}/"
    if not terms and license in {"CC0", "CC0-1.0"}:
        terms = "https://creativecommons.org/publicdomain/zero/1.0/"
    if not isinstance(attribution, str) or not attribution.strip() or not source_url or not terms:
        raise ValueError("A quoted public source needs attribution, a public source URL and a license URL in sources/SOURCE.json. Review its source record before sharing.")
    title = record.get("title") or (paper.get("title") if name == paper.get("filename") else None)
    return {"evidenceIds": [], "url": source_url, "attribution": attribution.strip(), "license": license,
            "licenseUrl": terms, "sha256": record["sha256"],
            **({"title": title} if isinstance(title, str) and title.strip() else {}),
            "changes": "Source information organized into a Human Study Program; evidence excerpts retained. Original source unchanged."}


class SourcePolicy:
    """Which local sources may be quoted publicly: a hosted open licence, matching bytes, not private, and not a
    protocol source declared link/user. Everything else is restricted and only ships as "Get from source"."""

    def __init__(self, root, protocol, licensed):
        release, _, _ = projection_engine()
        self.root, self.licensed, self.release = root, licensed, release
        sources = (protocol.get("meta") or {}).get("sources") or {}
        self.private_paths = set(check_materials.private_paths(root))
        self.restricted = {name for name, record in licensed.items() if not release.hosted_licence_ok(recorded_license(record))}
        self.private = {name for name, record in licensed.items()
                        if record.get("private") is True or str(record.get("license")).lower() == check_materials.RESEARCHER_LICENSE}
        self.source_files = {}
        for source_id, entry in sources.items() if isinstance(sources, dict) else ():
            if not isinstance(entry, dict) or not isinstance(entry.get("file"), str):
                continue
            name = entry["file"]
            self.source_files[source_id] = name
            tier = (entry.get("distribution") or {}).get("tier")
            if tier in {"user", "link"} or not release.hosted_licence_ok(recorded_license(licensed.get(name, {}))):
                self.restricted.add(name)
        self._shareable = {}

    def shareable(self, name):
        if name not in self._shareable:
            self._shareable[name] = self._check(name)
        return self._shareable[name]

    def _check(self, name):
        if not name or name in self.restricted or name in self.private_paths or has_private_reference({"file": name}):
            return False
        record = self.licensed.get(name, {})
        if not self.release.hosted_licence_ok(recorded_license(record)):
            return False
        sha = record.get("sha256")
        path = self.root / name
        return isinstance(sha, str) and safe_candidate(self.root, path) and sha.lower() == check_materials.sha(path)


def held_hashes_of(protocol):
    held = (protocol.get("distribution") or {}).get("held") or {}
    hashes = set()
    for item in held.values() if isinstance(held, dict) else ():
        if isinstance(item, dict):
            loc = item.get("locator") or {}
            hashes.update(h for h in [item.get("text_sha256"), *(p.get("canon_sha256") for p in loc.get("parts", []) if isinstance(p, dict))]
                          if isinstance(h, str))
    return hashes


def verified_held_texts(protocol, held_texts):
    """Restored held wording supplied by the app ({held id: text}), each kept only when it matches its own hash.
    Returns (texts, complete): complete when every held text item has its wording, so files can be checked by text."""
    _, _, distribution = projection_engine()
    held = (protocol.get("distribution") or {}).get("held") or {}
    texts, complete = [], True
    for hid, item in held.items() if isinstance(held, dict) else ():
        if not isinstance(item, dict) or item.get("kind") == "image":
            continue
        text = (held_texts or {}).get(hid)
        if isinstance(text, str) and distribution.text_sha256(text) == item.get("text_sha256"):
            texts.append(text)
        else:
            complete = False
    return texts, complete


class RestrictedWording:
    """Wording no public layer may carry, checked by content (never by path alone): private and researcher files,
    sources without a hosted open licence or declared link/user, the local paper, and held protocol wording (by
    hash, and by text when the restored wording is known)."""

    def __init__(self, root, program, policy, protocol, held_texts=None):
        self.release = policy.release
        texts, hashes = check_materials.private_index(root)
        paper = program.get("source") or {}
        self.bibliography = {word for key in ("title", "authors", "venue", "doi") for word in check_materials.words(paper.get(key))}
        for name in (policy.restricted | research_sources(program) | {"paper.pdf"}) - policy.private_paths:
            if has_private_reference({"file": name}) or policy.shareable(name):
                continue
            path = root / name
            if safe_candidate(root, path):
                hashes.setdefault(check_materials.sha(path), name)
                for shingle in check_materials.shingles(check_materials.text_of(path)):
                    if not all(word in self.bibliography for word in shingle.split()):
                        texts.setdefault(shingle, name)
        self.texts, self.hashes = texts, hashes
        self.sizes = sorted({len(s.split()) for s in texts}, reverse=True)
        self.held_hashes = held_hashes_of(protocol)
        self.held_texts, self.held_complete = verified_held_texts(protocol, held_texts)
        self._index()

    def _index(self):
        self.held = self.release.HeldIndex(texts=self.held_texts, hashes=self.held_hashes)

    def add_held(self, texts, hashes, complete):
        """After a fresh projection: the wording it held, recovered from the builder's own source copies."""
        self.held_texts = list(self.held_texts) + list(texts)
        self.held_hashes = set(self.held_hashes) | set(hashes)
        self.held_complete = self.held_complete and complete
        self._index()

    def string_hit(self, value):
        """'held' or 'restricted' for one Program string (the long-standing Program-only rule), else None."""
        for form in readable_forms(value):
            if self.held.hit(form):
                return "held"
            words = check_materials.words(form)
            if any(" ".join(words[i:i + size]) in self.texts
                   for size in range(4, check_materials.SHINGLE + 1) for i in range(len(words) - size + 1)):
                return "restricted"
        return None

    def text_hit(self, text):
        return any(self._text_hit(form) for form in readable_forms(text))

    def _text_hit(self, text):
        for seg in check_materials.segments(text) + [text]:
            w = check_materials.words(seg)
            for size in self.sizes:
                if any(" ".join(w[i:i + size]) in self.texts for i in range(max(0, len(w) - size + 1))):
                    return True
        return False

    def data_problem(self, name, data, path=None):
        """Why one public file may carry restricted wording, or None. Every file is read as text whatever its name;
        office documents through check_materials.text_of; pictures are compared by hash; anything else that cannot
        be read is refused."""
        if digest(data) in self.hashes:
            return "is a copy of a restricted or private file"
        suffix = Path(name).suffix.lower()
        if suffix in OFFICE_SUFFIXES:
            text = check_materials.text_of(path) if path is not None else ""
            if not text.strip():
                return "cannot be read to check it for restricted wording"
            return "contains wording from a restricted source" if self.text_hit(text) else (
                "contains held original wording" if self.held_hashes and not self.held.text_file(text) else None)
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            return None if suffix in IMAGE_SUFFIXES else "cannot be read to check it for restricted wording"
        values = None
        if suffix in {".json", ".qsf", ".ipynb"} or text.lstrip()[:1] in {"{", "["}:
            try:
                values = list(check_materials.strings(json.loads(text)))
            except ValueError:
                values = None
        flat = "\n".join(values) if values is not None else text
        if self.text_hit(flat):
            return "contains wording from a restricted source"
        if self.held_hashes:
            if values is not None:
                if any(self.held.hit(f) for v in values for f in readable_forms(v)):
                    return "contains held original wording"
            elif not self.held.text_file(data):
                return "contains held original wording"
        return None


def source_reference(evidence, licensed, paper, name):
    """Where a withheld excerpt can be read: the public URL or DOI and the source hash. Never a local path."""
    record = licensed.get(name, {}) if isinstance(name, str) else {}
    url = public_source_url(evidence.get("url")) or public_source_url(record.get("url"))
    doi = normalized_doi(record.get("doi")) or (normalized_doi(paper.get("doi")) if not name or name == paper.get("filename") else "")
    if not url and doi:
        url = "https://doi.org/" + doi
    sha = evidence.get("sourceSha256") or record.get("sha256")
    return {"url": url, "sha256": sha.lower() if isinstance(sha, str) and re.fullmatch(r"[0-9a-fA-F]{64}", sha) else None}


def library_validated(root, protocol_bytes):
    """The project is an unchanged copy of a Validated (maintainer-reviewed) library protocol."""
    context = optional_document(root, root / ".humanstudy/community.json")
    publication = context.get("publication") if isinstance(context.get("publication"), dict) else {}
    revision = context.get("currentRevision")
    if not (publication.get("kind") == "maintainer-reviewed-protocol" and context.get("hasReviewedProtocol") is True
            and isinstance(revision, str) and revision and publication.get("revision") == revision):
        return None
    files = {f.get("path"): f.get("sha256") for f in context.get("assetFiles") or [] if isinstance(f, dict)}
    if files.get("protocol.json") != digest(protocol_bytes):
        return None
    return files


def experiment_status(root, checks_passed=None, library_attested=None):
    """Whether the runnable experiment (layer 2) may be shared, with a plain reason when not. The project's own
    .humanstudy/community.json is informational only: the Validated route also needs `library_attested`, the
    SHA-256 of protocol.json that the app confirmed against the library catalog (outside the project)."""
    def unavailable(code, reason):
        return {"available": False, "code": code, "reason": reason}
    root = Path(root).resolve()
    protocol_path, study_path = root / "protocol.json", root / "study.json"
    if not (protocol_path.exists() or protocol_path.is_symlink()):
        return unavailable("no-protocol", "This study has no runnable protocol yet.")
    if not safe_candidate(root, protocol_path) or not safe_candidate(root, study_path):
        return unavailable("no-protocol", "A runnable experiment needs both protocol.json and study.json.")
    raw = protocol_path.read_bytes()
    try:
        protocol = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, ValueError):
        return unavailable("no-protocol", "protocol.json cannot be read.")
    if not isinstance(protocol, dict):
        return unavailable("no-protocol", "protocol.json cannot be read.")
    published = isinstance(protocol.get("distribution"), dict)
    release, _, _ = projection_engine()
    assets = library_validated(root, raw) if published else None
    if assets is not None and not (isinstance(library_attested, str) and library_attested.lower() == digest(raw)):
        return unavailable("not-validated", "The library could not confirm this Validated version right now. Connect to the internet and try again, or share the study overview.")
    if assets is not None:
        same = []
        for name, sha in sorted(assets.items()):
            if not isinstance(name, str) or name in {"protocol.json", "study.json", "program.json"} or not release.is_public(name) \
                    or name.split("/")[0] in {"package", "artifacts"} or private_payload(name):
                continue
            path = root / name
            if safe_candidate(root, path) and check_materials.sha(path) == sha:
                same.append(name)
        if assets.get("study.json") != check_materials.sha(study_path):
            return unavailable("changed-published", "study.json was changed after this study came from the library. Share the study overview instead.")
        return {"available": True, "code": "validated", "validated": "library", "route": "published", "publishedFiles": same}
    if published:
        return unavailable("changed-published", "This experiment was changed after it came from the library, so it is no longer the Validated version. Share the study overview instead.")
    if isinstance(checks_passed, str) and checks_passed.lower() == digest(raw):
        return {"available": True, "code": "checked", "validated": "checks", "route": "own", "publishedFiles": []}
    return unavailable("not-validated", "The runnable experiment can be shared once the study is Validated or its checks pass.")


def protocol_get_from_source(protocol):
    """Per restricted source of a shared protocol: how many items are held and where to get them (URL/DOI, hash)."""
    held = (protocol.get("distribution") or {}).get("held") or {}
    counts = {}
    for item in held.values() if isinstance(held, dict) else ():
        if isinstance(item, dict) and isinstance(item.get("source"), str):
            counts[item["source"]] = counts.get(item["source"], 0) + 1
    sources = (protocol.get("meta") or {}).get("sources") or {}
    out = []
    for key, n in sorted(counts.items()):
        d = (sources.get(key) or {}).get("distribution") or {} if isinstance(sources.get(key), dict) else {}
        url = public_source_url(d.get("url")) or ("https://doi.org/" + d["doi"] if isinstance(d.get("doi"), str) and d["doi"] else None)
        out.append({"source": key, "tier": d.get("tier", "user"), "url": url, "sha256": d.get("sha256"), "heldItems": n})
    return out


def result_file_reason(root, rel, path):
    """Why one artifacts/ file can never be a shared result, or None. AI-trial outputs are the run's results page,
    summary and reports; raw records, logs and participant-like data stay local."""
    parts = rel.split("/")
    trial_output = parts[:2] == ["artifacts", "simulations"] and len(parts) == 4 and parts[-1].lower() in TRIAL_OUTPUTS
    if private_payload(rel) and not trial_output:
        return "local or private material"
    if rel.lower() in {p.lower() for p in check_materials.private_paths(root)} or check_materials.private_rel(rel):
        return "local or private material"
    suffix = path.suffix.lower()
    if suffix == ".pdf":
        return "PDF"
    if suffix in NESTED_ARCHIVES:
        return "nested archive"
    if path.stat().st_size > MAX_FILE_BYTES:
        return "larger than 25 MB"
    if not trial_output and check_materials.looks_like_data(path):
        return "possible raw participant data"
    return None


def results_items(root):
    """Layer 3: the researcher's own results and materials, one item per simulation run and per top-level entry of
    artifacts/. Each item lists only the files that may ever be shared."""
    root = Path(root).resolve()
    folder = root / "artifacts"
    items = {}
    if not folder.is_dir() or folder.is_symlink():
        return items
    for path in sorted(folder.rglob("*")):
        if path.is_symlink() or not path.is_file() or any(p.is_symlink() for p in path.parents if p != root and p.is_relative_to(root)):
            continue
        rel = path.relative_to(root).as_posix()
        parts = rel.split("/")
        if parts[1] == "simulations":
            if len(parts) < 4:
                continue
            item, kind = "/".join(parts[:3]), "trial"
        else:
            item, kind = "/".join(parts[:2]), "material"
        if result_file_reason(root, rel, path):
            continue
        entry = items.setdefault(item, {"id": item, "kind": kind, "files": [], "bytes": 0})
        entry["files"].append(rel)
        entry["bytes"] += path.stat().st_size
    return items


def result_problem(wording, name, data, path=None):
    problem = wording.data_problem(name, data, path)
    if problem:
        return problem
    if wording.held_hashes and not wording.held_complete and Path(name).suffix.lower() in TEXT_SUFFIXES:
        return "cannot be checked for the study's original wording yet"
    return None


def plan(root, checks_passed=None, held_texts=None, library_attested=None):
    """What each share layer would contain, and why a layer or a result is unavailable. Writes nothing."""
    root = Path(root).resolve()
    errors = (ValueError, KeyError, TypeError, AttributeError, OSError)

    def preview(layer):
        try:
            r = export(root, None, layer=layer, checks_passed=checks_passed, held_texts=held_texts, dry_run=True,
                       library_attested=library_attested)
        except errors as exc:
            return {"available": False, "code": "blocked", "reason": str(exc) or "This layer cannot be prepared."}
        return {"available": True, "files": r["publicFiles"], "omitted": r["omitted"],
                "withheld": len(r.get("withheldEvidenceQuotes", {}).get("ids", [])), "getFromSource": r.get("getFromSource", [])}

    out = {"overview": preview("overview")}
    status = experiment_status(root, checks_passed, library_attested)
    if status["available"]:
        out["experiment"] = {**preview("experiment"), "validated": status["validated"]}
    else:
        out["experiment"] = {k: status[k] for k in ("available", "code", "reason")}
    results = []
    items = results_items(root)
    wording = None
    if items:
        try:
            program = read_json(root / "program.json")
            protocol = optional_document(root, root / "protocol.json")
            policy = SourcePolicy(root, protocol, source_licenses(root))
            wording = RestrictedWording(root, program, policy, protocol, held_texts)
        except errors:
            wording = None
    for item in items.values():
        blocked = None if wording else "needs a readable study overview (program.json)"
        for rel in item["files"] if wording else ():
            try:
                problem = result_problem(wording, rel, (root / rel).read_bytes(), root / rel)
            except OSError:
                problem = "cannot be read"
            if problem:
                blocked = f"{rel} {problem}"
                break
        results.append({**item, **({"blocked": blocked} if blocked else {})})
    out["results"] = results
    return out


def program_only_projection(root, program, licensed, policy=None, wording=None, *, keep_binding=False, scope="program-only"):
    """The shareable study overview: the scholarly document without its local execution files. Excerpts and field
    wording from sources that cannot be redistributed are withheld and marked "Get from source" (URL or DOI plus
    hash); private file paths are removed. Returns (bytes, withheld evidence ids, get-from-source list)."""
    protocol = optional_document(root, root / "protocol.json")
    policy = policy or SourcePolicy(root, protocol, licensed)
    wording = wording or RestrictedWording(root, program, policy, protocol)
    binding = (program.get("extensions") or {}).get("scholarly")
    if isinstance(binding, dict) and not keep_binding:
        binding.pop("protocol", None)

    paper = program["source"]
    evidence_records = program.get("evidence", [])
    by_id = {e.get("id"): e for e in evidence_records if isinstance(e, dict)}
    permitted_quotes = set()
    public_credits = {}
    withheld_quotes = []
    get_from = {}
    refs_of = {}

    def note(ref, kind, ident):
        entry = get_from.setdefault((ref["url"], ref["sha256"]), {**ref, "evidenceIds": [], "fieldIds": []})
        if ident not in entry[kind]:
            entry[kind].append(ident)

    for evidence in evidence_records:
        # Keep the source identifier, URL and locator even when its exact quote stays local.
        source_id = evidence.get("sourceId")
        linked_name = policy.source_files.get(source_id) if isinstance(source_id, str) else None
        name = evidence.get("path") or (linked_name if source_id else paper.get("filename"))
        refs_of[evidence.get("id")] = source_reference(evidence, licensed, paper, name)
        recorded_hash = licensed.get(name, {}).get("sha256") if isinstance(name, str) else None
        cited_hash = evidence.get("sourceSha256")
        matching_hash = cited_hash is None or (isinstance(cited_hash, str) and isinstance(recorded_hash, str)
                                               and cited_hash.lower() == recorded_hash.lower())
        if evidence.get("quote"):
            if isinstance(name, str) and matching_hash and (linked_name is None or linked_name == name) and policy.shareable(name):
                permitted_quotes.add(evidence["id"])
                if name not in public_credits:
                    public_credits[name] = public_source_credit(licensed[name], evidence, paper, name)
                public_credits[name]["evidenceIds"].append(evidence["id"])
            else:
                evidence.pop("quote")
                evidence.pop("verification", None)
                withheld_quotes.append(evidence["id"])
                note(refs_of[evidence["id"]], "evidenceIds", evidence["id"])
        # A private or local file path is never published; the URL, hash and locator remain.
        if isinstance(evidence.get("path"), str) and (has_private_reference({"path": evidence["path"]})
                                                      or evidence["path"] in policy.private):
            evidence.pop("path")
    if isinstance(paper.get("filename"), str) and (has_private_reference({"filename": paper["filename"]})
                                                   or paper["filename"] in policy.private):
        paper.pop("filename")

    fields = [(f"{node.get('id')}/{field.get('id')}", field) for node in program.get("nodes", []) for field in node.get("fields", [])]
    fields.extend((f"{step.get('id')}/rule", step["rule"]) for step in program.get("steps", []) if isinstance(step.get("rule"), dict))
    for ident, field in fields:
        if field.get("state") == "missing" or field.get("value") is None:
            continue
        unsupported = field.get("origin") == "verbatim" and not (
            field.get("evidenceIds") and set(field["evidenceIds"]) <= permitted_quotes)
        if unsupported or any(wording.string_hit(v) for v in check_materials.strings(field.get("value"))):
            # Restricted wording stays local; the field keeps its label, origin, state and evidence links.
            refs = [refs_of[e] for e in field.get("evidenceIds") or [] if e in refs_of] or [source_reference({}, licensed, paper, None)]
            field["value"] = None
            field.setdefault("extensions", {})["getFromSource"] = {"reason": "redistribution-unverified", "sources": refs}
            for ref in refs:
                note(ref, "fieldIds", ident)
    if has_private_reference(program) or policy.private & research_sources(program):
        raise ValueError("The Program contains a private or local path. Keep a public citation or locator instead.")

    for value in check_materials.strings(program):
        hit = wording.string_hit(value)
        if hit == "held":
            raise ValueError("Held source wording appears in program.json. Keep the material local and cite its source.")
        if hit:
            raise ValueError("Restricted source wording appears in program.json. Keep the material local and cite its source.")
    extensions = program.setdefault("extensions", {})
    previous = extensions.get("communityExport") or {}
    previous_quotes = previous.get("withheldEvidenceQuotes") if isinstance(previous, dict) else None
    previous_ids = previous_quotes.get("ids") if isinstance(previous_quotes, dict) else None
    prior_ids = {value for value in previous_ids if isinstance(value, str)} if isinstance(previous_ids, list) else set()
    withheld = set(withheld_quotes) | prior_ids
    withheld_quotes = [e["id"] for e in evidence_records if e["id"] in withheld and not e.get("quote")]
    extensions["communityExport"] = {
        "scope": scope,
        "sources": list(public_credits.values()),
        "withheldEvidenceQuotes": {"ids": withheld_quotes, "reason": "redistribution-unverified"},
    }
    return json_bytes(program), withheld_quotes, list(get_from.values())


def paired_projection(protocol, study, program, payload, licensed, layered=None):
    """Project the protocol from its sources and bind the pair to it. `layered` (an experiment share) is
    {"restricted": {key: bytes}, "omitted": [...]}: link and user sources are held as "Get from source" and a
    non-core file the projection refuses is left out instead of failing the export."""
    release, schema_check, distribution = projection_engine()

    if protocol.get("schema_version") != "1" or study.get("schema_version") != "1":
        raise ValueError("Paired export needs the v1 protocol and study card.")
    if (protocol.get("distribution") or {}).get("held") or "░" in json.dumps(
            {key: value for key, value in protocol.items() if key != "distribution"}, ensure_ascii=False):
        raise ValueError("Paired export cannot carry held or locally restored wording.")
    if any(has_private_reference(doc) for doc in (protocol, study, program)):
        raise ValueError("The pair refers to a private or local file.")
    if study.get("release_hold") or any(a.get("release_hold") for a in protocol.get("arms", [])):
        raise ValueError("Resolve the public release holds before exporting this pair.")
    binding = program.get("extensions", {}).get("scholarly", {})
    expected = {"path": "protocol.json", "id": protocol.get("id"), "sha256": digest(payload["protocol.json"][0])}
    if program.get("schemaVersion") != 2 or binding.get("profile") != "scholarly-v1" or binding.get("protocol") != expected:
        raise ValueError("program.json does not bind to this protocol version.")
    if study.get("id") != protocol.get("id") or study.get("protocol") != {
            "path": "protocol.json", "sha256": schema_check.canonical_sha256(protocol), "schema_version": "1"}:
        raise ValueError("study.json does not bind to this protocol version.")

    paper = program["source"]
    title, doi = normalized_title(paper.get("title")), normalized_doi(paper.get("doi"))
    if not title or title != normalized_title(study.get("title")) or (
            doi and normalized_doi(study.get("doi")) != doi):
        raise ValueError("study.json and program.json describe different paper identities.")
    protocol_sources = paired_sources(protocol, licensed, layered is not None)
    for name in research_sources(program) if layered is None else ():
        if name not in payload or not release.hosted_licence_ok(payload[name][1]):
            raise ValueError("A source cited by program.json is missing from the licensed public files.")
        record = licensed.get(name, {})
        sha = record.get("sha256")
        if not isinstance(sha, str) or sha.lower() != digest(payload[name][0]):
            raise ValueError("A source cited by program.json needs a matching recorded SHA-256.")
        if name not in protocol_sources.values() and not str(record.get("attribution") or "").strip():
            raise ValueError("A source cited by program.json needs recorded attribution.")

    tiers, sources = {}, {}
    for key, name in protocol_sources.items():
        declared = protocol["meta"]["sources"][key].get("distribution") or {}
        if layered is not None and key in layered["restricted"]:
            data = layered["restricted"][key]
            record = licensed.get(name, {})
            tier = source_tier(protocol["meta"]["sources"][key], record)
            entry = {"tier": tier, **source_link(protocol["meta"]["sources"][key], record)}
            for field in ("licence", "attribution"):
                value = declared.get(field) or record.get("license" if field == "licence" else field)
                if isinstance(value, str) and value.strip():
                    entry[field] = value.strip()
            entry["sha256"], entry["format"] = digest(data), distribution.sniff(data)
            tiers[key], sources[key] = entry, data
            continue
        if declared.get("tier", "hosted") != "hosted":
            raise ValueError("Paired contributions currently need redistributable hosted sources.")
        data, license = payload.get(name, (None, None))
        record = licensed.get(name, {})
        attribution = record.get("attribution") or declared.get("attribution")
        if data is None or not release.hosted_licence_ok(license) or not isinstance(attribution, str) or not attribution.strip():
            raise ValueError(f"Paired source {name} needs licensed bytes and attribution.")
        sha = digest(data)
        recorded_sha = record.get("sha256")
        if not isinstance(recorded_sha, str) or recorded_sha.lower() != sha or declared.get("sha256", sha) != sha:
            raise ValueError(f"Paired source {name} needs a matching recorded SHA-256.")
        tiers[key] = {"tier": "hosted", "licence": license, "attribution": attribution, "sha256": sha,
                      "format": distribution.sniff(data)}
        sources[key] = data

    bare = {key: value for key, value in protocol.items() if key != "distribution"}
    extractors = {"pdf": distribution.pdfium_extractor()} if any(d["format"] == "pdf" for d in tiers.values()) else {}
    try:
        projected, _ = release.project(bare, tiers=tiers, sources=sources, extractors=extractors, strict=True)
    except release.ProjectionError as exc:
        raise ValueError("The protocol could not be projected from the supplied public sources. Check its source citations.") from exc
    if projected["distribution"]["held"] and layered is None:
        raise ValueError("The projected protocol still contains held wording.")
    schema = schema_check.validate(projected, "protocol")
    if not schema["valid"]:
        paths = ", ".join(path or "/" for path, _ in schema["errors"][:5])
        raise ValueError(f"The public protocol has schema errors at {paths}.")

    projected_bytes = json_bytes(projected)
    binding["protocol"]["sha256"] = digest(projected_bytes)
    card = {key: value for key, value in study.items() if key in
            {"schema_version", "id", "title", "authors", "year", "doi", "version", "licence", "tags", "protocol"}}
    card["quality"] = "draft"
    card["protocol"] = {**card["protocol"], "sha256": schema_check.canonical_sha256(projected)}
    if not schema_check.validate(card, "study")["valid"]:
        raise ValueError("The study card has invalid public metadata.")
    payload.update({"protocol.json": (projected_bytes, None), "program.json": (json_bytes(program), None),
                    "study.json": (json_bytes(card), None)})
    for name, (data, _) in list(payload.items()):
        if not release.distributable(name, projected, content=data, sources=sources, extractors=extractors):
            if layered is None or name in {"protocol.json", "study.json", "program.json"}:
                raise ValueError(f"{name} is not part of the public protocol projection.")
            # Beside held wording an original cannot ship; the protocol carries its link and hash instead.
            payload.pop(name)
            layered["omitted"].append({"path": name, "reason": "ships as Get from source with the protocol"})
    if layered is not None:
        layered.update(projected=projected, sources=sources, extractors=extractors)
    return card


def export(root, output, include_paper=False, *, program_only=False, layer=None, results=(), checks_passed=None,
           held_texts=None, dry_run=False, library_attested=None):
    """Write the public ZIP. `layer` selects a share layer (see LAYERS); without it the legacy contribution routes
    apply (paired when protocol.json exists, else the legacy bundle). `results` adds ticked layer-3 items."""
    if program_only:
        layer = layer or "overview"
    if layer is not None and layer not in LAYERS:
        raise ValueError("Choose the study overview or the runnable experiment.")
    if results and layer is None:
        raise ValueError("Results are shared with the study overview or the runnable experiment.")
    program_only = layer == "overview"
    root = Path(root).resolve()
    output = None if dry_run else Path(output).resolve()
    # A share (layered) may be written outside the project, so no temporary copy ever sits in it.
    if output is not None and ((layer is None and not output.is_relative_to(root)) or output.exists()):
        raise ValueError("Choose a new export path inside the research project")
    protocol_path = root / "protocol.json"
    paired = layer == "experiment" or (layer is None and (protocol_path.exists() or protocol_path.is_symlink()))
    if layer is not None and include_paper:
        raise ValueError("A Program-only export contains just program.json." if program_only
                         else "A shared study never includes the paper PDF.")
    study_path = root / "study.json"
    protocol = study = None
    status = experiment_status(root, checks_passed, library_attested) if layer == "experiment" else None
    if status and not status["available"]:
        raise ValueError(status["reason"])
    published = bool(status and status["route"] == "published")
    if paired:
        if not safe_candidate(root, protocol_path) or not safe_candidate(root, study_path):
            raise ValueError("A paired contribution needs both protocol.json and study.json.")
        protocol, study = read_json(protocol_path), read_json(study_path)
        if not isinstance(protocol, dict) or not isinstance(study, dict):
            raise ValueError("protocol.json and study.json must be JSON objects.")
    program_path = root / "program.json"
    if not safe_candidate(root, program_path):
        raise ValueError("The project has no readable program.json")
    program_bytes = program_path.read_bytes()
    program = json.loads(program_bytes.decode("utf-8-sig"))
    source_path = root / ".humanstudy/community.json"
    if not source_path.is_file():
        source_path = root / "sources/study.json"
    original = read_json(source_path) if safe_candidate(root, source_path) else {}
    paper = dict(program["source"])
    metadata_files = sorted((root / "package").glob("*/source/paper_metadata.json"))
    bibliography = read_json(metadata_files[0]) if len(metadata_files) == 1 and safe_candidate(root, metadata_files[0]) else {}
    if isinstance(bibliography.get("paper"), dict):
        bibliography = bibliography["paper"]
    overview_year = next((f["value"] for n in program.get("nodes", []) if n.get("kind") == "overview"
                          for f in n.get("fields", []) if f.get("id") == "year" and isinstance(f.get("value"), int)), None)
    authors = paper.get("authors") or original.get("authors") or bibliography.get("authors") or []
    authors = [authors] if isinstance(authors, str) else authors
    authors = [a if isinstance(a, str) else a.get("name", a.get("full_name", "")) for a in authors]
    meta = {"schemaVersion": 2, "appVersion": "unknown", "baseRevision": original.get("baseRevision") or original.get("currentRevision"),
            "paperId": original.get("id") if str(original.get("id", "")).startswith("paper_") else None,
            "sourceAlias": "bench:" + original["id"] if str(original.get("id", "")).startswith("study_") else None,
            "paper": {"title": paper.get("title") or original.get("title") or bibliography.get("title"), "authors": authors,
                      "firstAuthor": authors[0] if authors else "", "year": paper.get("year") or original.get("year") or bibliography.get("year") or bibliography.get("publication_year") or overview_year,
                      "doi": paper.get("doi") or bibliography.get("doi") or next((a[4:] for a in original.get("aliases", []) if a.startswith("doi:")), None)},
            "checks": {"schema": False, "package": None, "simulation": None}}
    licensed = source_licenses(root)
    layered = layer is not None
    policy = wording = None
    if layered:
        policy = SourcePolicy(root, protocol if protocol is not None else optional_document(root, protocol_path), licensed)
        wording = RestrictedWording(root, program, policy, protocol if protocol is not None else optional_document(root, protocol_path), held_texts)
    restricted_bytes = {}
    candidates = {program_path: "program.json"}
    if published:
        candidates.update({protocol_path: "protocol.json", study_path: "study.json"})
        for name in status["publishedFiles"]:
            candidates.setdefault(root / name, name)
    elif paired and layered:
        candidates.update({protocol_path: "protocol.json", study_path: "study.json"})
        for key, name in paired_sources(protocol, licensed, True).items():
            if name.startswith("sources/open/") and source_tier(protocol["meta"]["sources"][key], licensed.get(name, {})) == "hosted":
                candidates[root / name] = name
                continue
            path = root / name
            if not safe_candidate(root, path):
                raise ValueError("Each restricted protocol source must be in the project so its Get from source links can be built.")
            restricted_bytes[key] = path.read_bytes()
    elif paired:
        candidates.update({protocol_path: "protocol.json", study_path: "study.json"})
        paths = set(paired_sources(protocol).values()) | research_sources(program)
        for name in sorted(paths):
            if not name.startswith("sources/open/") or "\\" in name or any(
                    part in {"", ".", ".."} for part in name.split("/")) or private_payload(name):
                raise ValueError("A source cited by the pair is missing from the licensed public sources/open/ files.")
            candidates[root / name] = name
    for top in (() if layered else ("artifacts",) if paired else ("package", "artifacts", "sources")):
        folder = root / top
        if folder.is_symlink():
            raise ValueError("Symlinked source folders cannot be published")
        if folder.is_dir():
            candidates.update((path, path.relative_to(root).as_posix()) for path in sorted(folder.rglob("*")))
    # Older projects cite source files beside the program. Preserve their attachment path convention.
    referenced = {e.get("path") for e in program.get("evidence", []) if isinstance(e.get("path"), str)}
    if isinstance(paper.get("filename"), str):
        referenced.add(paper["filename"])
    if include_paper:
        referenced.add("paper.pdf")
    for name in sorted(referenced) if not paired and not layered else ():
        relative = Path(name)
        if relative.is_absolute() or "\\" in name or ":" in name or ".." in relative.parts:
            continue
        path = root / relative
        candidates.setdefault(path, "sources/attached/" + relative.as_posix())

    private = {p.lower() for p in check_materials.private_paths(root)}
    omitted = []
    selected = {}
    for path, name in candidates.items():
        rel = path.relative_to(root).as_posix()
        if private_payload(rel) or rel.lower() in private or check_materials.private_rel(rel):
            if path.is_file():
                omitted.append({"path": rel, "reason": "local or private material"})
            continue
        if not safe_candidate(root, path):
            continue
        if rel in {"sources/SOURCE.json", "sources/study.json"} and not published:
            continue
        if paired and rel in {"artifacts/preview.html", "artifacts/participant-preview.html"}:
            omitted.append({"path": rel, "reason": "preview must be generated against the public protocol"})
            continue
        suffix = path.suffix.lower()
        if suffix == ".pdf" and not include_paper:
            omitted.append({"path": rel, "reason": "PDF redistribution was not selected"})
            continue
        if suffix in NESTED_ARCHIVES:
            omitted.append({"path": rel, "reason": "nested archive"})
            continue
        is_source = (name.startswith("sources/") or suffix == ".pdf") and not (published and name == "sources/SOURCE.json")
        record = licensed.get(rel, {})
        license = recorded_license(record) if is_source else None
        if is_source and not license:
            omitted.append({"path": rel, "reason": "no recognized redistribution licence"})
            continue
        if path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError(f"{rel} exceeds the Hub's 25 MB per-file limit.")
        if rel not in {"program.json", "protocol.json", "study.json"} and check_materials.looks_like_data(path):
            omitted.append({"path": rel, "reason": "possible raw participant data"})
            continue
        before = digest(program_bytes) if path == program_path else check_materials.sha(path)
        declared = record.get("sha256") if is_source else None
        if declared is not None and (not isinstance(declared, str) or declared.lower() != before):
            raise ValueError(f"The bytes of {rel} no longer match sources/SOURCE.json. Verify its source licence again.")
        selected[path] = (name, before, license)

    # Copied private wording is a blocking finding in the program/package and an omission in a report.
    for shown, src, _ in check_materials.leaks(root, selected) if not layered else ():
        if not shown.startswith("artifacts/"):
            raise ValueError(f"Private materials appear in {shown} (from {src}). Keep the material in the project and cite its source.")
        selected.pop(root / shown, None)
        omitted.append({"path": shown, "reason": "contains private material"})

    payload = {}
    public_sources = []
    expanded_bytes = 0
    for path, (name, before, license) in selected.items():
        with path.open("rb") as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise ValueError(f"{name} exceeds the Hub's 25 MB per-file limit.")
        expanded_bytes += len(data)
        if expanded_bytes > MAX_EXPANDED_BYTES:
            raise ValueError("The expanded contribution exceeds the Hub's 128 MB limit.")
        if hashlib.sha256(data).hexdigest() != before:
            raise ValueError(f"{name} changed during export. Review the updated file and export again.")
        if name in payload:
            raise ValueError(f"More than one file maps to {name}")
        payload[name] = (data, license)
        if license:
            info = licensed[path.relative_to(root).as_posix()]
            credits = {key: info[key] for key in ("title", "attribution", "licenseEvidence") if isinstance(info.get(key), str)}
            public_sources.append({"path": name, "bytes": len(data), "sha256": before, "license": license, **credits})
    get_from_source = []
    withheld_quotes = []
    if paired and layered:
        # Layer 2 always carries the layer-1 overview, bound to the protocol it ships with.
        if "protocol.json" not in payload or "study.json" not in payload:
            raise ValueError("The runnable experiment is missing its protocol or study card.")
        _, withheld_quotes, get_from_source = program_only_projection(
            root, program, licensed, policy, wording, keep_binding=True, scope="experiment")
    if published:
        payload["program.json"] = (json_bytes(program), None)
        shipped = json.loads(payload["protocol.json"][0])
        meta["kind"] = "protocol"
        card = json.loads(payload["study.json"][0])
        meta["paper"] = {"title": card.get("title"), "authors": card.get("authors") or [],
                         "firstAuthor": next(iter(card.get("authors") or []), ""), "year": card.get("year"), "doi": card.get("doi")}
    elif paired:
        # Re-read from the same frozen bytes that will be archived.
        if "protocol.json" not in payload or "study.json" not in payload:
            raise ValueError("The paired contribution is missing a public protocol or study card.")
        frame = {"restricted": restricted_bytes, "omitted": omitted} if layered else None
        card = paired_projection(json.loads(payload["protocol.json"][0]), json.loads(payload["study.json"][0]),
                                 program, payload, licensed, frame)
        meta["kind"] = "protocol"
        meta["paper"] = {"title": card["title"], "authors": card["authors"], "firstAuthor": card["authors"][0],
                         "year": card["year"], "doi": card.get("doi")}
        if frame is not None:
            shipped = frame["projected"]
            held = shipped["distribution"]["held"]
            release, _, _ = projection_engine()
            recovered = release._recover_held(held, frame["sources"], frame["extractors"], None) if held else ([], set())
            if recovered is None:
                wording.add_held([], held_hashes_of(shipped), False)
            else:
                wording.add_held(recovered[0], recovered[1], True)
        public_sources = [entry for entry in public_sources if entry["path"] in payload]
    if paired and layered:
        meta["getFromSource"] = protocol_get_from_source(shipped) + get_from_source
    if program_only:
        if "program.json" not in payload:
            raise ValueError("The project does not have a shareable program.json.")
        card = optional_document(root, study_path)
        paper_meta = meta["paper"]
        if normalized_title(card.get("title")) == normalized_title(paper_meta["title"]) and (
                not card.get("doi") or not paper_meta["doi"] or normalized_doi(card["doi"]) == normalized_doi(paper_meta["doi"])):
            if not paper_meta["year"]:
                paper_meta["year"] = card.get("year")
            if not paper_meta["authors"] and isinstance(card.get("authors"), list):
                paper_meta["authors"] = [author.strip() for author in card["authors"] if isinstance(author, str) and author.strip()]
                paper_meta["firstAuthor"] = next(iter(paper_meta["authors"]), "")
        year = paper_meta["year"]
        if not normalized_title(paper_meta["title"]) or not normalized_title(paper_meta["firstAuthor"]) or (
                type(year) is not int or not 1800 <= year <= 2200):
            raise ValueError("Add the paper title, first author and publication year to the project before exporting a Program for the Hub.")
        shared_program, withheld_quotes, get_from_source = program_only_projection(root, program, licensed, policy, wording)
        payload["program.json"] = (shared_program, None)
        meta["getFromSource"] = get_from_source
    if public_sources and not published:
        source_manifest = {"schemaVersion": 1, "files": public_sources}
        payload["sources/SOURCE.json"] = (json.dumps(source_manifest, ensure_ascii=False, indent=2).encode("utf-8") + b"\n", None)
    shared_results = []
    if layered:
        items = results_items(root)
        for item_id in dict.fromkeys(results):
            if item_id not in items:
                raise ValueError("A selected result is no longer in the project. Review the list and share again.")
            for rel in items[item_id]["files"]:
                data = (root / rel).read_bytes()
                if rel in payload:
                    raise ValueError(f"More than one file maps to {rel}")
                payload[rel] = (data, None)
            shared_results.append(item_id)
        meta["layers"] = {"overview": True, "experiment": paired, "results": shared_results}
        # Restricted wording is checked by content in every shared file; licensed hosted originals are exempt.
        exempt = {entry["path"] for entry in public_sources}
        for name, (data, _) in payload.items():
            if name in exempt:
                continue
            problem = result_problem(wording, name, data, root / name) if name in {f for i in shared_results for f in items[i]["files"]} \
                else wording.data_problem(name, data)
            if problem:
                raise ValueError(f"{name} {problem}. It stays in your project; remove that wording or leave it out.")
    # Scan the frozen public text after projection, including reports and source metadata.
    text_suffixes = TEXT_SUFFIXES
    for name, (data, _) in payload.items():
        if public_text_problem(name):
            raise ValueError("Public export blocked: a file name contains a sensitive value. Review it locally before sharing.")
        if Path(name).suffix.lower() not in text_suffixes:
            continue
        content = data.decode("utf-8", errors="replace")
        if Path(name).suffix.lower() in {".json", ".qsf"}:
            try:
                content = json.loads(content)
            except ValueError:
                pass  # Structural validation owns malformed JSON.
        problem = public_text_problem(content)
        if problem:
            raise ValueError(f"Public export blocked: a public file contains {problem}. Review it locally before sharing.")
    problem = public_text_problem(meta)
    if problem:
        raise ValueError(f"Public export blocked: contribution metadata contains {problem}. Review it locally before sharing.")
    meta["includesPdf"] = any(name.lower().endswith(".pdf") for name in payload)
    meta["files"] = [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                      **({"license": license} if license else {})}
                     for name, (data, license) in sorted(payload.items())]
    metadata = json.dumps(meta, ensure_ascii=False, indent=2).encode("utf-8")
    if len(payload) + 1 > MAX_ENTRIES or sum(len(data) for data, _ in payload.values()) + len(metadata) > MAX_EXPANDED_BYTES:
        raise ValueError("The expanded contribution exceeds the Hub's file count or size limit.")
    result = {"files": len(payload) + 1, "publicFiles": ["CONTRIBUTION.json", *sorted(payload)],
              "omitted": omitted, "baseRevision": meta["baseRevision"], "paperId": meta["paperId"]}
    if layered:
        result["layer"] = layer
        result["results"] = shared_results
        result["getFromSource"] = meta.get("getFromSource", [])
    if program_only or (paired and layered):
        result["withheldEvidenceQuotes"] = {
            "ids": withheld_quotes,
            "reason": "Redistribution was not verified. Evidence locators and source references are preserved.",
        }
    if program_only:
        result["scope"] = "Program only. The experiment needs its protocol and any missing materials to run."
    if dry_run:
        return result
    output.parent.mkdir(parents=True, exist_ok=True)
    created = False
    try:
        with output.open("xb") as handle:
            created = True
            with zipfile.ZipFile(handle, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("CONTRIBUTION.json", metadata)
                for name, (data, _) in sorted(payload.items()):
                    archive.writestr(name, data)
        if output.stat().st_size > MAX_ZIP_BYTES:
            raise ValueError("The contribution ZIP exceeds the Hub's 40 MB limit.")
    except Exception:
        if created:
            output.unlink(missing_ok=True)
        raise
    return {"file": str(output), **result}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output")
    parser.add_argument("--include-paper", action="store_true", help="Only if the researcher explicitly permits public redistribution of the paper PDF")
    parser.add_argument("--program-only", action="store_true", help="Share the research Program without runtime files (the same as --layer overview)")
    parser.add_argument("--layer", choices=LAYERS, help="overview: program.json only; experiment: protocol and allowed materials as well")
    parser.add_argument("--results", action="append", default=[], help="A ticked layer-3 item (an id from --plan); repeat for more")
    parser.add_argument("--checks-passed", help="SHA-256 of the protocol.json bytes whose checks passed in the app")
    parser.add_argument("--held-texts", help="JSON file {held id: restored text} used only to check files for held wording")
    parser.add_argument("--library-validated", help="SHA-256 of protocol.json the app confirmed as the Validated library version")
    parser.add_argument("--plan", action="store_true", help="Print what each layer would contain; write nothing")
    args = parser.parse_args()
    held = read_json(Path(args.held_texts)) if args.held_texts else None
    held = held if isinstance(held, dict) else None
    if args.plan:
        print(json.dumps(plan(Path.cwd(), args.checks_passed, held, args.library_validated)))
        sys.exit(0)
    if not args.output:
        parser.error("--output is required")
    try:
        print(json.dumps(export(Path.cwd(), args.output, args.include_paper, program_only=args.program_only, layer=args.layer,
                                results=args.results, checks_passed=args.checks_passed, held_texts=held,
                                library_attested=args.library_validated)))
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
