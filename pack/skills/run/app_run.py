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
import os
import re
import sys
import time
from pathlib import Path

# Never the engine's private sidecar in a desktop run, on any platform or path (before any hsenv import).
os.environ["HSENV_PRIVATE_CONFIG"] = ""
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


PLAN_KEYS = ("route", "protocolSha256", "perArm", "arms", "seeds", "temperature")


def approved_plan(run_dir: Path) -> dict:
    """The plan to play. When the app started the run it hands over the approved plan itself (HUMANSTUDY_RUN_PLAN,
    set by the main process from the approval it checked): that is what runs, and plan.json in the run folder, which
    any process of the user can rewrite, must say exactly the same or the run is refused (review 5, M1). Without
    it (the agent path on Linux/Windows) plan.json is the plan."""
    on_disk = json.loads((run_dir / "plan.json").read_text(encoding="utf-8"))
    given = os.environ.get("HUMANSTUDY_RUN_PLAN")
    if not given:
        return on_disk
    try:
        approved = json.loads(given)
    except ValueError:
        raise Refused("the app's approved plan is unreadable: the run was not started")
    if any(on_disk.get(k) != approved.get(k) for k in PLAN_KEYS):
        raise Refused("plan.json in the run folder is not the approved plan (it was changed after the app wrote it): "
                      "the run was not started")
    return {**on_disk, **{k: approved.get(k) for k in PLAN_KEYS}}


def check_approval(run_dir: Path, project: Path, plan: dict, bound: dict) -> str:
    """-> the protocol's SHA-256, after checking the plan, the file and the app's binding agree (review 2, S6)."""
    actual = sha256(project / "protocol.json")
    if actual != plan.get("protocolSha256"):
        raise Refused("protocol.json changed after approval: ask the researcher to press Run simulation again")
    if bound and (project / "variant.json").exists():
        raise Refused("this project holds a variant (variant.json), which is not part of the approval: not run")
    if bound:
        if bound.get("route") != "protocol":
            raise Refused("this run was approved for the package, not for protocol.json")
        if bound.get("protocolSha256") != actual:
            raise Refused("this run's approval is for another version of protocol.json: ask the researcher to press "
                          "Run simulation again")
    return actual


def stopped_at(run_dir: Path) -> float | None:
    """When the researcher stopped this run (STOP, or progress `stopped`), in epoch seconds; None if not stopped."""
    import calendar
    stop = run_dir / "STOP"
    at = stop.stat().st_mtime if stop.exists() else None
    try:
        progress = json.loads((run_dir / "progress.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        progress = {}
    if progress.get("stage") == "stopped":
        # When the researcher asked (review 4, M1), not when the stopped process got round to writing `stopped`:
        # a resume approved in between must not be taken for an approval given before the stop.
        if isinstance(progress.get("stopRequestedAt"), (int, float)) and not isinstance(progress.get("stopRequestedAt"), bool):
            p_at = float(progress["stopRequestedAt"])
        else:
            try:
                p_at = calendar.timegm(time.strptime(str(progress.get("updatedAt"))[:19], "%Y-%m-%dT%H:%M:%S"))
            except ValueError:
                p_at = time.time()   # unknown: as if just now, so only a later approval counts
        at = p_at if at is None else max(at, p_at)   # the latest request: a second Stop after a resume counts
    return at


def fresh_after_stop(plan: dict, bound: dict, at: float) -> bool:
    return bool(bound.get("runId")) and bound["runId"] not in (plan.get("runIds") or []) and \
        isinstance(bound.get("approvedAt"), float) and bound["approvedAt"] > at


def check_not_stopped(run_dir: Path, plan: dict, bound: dict) -> None:
    """A stopped run starts again only under an approval given after the stop (the app records when it approved),
    and the restart is recorded in plan.json, never silent (review 2, S7). Call it holding the run lock."""
    at = stopped_at(run_dir)
    if at is None:
        return
    if not fresh_after_stop(plan, bound, at):
        raise Refused("the researcher stopped this run: it starts again only after a new Run simulation approval")
    stop = run_dir / "STOP"
    plan.setdefault("resumedAfterStop", []).append({"runId": bound["runId"], "at": run_study_now(),
                                                    "stopFile": stop.exists()})
    stop.unlink(missing_ok=True)
    print("resuming a stopped run under a new approval (%s)" % bound["runId"])


class RunLock:
    """One runner per run folder (review 3, S2): an OS lock on <run>/run.lock, held for the life of the process
    (released when it exits, however it exits), with its pid and start time written in for people. A second
    start refuses while the first lives; `wait` seconds lets a resume wait for a stopped run's process to end."""

    def __init__(self, run_dir: Path, wait: float = 0):
        self.path, self.wait, self.fh = run_dir / "run.lock", wait, None

    def _try(self) -> bool:
        try:
            import fcntl
            try:
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except OSError:
                return False
        except ImportError:   # Windows
            import msvcrt
            try:
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
                return True
            except OSError:
                return False

    def __enter__(self):
        self.fh = open(self.path, "a+", encoding="utf-8")
        deadline = time.time() + self.wait
        while not self._try():
            if time.time() >= deadline:
                try:   # Windows enforces the lock on reads too
                    self.fh.seek(0)
                    holder = json.loads(self.fh.read() or "{}")
                except (OSError, ValueError):
                    holder = {}
                self.fh.close()
                who = "process %s, started %s" % (holder.get("pid"), holder.get("startedAt")) if holder.get("pid") else "another process"
                raise Refused("this run is still running (%s): it was not started again. Wait for it to end, or "
                              "press Stop first." % who)
            time.sleep(0.5)
        self.fh.seek(0)
        self.fh.truncate()
        self.fh.write(json.dumps({"pid": os.getpid(), "startedAt": run_study_now()}))
        self.fh.flush()
        return self

    def __exit__(self, *exc):
        try:
            self.fh.seek(0)
            self.fh.truncate()
        finally:
            self.fh.close()   # closing releases the lock
        return False


def run_study_now() -> str:
    import time
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


# The relay refuses a call over the cap with HTTP 402 "Run token cap reached."; humanstudy_llm reports "HTTP 402: …".
TOKEN_CAP = re.compile(r"\bHTTP 402\b|\btoken cap\b", re.I)


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
        cap = cap or bool(TOKEN_CAP.search(text))
        if r.get("status") not in (None, "incomplete") and not r.get("error") and not errs:
            valid += 1
    return {"planned": planned, "valid": valid, "failed_calls": failed_calls, "token_cap": cap,
            "complete": planned > 0 and valid >= planned and failed_calls == 0}


# What the Simulation tab shows from progress.json, in the app's language (HUMANSTUDY_LANG, set by the app).
MSG = {
    "en": {"stopped": "Stopped by the researcher: {done} of {planned} planned participants finished; {partial} in "
                      "progress are recorded as partial (partial.jsonl). No comparison is drawn from a stopped run.",
           "changed": "protocol.json changed, or a variant appeared, while the run started; nothing from this run is "
                      "reported. Press Run simulation again.",
           "finished": "{done} of {planned} planned participants finished",
           "trial": "Trial: {finished}",
           "cap": "the run reached its approved token budget", "calls": "{n} model call(s) failed",
           "unfinished": "some participants did not finish",
           "partial": "Partial run: {finished}; {why}. The results page is labelled partial. Press Run simulation to run it again.",
           "page_failed": "{before} The results page could not be written: {error}",
           "ran": "The run finished ({finished}).", "done": "{finished}; {calls} model calls.",
           "text_missing": "This study's original wording has not been filled in on this computer yet, so it was not "
                           "run (AI participants would have seen \"[text not available]\"). Ask the agent what is "
                           "missing, then press Run simulation again.",
           "text_other": "The original wording filled in on this computer belongs to another version of this study, "
                         "so it was not run. Press Run simulation again."},
    "zh": {"stopped": "已由研究者停止：计划 {planned} 名参与者中完成了 {done} 名；{partial} 名进行中的记为部分完成"
                      "（partial.jsonl）。已停止的运行不做比较。",
           "changed": "运行开始时 protocol.json 被改动，或出现了变体；本次运行不报告任何结果。请重新点击“运行模拟”。",
           "finished": "计划 {planned} 名参与者中完成了 {done} 名",
           "trial": "试运行：{finished}",
           "cap": "运行用完了批准的模型用量", "calls": "{n} 次模型调用失败",
           "unfinished": "有参与者没有完成",
           "partial": "部分运行：{finished}；{why}。结果页标为部分运行。点击“运行模拟”可重新运行。",
           "page_failed": "{before}结果页无法生成：{error}",
           "ran": "运行已完成（{finished}）。", "done": "{finished}；{calls} 次模型调用。",
           "text_missing": "这项研究的原始措辞还没有在这台电脑上补全，因此没有运行（否则 AI 参与者会看到“[文字不可用]”）。"
                           "请问助手还缺什么，补全后再点击“运行模拟”。",
           "text_other": "这台电脑上补全的原始措辞属于这项研究的另一个版本，因此没有运行。请重新点击“运行模拟”。"},
}


def msg(key: str, **kw) -> str:
    lang = "zh" if os.environ.get("HUMANSTUDY_LANG", "").lower().startswith("zh") else "en"
    return MSG[lang][key].format(**kw)


def write_progress(run_dir: Path, stage: str, message: str, **extra) -> None:
    path = run_dir / "progress.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {"done": 0, "total": 0, "failed": 0, "conditions": []}
    data.update(stage=stage, message=message[:400], updatedAt=run_study_now(), runner="exited", **extra)
    if stage != "stopped":
        data.pop("stopRequestedAt", None)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=1), encoding="utf-8")
    tmp.replace(path)


def stopped(run_dir: Path, meta: dict, bound: dict) -> dict:
    """The researcher stopped the run (the app closed its model access at the same moment): record what finished
    and, as partial, every participant that was in progress, and end with stage `stopped`. No comparison is drawn
    from a stopped run."""
    def keys(name, who):
        path = run_dir / name
        out = {}
        for line in path.read_text(encoding="utf-8").splitlines() if path.exists() else []:
            try:
                r = json.loads(line)
            except ValueError:
                continue   # a line cut off by the stop
            k = (r.get("seed"), r.get(who), r.get("member"))
            out[k] = out.get(k, 0) + 1
        return out
    finished = keys("operator.jsonl", "opaque_id")
    in_flight = {k: n for k, n in keys("steps.jsonl", "participant").items() if k not in finished}
    with (run_dir / "partial.jsonl").open("w", encoding="utf-8") as fh:
        for (seed, opaque, member), steps in sorted(in_flight.items(), key=str):
            fh.write(json.dumps({"seed": seed, "opaque_id": opaque, "member": member, "status": "partial",
                                 "steps_logged": steps, "why": "stopped by the researcher"}) + "\n")
    result = outcome(run_dir, meta)
    meta["app"] = {"route": "protocol", "runId": bound.get("runId"), **result, "stopped": True, "partial": len(in_flight)}
    (run_dir / "run.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    stop = run_dir / "STOP"
    write_progress(run_dir, "stopped", msg("stopped", done=result["valid"], planned=result["planned"], partial=len(in_flight)),
                   # when the researcher asked, so a resume approved since then is not mistaken for an earlier one
                   stopRequestedAt=stop.stat().st_mtime if stop.exists() else time.time())
    print(json.dumps({"status": "stopped", "app": meta["app"]}))
    return meta


PLACEHOLDER = "\u2591"   # hsenv.distribution.PLACEHOLDER: one per character of a held text in a published study


def _pointer_parts(path: str) -> list:
    return [p.replace("~1", "/").replace("~0", "~") for p in path.split("/")[1:]]


def _put(doc, path: str, value) -> None:
    *parents, last = _pointer_parts(path)
    for p in parents:
        doc = doc[int(p)] if isinstance(doc, list) else doc[p]
    if isinstance(doc, list):
        doc[int(last)] = value
    else:
        doc[last] = value


def _get(doc, path: str):
    for p in _pointer_parts(path):
        doc = doc[int(p)] if isinstance(doc, list) else doc[p]
    return doc


def matches_projection(projection: dict, restored: dict) -> bool:
    """True when `restored` is exactly `projection` with every held text filled in: each held slot holds the text
    whose sha256 the published study recorded (hsenv's own per-item check), no placeholder is left anywhere, and
    putting the placeholders back gives the published study unchanged. A held picture is not supported (the app
    does not restore pictures yet), so a study holding one never matches."""
    from hsenv import distribution as D
    if not isinstance(restored, dict) or "distribution" in restored or PLACEHOLDER in json.dumps(restored, ensure_ascii=False):
        return False
    held = projection["distribution"]["held"]
    a = json.loads(json.dumps({k: v for k, v in projection.items() if k != "distribution"}))
    b = json.loads(json.dumps(restored))
    try:
        for h in held.values():
            if h.get("kind") == "image":
                return False
            text = _get(b, h["path"])
            if not isinstance(text, str) or D.text_sha256(text) != h["text_sha256"]:
                return False
            _put(b, h["path"], PLACEHOLDER * int(h["length"]))
    except (KeyError, IndexError, ValueError, TypeError, AttributeError):
        return False
    return a == b


def restored_protocol(project: Path) -> dict | None:
    """The protocol to play when protocol.json is a published study whose original wording is held back (its
    `distribution.held` lists placeholders): the restored copy the app filled in on this computer and handed to
    this run (HUMANSTUDY_RUN_RESTORED, in the app's own code folder, never the project). None for an ordinary
    protocol.json. A published study without that copy is never played: its screens would show placeholders.
    The copy is read from the app's code folder next to this file (<code>/restored/protocol.json), never from the
    environment; and whatever its origin, every held text must hash to the value the published study recorded,
    so a copy written by anyone else can never put other wording on a screen."""
    projection = json.loads((project / "protocol.json").read_text(encoding="utf-8"))
    dist = projection.get("distribution") if isinstance(projection, dict) else None
    if not (isinstance(dist, dict) and isinstance(dist.get("held"), dict) and dist["held"]):
        return None
    given = HERE.parents[1] / "restored" / "protocol.json"
    if not given.is_file():
        raise Refused(msg("text_missing"))
    restored = json.loads(given.read_text(encoding="utf-8"))
    if not matches_projection(projection, restored):
        raise Refused(msg("text_other"))
    return restored


def main_run(run_dir: Path, project: Path, trial: bool = False, complete=None, model: str | None = None) -> dict:
    """Play the approved plan. `complete` (messages -> text) and `model` replace the app's model client in tests.
    A run is `done`, with a results page, only when every planned participant finished without a failed model
    call; otherwise it ends `failed` and any page it writes is labelled partial (review 2, M3)."""
    plan = approved_plan(run_dir)
    bound = binding()
    check_approval(run_dir, project, plan, bound)
    at = None if trial else stopped_at(run_dir)
    if at is not None and not fresh_after_stop(plan, bound, at):
        raise Refused("the researcher stopped this run: it starts again only after a new Run simulation approval")
    # A resume after Stop waits for the stopped process to end (it stops after the pages in flight).
    with RunLock(run_dir, wait=120 if at is not None else 0):
        return _main_run(run_dir, project, plan, bound, trial, complete, model)


def _main_run(run_dir, project, plan, bound, trial, complete, model):
    import run_study
    from render import make_chat_f, render_state
    restored = restored_protocol(project)
    out = run_dir / "trial" if trial else run_dir
    if not trial:
        check_not_stopped(run_dir, plan, bound)
        if bound.get("runId") and bound["runId"] not in (plan.get("runIds") or []):
            plan.setdefault("runIds", []).append(bound["runId"])
        record = json.loads((run_dir / "plan.json").read_text(encoding="utf-8"))
        record.update({k: plan[k] for k in ("runIds", "resumedAfterStop") if k in plan})
        (run_dir / "plan.json").write_text(json.dumps(record, indent=1) + "\n", encoding="utf-8")
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
    original_cache, original_stage = run_study.baseline_cached, run_study.Progress.stage
    original_load = run_study.load_protocol
    run_study.baseline_cached = lambda E, protocol, plan_, run_dir_, mf: original_cache(E, protocol, plan_, Path(run_dir_) / "baseline", mf)
    if restored is not None:
        # A published study: the engine plays the copy restored on this computer. Its recorded hash stays that of
        # protocol.json as approved (the published version), which the checks below and the results page compare.
        def load_restored(arg):
            protocol, psha, sdir, variant = original_load(arg)
            return run_study.Protocol(restored, protocol.root), psha, sdir, variant
        run_study.load_protocol = load_restored
    # The app, not run_study, says when a run is done: only after it is judged complete and its page is written
    # (review 3, S6), so a partial run is never shown as done, not even for a moment.
    run_study.Progress.stage = lambda self, name, message=None: original_stage(self, "writing" if name == "done" else name, message)
    try:
        meta = run_study.run(project, spec, n=1 if trial else int(plan["perArm"]), seeds=[1] if trial else plan["seeds"],
                             out=out, host_f=f, arms=plan.get("arms"), quiet=True, baseline=not trial,
                             top_up=False,   # exactly the approved n: no extra sessions beyond the measured budget
                             # a restored study's wording stays out of the project: records keep answers, no screens
                             **({"states": "none"} if restored is not None else {}))
    finally:
        run_study.baseline_cached, run_study.Progress.stage = original_cache, original_stage
        run_study.load_protocol = original_load
    # The protocol the engine actually loaded must be the approved one: run_study reads protocol.json again after
    # check_approval hashed it (review 5, S3).
    if meta.get("protocol_sha256") != plan.get("protocolSha256") or (bound and meta.get("variant") is not None):
        # a variant.json that appeared after check_approval leaves protocol.json's hash unchanged (review 6, S2)
        write_progress(out, "failed", msg("changed"))
        raise Refused("protocol.json changed while the run started" if meta.get("protocol_sha256") != plan.get("protocolSha256")
                      else "a variant (variant.json) appeared while the run started")
    if meta.get("status") == "stopped" and not trial:
        return stopped(run_dir, meta, bound)
    if meta.get("status") != "done":
        print(json.dumps({"status": meta.get("status"), "participants": meta.get("participants")}, default=str))
        return meta
    result = outcome(out, meta)
    meta["app"] = {"route": "protocol", "runId": bound.get("runId"), **result}
    if not result["complete"]:
        meta["status"] = "partial"
    (out / "run.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    finished = msg("finished", done=result["valid"], planned=result["planned"])
    if trial:
        write_progress(out, "done" if result["complete"] else "failed", msg("trial", finished=finished))
        print(json.dumps({"status": meta["status"], **result}))
        return meta
    if not result["complete"]:
        why = (msg("cap") if result["token_cap"] else
               msg("calls", n=result["failed_calls"]) if result["failed_calls"] else msg("unfinished"))
        message = msg("partial", finished=finished, why=why)
        write_progress(run_dir, "failed", message)   # before the page: never `done`, whatever happens next
    import protocol_report
    try:
        protocol_report.build(run_dir, project, partial=not result["complete"])
    except BaseException as e:   # noqa: BLE001 — the run's data is kept; the stage says what is missing
        write_progress(run_dir, "failed", msg("page_failed", before=message if not result["complete"] else msg("ran", finished=finished),
                                              error=str(e)[:200]))
        raise
    if result["complete"]:
        write_progress(run_dir, "done", msg("done", finished=finished, calls=meta.get("calls", 0)))
    return meta


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    n = sub.add_parser("new", help="write plan.json and run.py into a new run folder (Linux/Windows agent path)")
    n.add_argument("run_dir")
    n.add_argument("--per-arm", type=int, required=True)
    n.add_argument("--protocol-hash", required=True, help="protocolHash from the researcher's approval")
    n.add_argument("--arms", help="comma-separated arm ids (default: every runnable arm)")
    n.add_argument("--seeds", default="1")
    n.add_argument("--temperature", type=float, default=1.0)
    r = sub.add_parser("run", help="play the approved plan (the app starts this from its trusted copy)")
    r.add_argument("run_dir")
    r.add_argument("project")
    a = ap.parse_args(argv)
    if a.cmd == "run":
        meta = main_run(Path(a.run_dir).resolve(), Path(a.project).resolve())
        print(json.dumps({"status": meta.get("status"), "app": meta.get("app")}, default=str))
        return
    plan = new(Path(a.run_dir), a.per_arm, a.protocol_hash, a.arms.split(",") if a.arms else None,
               [int(x) for x in a.seeds.split(",")], a.temperature)
    print("ready: %s (%s per arm). Trial: run_confined.py %s/run.py --trial; then simkit.py start %s"
          % (a.run_dir, plan["perArm"], a.run_dir, a.run_dir))


if __name__ == "__main__":
    main()
