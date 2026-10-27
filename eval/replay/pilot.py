#!/usr/bin/env python3
"""Run conversion pilots end to end: build -> attach human data -> replay vs humans -> community export.

    python eval/replay/pilot.py pilots.json --work runs/pilots [--jobs 3] [--n 10] [--steps build,human,replay,export]

pilots.json lists papers:
  [{"id": "manylabs1", "paper": "path/to/paper.pdf", "sources": ["supp.pdf"],
    "data": ["path/to/data.csv", "path/to/codebook/"], "catalog": {"id": "paper_...", "aliases": [...]}}]

Each paper gets <work>/<id>/. Steps already done are skipped (a step is done when its output exists),
so the command can be rerun after an interruption. Writes <work>/pilots.json and pilots.md.
"""
import argparse
import json
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
STEPS = ["build", "human", "replay", "export"]


def sh(args, cwd=None, log=None, timeout=None):
    with open(log, "a", encoding="utf-8") if log else open("/dev/null", "w") as out:
        return subprocess.run([str(a) for a in args], cwd=cwd, stdout=out, stderr=subprocess.STDOUT,
                              timeout=timeout).returncode


def one(p, work, a):
    project = work / p["id"]
    log = work / ("%s.log" % p["id"])
    row = {"id": p["id"]}
    t0 = time.time()
    py = a.python
    if "build" in a.steps and not (project / "program.json").is_file():
        stage = work / "_in" / p["id"]
        shutil.rmtree(stage, ignore_errors=True)
        stage.mkdir(parents=True)
        shutil.copy2(p["paper"], stage / "paper.pdf")
        for s in p.get("sources", []):
            shutil.copy2(s, stage / Path(s).name)
        sh([sys.executable, REPO / "scripts/batch_build.py", "--pdfs", stage, "--work", work / "_build" / p["id"],
            "--jobs", 1, "--python", py, "--agent", a.build_agent]
           + (["--model", a.build_model] if a.build_model else []), log=log)
        built = work / "_build" / p["id"] / p["id"]
        if built.is_dir():
            shutil.rmtree(project, ignore_errors=True)
            shutil.copytree(built, project)
    if not (project / "program.json").is_file():
        row["failed"] = "build"
        return row
    if p.get("catalog"):
        (project / ".humanstudy").mkdir(exist_ok=True)
        (project / ".humanstudy/community.json").write_text(json.dumps(p["catalog"], indent=2), encoding="utf-8")
    pkg = sorted(x for x in (project / "package").glob("*") if (x / "study.json").is_file())
    row["package"] = pkg[0].name if pkg else None
    if pkg:
        try:
            row["readiness"] = json.loads((pkg[0] / "study.json").read_text())["readiness"]["status"]
        except Exception:
            row["readiness"] = None
    if "human" in a.steps and pkg and p.get("data") and not (project / "human-check.json").is_file():
        args = [py, HERE / "attach_human.py", project, "--python", py]
        for d in p["data"]:
            args += ["--data", d]
        sh(args, log=log, timeout=3600)
    if (project / "human-check.json").is_file():
        hc = json.loads((project / "human-check.json").read_text())
        row["humanSessions"] = hc.get("sessions")
    if "replay" in a.steps and (project / "human-check.json").is_file() and not (project / "replay-compare.json").is_file():
        sh([py, HERE / "compare.py", project, "--n", a.n, "--jobs", a.participant_jobs], log=log, timeout=7200)
    if (project / "replay-compare.json").is_file():
        rc = json.loads((project / "replay-compare.json").read_text())
        row["humanMatchesPaper"] = "%d/%d" % tuple(rc["humanMatchesPaper"])
        row["agentAgrees"] = "%d/%d" % tuple(rc["agentAgrees"])
        art = project / "artifacts/replay"
        art.mkdir(parents=True, exist_ok=True)
        for f in ("replay-compare.json", "replay-compare.md", "human-check.json"):
            if (project / f).is_file():
                shutil.copy2(project / f, art / f)
    if "export" in a.steps and pkg:
        out = project / "exports" / ("community-%s.zip" % p["id"])
        if not out.is_file():
            out.parent.mkdir(exist_ok=True)
            sh([py, project / ".claude/skills/humanstudy/scripts/export/community.py", "--output", out],
               cwd=project, log=log)
            if not out.is_file():  # standalone skills without the exporter: use the repo copy
                sh([py, REPO / "pack/skills/export/community.py", "--output", out], cwd=project, log=log)
        row["export"] = str(out) if out.is_file() else None
    row["minutes"] = round((time.time() - t0) / 60, 1)
    return row


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pilots")
    ap.add_argument("--work", required=True)
    ap.add_argument("--jobs", type=int, default=3)
    ap.add_argument("--n", type=int, default=10, help="AI participants per arm")
    ap.add_argument("--participant-jobs", type=int, default=6)
    ap.add_argument("--build-agent", choices=["claude", "opencode"], default="claude",
                    help="opencode = the desktop app's OpenCode on its hosted models (needs HUMANSTUDY_DESKTOP_KEY)")
    ap.add_argument("--build-model", default=None, help="default: sonnet (claude) or anthropic/claude-sonnet-5.5")
    ap.add_argument("--steps", default=",".join(STEPS))
    ap.add_argument("--only", help="comma-separated pilot ids")
    ap.add_argument("--python", default=sys.executable)
    a = ap.parse_args(argv)
    a.steps = a.steps.split(",")
    pilots = json.loads(Path(a.pilots).read_text(encoding="utf-8"))
    if a.only:
        keep = set(a.only.split(","))
        pilots = [p for p in pilots if p["id"] in keep]
    work = Path(a.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    rows = []
    with ThreadPoolExecutor(a.jobs) as pool:
        futs = {pool.submit(one, p, work, a): p["id"] for p in pilots}
        for f in as_completed(futs):
            try:
                row = f.result()
            except Exception as e:
                row = {"id": futs[f], "failed": repr(e)[:300]}
            rows.append(row)
            print(json.dumps(row), flush=True)
    rows.sort(key=lambda r: r["id"])
    (work / "pilots.json").write_text(json.dumps(rows, indent=2) + "\n", encoding="utf-8")
    keys = ["id", "readiness", "humanSessions", "humanMatchesPaper", "agentAgrees", "minutes", "failed"]
    md = ["| " + " | ".join(keys) + " |", "|" + " --- |" * len(keys)]
    md += ["| " + " | ".join(str(r.get(k, "–")) for k in keys) + " |" for r in rows]
    (work / "pilots.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n".join(md))
    return 0


if __name__ == "__main__":
    sys.exit(main())
