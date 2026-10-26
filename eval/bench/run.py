#!/usr/bin/env python3
"""Build every HumanStudy-Bench paper with the standalone humanstudy skill, then score the programs.

    python eval/bench/run.py --bench ../HumanStudy-Bench --work <scratch>/bench-run [--model sonnet]
                             [--jobs 3] [--only study_001,study_005] [--score-only]

Each study gets a fresh project folder (paper.pdf, supplements in sources/, the skill in
.claude/skills/) and one non-interactive Claude Code session that builds the program and the replay
package with every check passing and runs no simulation. The agent never sees the ground truth.
Results go to <work>/results.json; programs stay in <work> (they contain the papers' materials).
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PROMPT = ("Use the humanstudy skill to build this study from paper.pdf (and sources/ if present): the "
          "program and the runnable replay package, with all checks passing. Do not run any simulation. "
          "At the end, report studies found, issue counts, the quote check line and readiness, in at most 8 lines.")
MAIN_PDF = {"study_014": "Davis"}          # the other PDF there is a later LLM paper, not a source
SUPPLEMENT = {"study_015": "apndx"}


def setup(study, work, skill):
    project = work / study.name
    if project.exists():
        shutil.rmtree(project)
    (project / ".claude/skills").mkdir(parents=True)
    shutil.copytree(skill, project / ".claude/skills/humanstudy")
    pdfs = sorted((study / "source").glob("*.pdf"))
    key = MAIN_PDF.get(study.name)
    main = next((p for p in pdfs if key and key in p.name), None) or \
        next(p for p in pdfs if not (SUPPLEMENT.get(study.name, "\0") in p.name))
    shutil.copy2(main, project / "paper.pdf")
    for p in pdfs:
        if SUPPLEMENT.get(study.name, "\0") in p.name:
            (project / "sources").mkdir(exist_ok=True)
            shutil.copy2(p, project / "sources" / p.name)
    return project


def build(project, model, env):
    start = time.time()
    with open(project / "build.log", "w", encoding="utf-8") as log:
        run = subprocess.run(["claude", "-p", PROMPT, "--model", model, "--dangerously-skip-permissions",
                              "--strict-mcp-config", "--output-format", "json"],
                             cwd=str(project), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                             env=env, timeout=3600)
    return {"exit": run.returncode, "minutes": round((time.time() - start) / 60, 1)}


def checks(project, skill, python):
    out = {}
    hs = project / ".claude/skills/humanstudy/scripts/build"
    if not (project / "program.json").is_file():
        return {"program": "missing"}
    r = subprocess.run([python, str(hs / "check_program.py"), "program.json", "--complete"], cwd=str(project),
                       capture_output=True, text=True)
    out["programComplete"] = "PASS" in r.stdout
    pkgs = sorted((project / "package").glob("*")) if (project / "package").is_dir() else []
    if pkgs:
        r = subprocess.run([python, str(hs / "check_package.py"), str(pkgs[0])], cwd=str(project),
                           capture_output=True, text=True)
        out["package"] = "PASS package checks" in r.stdout
        try:
            out["readiness"] = json.loads((pkgs[0] / "study.json").read_text())["readiness"]["status"]
        except Exception:
            out["readiness"] = None
    else:
        out["package"] = None
    return out


def usage(project):
    try:
        data = json.loads((project / "build.log").read_text(encoding="utf-8").strip().splitlines()[-1])
        return {"costUsd": data.get("total_cost_usd"), "turns": data.get("num_turns")}
    except Exception:
        return {}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bench", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--model", default="sonnet")
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--only")
    ap.add_argument("--python", default=sys.executable, help="Python with pypdf, for checks and scoring")
    ap.add_argument("--score-only", action="store_true")
    a = ap.parse_args(argv)
    work = Path(a.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    skill = work / "_skill/humanstudy"
    subprocess.run([sys.executable, str(REPO / "scripts/build_standalone_skill.py"), "--out", str(skill)], check=True,
                   capture_output=True)
    studies = sorted(p for p in (Path(a.bench) / "studies").glob("study_*") if (p / "source/ground_truth.json").is_file())
    if a.only:
        studies = [s for s in studies if s.name in a.only.split(",")]
    env = dict(os.environ, PATH=str(Path(a.python).parent) + os.pathsep + os.environ.get("PATH", ""))

    def one(study):
        project = work / study.name
        row = {"study": study.name, **{k: v for k, v in previous.get(study.name, {}).items() if k in keep}}
        if not a.score_only:
            project = setup(study, work, skill)
            row.update(build(project, a.model, env))
            print("built", study.name, row, flush=True)
        row.update(usage(project))
        row.update(checks(project, skill, a.python))
        if (project / "program.json").is_file():
            r = subprocess.run([a.python, str(HERE / "score.py"), str(study), str(project / "program.json")],
                               capture_output=True, text=True)
            row["score"] = json.loads(r.stdout) if r.returncode == 0 else {"error": r.stderr[-400:]}
        return row

    previous = {}
    if a.score_only and (work / "results.json").is_file():
        previous = {r["study"]: r for r in json.loads((work / "results.json").read_text())["rows"]}
    keep = ("exit", "minutes", "costUsd", "turns", "variant")

    with ThreadPoolExecutor(a.jobs) as pool:
        rows = list(pool.map(one, studies))
    (work / "results.json").write_text(json.dumps({"model": a.model, "rows": rows}, indent=2) + "\n", encoding="utf-8")
    print("wrote", work / "results.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
