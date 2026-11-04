#!/usr/bin/env python3
"""Which build contract a package was built under: decides whether the newer build rules block.

    python .opencode/skills/build/contract.py .        prints "current" or "older build" per package

A package is built under the current contract when it carries the shared reply reader (task/replies.py, or
an adapter that imports it; the same test check_replies.py uses), or when its project shows the current build
skill's work in any other way, so leaving task/replies.py out does not turn the newer rules into warnings:
study.json `"buildContract": 2` (or higher); sources/SOURCE.json with any of licenceLookups, paperTables,
signChecks, analysisCode, surveyVersions, questionsChecked, decisionsFromSources, or a file entry with
`retrieved` or `finalUrl` (written by fetch_source.py); program.json or the package's materials.json carrying
a `qsfReachability` mark (qsf_flow.py). Rules added together with that reader
(prompt memory claims, internal identifiers in prompts, arms that crash, image-only tables, lost minus
signs, impossible values, downloaded-source and survey-flow checks) are problems for a current package and
warnings for an older one, so a project that was ready before an app update stays ready. Rebuilding the
package under the current contract makes them blocking.

Limits: the test reads files only; it never imports or runs package code. Standard library.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_replies import uses_replies  # noqa: E402


BUILD_CONTRACT = 2
# SOURCE.json records only the current build skill writes
NEW_SOURCE_KEYS = ("licenceLookups", "paperTables", "signChecks", "analysisCode", "surveyVersions",
                   "questionsChecked", "decisionsFromSources")
NEW_FILE_KEYS = ("retrieved", "finalUrl")
QSF_MARK = '"qsfReachability"'


def _json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _text(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def new_build_signs(package_dir) -> list:
    """What shows the current build skill made this package or its project (empty: none)."""
    pkg = Path(package_dir)
    signs = []
    study = _json(pkg / "study.json")
    marked = study.get("buildContract") if isinstance(study, dict) else None
    if isinstance(marked, (int, float)) and not isinstance(marked, bool) and marked >= BUILD_CONTRACT:
        signs.append("study.json buildContract %s" % marked)
    project = pkg.parent.parent if pkg.parent.name == "package" else None
    if project is not None:
        record = _json(project / "sources" / "SOURCE.json")
        if isinstance(record, dict):
            signs += ["SOURCE.json %s" % k for k in NEW_SOURCE_KEYS if record.get(k) not in (None, [], {}, "")]
            files = record.get("files") if isinstance(record.get("files"), list) else []
            if any(isinstance(f, dict) and any(f.get(k) for k in NEW_FILE_KEYS) for f in files):
                signs.append("SOURCE.json a downloaded file (retrieved / finalUrl)")
        if QSF_MARK in _text(project / "program.json"):
            signs.append("program.json qsfReachability")
    if QSF_MARK in _text(pkg / "materials" / "materials.json"):
        signs.append("materials.json qsfReachability")
    return signs


def current_contract(package_dir) -> bool:
    """The package carries the shared reply reader, or its project shows the current build skill's work: the
    newer rules are hard failures for it."""
    try:
        if package_dir is None or not Path(package_dir).is_dir():
            return False
        return uses_replies(Path(package_dir)) or bool(new_build_signs(package_dir))
    except OSError:
        return False


def project_current(project_root) -> bool:
    """Any package/<slug>/ of the project is built under the current contract."""
    folder = Path(project_root) / "package"
    try:
        return folder.is_dir() and any(current_contract(p) for p in sorted(folder.iterdir()) if p.is_dir())
    except OSError:
        return False


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    root = Path(argv[0] if argv else ".")
    folder = root / "package"
    for p in sorted(folder.iterdir()) if folder.is_dir() else []:
        if p.is_dir():
            print("%s: %s" % (p.name, "current" if current_contract(p) else "older build (newer rules warn)"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
