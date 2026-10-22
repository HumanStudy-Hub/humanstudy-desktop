#!/usr/bin/env python3
"""Run AI participants for a simulation and report progress the app can show.

Used by artifacts/simulations/<run>/run.py (see SKILL.md). Standard library only.

    import sys; sys.path.insert(0, ".opencode/skills/simulate")   # path from the project folder
    from simkit import SimRun
    run = SimRun(RUN_DIR, plan={"harm": 20, "help": 20}, model=model_name(), seed=7)
    run.stage("trial")                               # optional: the two-participant trial
    sessions = run.participants(one_participant)     # parallel, resumable, writes progress.json
    run.stage("scoring"); ...; run.stage("writing"); ...; run.finish()

`one_participant(condition, index, rng)` returns one session dict (it must carry "condition");
it calls the model through the adapter. Sessions are appended to sessions.jsonl as they finish, so an
interrupted run resumes where it stopped (the same participant index is never run twice).

The app reads progress.json:
  {"stage": "preparing|trial|running|scoring|writing|done|failed|stopped",
   "done": 12, "total": 40, "failed": 0,
   "conditions": [{"id": "harm", "done": 6, "total": 20}, ...],
   "model": "...", "startedAt": "...Z", "updatedAt": "...Z", "message": "plain sentence",
   "runner": "alive|exited", "heartbeatAt": "...Z"}
While run.py runs, a background thread refreshes heartbeatAt every HEARTBEAT_SECONDS (also through a
long scoring step), so the app can tell a quiet but live run from one whose process is gone. When
run.py ends normally, runner becomes "exited": the agent is writing the results up.
The researcher's Stop button writes a file named STOP into the run folder; the run then ends after the
participants in flight, with stage "stopped".

Command line (for the agent's shell between steps):
  python .opencode/skills/simulate/simkit.py start <run-dir>      # run.py detached; output in run.log
  python .opencode/skills/simulate/simkit.py stage <run-dir> scoring|writing|done|failed|stopped ["message"]
"""
from __future__ import annotations

import atexit
import json
import os
import random
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable

HEARTBEAT_SECONDS = 15
STAGES = ("preparing", "trial", "running", "scoring", "writing", "done", "failed", "stopped")


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def _write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)  # atomic: the app never reads a half-written file


class Stopped(Exception):
    """The researcher pressed Stop."""


class SimRun:
    def __init__(self, run_dir, plan: dict[str, int], model: str = "", seed: int = 0, workers: int | None = None):
        self.dir = Path(run_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.plan = {str(k): int(v) for k, v in plan.items()}
        self.seed = seed
        self.workers = workers
        self.sessions_path = self.dir / "sessions.jsonl"
        self.progress_path = self.dir / "progress.json"
        self._lock = threading.Lock()
        old = self._read_progress()
        self.progress = {
            "stage": "preparing",
            "done": 0,
            "total": sum(self.plan.values()),
            "failed": 0,
            "conditions": [{"id": c, "done": 0, "total": n} for c, n in self.plan.items()],
            "model": model or old.get("model", ""),
            "startedAt": old.get("startedAt") or _now(),
            "updatedAt": _now(),
            "runner": "alive",
            "pid": os.getpid(),
        }
        self._save()
        self._closed = threading.Event()
        threading.Thread(target=self._heartbeat, name="simkit-heartbeat", daemon=True).start()
        atexit.register(self._exit)
        # An uncaught error anywhere in run.py (the evaluation, a file write) ends the run as "failed"
        # with its reason, so the app never shows a run that silently stopped moving.
        previous = sys.excepthook

        def hook(kind, value, tb):
            if not issubclass(kind, (KeyboardInterrupt, SystemExit)):
                try:
                    self.fail(f"{kind.__name__}: {value}")
                except Exception:
                    pass
            previous(kind, value, tb)

        sys.excepthook = hook

    # -- progress -------------------------------------------------------------------------------
    def _read_progress(self) -> dict:
        try:
            return json.loads(self.progress_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save(self) -> None:
        self.progress["updatedAt"] = self.progress["heartbeatAt"] = _now()
        _write_json(self.progress_path, self.progress)

    def _heartbeat(self) -> None:
        """Liveness only: heartbeatAt moves, updatedAt (the last real progress) does not."""
        while not self._closed.wait(HEARTBEAT_SECONDS):
            with self._lock:
                self.progress["heartbeatAt"] = _now()
                try:
                    _write_json(self.progress_path, self.progress)
                except OSError:
                    return

    def _exit(self) -> None:
        """run.py ended (normally, after an error, or after Stop): no process is behind this run any more."""
        self._closed.set()
        with self._lock:
            self.progress["runner"] = "exited"
            try:
                _write_json(self.progress_path, self.progress)
            except OSError:
                pass

    def stage(self, name: str, message: str | None = None) -> None:
        if name not in STAGES:
            raise ValueError(f"unknown stage {name!r}; use one of {STAGES}")
        with self._lock:
            self.progress["stage"] = name
            if message is not None:
                self.progress["message"] = message
            else:
                self.progress.pop("message", None)
            self._save()

    def finish(self, message: str | None = None) -> None:
        self.stage("done", message)

    def fail(self, message: str) -> None:
        self.stage("failed", message[:400])

    @property
    def stop_requested(self) -> bool:
        return (self.dir / "STOP").exists()

    # -- participants ---------------------------------------------------------------------------
    def _existing(self) -> list[dict]:
        if not self.sessions_path.exists():
            return []
        rows = []
        for line in self.sessions_path.read_text(encoding="utf-8").splitlines():
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue  # a line cut off by an interruption
        return rows

    def participants(self, one: Callable[[str, int, random.Random], dict], trial: int = 0) -> list[dict]:
        """Run every planned participant (or `trial` per condition), in parallel; returns all sessions.

        Each participant gets its own random generator seeded by (seed, condition, index), so a
        resumed run gives the same assignment. Failed calls are recorded, not retried forever."""
        trial_run = trial > 0
        plan = {c: min(n, trial) for c, n in self.plan.items()} if trial_run else self.plan
        path = self.dir / "trial-sessions.jsonl" if trial_run else self.sessions_path
        if trial_run:
            path.write_text("", encoding="utf-8")
        done_keys = set() if trial_run else {(s.get("condition"), s.get("index")) for s in self._existing()}
        todo = [(c, i) for c, n in plan.items() for i in range(n) if (c, i) not in done_keys]
        with self._lock:
            self.progress["stage"] = "trial" if trial_run else "running"
            self.progress.pop("message", None)
            if not trial_run:
                for cond in self.progress["conditions"]:
                    cond["done"] = sum(1 for k in done_keys if k[0] == cond["id"])
                self.progress["done"] = len(done_keys)
            self._save()

        def work(cond: str, idx: int) -> dict:
            if self.stop_requested:
                raise Stopped()
            rng = random.Random(f"{self.seed}:{cond}:{idx}")
            try:
                session = dict(one(cond, idx, rng))
            except Stopped:
                raise
            except Exception as exc:  # one participant failing must not end the run
                session = {"error": f"{type(exc).__name__}: {exc}"[:300], "trace": traceback.format_exc(limit=2)[-600:]}
            session.setdefault("condition", cond)
            session["index"] = idx
            return session

        try:
            from humanstudy_llm import _concurrency  # same cap as the model client
            workers = self.workers or _concurrency()
        except ImportError:
            workers = self.workers or 8
        stopped = False
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(work, c, i) for c, i in todo]
            for fut in as_completed(futures):
                try:
                    s = fut.result()
                except Stopped:
                    stopped = True
                    continue
                with self._lock:
                    with path.open("a", encoding="utf-8") as f:
                        f.write(json.dumps(s, ensure_ascii=False, default=str) + "\n")
                    if not trial_run:
                        self.progress["done"] += 1
                        if s.get("error"):
                            self.progress["failed"] += 1
                        for cond in self.progress["conditions"]:
                            if cond["id"] == s["condition"]:
                                cond["done"] += 1
                        self._save()
        if stopped:
            self.stage("stopped", "Stopped by the researcher")
            raise SystemExit("stopped by the researcher")
        rows = [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
        return sorted(rows, key=lambda s: (str(s.get("condition")), s.get("index", 0)))


def _start(run_dir: Path) -> None:
    """Start run.py in its own session, so it outlives the shell command that started it."""
    script = run_dir / "run.py"
    if not script.is_file():
        sys.exit(f"no run.py in {run_dir}")
    log = open(run_dir / "run.log", "a", encoding="utf-8")
    proc = subprocess.Popen([sys.executable, str(script)], cwd=str(run_dir), stdout=log, stderr=subprocess.STDOUT,
                            stdin=subprocess.DEVNULL, start_new_session=True, env=os.environ.copy())
    print(f"started run.py (pid {proc.pid}); follow progress.json and run.log")


def _cli(argv: list[str]) -> None:
    if len(argv) == 2 and argv[0] == "start":
        return _start(Path(argv[1]))
    if len(argv) < 3 or argv[0] != "stage" or argv[2] not in STAGES:
        sys.exit(__doc__.split("Command line")[1])
    path = Path(argv[1]) / "progress.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"done": 0, "total": 0, "failed": 0, "conditions": [], "startedAt": _now()}
    data["stage"] = argv[2]
    if len(argv) > 3:
        data["message"] = argv[3][:400]
    else:
        data.pop("message", None)
    data["updatedAt"] = _now()
    _write_json(path, data)
    print(f"progress: {argv[2]}")


if __name__ == "__main__":
    _cli(sys.argv[1:])
