#!/usr/bin/env python3
"""Run the project's protocol.json with AI participants in the desktop app: answers = f(state), where f is the
app's model behind the approved-run relay. App-owned (run_study.py, fspec.py and render.py beside it are vendored
from the sandbox; this file is not).

    python .opencode/skills/run/app_run.py new artifacts/simulations/<stamp> --per-arm N --protocol-hash <sha256>
           [--arms a,b] [--seeds 1] [--temperature 1.0]
    python .opencode/skills/simulate/run_confined.py artifacts/simulations/<stamp>/run.py --trial
    python .opencode/skills/simulate/simkit.py start artifacts/simulations/<stamp>

`new` writes plan.json and a fixed run.py into the run folder. run.py (launched through run_confined.py, so on
macOS it runs in the sandbox and reaches the model only through the relay) plays every participant with
run_study.run(), writes run.json, progress.json (the Simulation tab reads it), records.jsonl, operator.jsonl,
effects.json, then results.html (human vs AI per effect, an offline report) and summary.json. STOP in the run
folder stops it; starting it again resumes. `--trial` plays one participant per arm into <run>/trial/.

f: the default renderer of skills/run (render.render_state) and make_chat_f, one fresh model call per page,
JSON answers, the model and temperature recorded in run.json. Keys never reach this process: humanstudy_llm reads
the relay's per-run capability from the environment run_confined.py sets.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

RUN_PY = '''"""Protocol run (written by .opencode/skills/run/app_run.py new; do not edit). Launch it through
.opencode/skills/simulate/run_confined.py or simkit.py start."""
import sys
from pathlib import Path

RUN = Path(__file__).resolve().parent
PROJECT = RUN.parents[2]
sys.path.insert(0, str(PROJECT / ".opencode" / "skills" / "run"))
import app_run  # noqa: E402

app_run.main_run(RUN, PROJECT, trial="--trial" in sys.argv)
'''


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def project_of(run_dir: Path) -> Path:
    run_dir = run_dir.resolve()
    if run_dir.parent.name != "simulations" or run_dir.parents[1].name != "artifacts":
        raise SystemExit("the run folder must be artifacts/simulations/<stamp>/ inside the project")
    return run_dir.parents[2]


def new(run_dir: Path, per_arm: int, protocol_hash: str, arms: list[str] | None, seeds: list[int],
        temperature: float) -> dict:
    project = project_of(run_dir)
    protocol = project / "protocol.json"
    if not protocol.is_file():
        raise SystemExit("this project has no protocol.json")
    if sha256(protocol) != protocol_hash:
        raise SystemExit("protocol.json changed after approval: ask the researcher to press Run simulation again")
    if not 1 <= per_arm <= 60:
        raise SystemExit("--per-arm must be 1 to 60 (the approved plan)")
    run_dir.mkdir(parents=True, exist_ok=True)
    plan = {"route": "protocol", "protocolSha256": protocol_hash, "perArm": per_arm, "arms": arms, "seeds": seeds,
            "temperature": temperature}
    (run_dir / "plan.json").write_text(json.dumps(plan, indent=1) + "\n", encoding="utf-8")
    (run_dir / "run.py").write_text(RUN_PY, encoding="utf-8")
    return plan


def relay_complete(temperature: float):
    """complete(messages) -> text through the app's model client (relay on macOS; never a key in this process)."""
    from humanstudy_llm import chat

    def complete(messages):
        return chat(messages, temperature=temperature)
    return complete


def main_run(run_dir: Path, project: Path, trial: bool = False, complete=None, model: str | None = None) -> dict:
    """Play the approved plan. `complete` (messages -> text) and `model` replace the app's model client in tests."""
    import run_study
    from render import make_chat_f, render_state
    plan = json.loads((run_dir / "plan.json").read_text(encoding="utf-8"))
    if sha256(project / "protocol.json") != plan["protocolSha256"]:
        raise SystemExit("protocol.json changed after approval: ask the researcher to press Run simulation again")
    if complete is None:
        from humanstudy_llm import model_name
        complete, model = relay_complete(plan.get("temperature", 1.0)), model_name()
    f = make_chat_f(complete, render=render_state)
    spec = {"kind": "llm", "name": "desktop model", "model": model or "unknown", "renderer": "default",
            "temperature": plan.get("temperature", 1.0), "retries": 2,
            "host": "the desktop app's model relay (humanstudy_llm), passed in-process"}
    out = run_dir / "trial" if trial else run_dir
    meta = run_study.run(project, spec, n=1 if trial else int(plan["perArm"]), seeds=[1] if trial else plan["seeds"],
                         out=out, host_f=f, arms=plan.get("arms"), quiet=True, baseline=not trial)
    if trial or meta.get("status") != "done":
        print(json.dumps({"status": meta.get("status"), "participants": meta.get("participants"),
                          "calls": meta.get("calls")}, default=str))
        return meta
    import protocol_report
    protocol_report.build(run_dir, project)
    return meta


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new", help="write plan.json and run.py into a new run folder")
    n.add_argument("run_dir")
    n.add_argument("--per-arm", type=int, required=True)
    n.add_argument("--protocol-hash", required=True, help="protocolHash from the researcher's approval")
    n.add_argument("--arms", help="comma-separated arm ids (default: every runnable arm)")
    n.add_argument("--seeds", default="1")
    n.add_argument("--temperature", type=float, default=1.0)
    a = ap.parse_args(argv)
    plan = new(Path(a.run_dir), a.per_arm, a.protocol_hash, a.arms.split(",") if a.arms else None,
               [int(x) for x in a.seeds.split(",")], a.temperature)
    print("ready: %s (%s per arm). Trial: run_confined.py %s/run.py --trial; then simkit.py start %s"
          % (a.run_dir, plan["perArm"], a.run_dir, a.run_dir))


if __name__ == "__main__":
    main()
