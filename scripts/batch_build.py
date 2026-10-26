#!/usr/bin/env python3
"""Build many papers at once with the standalone humanstudy skill: one fresh agent session per paper.

    python scripts/batch_build.py --pdfs papers/ --work runs/batch-1 [--jobs 4] [--model sonnet]
                                  [--agent claude|codex] [--limit 20] [--python <python with pypdf>]

Each PDF gets its own project folder `<work>/<pdf name>/` (paper.pdf + the skill), and one
non-interactive agent session builds program.json and the replay package with every check passing.
No simulation is run. A paper whose project already holds a passing program is skipped, so the
command can be rerun after an interruption; `--rebuild` starts those again.

Writes `<work>/results.json` and `<work>/results.csv`: per paper the build time, cost, checks,
readiness, issue counts and quote check. Projects contain the papers' text: keep `<work>` private.
Codex support is untested.
"""
import argparse
import csv
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PROMPT = ("Use the humanstudy skill to build this study from paper.pdf: the program and the runnable replay "
          "package, with all checks passing. Do not run any simulation. At the end, report studies found, issue "
          "counts, the quote check line and readiness, in at most 8 lines.")


def slug(name):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", Path(name).stem).strip("-")[:80] or "paper"


def setup(pdf, project, skill):
    if project.exists():
        shutil.rmtree(project)
    for where in (".claude/skills", ".agents/skills"):
        (project / where).mkdir(parents=True)
        shutil.copytree(skill, project / where / "humanstudy")
    shutil.copy2(pdf, project / "paper.pdf")


def agent_command(agent, model):
    if agent == "claude":
        return ["claude", "-p", PROMPT, "--model", model, "--dangerously-skip-permissions",
                "--strict-mcp-config", "--output-format", "json"]
    return ["codex", "exec", "--full-auto", "--skip-git-repo-check"] + (["-m", model] if model else []) + [PROMPT]


def build(project, agent, model, env, timeout):
    start = time.time()
    with open(project / "build.log", "w", encoding="utf-8") as log:
        try:
            run = subprocess.run(agent_command(agent, model), cwd=str(project), stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, env=env, timeout=timeout)
            code = run.returncode
        except subprocess.TimeoutExpired:
            code = "timeout"
    return {"exit": code, "minutes": round((time.time() - start) / 60, 1)}


def usage(project):
    try:
        data = json.loads((project / "build.log").read_text(encoding="utf-8").strip().splitlines()[-1])
        return {"costUsd": data.get("total_cost_usd"), "turns": data.get("num_turns")}
    except Exception:
        return {}


def checks(project, python):
    hs = project / ".claude/skills/humanstudy/scripts/build"
    out = {"programComplete": False, "package": None, "readiness": None}
    if not (project / "program.json").is_file():
        return out
    run = lambda *a: subprocess.run([python, *map(str, a)], cwd=str(project), capture_output=True, text=True,
                                    encoding="utf-8", errors="replace")
    out["programComplete"] = "PASS" in run(hs / "check_program.py", "program.json", "--complete").stdout
    try:
        program = json.loads((project / "program.json").read_text(encoding="utf-8"))
        out["studies"] = len(program.get("studies", []))
        for i in program.get("issues", []):
            key = "issues_" + str(i.get("severity", "other"))
            out[key] = out.get(key, 0) + 1
    except Exception:
        pass
    report = project / ".humanstudy" / "quote-check.json"
    report.parent.mkdir(exist_ok=True)
    run(hs / "check_quotes.py", "program.json", "--json", report)
    try:
        q = json.loads(report.read_text(encoding="utf-8"))
        out.update({"quotes_" + k: v for k, v in q["counts"].items()})
        out["unnamedStudies"] = " ".join(q.get("unnamedStudies") or [])
    except Exception:
        pass
    pkgs = sorted(p for p in (project / "package").glob("*") if p.is_dir()) if (project / "package").is_dir() else []
    if pkgs:
        out["package"] = "PASS package checks" in run(hs / "check_package.py", pkgs[0]).stdout
        try:
            out["readiness"] = json.loads((pkgs[0] / "study.json").read_text(encoding="utf-8"))["readiness"]["status"]
        except Exception:
            pass
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdfs", required=True, help="a folder of PDFs (searched recursively) or one PDF")
    ap.add_argument("--work", required=True)
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--agent", choices=["claude", "codex"], default="claude")
    ap.add_argument("--model", default=None, help="default: sonnet for claude, the CLI default for codex")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--timeout", type=int, default=3600, help="seconds per paper")
    ap.add_argument("--rebuild", action="store_true", help="rebuild papers that already passed")
    ap.add_argument("--python", default=sys.executable, help="Python with pypdf, for the checks")
    a = ap.parse_args(argv)
    model = a.model or ("sonnet" if a.agent == "claude" else None)
    src = Path(a.pdfs)
    pdfs = [src] if src.is_file() else sorted(p for p in src.rglob("*") if p.suffix.lower() == ".pdf")
    pdfs = pdfs[:a.limit] if a.limit else pdfs
    if not pdfs:
        print("no PDFs found in %s" % src, file=sys.stderr)
        return 1
    if not shutil.which(a.agent):
        print("the %s CLI is not on PATH" % a.agent, file=sys.stderr)
        return 1
    work = Path(a.work).resolve()
    work.mkdir(parents=True, exist_ok=True)
    skill = work / "_skill/humanstudy"
    shutil.rmtree(skill, ignore_errors=True)
    subprocess.run([sys.executable, str(REPO / "scripts/build_standalone_skill.py"), "--out", str(skill)],
                   check=True, capture_output=True)
    env = dict(os.environ, PATH=str(Path(a.python).parent) + os.pathsep + os.environ.get("PATH", ""))
    names, rows = {}, []
    for pdf in pdfs:  # unique project names even when two PDFs share a file name
        base = slug(pdf.name)
        name, k = base, 2
        while name in names.values():
            name, k = "%s-%d" % (base, k), k + 1
        names[pdf] = name

    def one(pdf):
        project = work / names[pdf]
        row = {"paper": str(pdf), "project": names[pdf]}
        done = (project / "program.json").is_file() and checks(project, a.python)["programComplete"]
        if done and not a.rebuild:
            row["skipped"] = "already built"
        else:
            setup(pdf, project, skill)
            row.update(build(project, a.agent, model, env, a.timeout))
        row.update(usage(project))
        row.update(checks(project, a.python))
        return row

    with ThreadPoolExecutor(a.jobs) as pool:
        futures = [pool.submit(one, p) for p in pdfs]
        for i, f in enumerate(as_completed(futures), 1):
            row = f.result()
            rows.append(row)
            print("[%d/%d] %s: %s, program %s, package %s, %s" % (
                i, len(pdfs), row["project"], row.get("skipped") or "%s min" % row.get("minutes"),
                "PASS" if row.get("programComplete") else "FAIL", row.get("package"), row.get("readiness")), flush=True)
    rows.sort(key=lambda r: r["project"])
    (work / "results.json").write_text(json.dumps({"agent": a.agent, "model": model, "rows": rows}, indent=2) + "\n",
                                       encoding="utf-8")
    keys = []
    for r in rows:
        keys += [k for k in r if k not in keys]
    with open(work / "results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)
    ok = sum(1 for r in rows if r.get("programComplete"))
    cost = sum(r.get("costUsd") or 0 for r in rows)
    print("%d/%d papers built with a passing program; cost $%.2f; results in %s" % (ok, len(rows), cost,
                                                                                   work / "results.csv"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
