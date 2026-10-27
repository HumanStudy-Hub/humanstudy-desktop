#!/usr/bin/env python3
"""Let an agent write the loader that turns a study's human data into replay-package sessions.

    python eval/replay/attach_human.py <project> --data <file or folder> [--model sonnet] [--python <py>]

<project> is a built HumanStudy project (program.json + package/<slug>/). The data (and codebook) are
copied to <project>/human-data/; one non-interactive agent session follows eval/replay/HUMAN_DATA.md
and writes package/<slug>/human/human_sessions.py. The loader is then checked here: it loads, every
session has the run_sessions shape, the package's evaluate runs on it, and key_effects lists effects.
"""
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(REPO / "pack/skills/export/agent"))


def package_dir(project):
    pkgs = sorted(p for p in (project / "package").glob("*") if (p / "study.json").is_file())
    if not pkgs:
        raise SystemExit("no replay package in %s/package" % project)
    return pkgs[0]


def load_module(path):
    import importlib.util
    spec = importlib.util.spec_from_file_location("human_sessions_%d" % abs(hash(str(path))), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def check(project):
    """Load the human sessions and run the package's analysis on them. Returns a summary dict."""
    import study_core
    pkg = package_dir(project)
    mod = load_module(pkg / "human/human_sessions.py")
    sessions = mod.load(str(project / "human-data"))
    # a session is one arm ({study, condition, arm, parsed, ...}) or one participant holding several
    # arms in "responses", whichever shape the package's run_sessions returns
    units = [r for s in sessions for r in (s["responses"] if isinstance(s.get("responses"), list) else [s])]
    need = {"study", "condition", "parsed"}
    bad = [i for i, u in enumerate(units) if not need <= set(u)]
    if bad:
        raise SystemExit("responses %s lack %s" % (bad[:5], sorted(need)))
    arms = sorted({str(u.get("arm") or "%s:%s" % (u["study"], u["condition"])) for u in units})
    # the human side needs only the analysis, not the materials, so readiness does not gate it
    evaluation = study_core.Study(str(project)).module("evaluation").evaluate(sessions)
    effects = mod.key_effects(evaluation)
    return {"package": pkg.name, "sessions": len(sessions), "valid": sum(1 for s in sessions if s.get("valid")),
            "arms": arms,
            "notMapped": getattr(mod, "NOT_MAPPED", []), "exclusions": getattr(mod, "EXCLUSIONS", None),
            "effects": effects}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--data", required=True, action="append", help="data file or folder (repeatable)")
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--python", default=sys.executable, help="python on PATH for the agent")
    ap.add_argument("--check-only", action="store_true", help="skip the agent; check an existing loader")
    a = ap.parse_args(argv)
    project = Path(a.project).resolve()
    pkg = package_dir(project)
    if not a.check_only:
        dest = project / "human-data"
        dest.mkdir(exist_ok=True)
        for d in map(Path, a.data):
            target = dest / d.name
            if d.is_dir():
                shutil.copytree(d, target, dirs_exist_ok=True)
            else:
                shutil.copy2(d, target)
        (pkg / "human").mkdir(exist_ok=True)
        prompt = (HERE / "HUMAN_DATA.md").read_text(encoding="utf-8").replace("<slug>", pkg.name).replace(
            "<skill>", ".claude/skills/humanstudy")
        env = dict(__import__("os").environ)
        env["PATH"] = str(Path(a.python).parent) + __import__("os").pathsep + env.get("PATH", "")
        with open(project / "human.log", "w", encoding="utf-8") as log:
            subprocess.run(["claude", "-p", prompt, "--model", a.model, "--dangerously-skip-permissions",
                            "--strict-mcp-config", "--output-format", "json"], cwd=str(project),
                           stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, env=env, timeout=3600)
    summary = check(project)
    (project / "human-check.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
