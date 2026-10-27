#!/usr/bin/env python3
"""Replay a study with AI participants and compare it with the human data and the paper.

    python eval/replay/compare.py <project> [--cli "claude -p --model haiku"] [--n 10] [--jobs 8]
    python eval/replay/compare.py <project> --human-only

<project> is a built project whose package has human/human_sessions.py (see attach_human.py). The
package's own analysis runs three times over the same key effects:

  reported  the paper's numbers (from key_effects)
  human     the original human data, analysed by our package          (does the analysis match the paper?)
  agent     AI participants run through the package                   (does the simulation match the humans?)

Writes <project>/replay-compare.json and .md. Participants answer in parallel when the study's prompts
do not depend on earlier answers; otherwise they run one by one.
"""
import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / "pack/skills/export/agent"))
sys.path.insert(0, str(HERE))
import study_core  # noqa: E402
from attach_human import load_module, package_dir  # noqa: E402

ALPHA = 0.05
# A fresh Claude Code process per participant, with no tools, settings or MCP servers and a plain system
# prompt. Claude Code still adds a short environment note (platform, date); fine for tests, not for papers.
PARTICIPANT = ('claude -p --model haiku --strict-mcp-config --setting-sources "" --tools "" '
               '--system-prompt "You are taking part in a study. Answer as asked."')


def close(a, b):
    """Same quantity up to rounding and small analysis differences."""
    if a is None or b is None:
        return None
    return abs(a - b) <= max(0.05, 0.15 * abs(b))


def agree(x, h):
    """Sign agreement, and agreement on significance where both have p-values."""
    if x.get("estimate") is None or h.get("estimate") is None:
        return None
    same_sign = (x["estimate"] > 0) == (h["estimate"] > 0)
    if x.get("p") is None or h.get("p") is None:
        return same_sign
    return same_sign and ((x["p"] < ALPHA) == (h["p"] < ALPHA))


def run_agents(study, cli, n, jobs, seed):
    llm = study_core.cli_llm(cli)
    try:
        prompts = study.plan(n=n, seed=seed)["prompts"]
    except Exception:
        prompts = None
    if prompts:
        with ThreadPoolExecutor(jobs) as pool:
            replies = list(pool.map(lambda c: _safe(llm, c["prompt"]), prompts))
        try:
            return study.replay(replies, n=n, seed=seed)["sessions"], "parallel"
        except RuntimeError:
            pass  # adaptive prompts: fall back to one by one
    return study.run(lambda p, *a, **k: _safe(llm, p, *a, **k), seed=seed, n=n)["sessions"], "sequential"


def _safe(llm, prompt, *a, **k):
    try:
        return llm(prompt, *a, **k)
    except Exception as e:  # one failed participant is an unreadable reply, not a failed run
        return "ERROR: %s" % e


def table(rows):
    fmt = lambda v: "–" if v is None else ("%.3g" % v if isinstance(v, float) else str(v))
    out = ["| Effect | Reported | Human | Agent | Human≈paper | Agent agrees |", "| --- | --- | --- | --- | --- | --- |"]
    for r in rows:
        mark = lambda b: "–" if b is None else ("✓" if b else "✗")
        out.append("| %s | %s | %s (p %s) | %s (p %s) | %s | %s |" % (
            r["label"], fmt(r["reported"]), fmt(r["human"]), fmt(r["human_p"]), fmt(r["agent"]), fmt(r["agent_p"]),
            mark(r["humanMatchesPaper"]), mark(r["agentAgrees"])))
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project")
    ap.add_argument("--cli", default=PARTICIPANT, help="participant command: prompt on stdin, reply on stdout")
    ap.add_argument("--n", type=int, default=10, help="AI participants per arm")
    ap.add_argument("--jobs", type=int, default=8)
    ap.add_argument("--seed", type=int, default=20261027)
    ap.add_argument("--human-only", action="store_true")
    a = ap.parse_args(argv)
    project = Path(a.project).resolve()
    pkg = package_dir(project)
    study = study_core.Study(str(project))
    human_mod = load_module(pkg / "human/human_sessions.py")
    human_sessions = human_mod.load(str(project / "human-data"))
    human = {e["id"]: e for e in human_mod.key_effects(study.module("evaluation").evaluate(human_sessions))}
    agent, mode, minutes = {}, None, None
    if not a.human_only:
        start = time.time()
        sessions, mode = run_agents(study, a.cli, a.n, a.jobs, a.seed)
        minutes = round((time.time() - start) / 60, 1)
        (project / "replay-sessions.jsonl").write_text("\n".join(json.dumps(s) for s in sessions) + "\n",
                                                     encoding="utf-8")
        agent = {e["id"]: e for e in human_mod.key_effects(study.evaluate(sessions))}
    rows = []
    for eid, h in human.items():
        x = agent.get(eid, {})
        rows.append({"id": eid, "label": h.get("label", eid), "reported": h.get("reported"),
                     "human": h.get("estimate"), "human_p": h.get("p"),
                     "agent": x.get("estimate"), "agent_p": x.get("p"),
                     "humanMatchesPaper": close(h.get("estimate"), h.get("reported")),
                     "agentAgrees": agree(x, h) if x else None})
    count = lambda k: [sum(1 for r in rows if r[k] is True), sum(1 for r in rows if r[k] is not None)]
    result = {"package": pkg.name, "humanSessions": len(human_sessions), "agentN": None if a.human_only else a.n,
              "participantCommand": None if a.human_only else a.cli, "mode": mode, "minutes": minutes,
              "humanMatchesPaper": count("humanMatchesPaper"), "agentAgrees": count("agentAgrees"), "effects": rows,
              "note": "Agent results are a simulation; agreement with people is measured, not assumed."}
    (project / "replay-compare.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    md = ["# %s: replay vs human data" % pkg.name, "",
          "Human sessions: %d. AI participants: %s per arm (%s)." % (len(human_sessions), result["agentN"], a.cli),
          "", table(rows), "",
          "Human data reproduces the paper on %d of %d effects; agents agree with humans on %d of %d." % (
              *result["humanMatchesPaper"], *result["agentAgrees"])]
    (project / "replay-compare.md").write_text("\n".join(md) + "\n", encoding="utf-8")
    print("\n".join(md))
    return 0


if __name__ == "__main__":
    sys.exit(main())
