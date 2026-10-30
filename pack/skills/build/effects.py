#!/usr/bin/env python3
"""Check effects.json: hypotheses -> effects -> the program nodes they bind, every reported number quoted.

Usage: python effects.py <project>           check; prints PASS or each problem, exits 1 on a problem
       python effects.py <project> --graph   the hypothesis graph (edges and unlinked program nodes)

The rules and the computation live in ../export/agent/effects_core.py (shipped with every agent export).
"""
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "export" / "agent"))
import effects_core  # noqa: E402

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(2)
    sys.exit(effects_core.main(["graph" if "--graph" in args else "check", args[0]]))
