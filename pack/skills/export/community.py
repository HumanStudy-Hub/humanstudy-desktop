#!/usr/bin/env python3
"""Export public research assets with their exact community baseline; never chat or credentials."""
import argparse
import hashlib
import json
import re
import sys
import unicodedata
import zipfile
from functools import lru_cache
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


def paired_sources(protocol):
    sources = (protocol.get("meta") or {}).get("sources")
    if not isinstance(sources, dict) or not sources:
        raise ValueError("Paired contributions need declared public sources.")
    paths = {}
    for key, source in sources.items():
        name = source.get("file") if isinstance(source, dict) else None
        if not isinstance(name, str) or not name.startswith("sources/open/") or "\\" in name or any(
                part in {"", ".", ".."} for part in name.split("/")) or private_payload(name):
            raise ValueError("Every paired source must be a public file under sources/open/.")
        paths[key] = name
    return paths


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


def program_only_projection(root, program, licensed):
    """Keep the scholarly document independent of its local execution files."""
    release, _, _ = projection_engine()
    protocol = optional_document(root, root / "protocol.json")
    binding = (program.get("extensions") or {}).get("scholarly")
    if isinstance(binding, dict):
        binding.pop("protocol", None)

    sources = (protocol.get("meta") or {}).get("sources") or {}
    private_paths = set(check_materials.private_paths(root))
    restricted = {name for name, record in licensed.items() if not release.hosted_licence_ok(recorded_license(record))}
    private = {name for name, record in licensed.items()
               if record.get("private") is True or str(record.get("license")).lower() == check_materials.RESEARCHER_LICENSE}
    source_files = {}
    for source_id, entry in sources.items() if isinstance(sources, dict) else ():
        if not isinstance(entry, dict) or not isinstance(entry.get("file"), str):
            continue
        name = entry["file"]
        source_files[source_id] = name
        tier = (entry.get("distribution") or {}).get("tier")
        if tier in {"user", "link"} or not release.hosted_licence_ok(recorded_license(licensed.get(name, {}))):
            restricted.add(name)

    @lru_cache(maxsize=None)
    def shareable_quote(name):
        if not name or name in restricted or name in private_paths or has_private_reference({"file": name}):
            return False
        record = licensed.get(name, {})
        if not release.hosted_licence_ok(recorded_license(record)):
            return False
        sha = record.get("sha256")
        path = root / name
        return isinstance(sha, str) and safe_candidate(root, path) and sha.lower() == check_materials.sha(path)

    paper = program["source"]
    evidence_records = program.get("evidence", [])
    permitted_quotes = set()
    public_credits = {}
    withheld_quotes = []
    for evidence in evidence_records:
        # Keep the source identifier, URL and locator even when its exact quote stays local.
        source_id = evidence.get("sourceId")
        linked_name = source_files.get(source_id) if isinstance(source_id, str) else None
        name = evidence.get("path") or (linked_name if source_id else paper.get("filename"))
        recorded_hash = licensed.get(name, {}).get("sha256") if isinstance(name, str) else None
        cited_hash = evidence.get("sourceSha256")
        matching_hash = cited_hash is None or (isinstance(cited_hash, str) and isinstance(recorded_hash, str)
                                               and cited_hash.lower() == recorded_hash.lower())
        if evidence.get("quote"):
            if isinstance(name, str) and matching_hash and (linked_name is None or linked_name == name) and shareable_quote(name):
                permitted_quotes.add(evidence["id"])
                if name not in public_credits:
                    public_credits[name] = public_source_credit(licensed[name], evidence, paper, name)
                public_credits[name]["evidenceIds"].append(evidence["id"])
            else:
                evidence.pop("quote")
                evidence.pop("verification", None)
                withheld_quotes.append(evidence["id"])
    fields = [field for node in program.get("nodes", []) for field in node.get("fields", [])]
    fields.extend(step["rule"] for step in program.get("steps", []) if isinstance(step.get("rule"), dict))
    for field in fields:
        if field.get("origin") == "verbatim" and field.get("state") != "missing" and not (
                field.get("evidenceIds") and set(field["evidenceIds"]) <= permitted_quotes):
            raise ValueError("Verbatim Program fields need a verified redistributable source. Keep restricted wording local.")
    if has_private_reference(program) or private & research_sources(program):
        raise ValueError("The Program contains a private or local path. Keep a public citation or locator instead.")

    # The standard private index includes researcher files and unlicensed sources. Also check restricted
    # references outside its default directories, including a local paper.pdf or a mislabelled open file.
    texts, _ = check_materials.private_index(root)
    bibliography = {word for key in ("title", "authors", "venue", "doi")
                    for word in check_materials.words(paper.get(key))}
    for name in (restricted | research_sources(program) | {"paper.pdf"}) - private_paths:
        if has_private_reference({"file": name}) or shareable_quote(name):
            continue
        path = root / name
        if safe_candidate(root, path):
            for shingle in check_materials.shingles(check_materials.text_of(path)):
                if not all(word in bibliography for word in shingle.split()):
                    texts.setdefault(shingle, name)
    held = (protocol.get("distribution") or {}).get("held") or {}
    held_hashes = set()
    for item in held.values() if isinstance(held, dict) else ():
        if isinstance(item, dict):
            loc = item.get("locator") or {}
            held_hashes.update(h for h in [item.get("text_sha256"), *(p.get("canon_sha256") for p in loc.get("parts", []))]
                               if isinstance(h, str))
    held_index = release.HeldIndex(hashes=held_hashes)
    for value in check_materials.strings(program):
        if held_index.hit(value):
            raise ValueError("Held source wording appears in program.json. Keep the material local and cite its source.")
        words = check_materials.words(value)
        if any(" ".join(words[i:i + size]) in texts
               for size in range(4, check_materials.SHINGLE + 1) for i in range(len(words) - size + 1)):
            raise ValueError("Restricted source wording appears in program.json. Keep the material local and cite its source.")
    extensions = program.setdefault("extensions", {})
    previous = extensions.get("communityExport") or {}
    previous_quotes = previous.get("withheldEvidenceQuotes") if isinstance(previous, dict) else None
    previous_ids = previous_quotes.get("ids") if isinstance(previous_quotes, dict) else None
    prior_ids = {value for value in previous_ids if isinstance(value, str)} if isinstance(previous_ids, list) else set()
    withheld = set(withheld_quotes) | prior_ids
    withheld_quotes = [e["id"] for e in evidence_records if e["id"] in withheld and not e.get("quote")]
    extensions["communityExport"] = {
        "scope": "program-only",
        "sources": list(public_credits.values()),
        "withheldEvidenceQuotes": {"ids": withheld_quotes, "reason": "redistribution-unverified"},
    }
    return json_bytes(program), withheld_quotes


def paired_projection(protocol, study, program, payload, licensed):
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
    protocol_sources = paired_sources(protocol)
    for name in research_sources(program):
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
    if projected["distribution"]["held"]:
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
    for name, (data, _) in payload.items():
        if not release.distributable(name, projected, content=data, sources=sources, extractors=extractors):
            raise ValueError(f"{name} is not part of the public protocol projection.")
    return card


def export(root, output, include_paper=False, *, program_only=False):
    root, output = Path(root).resolve(), Path(output).resolve()
    if not output.is_relative_to(root) or output.exists():
        raise ValueError("Choose a new export path inside the research project")
    protocol_path = root / "protocol.json"
    paired = not program_only and (protocol_path.exists() or protocol_path.is_symlink())
    if program_only and include_paper:
        raise ValueError("A Program-only export contains just program.json.")
    study_path = root / "study.json"
    protocol = study = None
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
    candidates = {program_path: "program.json"}
    if paired:
        candidates.update({protocol_path: "protocol.json", study_path: "study.json"})
        paths = set(paired_sources(protocol).values()) | research_sources(program)
        for name in sorted(paths):
            if not name.startswith("sources/open/") or "\\" in name or any(
                    part in {"", ".", ".."} for part in name.split("/")) or private_payload(name):
                raise ValueError("A source cited by the pair is missing from the licensed public sources/open/ files.")
            candidates[root / name] = name
    for top in (() if program_only else ("artifacts",) if paired else ("package", "artifacts", "sources")):
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
    for name in sorted(referenced) if not paired and not program_only else ():
        relative = Path(name)
        if relative.is_absolute() or "\\" in name or ":" in name or ".." in relative.parts:
            continue
        path = root / relative
        candidates.setdefault(path, "sources/attached/" + relative.as_posix())

    licensed = source_licenses(root)
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
        if rel in {"sources/SOURCE.json", "sources/study.json"}:
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
        is_source = name.startswith("sources/") or suffix == ".pdf"
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
    for shown, src, _ in check_materials.leaks(root, selected) if not program_only else ():
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
    if paired:
        # Re-read from the same frozen bytes that will be archived.
        if "protocol.json" not in payload or "study.json" not in payload:
            raise ValueError("The paired contribution is missing a public protocol or study card.")
        card = paired_projection(json.loads(payload["protocol.json"][0]), json.loads(payload["study.json"][0]),
                                 program, payload, licensed)
        meta["kind"] = "protocol"
        meta["paper"] = {"title": card["title"], "authors": card["authors"], "firstAuthor": card["authors"][0],
                         "year": card["year"], "doi": card.get("doi")}
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
        shared_program, withheld_quotes = program_only_projection(root, program, licensed)
        payload["program.json"] = (shared_program, None)
    if public_sources:
        source_manifest = {"schemaVersion": 1, "files": public_sources}
        payload["sources/SOURCE.json"] = (json.dumps(source_manifest, ensure_ascii=False, indent=2).encode("utf-8") + b"\n", None)
    # Scan the frozen public text after projection, including reports and source metadata.
    text_suffixes = {".json", ".jsonl", ".md", ".txt", ".htm", ".html", ".csv", ".tsv", ".py", ".js", ".cjs", ".mjs",
                     ".ts", ".tsx", ".yaml", ".yml", ".toml", ".xml", ".svg", ".qsf"}
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
    result = {"file": str(output), "files": len(payload) + 1, "publicFiles": ["CONTRIBUTION.json", *sorted(payload)],
              "omitted": omitted, "baseRevision": meta["baseRevision"], "paperId": meta["paperId"]}
    if program_only:
        result["scope"] = "Program only. The experiment needs its protocol and any missing materials to run."
        result["withheldEvidenceQuotes"] = {
            "ids": withheld_quotes,
            "reason": "Redistribution was not verified. Evidence locators and source references are preserved.",
        }
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--include-paper", action="store_true", help="Only if the researcher explicitly permits public redistribution of the paper PDF")
    parser.add_argument("--program-only", action="store_true", help="Share the research Program without runtime files")
    args = parser.parse_args()
    print(json.dumps(export(Path.cwd(), args.output, args.include_paper, program_only=args.program_only)))
