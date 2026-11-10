#!/usr/bin/env python3
"""Build the participant view of the project's protocol.json as an artifact. App-owned wrapper around the
vendored build_preview.py (sandbox skills/preview).

    python .opencode/skills/preview/make_preview.py [--out artifacts/preview.html] [--arms a b] [--seed 1] [--tries N]
           [--lang en|zh-CN]

Run from the project folder. Plays a few sessions per arm with the engine (no model calls), renders every screen
as the participant saw it, then embeds the protocol's identity and checks the page with the artifact kit
(.opencode/artifact-kit/inline.py, protocol mode). Prints PASS <file> or FAIL with the problems (exit 1). The page
holds the protocol's screen text: it stays in the project (never published or attached anywhere).
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

os.environ["HSENV_PRIVATE_CONFIG"] = ""   # never the engine's private sidecar in the app (before any hsenv import)

HERE = Path(__file__).resolve().parent


def make(project: Path, out: Path, arms=None, seed: int = 1, tries=None, max_image_kb: int = 1500, lang=None) -> list[str]:
    """lang: the app's UI language for the page's own words ('zh-CN' or 'en'; default env HS_UI_LANG, else en).
    The participant's screens keep the protocol's own language."""
    sys.path.insert(0, str(HERE))
    import build_preview   # vendored; finds the engine in .opencode/hsenv and the kit in .opencode/artifact-kit
    data = build_preview.build(str(project.resolve()), arms, seed, tries, max_image_kb)
    # The same finishing step as the sandbox CLI: the protocol's identity block, then the kit's protocol-mode check.
    text, problems = build_preview.finish(build_preview.page(data, lang), project / "protocol.json",
                                          build_preview.kit_module() or _project_kit(project))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    for arm in data["arms"]:
        if not arm["participants"]:
            print("  finding: arm %s has no session to show" % arm["id"])
    for x in data.get("engine_problems") or []:
        print("  engine problem: " + x)
    return problems


def _project_kit(project: Path):
    sys.path.insert(0, str(project / ".opencode" / "artifact-kit"))
    import inline
    return inline


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--project", default=".")
    ap.add_argument("--out", default="artifacts/preview.html")
    ap.add_argument("--arms", nargs="+")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--tries", type=int)
    ap.add_argument("--lang", help="the app's UI language (uiLanguage in the workspace context): en or zh-CN")
    a = ap.parse_args(argv)
    project = Path(a.project).resolve()
    out = Path(a.out) if Path(a.out).is_absolute() else project / a.out
    problems = make(project, out, a.arms, a.seed, a.tries, lang=a.lang)
    if problems:
        print("FAIL %s - %d problem(s):" % (out, len(problems)))
        for p in problems:
            print("  - " + p)
        return 1
    print("PASS %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
