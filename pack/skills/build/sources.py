#!/usr/bin/env python3
"""Record the files a study was built from in sources/SOURCE.json: path, SHA-256, size and license.

    python .opencode/skills/build/sources.py .                         write or refresh sources/SOURCE.json
    python .opencode/skills/build/sources.py . --license paper.pdf=CC-BY-4.0 \\
                                              --license-evidence "paper.pdf=p. 1 footer: 'CC BY 4.0'"
    python .opencode/skills/build/sources.py . --check                 exit 1 when the record is missing or stale

Recorded files: the paper (program.json source.filename, else paper.pdf), every file under sources/ and
every file an evidence record cites by `path`. A license is the one the file itself (or the page that
served it) states; otherwise "unknown". Never guess one. A rerun refreshes hashes and sizes and keeps the
license, evidence and any other keys already written (by you or the researcher).
Standard library only.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

NAME = "sources/SOURCE.json"
SKIP = {".DS_Store", "SOURCE.json"}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def paper_name(root, program):
    name = ((program or {}).get("source") or {}).get("filename")
    if name and (root / name).is_file():
        return name
    return "paper.pdf" if (root / "paper.pdf").is_file() else name


def inside(root, rel):
    try:
        (root / rel).resolve().relative_to(root.resolve())
        return True
    except ValueError:
        return False


def source_files(root, program):
    """Project-relative paths of the files the program was built from, the paper first."""
    out = []
    paper = paper_name(root, program)
    if paper and (root / paper).is_file():
        out.append(paper)
    if (root / "sources").is_dir():
        out += sorted(p.relative_to(root).as_posix() for p in (root / "sources").rglob("*")
                      if p.is_file() and p.name not in SKIP and not any(x.startswith(".") for x in p.relative_to(root).parts))
    for e in (program or {}).get("evidence") or []:
        rel = e.get("path") if isinstance(e, dict) else None
        if rel and inside(root, rel) and (root / rel).is_file():
            out.append(Path(rel).as_posix())
    return list(dict.fromkeys(out))


def record(root, rel, old):
    path = root / rel
    entry = dict(old or {})
    entry.update({"path": rel, "sha256": sha256(path), "bytes": path.stat().st_size})
    entry.setdefault("license", "unknown")
    return entry


def build(root, licenses=None, evidence=None):
    root = Path(root).resolve()
    program = load(root / "program.json") or {}
    old = load(root / NAME) or {}
    known = {f.get("path"): f for f in old.get("files") or [] if isinstance(f, dict)}
    paper = paper_name(root, program)
    if isinstance(old.get("pdf"), dict) and old["pdf"].get("filename"):
        known.setdefault(old["pdf"]["filename"], {k: v for k, v in old["pdf"].items() if k in ("license", "licenseEvidence")})
    files = [record(root, rel, known.get(rel)) for rel in source_files(root, program)]
    for f in files:
        if f["path"] in (licenses or {}):
            f["license"] = licenses[f["path"]]
        if f["path"] in (evidence or {}):
            f["licenseEvidence"] = evidence[f["path"]]
    src = program.get("source") or {}
    out = dict(old)
    out["schemaVersion"] = 1
    paper_meta = dict(old.get("paper") or {})
    for k in ("title", "doi"):
        if src.get(k) and not paper_meta.get(k):
            paper_meta[k] = src[k]
    out["paper"] = paper_meta
    pdf = next((f for f in files if f["path"] == paper), None)
    if pdf:  # the summary the audit and the app read; same values as its files[] entry
        out["pdf"] = dict(old.get("pdf") or {}, filename=paper, sha256=pdf["sha256"], bytes=pdf["bytes"],
                          license=pdf["license"], **({"licenseEvidence": pdf["licenseEvidence"]} if "licenseEvidence" in pdf else {}))
        out["pdf"].setdefault("builtFrom", "the PDF the program's page numbers refer to")
    out["files"] = files
    return out


def problems(root):
    """What is missing or stale in sources/SOURCE.json, as (message, fix) pairs."""
    root = Path(root).resolve()
    fix = "run the build skill's sources.py on the project folder"
    data = load(root / NAME)
    if data is None:
        return [("%s is missing: the paper's hash and license are not recorded" % NAME, fix)]
    program = load(root / "program.json") or {}
    recorded = {f.get("path"): f for f in data.get("files") or [] if isinstance(f, dict)}
    out = []
    for rel in source_files(root, program):
        f = recorded.get(rel)
        if f is None:
            out.append(("%s does not record %s" % (NAME, rel), fix))
        elif f.get("sha256") != sha256(root / rel):
            out.append(("%s: the SHA-256 of %s changed since it was recorded" % (NAME, rel), fix))
        elif not f.get("license"):
            out.append(("%s: %s has no license entry" % (NAME, rel), 'record the stated license, or "unknown"'))
    paper = paper_name(root, program)
    if paper and (root / paper).is_file() and ((data.get("pdf") or {}).get("sha256") != sha256(root / paper)):
        out.append(("%s#pdf does not hold the current SHA-256 of %s" % (NAME, paper), fix))
    return out


def pairs(values, flag):
    out = {}
    for v in values or []:
        if "=" not in v:
            sys.exit("%s expects PATH=VALUE, got %r" % (flag, v))
        k, val = v.split("=", 1)
        out[Path(k).as_posix()] = val
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("root", nargs="?", default=".")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--license", action="append", metavar="PATH=LICENSE", help="the license the file states")
    ap.add_argument("--license-evidence", action="append", metavar="PATH=TEXT", help="where it says so")
    a = ap.parse_args(argv)
    root = Path(a.root)
    if a.check:
        found = problems(root)
        for msg, hint in found:
            print("PROBLEM %s\n        fix: %s" % (msg, hint))
        print("FAIL %d problem(s) in %s" % (len(found), NAME) if found else "PASS %s" % NAME)
        return 1 if found else 0
    data = build(root, pairs(a.license, "--license"), pairs(a.license_evidence, "--license-evidence"))
    (root / "sources").mkdir(exist_ok=True)
    (root / NAME).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    for f in data["files"]:
        print("%s  %s  %d bytes  license: %s" % (f["sha256"][:12], f["path"], f["bytes"], f["license"]))
    print("wrote %s (%d files)" % (NAME, len(data["files"])))
    return 0


if __name__ == "__main__":
    sys.exit(main())
