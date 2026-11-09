#!/usr/local/bin/python3
"""Run a study with a participant f: answers = f(state). We own the state and the step; f is the user's.

    /usr/local/bin/python3 skills/run/run_study.py <study_id | study or variant dir> --f f-spec.json \
        [--n paper|N] [--arms a,b] [--seeds 1,2,3] [--out <study>/runs/<stamp>/] [--workers 8]
        [--states auto|screen|full|none] [--no-eval] [--no-baseline] [--detach]

Writes into the run folder:
  run.json        what ran: study, protocol sha256, f's description (f-spec, sources + sha256, renderer), n, seeds
  progress.json   desktop simkit conventions: stage, done/total/failed, conditions (arms), runner, heartbeatAt
  steps.jsonl     every call of f: (seed, opaque participant id, member, step, attempt) -> answers + screen sha
                  + timing (the resume log)
  records.jsonl   what f saw and did, nothing else: one line per participant {seed, opaque_id, member, status,
                  transcript [{state, answers, error (the page's refusal message), note, timing}]}
  operator.jsonl  operator side, never passed to f: arm, index, the engine record (seed, group, flags, exclusions,
                  bindings), f errors with tracebacks
  assets/         copies of images f asked for, under opaque names (ctx.asset_path never exposes the study folder)
  effects.json    every analysis effect computed on the agent sessions, per seed and pooled
  evaldata.json, rewards.json   when hsenv.evaldata / hsenv.rewards are present; never for a variant (its human
                  numbers belong to the original experiment); baseline-run.json caches the random baseline
  STOP            create it to stop after the pages in flight; rerun the same command to resume

Resume: rerunning with the same --out continues where it stopped. Every f call is logged; the engine replays the
logged answers (checking each screen's sha256) and calls f only for what is missing. Scheduling is deterministic
(up to --workers participants in flight, pages applied in participant order each round), so a resumed run is
the run that would have happened without the interruption.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
SANDBOX = HERE.parents[1]
HSENV = SANDBOX / "hsenv"
STUDIES = HSENV / "studies"
sys.path.insert(0, str(HSENV))
sys.path.insert(0, str(HERE))

from hsenv import checks  # noqa: E402
from hsenv.engine import Env, Protocol, ProtocolError  # noqa: E402
import fspec  # noqa: E402

HEARTBEAT_SECONDS = 15
AUTO_STATES_LIMIT = 2000   # --states auto: per-step States in records.jsonl up to this many participants
STAGES = ("preparing", "trial", "running", "scoring", "writing", "done", "failed", "stopped")


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + "Z"


def _sha(b):
    return hashlib.sha256(b if isinstance(b, bytes) else json.dumps(b, sort_keys=True, ensure_ascii=False,
                                                                   default=str).encode()).hexdigest()


def write_json(path, data):
    path = Path(path)
    tmp = path.with_suffix("%s.%d.tmp" % (path.suffix, os.getpid()))
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), encoding="utf-8")
    tmp.replace(path)


# ----------------------------------------------------------------------------------------------- study
def resolve_study(arg):
    """-> (folder holding protocol.json, asset root, variant.json or None)."""
    p = Path(arg)
    d = p if (p / "protocol.json").is_file() else STUDIES / arg
    if not (d / "protocol.json").is_file():
        raise SystemExit("no study %s (looked for %s/protocol.json)" % (arg, d))
    variant = None
    if (d / "variant.json").is_file():
        variant = json.loads((d / "variant.json").read_text(encoding="utf-8"))
        root = Path(variant["variant_of"]["study_dir"])
    else:
        root = d
    return d.resolve(), root.resolve(), variant


def load_protocol(arg):
    d, root, variant = resolve_study(arg)
    raw = (d / "protocol.json").read_bytes()
    return Protocol(json.loads(raw), root), hashlib.sha256(raw).hexdigest(), d, variant


def n_per_arm(protocol, n, arms=None):
    out, missing = {}, []
    known = {a["id"] for a in protocol.arms if a.get("runnable") is not False}
    if arms:
        bad = [x for x in arms if x not in known]
        if bad:
            raise SystemExit("unknown or blocked arms %s (runnable: %s)" % (bad, sorted(known)))
    for a in protocol.arms:
        if a.get("runnable") is False or (arms and a["id"] not in arms):
            continue
        if n == "paper":
            if a.get("n_paper") is None:
                missing.append(a["id"])
            else:
                out[a["id"]] = int(a["n_paper"])
        else:
            out[a["id"]] = int(n)
    if missing:
        raise SystemExit("arms %s print no human n; pass --n N" % missing)
    return out


# ----------------------------------------------------------------------------------------------- progress
class Progress:
    """progress.json as the desktop app reads it (simkit.py conventions), plus a STOP file."""

    def __init__(self, run_dir, plan, model=""):
        self.dir = Path(run_dir)
        self.path = self.dir / "progress.json"
        self.lock = threading.Lock()
        try:
            old = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            old = {}
        self.p = {"stage": "preparing", "done": 0, "total": sum(plan.values()), "failed": 0,
                  "conditions": [{"id": c, "done": 0, "total": k} for c, k in plan.items()],
                  "model": model, "startedAt": old.get("startedAt") or _now(), "updatedAt": _now(),
                  "runner": "alive", "pid": os.getpid()}
        self.save()
        self.closed = threading.Event()
        threading.Thread(target=self._beat, daemon=True).start()

    def save(self):
        self.last = time.time()
        self.p["updatedAt"] = self.p["heartbeatAt"] = _now()
        write_json(self.path, self.p)

    def _beat(self):
        while not self.closed.wait(HEARTBEAT_SECONDS):
            with self.lock:
                self.p["heartbeatAt"] = _now()
                try:
                    write_json(self.path, self.p)
                except OSError:
                    continue

    def stage(self, name, message=None):
        assert name in STAGES
        with self.lock:
            self.p["stage"] = name
            if message is None:
                self.p.pop("message", None)
            else:
                self.p["message"] = message[:400]
            self.save()

    def finished(self, arm, members, failed):
        """members: participants in this session (1, or the group size); failed: how many did not complete."""
        with self.lock:
            self.p["done"] += members
            self.p["failed"] += failed
            for c in self.p["conditions"]:
                if c["id"] == arm:
                    c["done"] += members
            if time.time() - self.last >= 1.0 or self.p["done"] == self.p["total"]:   # at most once a second
                self.save()

    def close(self):
        self.closed.set()
        with self.lock:
            self.p["runner"] = "exited"
            try:
                write_json(self.path, self.p)
            except OSError:
                pass

    @property
    def stop_requested(self):
        return (self.dir / "STOP").exists()


# ----------------------------------------------------------------------------------------------- participants
def compact(state, mode):
    if mode == "full":
        return state
    if mode == "none":
        return {k: state[k] for k in ("step", "page", "done") if k in state}
    out = {k: v for k, v in state.items() if k not in ("seen", "answered")}
    if "seen" in state:   # derivable from earlier screens in this transcript; kept as counts
        out["seen"] = {"count": len(state["seen"]),
                       "not_reviewable": sum(1 for x in state["seen"] if not x.get("reviewable"))}
        out["answered"] = {"count": len(state.get("answered") or [])}
    return out


class Participant:
    def __init__(self, env, spec, seed):
        self.spec = spec
        self.seed = seed
        self.key = "%s:%s" % (spec["arm"], spec["index"])
        self.opaque = _sha("%s|%s|%s" % (seed, spec["arm"], spec["index"]))[:12]   # never shows the arm
        self.s = env.open(spec)
        self.group = bool(spec.get("group_size"))
        st = self.s.reset()
        self.states = st if self.group else {"p1": st}
        self.attempt = {pid: 0 for pid in self.states}
        self.transcript = {pid: [] for pid in self.states}
        self.history = {pid: [] for pid in self.states}
        self.error = None   # "stuck: …" or "f failed: …"
        self.f_errors = {}  # pid -> [{failed, trace}] (operator side)

    def member(self, pid):
        return next(m for m in self.s.members if m.pid == pid) if self.group else self.s

    def todo(self):
        if self.error:
            return []
        return [(pid, st) for pid, st in sorted(self.states.items())
                if not st.get("done") and not st.get("waiting")]

    @property
    def finished(self):
        if self.error:
            return True
        if all(st.get("done") for st in self.states.values()):
            return True
        if not self.todo():
            self.error = "stuck: nobody in the group can act"
            return True
        return False

    def apply(self, pid, answers, seen_state):
        """seen_state: the State f answered (in a group another member's step may already have replaced
        self.states[pid] in this round)."""
        st = seen_state
        if self.group:
            new = self.s.step(pid, answers)
            mine = new[pid]
        else:
            mine = self.s.step(answers)
            new = {"p1": mine}
        if mine.get("error"):
            self.attempt[pid] += 1
            self.states[pid] = mine
        else:
            self.attempt[pid] = 0
            self.history[pid].append({"state": compact(st, "screen"), "answers": answers})
            self.states.update(new)
        return mine.get("error")


def _screen_sha(state):
    return _sha({k: state.get(k) for k in ("screen", "error", "step")})[:16]


class Runner:
    def __init__(self, protocol, f, fdesc, run_dir, workers=8, states="screen", asset_root=None):
        self.p = protocol
        self.f = f
        self.fdesc = fdesc
        self.dir = Path(run_dir)
        self.workers = max(1, int(workers))
        self.states_mode = states
        self.steps_path = self.dir / "steps.jsonl"
        self.records_path = self.dir / "records.jsonl"
        self.operator_path = self.dir / "operator.jsonl"
        self.asset_lock = threading.Lock()
        self.cache = {}
        if self.steps_path.exists():
            for line in self.steps_path.read_text(encoding="utf-8").splitlines():
                try:
                    r = json.loads(line)
                except ValueError:
                    continue   # a line cut off by an interruption
                self.cache[(r["seed"], r["participant"], r["member"], r["step"], r["attempt"])] = r
        self.written = set()
        if self.records_path.exists():
            for line in self.records_path.read_text(encoding="utf-8").splitlines():
                try:
                    r = json.loads(line)
                    self.written.add((r["seed"], r["opaque_id"], r["member"]))
                except ValueError:
                    continue
        self.calls = 0
        self.replayed = 0

    def asset(self, ref):
        """An image f may look at: a copy under runs/<stamp>/assets/<opaque id><ext>; never the study's own path
        (the folder holds protocol.json and file names can name a condition)."""
        h = str(ref).replace("asset:", "")
        src = self.p._asset_paths.get(h)
        if not src or not Path(src).is_file():
            return None
        dst = self.dir / "assets" / (h + Path(src).suffix.lower())
        with self.asset_lock:
            if not dst.exists():
                dst.parent.mkdir(exist_ok=True)
                dst.write_bytes(Path(src).read_bytes())
        return str(dst)

    def _call(self, part, pid, state):
        attempt = part.attempt[pid]
        ckey = (part.seed, part.opaque, pid, state.get("step"), attempt)
        hit = self.cache.get(ckey)
        sha = _screen_sha(state)
        if hit is not None:
            if hit.get("screen_sha") != sha:
                raise SystemExit("resume mismatch at %s: the logged screen differs from the replayed one (protocol "
                                 "or engine changed?). Start a new --out." % (ckey,))
            self.replayed += 1
            return hit, False
        operator = (lambda: part.member(pid)) if self.fdesc.get("operator_access") else None
        last = None
        for k in range(1 + self.fdesc["retries"]):
            ctx = fspec.Ctx("%s|%s|%s|%s|%s|%s" % (self.fdesc["name"], part.seed, part.key, pid,
                                                  state.get("step"), attempt) + ("|%d" % k if k else ""),
                            attempt, part.opaque, pid, list(part.history[pid]), self.asset, operator)
            t0 = time.time()
            try:
                ans = self.f(state, ctx)
                if not isinstance(ans, dict):
                    raise TypeError("f returned %s, not a dict of answers" % type(ans).__name__)
                row = {"seed": part.seed, "participant": part.opaque, "member": pid, "step": state.get("step"),
                       "attempt": attempt, "screen_sha": sha, "answers": ans, "f_tries": k + 1, "at": _now(),
                       "f_ms": int((time.time() - t0) * 1000)}
                if ctx.note is not None:
                    row["note"] = ctx.note
                self.calls += 1
                return row, True
            except Exception as e:  # one participant's f failing must not end the run
                last = "%s: %s" % (type(e).__name__, e)
                tb = traceback.format_exc(limit=3)[-800:]
        return {"failed": last, "trace": tb}, False

    def _write_record(self, part):
        lines, ops = [], []
        for pid in sorted(part.states):
            if (part.seed, part.opaque, pid) in self.written:
                continue
            m = part.member(pid)
            status = m.status or "incomplete"
            lines.append(json.dumps({"seed": part.seed, "opaque_id": part.opaque, "member": pid, "status": status,
                                     "transcript": part.transcript[pid]}, ensure_ascii=False, default=str))
            ops.append(json.dumps({"seed": part.seed, "opaque_id": part.opaque, "member": pid,
                                   "participant": part.key, "arm": part.spec["arm"], "index": part.spec["index"],
                                   "status": status, "error": part.error, "f_errors": part.f_errors.get(pid, []),
                                   "record": m.record() if m.status else None}, ensure_ascii=False, default=str))
            self.written.add((part.seed, part.opaque, pid))
        if lines:
            self.records_fh.write("\n".join(lines) + "\n")
            self.records_fh.flush()
            self.operator_fh.write("\n".join(ops) + "\n")
            self.operator_fh.flush()

    def run_seed(self, seed, plan, progress):
        env = Env(self.p)
        specs = env.design(n=plan, seed=seed)
        queue = list(specs)
        active = []
        pool = ThreadPoolExecutor(max_workers=self.workers)
        steps_fh = self.steps_path.open("a", encoding="utf-8")
        self.records_fh = self.records_path.open("a", encoding="utf-8")
        self.operator_fh = self.operator_path.open("a", encoding="utf-8")
        stopped = False
        try:
            while queue or active:
                while queue and len(active) < self.workers:   # opened in design order: deterministic
                    active.append(Participant(env, queue.pop(0), seed))
                calls = [(part, pid, st) for part in active for pid, st in part.todo()]
                futs = [pool.submit(self._call, part, pid, st) for part, pid, st in calls]
                results = [fu.result() for fu in futs]
                new_rows = [row for row, fresh in results if fresh]
                if new_rows:
                    steps_fh.write("".join(json.dumps(r, ensure_ascii=False, default=str) + "\n" for r in new_rows))
                    steps_fh.flush()
                for (part, pid, st), (row, _) in zip(calls, results):   # applied in participant order
                    if "failed" in row:
                        part.error = "f failed after %d tries: %s" % (1 + self.fdesc["retries"], row["failed"])
                        part.f_errors.setdefault(pid, []).append(row)   # operator side only
                        part.transcript[pid].append({"state": compact(st, self.states_mode),
                                                     "f_failed": True})
                        continue
                    if part.error:
                        continue
                    try:
                        err = part.apply(pid, dict(row["answers"]), st)
                    except (ProtocolError, RuntimeError) as e:
                        part.error = "engine: %s" % e
                        err = None
                    entry = {"state": compact(st, self.states_mode), "answers": row["answers"],
                             "timing": {k: row.get(k) for k in ("at", "f_ms", "f_tries")}}
                    if err:
                        entry["error"] = err
                    if row.get("note") is not None:
                        entry["note"] = row["note"]
                    part.transcript[pid].append(entry)
                    if err and part.attempt[pid] >= self.fdesc["max_refusals"]:
                        part.error = "stuck: the page refused %d answer sets in a row (%s)" % (
                            part.attempt[pid], json.dumps(err, ensure_ascii=False)[:200])
                still = []
                for part in active:
                    if part.finished:
                        self._write_record(part)
                        ms = part.s.members if part.group else [part.s]
                        progress.finished(part.spec["arm"], len(ms), sum(1 for m in ms if m.status != "completed"))
                    else:
                        still.append(part)
                active = still
                if progress.stop_requested and (queue or active):
                    stopped = True
                    break
        finally:
            pool.shutdown(wait=True)
            steps_fh.close()
            self.records_fh.close()
            self.operator_fh.close()
        return env, stopped


# ----------------------------------------------------------------------------------------------- evaluation
def evaluate(protocol, envs, plan, fdesc, run_dir, variant, baseline=True, effects_only=False):
    """effects.json always (hsenv.checks); evaldata.json + rewards.json when those modules exist."""
    out = {"per_seed": {}, "pooled": None}
    tables = {}
    for seed, env in envs.items():
        t = env.unit_tables()
        tables[seed] = t
        out["per_seed"][str(seed)] = checks.effect_blocks(protocol, t)
    pooled = {}
    for seed, t in tables.items():
        for unit, rows in t.items():
            pooled.setdefault(unit, []).extend(dict(r, session="%s:%s" % (seed, r.get("session", r.get("group"))))
                                               for r in rows)
    out["pooled"] = checks.effect_blocks(protocol, pooled) if len(tables) > 1 else None
    out["note"] = ("agent side only; for a variant the printed human numbers are those of the original experiment"
                   if variant else "agent side only; the human side is in evaldata.json when it exists")
    write_json(Path(run_dir) / "effects.json", out)
    summary = {"effects": "effects.json"}
    if effects_only:
        return summary
    if variant:
        summary["evaldata"] = summary["rewards"] = (
            "skipped: a variant is not the original experiment; the printed human numbers do not apply to it. "
            "Compare it with the original run (explore/compare.py)")
        return summary
    try:
        from hsenv import evaldata as E
    except ImportError as e:
        summary["evaldata"] = "skipped: hsenv.evaldata not importable (%s)" % e
        return summary
    try:
        runs = [E.run_from_env(env, seed, policy="f:%s" % fdesc["name"]) for seed, env in envs.items()]
        base = None
        if baseline:   # the random baseline at this n, cached in the run folder (reused on resume / rescoring)
            bpath = Path(run_dir) / "baseline-run.json"
            bkey = {"protocol_version": protocol.version, "n": plan, "seed": 0}
            try:
                cached = json.loads(bpath.read_text(encoding="utf-8"))
                base = cached["run"] if cached.get("key") == bkey else None
            except (OSError, ValueError, KeyError):
                base = None
            if base is None:
                base = E.baseline_run(protocol, plan, 0)
                write_json(bpath, {"key": bkey, "run": base})
        prov = {"policy": "f:%s" % fdesc["name"], "f": {k: fdesc[k] for k in ("kind", "name")},
                "agent_n_per_arm": plan, "seeds": list(envs), "baseline_seed": 0 if baseline else None,
                "top_up": "none (run_study runs exactly n per arm; excluded sessions are not replaced)",
                "variant_of": (variant or {}).get("variant_of")}
        ev = E.EvalData.build(protocol, runs, baseline=base, provenance=prov)
        write_json(Path(run_dir) / "evaldata.json", ev.to_dict())
        summary["evaldata"] = "evaldata.json"
    except Exception as e:
        summary["evaldata"] = "failed: %s: %s" % (type(e).__name__, e)
        return summary
    try:
        from hsenv import rewards as R
        from hsenv import score as S
    except ImportError as e:
        summary["rewards"] = "skipped: hsenv.rewards not importable (%s)" % e
        return summary
    try:
        res = S.summarize(ev, list(R.DEFAULT))
        write_json(Path(run_dir) / "rewards.json", {k: v["reward"] for k, v in res.items()})
        summary["rewards"] = {k: {"value": v["value"], "passed": v["passed"], "n_scored": v["n_scored"],
                                  "not_computable": v["not_computable"]} for k, v in res.items()}
    except Exception as e:
        summary["rewards"] = "failed: %s: %s" % (type(e).__name__, e)
    return summary


# ----------------------------------------------------------------------------------------------- entry points
def run(study, fspec_obj, n="paper", seeds=(1,), out=None, workers=8, states="auto", do_eval=True,
        baseline=True, spec_dir=".", host_f=None, quiet=False, effects_only=False, arms=None):
    """Python entry point (hosts embed this to pass an in-process f, e.g. an llm adapter): returns run.json."""
    protocol, psha, sdir, variant = load_protocol(study)
    f, fdesc = fspec.build(fspec_obj, protocol, spec_dir, host_f=host_f)
    plan = n_per_arm(protocol, n, arms)
    seeds = [int(s) for s in seeds]
    gsize = {a["id"]: int(a.get("group_size") or 1) for a in protocol.arms}
    members = sum(k * gsize[a] for a, k in plan.items()) * len(seeds)
    if states == "auto":   # large runs keep no per-step States in records.jsonl unless asked (memory, disk)
        states = "screen" if members <= AUTO_STATES_LIMIT else "none"
    if out is None:
        out = sdir / "runs" / time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    fingerprint = {"protocol_sha256": psha, "f": _sha(fdesc.get("spec")), "f_source": _sha(
        {k: fdesc.get(k) for k in ("source", "host", "renderer")}), "n_per_arm": plan, "seeds": seeds, "arms": sorted(plan)}
    meta_path = out / "run.json"
    if meta_path.exists():
        old = json.loads(meta_path.read_text(encoding="utf-8"))
        if old.get("fingerprint") != fingerprint:
            raise SystemExit("%s holds a different run (protocol, f, n or seeds differ); use a new --out" % out)
        resumed = True
    else:
        resumed = False
    (out / "STOP").unlink(missing_ok=True) if resumed else None
    meta = {"schema": "hs-run-1", "principle": "answers = f(state): the study owns state and step; f is the user's",
            "study": protocol.id, "study_dir": str(sdir), "protocol_sha256": psha, "protocol_version": protocol.version,
            "variant": variant, "f": fdesc, "n": n, "n_per_arm": plan, "arms": sorted(plan), "seeds": seeds,
            "workers": workers, "participants_planned": members,
            "states_kept": states, "fingerprint": fingerprint, "startedAt": _now(), "resumed": resumed,
            "engine": {"path": str(HSENV / "hsenv" / "engine.py"),
                       "sha256": hashlib.sha256((HSENV / "hsenv" / "engine.py").read_bytes()).hexdigest()},
            "label": "not the original experiment" if variant else None}
    if resumed:
        meta["startedAt"] = old.get("startedAt", meta["startedAt"])
        meta["resumedAt"] = (old.get("resumedAt") or []) + [_now()]
    write_json(meta_path, meta)
    plan_all = {a: k * gsize[a] * len(seeds) for a, k in plan.items()}   # participants, not groups
    prog = Progress(out, plan_all, model=str(fdesc.get("model") or fdesc["name"]))
    runner = Runner(protocol, f, fdesc, out, workers, states)
    envs = {}
    try:
        prog.stage("running")
        for sd in seeds:
            env, stopped = runner.run_seed(sd, plan, prog)
            if stopped:
                prog.stage("stopped", "Stopped by the researcher; rerun the same command to resume")
                meta.update(status="stopped", calls=runner.calls, replayed=runner.replayed)
                write_json(meta_path, meta)
                return meta
            envs[sd] = env
        meta.update(calls=runner.calls, replayed=runner.replayed)
        if do_eval:
            prog.stage("scoring")
            meta["evaluation"] = evaluate(protocol, envs, plan, fdesc, out, variant, baseline, effects_only)
        done = [json.loads(x) for x in runner.operator_path.read_text(encoding="utf-8").splitlines() if x.strip()]
        by = {}
        for r in done:
            by[r["status"]] = by.get(r["status"], 0) + 1
        comp = by.get("completed", 0)
        meta["participants"] = {"records": len(done), "completed": comp, "by_status": by,
                                "completion_rate": round(comp / len(done), 4) if done else None,
                                "incomplete": by.get("incomplete", 0),
                                "errors": sorted({(r["error"] or "")[:120] for r in done if r["error"]})[:10]}
        meta["status"] = "done"
        meta["finishedAt"] = _now()
        write_json(meta_path, meta)
        prog.stage("done", "%d participants, %d completed (%.0f%%); %d f calls (%d replayed)" % (
            len(done), comp, 100.0 * comp / max(len(done), 1), runner.calls, runner.replayed))
        if not quiet:
            print("done: %s  participants=%d completed=%d (%.0f%%)  f calls=%d replayed=%d" % (
                out, len(done), comp, 100.0 * comp / max(len(done), 1), runner.calls, runner.replayed))
        return meta
    except BaseException as e:
        if not isinstance(e, SystemExit) or "stopped" not in str(e):
            prog.stage("failed", "%s: %s" % (type(e).__name__, e))
        raise
    finally:
        prog.close()


def main(argv=None):
    if sys.version_info < (3, 11):
        sys.exit("run_study.py needs Python 3.11+ (/usr/local/bin/python3)")
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("study", help="study id under hsenv/studies, or a study/variant folder")
    ap.add_argument("--f", required=True, help="f-spec JSON file (or inline JSON)")
    ap.add_argument("--n", default="paper", help="'paper' (human n per arm) or N per arm")
    ap.add_argument("--seeds", default="1", help="comma-separated, e.g. 1,2,3")
    ap.add_argument("--out", help="run folder (default <study>/runs/<UTC stamp>/)")
    ap.add_argument("--workers", type=int, default=8, help="participants in flight (f calls run in parallel)")
    ap.add_argument("--arms", help="comma-separated arm ids (default: every runnable arm)")
    ap.add_argument("--states", choices=("auto", "screen", "full", "none"), default="auto",
                    help="what of each State records.jsonl keeps: screen (seen/answered as counts), full, none; "
                         "auto = screen up to %d participants, else none" % AUTO_STATES_LIMIT)
    ap.add_argument("--no-eval", action="store_true")
    ap.add_argument("--no-baseline", action="store_true", help="skip the random baseline in evaldata")
    ap.add_argument("--detach", action="store_true", help="run in the background (output in <out>/run.log)")
    a = ap.parse_args(argv)
    if a.f.strip().startswith("{"):
        spec, spec_dir = json.loads(a.f), Path.cwd()
    else:
        spec, spec_dir = json.loads(Path(a.f).read_text(encoding="utf-8")), Path(a.f).resolve().parent
    if a.detach:
        if not a.out:
            sys.exit("--detach needs --out (so the run folder is known)")
        Path(a.out).mkdir(parents=True, exist_ok=True)
        args = [x for x in (argv if argv is not None else sys.argv[1:]) if x != "--detach"]
        log = open(Path(a.out) / "run.log", "a", encoding="utf-8")
        proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve())] + args, stdout=log,
                                stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True,
                                env=os.environ.copy())
        print("started (pid %d); follow %s/progress.json and run.log; touch %s/STOP to stop" % (proc.pid, a.out, a.out))
        return 0
    try:
        run(a.study, spec, "paper" if a.n == "paper" else int(a.n), [s for s in a.seeds.split(",") if s.strip()],
            a.out, a.workers, a.states, not a.no_eval, not a.no_baseline, spec_dir,
            arms=[x.strip() for x in a.arms.split(",") if x.strip()] if a.arms else None)
    except fspec.SpecError as e:
        sys.exit("f-spec: %s" % e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
