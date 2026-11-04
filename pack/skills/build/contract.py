#!/usr/bin/env python3
"""Which build contract a package was built under: decides whether the newer build rules block.

    python .opencode/skills/build/contract.py .        prints "current" or "older build" per package

A package is built under the current contract when it carries the shared reply reader (task/replies.py, or
an adapter that imports it; the same test check_replies.py uses). Rules added together with that reader
(prompt memory claims, internal identifiers in prompts, arms that crash, image-only tables, lost minus
signs, impossible values, downloaded-source and survey-flow checks) are problems for a current package and
warnings for an older one, so a project that was ready before an app update stays ready. Rebuilding the
package under the current contract makes them blocking.

Limits: the test reads files only; it never imports or runs package code. Standard library.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_replies import uses_replies  # noqa: E402


def current_contract(package_dir) -> bool:
    """The package carries the shared reply reader, so the newer rules are hard failures for it."""
    try:
        return package_dir is not None and Path(package_dir).is_dir() and uses_replies(Path(package_dir))
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
