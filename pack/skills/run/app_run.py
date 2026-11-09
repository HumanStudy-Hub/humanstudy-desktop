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


class Refused(SystemExit):
    pass


def binding() -> dict:
    """What the app's run capability allows (run_confined.py sets it from the relay descriptor the app wrote):
    route, run id and the SHA-256 of protocol.json the app read at approval. Empty without a relay (Linux,
    Windows): only plan.json's hash is checked there."""
    import os
    out = {k: os.environ[v] for k, v in (("route", "HUMANSTUDY_RUN_ROUTE"), ("runId", "HUMANSTUDY_RUN_ID"),
                                         ("protocolSha256", "HUMANSTUDY_RUN_PROTOCOL_SHA256")) if os.environ.get(v)}
    if os.environ.get("HUMANSTUDY_RUN_APPROVED_AT", "").isdigit():
        out["approvedAt"] = int(os.environ["HUMANSTUDY_RUN_APPROVED_AT"]) / 1000   # epoch seconds
    return out


def check_approval(run_dir: Path, project: Path, plan: dict, bound: dict) -> str:
    """-> the protocol's SHA-256, after checking the plan, the file and the app's binding agree (review 2, S6)."""
    actual = sha256(project / "protocol.json")
    if actual != plan.get("protocolSha256"):
        raise Refused("protocol.json changed after approval: ask the researcher to press Run simulation again")
    if bound:
        if bound.get("route") != "protocol":
            raise Refused("this run was approved for the package, not for protocol.json")
        if bound.get("protocolSha256") != actual:
            raise Refused("this run's approval is for another version of protocol.json: ask the researcher to press "
                          "Run simulation again")
    return actual


def check_not_stopped(run_dir: Path, plan: dict, bound: dict) -> None:
    """A stopped run starts again only under an approval given after the stop (the app records when it approved),
    and the restart is recorded in plan.json, never silent (review 2, S7)."""
    import calendar
    import time
    stop = run_dir / "STOP"
    stopped_at = None
    if stop.exists():
        stopped_at = stop.stat().st_mtime
    try:
        progress = json.loads((run_dir / "progress.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        progress = {}
    if progress.get("stage") == "stopped":
        try:
            at = calendar.timegm(time.strptime(str(progress.get("updatedAt"))[:19], "%Y-%m-%dT%H:%M:%S"))
        except ValueError:
            at = time.time()   # unknown: as if just now, so only a later approval counts
        stopped_at = max(stopped_at or 0, at)
    if stopped_at is None:
        return
    fresh = bound.get("runId") and bound["runId"] not in (plan.get("runIds") or []) and \
        isinstance(bound.get("approvedAt"), float) and bound["approvedAt"] > stopped_at
    if not fresh:
        raise Refused("the researcher stopped this run: it starts again only after a new Run simulation approval")
    plan.setdefault("resumedAfterStop", []).append({"runId": bound["runId"], "at": run_study_now(),
                                                    "stopFile": stop.exists(), "stage": progress.get("stage")})
    stop.unlink(missing_ok=True)
    print("resuming a stopped run under a new approval (%s)" % bound["runId"])


def run_study_now() -> str:
    import time
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def outcome(run_dir: Path, meta: dict) -> dict:
    """Valid participants (finished by the protocol, no failed model call) against the plan."""
    planned = int(meta.get("participants_planned") or 0)
    valid, failed_calls, cap = 0, 0, False
    path = run_dir / "operator.jsonl"
    for line in path.read_text(encoding="utf-8").splitlines() if path.exists() else []:
        if not line.strip():
            continue
        r = json.loads(line)
        errs = r.get("f_errors") or []
        failed_calls += len(errs)
        text = json.dumps(errs) + str(r.get("error") or "")
        cap = cap or "token cap" in text.lower() or "402" in text
        if r.get("status") not in (None, "incomplete") and not r.get("error") and not errs:
            valid += 1
    return {"planned": planned, "valid": valid, "failed_calls": failed_calls, "token_cap": cap,
            "complete": planned > 0 and valid >= planned and failed_calls == 0}


def write_progress(run_dir: Path, stage: str, message: str) -> None:
    path = run_dir / "progress.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {"done": 0, "total": 0, "failed": 0, "conditions": []}
    data.update(stage=stage, message=message[:400], updatedAt=run_study_now(), runner="exited")
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    tmp.replace(path)


def main_run(run_dir: Path, project: Path, trial: bool = False, complete=None, model: str | None = None) -> dict:
    """Play the approved plan. `complete` (messages -> text) and `model` replace the app's model client in tests.
    A run is `done`, with a results page, only when every planned participant finished without a failed model
    call; otherwise it ends `failed` and any page it writes is labelled partial (review 2, M3)."""
    import run_study
    from render import make_chat_f, render_state
    plan = json.loads((run_dir / "plan.json").read_text(encoding="utf-8"))
    bound = binding()
    check_approval(run_dir, project, plan, bound)
    out = run_dir / "trial" if trial else run_dir
    if not trial:
        check_not_stopped(run_dir, plan, bound)
        if bound.get("runId") and bound["runId"] not in (plan.get("runIds") or []):
            plan.setdefault("runIds", []).append(bound["runId"])
        (run_dir / "plan.json").write_text(json.dumps(plan, indent=1) + "\n", encoding="utf-8")
    if complete is None:
        from humanstudy_llm import model_name
        complete, model = relay_complete(plan.get("temperature", 1.0)), model_name()
    f = make_chat_f(complete, render=render_state)
    # retries 0: humanstudy_llm already retries 429/5xx; a call that still fails (a refusal, the token cap) ends
    # that participant as incomplete instead of being asked again.
    spec = {"kind": "llm", "name": "desktop model", "model": model or "unknown", "renderer": "default",
            "temperature": plan.get("temperature", 1.0), "retries": 0,
            "host": "the desktop app's model relay (humanstudy_llm), passed in-process"}
    # The floor baseline's cache stays inside this run folder (run_study keeps it beside the run folders, which the
    # macOS sandbox does not let the run write, and which the Simulation tab would list as a run).
    original_cache = run_study.baseline_cached
    run_study.baseline_cached = lambda E, protocol, plan_, run_dir_, mf: original_cache(E, protocol, plan_, Path(run_dir_) / "baseline", mf)
    try:
        meta = run_study.run(project, spec, n=1 if trial else int(plan["perArm"]), seeds=[1] if trial else plan["seeds"],
                             out=out, host_f=f, arms=plan.get("arms"), quiet=True, baseline=not trial,
                             top_up=False)   # exactly the approved n: no extra sessions beyond the measured budget
    finally:
        run_study.baseline_cached = original_cache
    if meta.get("status") != "done":
        print(json.dumps({"status": meta.get("status"), "participants": meta.get("participants")}, default=str))
        return meta
    result = outcome(out, meta)
    meta["app"] = {"route": "protocol", "runId": bound.get("runId"), **result}
    if not result["complete"]:
        meta["status"] = "partial"
    (out / "run.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    if trial:
        print(json.dumps({"status": meta["status"], **result}))
        return meta
    import protocol_report
    protocol_report.build(run_dir, project, partial=not result["complete"])
    if not result["complete"]:
        why = ("the run reached its approved token budget" if result["token_cap"] else
               "%d model call(s) failed" % result["failed_calls"] if result["failed_calls"] else
               "some participants did not finish")
        write_progress(run_dir, "failed", "Partial run: %d of %d planned participants finished; %s. The results page "
                       "is labelled partial." % (result["valid"], result["planned"], why))
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
