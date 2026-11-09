#!/usr/bin/env python3
"""Build the participant view of the project's protocol.json as an artifact. App-owned wrapper around the
vendored build_preview.py (sandbox skills/preview).

    python .opencode/skills/preview/make_preview.py [--out artifacts/preview.html] [--arms a b] [--seed 1] [--tries N]

Run from the project folder. Plays a few sessions per arm with the engine (no model calls), renders every screen
as the participant saw it, then embeds the protocol's identity and checks the page with the artifact kit
(.opencode/artifact-kit/inline.py, protocol mode). Prints PASS <file> or FAIL with the problems (exit 1). The page
holds the protocol's screen text: it stays in the project (never published or attached anywhere).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def make(project: Path, out: Path, arms=None, seed: int = 1, tries=None, max_image_kb: int = 1500) -> list[str]:
    sys.path.insert(0, str(HERE))
    import build_preview   # vendored; finds the engine in .opencode/hsenv
    raw = (project / "protocol.json").read_bytes()
    protocol = (json.loads(raw.decode("utf-8")), hashlib.sha256(raw).hexdigest())
    data = build_preview.build(str(project.resolve()), arms, seed, tries, max_image_kb)
    sys.path.insert(0, str(project / ".opencode" / "artifact-kit"))
    import inline as kit_inline
    text = kit_inline.inline(build_preview.page(data), None, protocol)
    problems, _ = kit_inline.check(text, None, protocol[0])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text, encoding="utf-8")
    for arm in data["arms"]:
        if not arm["participants"]:
            print("  finding: arm %s has no session to show" % arm["id"])
    for x in data.get("engine_problems") or []:
        print("  engine problem: " + x)
    return problems


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--project", default=".")
    ap.add_argument("--out", default="artifacts/preview.html")
    ap.add_argument("--arms", nargs="+")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--tries", type=int)
    a = ap.parse_args(argv)
    project = Path(a.project).resolve()
    out = Path(a.out) if Path(a.out).is_absolute() else project / a.out
    problems = make(project, out, a.arms, a.seed, a.tries)
    if problems:
        print("FAIL %s - %d problem(s):" % (out, len(problems)))
        for p in problems:
            print("  - " + p)
        return 1
    print("PASS %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
