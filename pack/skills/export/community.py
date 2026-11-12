#!/usr/bin/env python3
"""Export public research assets with their exact community baseline; never chat or credentials."""
import argparse
import hashlib
import json
import sys
import unicodedata
import zipfile
from pathlib import Path

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
                        name.startswith(("/", "file:")) or len(name) > 1 and name[1] == ":" or private_payload(name)):
                    return True
            if has_private_reference(item):
                return True
    elif isinstance(value, list):
        return any(has_private_reference(item) for item in value)
    return False


def paired_projection(protocol, study, program, payload, licensed):
    # In an installed project the engine is beside skills/. The second path is for repository tests.
    here = Path(__file__).resolve()
    candidates = (here.parents[2] / "hsenv", here.parents[2] / "runtime/hsenv")
    engine = next((p for p in candidates if (p / "hsenv/release.py").is_file()), None)
    if engine is None:
        raise ValueError("Paired export needs the current Desktop protocol engine.")
    sys.path.insert(0, str(engine))
    from hsenv import release, schema_check, distribution
    sys.path.pop(0)

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


def export(root, output, include_paper=False):
    root, output = Path(root).resolve(), Path(output).resolve()
    if not output.is_relative_to(root) or output.exists():
        raise ValueError("Choose a new export path inside the research project")
    protocol_path = root / "protocol.json"
    paired = protocol_path.exists() or protocol_path.is_symlink()
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
    for top in (("artifacts",) if paired else ("package", "artifacts", "sources")):
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
    for name in sorted(referenced) if not paired else ():
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
    for shown, src, _ in check_materials.leaks(root, selected):
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
    if public_sources:
        source_manifest = {"schemaVersion": 1, "files": public_sources}
        payload["sources/SOURCE.json"] = (json.dumps(source_manifest, ensure_ascii=False, indent=2).encode("utf-8") + b"\n", None)
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
    return {"file": str(output), "files": len(payload) + 1, "publicFiles": ["CONTRIBUTION.json", *sorted(payload)],
            "omitted": omitted, "baseRevision": meta["baseRevision"], "paperId": meta["paperId"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--include-paper", action="store_true", help="Only if the researcher explicitly permits public redistribution of the paper PDF")
    args = parser.parse_args()
    print(json.dumps(export(Path.cwd(), args.output, args.include_paper)))
