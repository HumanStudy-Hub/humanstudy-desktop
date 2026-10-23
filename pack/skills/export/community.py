#!/usr/bin/env python3
"""Export public research assets with their exact community baseline; never chat or credentials."""
import argparse
import json
import zipfile
from pathlib import Path

PRIVATE = {".env", ".git", ".opencode", ".humanstudy", "node_modules", "__pycache__", "threads", "conversations", "chat", "chats", "credentials", "account.json", "settings.json"}


def export(root, output, include_paper=False):
    root, output = Path(root).resolve(), Path(output).resolve()
    if not output.is_relative_to(root) or output.exists():
        raise ValueError("Choose a new export path inside the research project")
    program = json.loads((root / "program.json").read_text())
    source_path = root / ".humanstudy/community.json"
    if not source_path.is_file():
        source_path = root / "sources/study.json"
    original = json.loads(source_path.read_text()) if source_path.is_file() else {}
    paper = dict(program["source"])
    metadata_files = sorted((root / "package").glob("*/source/paper_metadata.json"))
    bibliography = json.loads(metadata_files[0].read_text()) if len(metadata_files) == 1 else {}
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
    candidates = [root / "program.json"]
    for top in ["package", "artifacts", "sources"]:
        folder = root / top
        if folder.exists():
            if folder.is_symlink():
                raise ValueError("Symlinked source folders cannot be published")
            candidates.extend(sorted(folder.rglob("*")))
    files = []
    for path in candidates:
        if path.is_symlink():
            raise ValueError("Symlinks are not community research assets")
        if not path.resolve().is_relative_to(root):
            raise ValueError("Research assets must remain inside the project")
        if not path.is_file():
            continue
        rel = path.relative_to(root)
        if any(p.lower() in PRIVATE or p.lower().startswith(".env.") for p in rel.parts):
            continue
        if path.suffix.lower() == ".pdf" and not include_paper:
            continue
        if rel.as_posix() == "sources/study.json" and (source_path == path or source_path.is_file() and source_path.read_bytes() == path.read_bytes()):
            continue  # Local source/fork metadata is represented by the minimal baseline above.
        files.append((path, rel.as_posix()))
    # Older projects keep cited materials beside program.json. Carry those exact files too,
    # under a portable resource prefix; the program itself and its evidence IDs stay unchanged.
    referenced = {e.get("path") for e in program.get("evidence", []) if e.get("path")}
    if paper.get("filename"):
        referenced.add(paper["filename"])
    if include_paper and (root / "paper.pdf").is_file():
        referenced.add("paper.pdf")
    for name in sorted(referenced):
        relative = Path(name)
        if relative.is_absolute() or any(p in {"..", "."} or p.lower() in PRIVATE for p in relative.parts):
            continue
        source = root / relative
        if not source.is_file() or source.is_symlink() or not source.resolve().is_relative_to(root):
            continue
        if source.suffix.lower() == ".pdf" and not include_paper:
            continue
        if not any(path == source for path, _ in files):
            files.append((source, "sources/attached/" + relative.as_posix()))
    meta["includesPdf"] = include_paper
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("CONTRIBUTION.json", json.dumps(meta, ensure_ascii=False, indent=2))
            for path, name in files:
                archive.write(path, name)
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return {"file": str(output), "files": len(files) + 1, "baseRevision": meta["baseRevision"], "paperId": meta["paperId"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--include-paper", action="store_true", help="Only if the researcher explicitly permits public redistribution of the paper PDF")
    args = parser.parse_args()
    print(json.dumps(export(Path.cwd(), args.output, args.include_paper)))
