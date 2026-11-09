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
                  numbers belong to the original experiment). The baseline is evaldata's State-only `floor`
                  policy at the run's plan, cached in <runs>/.baseline-cache/ and shared by runs of the same study,
                  protocol and reward code
  STOP            create it to stop after the pages in flight; rerun the same command to resume

Resume: rerunning with the same --out continues where it stopped. Every f call is logged; the engine replays the
logged answers (checking each screen's sha256) and calls f only for what is missing. Scheduling is deterministic
(up to --workers participants in flight, pages applied in participant order each round), so a resumed run is
the run that would have happened without the interruption.
"""
import argparse
import hashlib
import hmac
import json
import math
import secrets
import shutil
import tempfile
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
from hsenv.engine import Env, Protocol, ProtocolError, _seed as engine_seed  # noqa: E402
import fspec  # noqa: E402

HEARTBEAT_SECONDS = 15
AUTO_STATES_BYTES = 100 * 1024 * 1024   # --states auto: screens in records.jsonl until it holds this many bytes
TOP_UP_MAX_FACTOR = 3                   # top-up brake: at most this many times the planned sessions per arm
TOP_UP_MIN_SHARE = 0.05                 # top-up brake: no top-up for an arm whose first round was < 5% valid
STAGES = ("preparing", "trial", "running", "scoring", "writing", "done", "failed", "stopped")


def salt_path(out):
    """The run's secret salt lives OUTSIDE the run folder: <runs>/.operator/<run name>.salt (operator side)."""
    out = Path(out).resolve()
    return out.parent / ".operator" / (out.name + ".salt")


def load_salt(out, create=True):
    sp = salt_path(out)
    old = Path(out) / ".operator-salt"          # earlier layout: move it out of the run folder
    if old.exists() and not sp.exists():
        sp.parent.mkdir(parents=True, exist_ok=True)
        sp.write_text(old.read_text(encoding="utf-8"), encoding="utf-8")
        old.unlink()
    if not sp.exists():
        if not create:
            return None
        sp.parent.mkdir(parents=True, exist_ok=True)
        sp.write_text(secrets.token_hex(32), encoding="utf-8")
    return bytes.fromhex(sp.read_text(encoding="utf-8").strip())


def order_key(seed, spec):
    """Sessions open in an order derived from the SEED (public): arms interleaved, never in arm blocks, so neither
    the opening order nor the wall-clock time of f's calls tracks the arm for an f that uses only ctx. The order
    is part of the design — balanced randomisers assign in opening order — so it must not depend on the secret
    salt: the same seed gives the same sample (the salt is used only for participant ids)."""
    return hashlib.sha256(("order|%s|%s|%s" % (seed, spec["arm"], spec["index"])).encode()).hexdigest()


def unit_counts(env):
    """Opened units (sessions; groups once) per arm."""
    seen, out = set(), {}
    for s in env.sessions:
        u = id(s.group) if s.group else id(s)
        if u not in seen:
            seen.add(u)
            out[s.spec["arm"]] = out.get(s.spec["arm"], 0) + 1
    return out


def valid_counts(env, plan):
    """Valid units per arm in the kept prefix (at most the plan), by the reward layer's one rule:
    hsenv.evaldata.valid_counts(run_from_env(env, planned=plan)) — all exclusions, population cutoffs included.
    Without hsenv.evaldata: completed sessions with no exclusion (population cutoffs not applied; documented)."""
    try:
        from hsenv import evaldata as E
    except ImportError:
        E = None
    if E is not None and hasattr(E, "valid_counts"):
        return E.valid_counts(env.p, [E.run_from_env(env, 0, planned=dict(plan))])[0]
    out, seen = {}, set()
    for s in env.sessions:
        u = id(s.group) if s.group else id(s)
        if u in seen:
            continue
        seen.add(u)
        ms = s.group.members if s.group else [s]
        ok = all(m.status == "completed" and not m.record()["excluded"] for m in ms)
        out[s.spec["arm"]] = min(out.get(s.spec["arm"], 0) + ok, plan.get(s.spec["arm"], 0))
    return out


def scored_env(env, plan):
    """The scored sample: evaldata keeps the first `plan` valid units per arm (top-up overshoot dropped)."""
    try:
        from hsenv import evaldata as E
        env2, _ = E._truncate(env, dict(plan))
        return env2
    except (ImportError, AttributeError):
        return env


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


def human_n(arm):
    """(n, basis): the human ANALYSED n the reward layer plans on (hsenv.evaldata.analysed_n: arms[].n_analysed,
    else n_paper labelled unverified); n_paper when evaldata is absent."""
    try:
        from hsenv.evaldata import analysed_n
        return analysed_n(arm)
    except ImportError:
        return (int(arm["n_paper"]), "n_paper") if arm.get("n_paper") is not None else (None, None)


def n_per_arm(protocol, n, arms=None):
    """--n paper: the human analysed n of each arm (an official plan when every arm runs); --n N: N per arm."""
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
            hn, _ = human_n(a)
            if hn is None:
                missing.append(a["id"])
            else:
                out[a["id"]] = int(hn)
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

    def add(self, arm, members):
        """Top-up sessions join the plan."""
        with self.lock:
            self.p["total"] += members
            for c in self.p["conditions"]:
                if c["id"] == arm:
                    c["total"] += members
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
    def __init__(self, env, spec, seed, salt):
        self.spec = spec
        self.seed = seed
        self.key = "%s:%s" % (spec["arm"], spec["index"])
        # HMAC with the run's secret salt (operator side): f cannot invert the id to the arm
        self.opaque = hmac.new(salt, ("%s|%s|%s" % (seed, spec["arm"], spec["index"])).encode(),
                               hashlib.sha256).hexdigest()[:16]
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
    def __init__(self, protocol, f, fdesc, run_dir, workers=8, states="screen", salt=b"", top_up=True,
                 top_up_max=TOP_UP_MAX_FACTOR):
        self.p = protocol
        self.top_up_max = int(top_up_max)
        self.salt = salt
        self.top_up = top_up
        self.auto_states = states == "auto"
        if self.auto_states:
            states = "screen"
        self.records_bytes = 0
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
                    self.records_bytes += len(line) + 1
                except ValueError:
                    continue
        self.calls = 0
        self.replayed = 0
        self.states_dropped_after = None   # auto: participants written with screens before the size cap
        # images f may read: copies in a private temporary folder (not under the run or the study), named by
        # content id. f gets a closure over a {id: copied file} map only — no protocol, no runner, no run folder.
        self.assets_dir = None
        self.asset_files = {}
        files = self.asset_files

        def asset_path(ref):
            return files.get(str(ref).replace("asset:", ""))
        self.asset_path = asset_path

    def _prepare_assets(self, state):
        """Copy the images on this screen and in `seen` before f is called (operator side)."""
        refs = [it.get("src") for it in (state.get("screen") or {}).get("items", []) + (state.get("seen") or [])]
        for ref in refs:
            if not (isinstance(ref, str) and ref.startswith("asset:")):
                continue
            h = ref[6:]
            if h in self.asset_files:
                continue
            src = self.p._asset_paths.get(h)
            if not src or not Path(src).is_file():
                continue
            with self.asset_lock:
                if self.assets_dir is None:
                    self.assets_dir = Path(tempfile.mkdtemp(prefix="hs-assets-"))
                dst = self.assets_dir / (h + Path(src).suffix.lower())
                if not dst.exists():
                    dst.write_bytes(Path(src).read_bytes())
                self.asset_files[h] = str(dst)

    def close(self):
        if self.assets_dir is not None:
            shutil.rmtree(self.assets_dir, ignore_errors=True)

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
        self._prepare_assets(state)
        last = None
        for k in range(1 + self.fdesc["retries"]):
            # f's rng follows the seed, not the salt, so the same seed reproduces the same answers; its seed is a
            # sha256 of the session's engine seed (no arm or index in clear)
            ctx = fspec.Ctx(_sha("rng|%s|%s|%s|%s|%s|%s" % (self.fdesc["name"], part.spec["seed"], pid,
                                                            state.get("step"), attempt, k)),
                            attempt, part.opaque, pid, list(part.history[pid]), self.asset_path, operator)
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
            tr = part.transcript[pid]
            if self.auto_states and self.records_bytes > AUTO_STATES_BYTES:
                if self.states_dropped_after is None:
                    self.states_dropped_after = len(self.written)
                tr = [dict(x, state=compact(x["state"], "none")) for x in tr]
            line = json.dumps({"seed": part.seed, "opaque_id": part.opaque, "member": pid, "status": status,
                               "transcript": tr}, ensure_ascii=False, default=str)
            self.records_bytes += len(line) + 1
            lines.append(line)
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

    def _spec(self, seed, arm, i):
        a = next(x for x in self.p.arms if x["id"] == arm)
        spec = {"study": self.p.id, "arm": arm, "index": i, "seed": engine_seed(seed, arm, i)}   # as Env.design
        if a.get("group_size"):
            spec["group_size"] = int(a["group_size"])
        return spec

    def run_seed(self, seed, plan, progress):
        """The planned sessions, then top-up rounds (§8.2): while an arm has fewer valid units than planned, more
        sessions are added (estimated from its valid share), up to TOP_UP_MAX_FACTOR x planned. Deterministic, so a
        resumed run tops up exactly as the uninterrupted one."""
        env = Env(self.p)
        okey = lambda sp: order_key(seed, sp)   # noqa: E731
        queue = sorted(env.design(n=plan, seed=seed), key=okey)
        issued = dict(plan)
        self.top_up_notes = getattr(self, "top_up_notes", {})
        notes = self.top_up_notes.setdefault(str(seed), {})
        first_share = {}
        gsize = {a["id"]: int(a.get("group_size") or 1) for a in self.p.arms}
        self.topped_up = getattr(self, "topped_up", {})
        active = []
        pool = ThreadPoolExecutor(max_workers=self.workers)
        steps_fh = self.steps_path.open("a", encoding="utf-8")
        self.records_fh = self.records_path.open("a", encoding="utf-8")
        self.operator_fh = self.operator_path.open("a", encoding="utf-8")
        stopped = False
        try:
            while True:
                stopped = self._drain(env, seed, queue, active, pool, steps_fh, progress)
                if stopped or not self.top_up:
                    break
                vcount, opened = valid_counts(env, plan), unit_counts(env)
                more = []
                for arm, k in plan.items():
                    valid, total = vcount.get(arm, 0), opened.get(arm, 0)
                    share = valid / total if total else 0.0
                    first_share.setdefault(arm, share)
                    cap = k * self.top_up_max
                    if valid >= k:
                        continue
                    if first_share[arm] < TOP_UP_MIN_SHARE:   # brake: f almost never yields a valid session here
                        notes[arm] = ("no top-up: only %.1f%% of the first %d sessions were valid (< %.0f%%); the "
                                      "run stays short (underpowered_run)" % (100 * first_share[arm], plan[arm],
                                                                            100 * TOP_UP_MIN_SHARE))
                        continue
                    if issued[arm] >= cap:
                        notes[arm] = ("top-up stopped at the cap (%dx plan = %d sessions) with %d valid of %d "
                                      "planned (underpowered_run)" % (self.top_up_max, cap, valid, k))
                        continue
                    if valid + share * (cap - issued[arm]) < k:   # predictive brake: the cap cannot reach the plan
                        notes[arm] = ("top-up not attempted: at the observed valid rate %.1f%% the remaining cap of "
                                      "%d sessions would give about %d valid, short of %d planned "
                                      "(underpowered_run)" % (100 * share, cap - issued[arm],
                                                              valid + int(share * (cap - issued[arm])), k))
                        continue
                    add = min(int(math.ceil((k - valid) / max(share, 1e-9))), cap - issued[arm])
                    more += [self._spec(seed, arm, i) for i in range(issued[arm], issued[arm] + add)]
                    issued[arm] += add
                    progress.add(arm, add * gsize[arm])
                if not more:
                    break
                queue.extend(sorted(more, key=okey))
            self.topped_up[seed] = {a: issued[a] - plan[a] for a in plan if issued[a] > plan[a]}
        finally:
            pool.shutdown(wait=True)
            steps_fh.close()
            self.records_fh.close()
            self.operator_fh.close()
        return env, stopped

    def _drain(self, env, seed, queue, active, pool, steps_fh, progress):
        """Run until queue and active are empty (False) or STOP was requested (True)."""
        while queue or active:
            while queue and len(active) < self.workers:   # opened in design order: deterministic
                active.append(Participant(env, queue.pop(0), seed, self.salt))
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
                    part.transcript[pid].append({"state": compact(st, self.states_mode), "f_failed": True})
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
            active[:] = still
            if progress.stop_requested and (queue or active):
                return True
        return False


# ----------------------------------------------------------------------------------------------- evaluation
def baseline_cached(E, protocol, plan, run_dir, max_factor):
    """The State-only `floor` baseline at the run's planned n (evaldata.baseline_run), shared by every run of the
    same study + protocol + reward code: cached next to the run folders in .baseline-cache/ (tables + session
    summaries only). Key: study, protocol sha16, code sha16, policy, planned n, seed, top-up cap."""
    key = {"study": protocol.id, "protocol_sha16": protocol.version, "code_sha16": E.code_hash(), "policy": "floor",
           "n": dict(sorted(plan.items())), "seed": 0, "max_factor": max_factor}
    cdir = Path(run_dir).resolve().parent / ".baseline-cache"
    path = cdir / ("%s-%s.json" % (protocol.id, _sha(key)[:16]))
    try:
        cached = json.loads(path.read_text(encoding="utf-8"))
        if cached.get("key") == key:
            return cached["run"], {"cache": str(path), "reused": True, "key": key}
    except (OSError, ValueError, KeyError):
        pass
    base = E.baseline_run(protocol, plan, 0, max_factor)
    keep = {k: base[k] for k in ("seed", "policy", "tables", "sessions", "n_per_arm", "n_target_per_arm",
                                 "truncated_sessions") if k in base}
    cdir.mkdir(parents=True, exist_ok=True)
    write_json(path, {"key": key, "run": keep})
    return keep, {"cache": str(path), "reused": False, "key": key}


def evaluate(protocol, envs, plan, fdesc, run_dir, variant, baseline=True, effects_only=False, top_up=None,
             baseline_max_factor=10):
    """effects.json always (hsenv.checks); evaldata.json + rewards.json when those modules exist."""
    out = {"per_seed": {}, "pooled": None, "kept": {}}
    tables = {}
    for seed, env in envs.items():
        # the scored sample: the first `plan` valid units per arm (top-up overshoot dropped), as evaldata keeps
        env = scored_env(env, plan)
        out["kept"][str(seed)] = {"sessions": len(env.sessions)}
        t = env.unit_tables()
        tables[seed] = t
        out["per_seed"][str(seed)] = checks.effect_blocks(protocol, t)
    pooled = {}
    for seed, t in tables.items():
        for unit, rows in t.items():
            pooled.setdefault(unit, []).extend(dict(r, session="%s:%s" % (seed, r.get("session", r.get("group"))))
                                               for r in rows)
    out["pooled"] = checks.effect_blocks(protocol, pooled) if len(tables) > 1 else None
    out["note"] = ("agent side only, on the scored sample (the first planned valid units per arm); "
                   + ("for a variant the printed human numbers are those of the original experiment" if variant
                      else "the human side is in evaldata.json when it exists"))
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
        # the run's own plan: evaldata keeps the first `plan` valid units per arm and judges power against it
        runs = [E.run_from_env(env, seed, policy="f:%s" % fdesc["name"], planned=dict(plan))
                for seed, env in envs.items()]
        for r in runs:
            r["n_target_per_arm"] = dict(plan)
        base, binfo = (None, None)
        if baseline:
            base, binfo = baseline_cached(E, protocol, plan, run_dir, baseline_max_factor)
            summary["baseline"] = binfo
        prov = {"policy": "f:%s" % fdesc["name"], "f": {k: fdesc[k] for k in ("kind", "name")},
                "agent_n_per_arm": plan, "seeds": list(envs), "baseline_seed": 0 if baseline else None,
                "baseline_cache": binfo, "top_up": top_up, "variant_of": (variant or {}).get("variant_of")}
        ev = E.EvalData.build(protocol, runs, baseline=base, provenance=prov, planned=dict(plan))
        summary["plan"] = {k: (ev.d.get("plan") or {}).get(k) for k in (
            "official", "per_arm", "human_per_arm", "human_n_basis", "factor", "official_rule", "n_unverified_arms",
            "official_n_basis", "subset_of_arms")}
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
        summary["rewards"] = {}
        for k, v in res.items():
            sp = (v.get("reward") or {}).get("spec") or {}
            summary["rewards"][k] = {
                "value": v["value"], "passed": v["passed"], "status": v.get("status") or sp.get("status"),
                "official": sp.get("official"), "label": sp.get("label"), "report_scope": sp.get("report_scope"),
                "n_scored": v["n_scored"], "not_computable": v["not_computable"], "reasons": v.get("reasons"),
                "view": v.get("view") or sp.get("view"),
                **{x: sp.get(x) for x in ("itt_unchecked", "itt_not_applicable", "value_analysed", "value_itt",
                                          "verdict_on_unverified_n") if x in sp}}
        try:
            summary["text_report"] = S.text_report(ev, res)
        except Exception as e:   # noqa: BLE001 — the report text is a convenience
            summary["text_report"] = ["(text_report failed: %s)" % e]
    except Exception as e:
        summary["rewards"] = "failed: %s: %s" % (type(e).__name__, e)
    return summary


# ----------------------------------------------------------------------------------------------- entry points
def run(study, fspec_obj, n="paper", seeds=(1,), out=None, workers=8, states="auto", do_eval=True,
        baseline=True, spec_dir=".", host_f=None, quiet=False, effects_only=False, arms=None, top_up=True,
        baseline_max_factor=10, top_up_max=TOP_UP_MAX_FACTOR):
    """Python entry point (hosts embed this to pass an in-process f, e.g. an llm adapter): returns run.json."""
    protocol, psha, sdir, variant = load_protocol(study)
    f, fdesc = fspec.build(fspec_obj, protocol, spec_dir, host_f=host_f)
    plan = n_per_arm(protocol, n, arms)
    seeds = [int(s) for s in seeds]
    gsize = {a["id"]: int(a.get("group_size") or 1) for a in protocol.arms}
    members = sum(k * gsize[a] for a, k in plan.items()) * len(seeds)
    if out is None:
        out = sdir / "runs" / time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    fingerprint = {"protocol_sha256": psha, "f": _sha(fdesc.get("spec")), "f_source": _sha(
        {k: fdesc.get(k) for k in ("source", "host", "renderer")}), "n_per_arm": plan, "seeds": seeds, "arms": sorted(plan),
        "top_up": bool(top_up), "top_up_max": int(top_up_max)}
    meta_path = out / "run.json"
    if meta_path.exists():
        old = json.loads(meta_path.read_text(encoding="utf-8"))
        if old.get("fingerprint") != fingerprint:
            raise SystemExit("%s holds a different run (protocol, f, n or seeds differ); use a new --out" % out)
        resumed = True
    else:
        resumed = False
    (out / "STOP").unlink(missing_ok=True) if resumed else None
    salt = load_salt(out)   # per-run secret, kept outside the run folder: opaque ids are HMACs under it
    human = {a["id"]: human_n(a) for a in protocol.arms if a.get("runnable") is not False}
    official = set(plan) == set(human) and all(plan[a] == (human[a][0] or -1) for a in plan) and not variant
    plan_note = {"per_arm": plan, "human_analysed_per_arm": {a: v[0] for a, v in human.items()},
                 "human_n_basis": {a: v[1] for a, v in human.items()}, "official": official,
                 "n_unverified_arms": sorted(a for a, v in human.items() if a in plan and v[1] == "n_paper_unverified"),
                 "why": "official only when every runnable arm runs at its human analysed n (--n paper, all arms) "
                        "on the original protocol; --n N, --arms or a variant give a non_official report (values, "
                        "no verdict)"}
    meta = {"schema": "hs-run-1", "principle": "answers = f(state): the study owns state and step; f is the user's",
            "study": protocol.id, "study_dir": str(sdir), "protocol_sha256": psha, "protocol_version": protocol.version,
            "variant": variant, "f": fdesc, "n": n, "n_per_arm": plan, "arms": sorted(plan), "seeds": seeds,
            "workers": workers, "participants_planned": members, "plan": plan_note,
            "top_up": {"enabled": bool(top_up), "rule": "after the planned sessions, more sessions per arm until its "
                       "valid units (completed; no whole-session exclusion, population cutoffs included) reach the "
                       "plan, at most %dx plan; no top-up for an arm whose first round was < %.0f%% valid (the run "
                       "is then reported short: underpowered_run); evaldata keeps the first planned valid units"
                       % (int(top_up_max), 100 * TOP_UP_MIN_SHARE), "max_factor": int(top_up_max)},
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
    runner = Runner(protocol, f, fdesc, out, workers, states, salt, top_up, top_up_max)
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
        meta["top_up"]["added_sessions_per_seed"] = {str(k): v for k, v in getattr(runner, "topped_up", {}).items()}
        meta["top_up"]["notes"] = {k: v for k, v in getattr(runner, "top_up_notes", {}).items() if v}
        if runner.auto_states:
            meta["states_kept"] = ("auto: screens for every participant" if runner.states_dropped_after is None else
                                   "auto: screens for the first %d participants, none after records.jsonl passed "
                                   "%d MB" % (runner.states_dropped_after, AUTO_STATES_BYTES // 2 ** 20))
        if do_eval:
            prog.stage("scoring")
            meta["evaluation"] = evaluate(protocol, envs, plan, fdesc, out, variant, baseline, effects_only,
                                          meta["top_up"], baseline_max_factor)
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
            for arm_notes in meta["top_up"]["notes"].values():
                for arm, why in arm_notes.items():
                    print("  top-up %s: %s" % (arm, why))
            ev_ = meta.get("evaluation") or {}
            for line in ev_.get("text_report") or []:
                print(line)
            if isinstance(ev_.get("evaldata"), str) and ev_["evaldata"] != "evaldata.json":
                print("  evaldata: %s" % ev_["evaldata"])
        return meta
    except BaseException as e:
        if not isinstance(e, SystemExit) or "stopped" not in str(e):
            prog.stage("failed", "%s: %s" % (type(e).__name__, e))
        raise
    finally:
        runner.close()
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
                         "auto = screen until records.jsonl holds %d MB, then none" % (AUTO_STATES_BYTES // 2 ** 20))
    ap.add_argument("--no-top-up", action="store_true", help="run exactly the planned sessions (no replacement of "
                    "excluded ones; the run may then be unscorable: underpowered_run)")
    ap.add_argument("--baseline-max-factor", type=int, default=10, help="top-up cap of the floor baseline")
    ap.add_argument("--top-up-max", type=int, default=TOP_UP_MAX_FACTOR,
                    help="top-up brake: at most this many times the planned sessions per arm (default %d)"
                         % TOP_UP_MAX_FACTOR)
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
            arms=[x.strip() for x in a.arms.split(",") if x.strip()] if a.arms else None, top_up=not a.no_top_up,
            baseline_max_factor=a.baseline_max_factor, top_up_max=a.top_up_max)
    except fspec.SpecError as e:
        sys.exit("f-spec: %s" % e)
    return 0


if __name__ == "__main__":
    sys.exit(main())
