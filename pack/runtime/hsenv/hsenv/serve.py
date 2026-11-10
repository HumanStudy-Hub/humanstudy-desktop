"""Shared core for the two outside-agent doors (DESIGN.md §9): serve_mcp (MCP over stdio) and serve_http.

A thin layer over engine.Env: sessions live in memory under a random id. Two modes:

- participant (default): responses carry the caller's own State only. Study handles are opaque and salted per
  server run ("st-" + 12 hex of sha256(salt|id), stable within one server run, different on the next), and only
  handles are accepted, never real study or arm ids. The server assigns the arm (balanced draw over the arms the
  operator allows) and a hidden seed; a participant cannot choose either. A group arm gives each participant its
  own session (a seat) and its own State; nobody sees another member's screen. get_record and score are refused.
  States are sent as a diff: `seen`/`answered` carry only entries new since the caller's last response
  (`seen_from`/`answered_from` say where they start; `seen_updates` re-flags earlier entries whose `reviewable`
  changed). get_state(history=true) returns the caller's whole State once.
- operator (HSENV_MODE=operator or --operator): adds real ids, arm/seed choice, whole-group views, the SessionSpec,
  records and scores. Never give an operator server to the agent being studied.

Limits: at most `max_sessions` live sessions; a session untouched for `ttl` seconds is dropped (with its record).
The HTTP door also binds each session to a secret `key` returned once by open_session (`require_key`).

Determinism: an operator's open_session(seed=k) draws the arm (if not given) and the session seed from k exactly
as Env.design does, so the same seed gives the same States. A participant session's seed comes from the server's
base seed (random unless the operator sets one), so an operator can replay a server run. Balanced randomisers
(`balanced(...)`) count across all sessions of a study on one server, as they do across an Env's sessions.
"""
import base64
import copy
import hashlib
import hmac
import json
import mimetypes
import os
import random
import secrets
import threading
import time
from pathlib import Path

from .engine import Env, GroupSession, Protocol, ProtocolError, _seed

DEFAULT_STUDIES = Path(__file__).resolve().parent.parent / "studies"
GENERIC_ERROR = "the session could not continue"
MAX_SESSIONS = 256
TTL_SECONDS = 2 * 3600


class ServeError(Exception):
    """An error safe to show in either mode (it carries no protocol internals)."""

    def __init__(self, message, code=400):
        super().__init__(message)
        self.code = code


def _clean(obj):
    return json.loads(json.dumps(obj, default=str))


def study_handle(study_id, salt):
    """Opaque study handle: stable for one salt (one server run), not computable from the id without it."""
    return "st-" + hashlib.sha256(("hsenv-study|%s|%s" % (salt, study_id)).encode()).hexdigest()[:12]


def _same(a, b):
    """Constant-time string comparison (hmac.compare_digest refuses non-ASCII str)."""
    return hmac.compare_digest(a.encode("utf-8", "replace"), b.encode("utf-8", "replace"))


def _env_int(name, default):
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


def _null_text(state):
    """True when a State's screen would show a gap as text: an item whose text is null, a null prompt, or a null
    option label (DESIGN §2 rule 2: a missing text is never served; schema_check.rule2_gaps catches it earlier)."""
    scr = state.get("screen") if isinstance(state, dict) else None
    if not isinstance(scr, dict):
        return False
    for it in scr.get("items") or []:
        if isinstance(it, dict) and "text" in it and it["text"] is None and it.get("type", "text") == "text":
            return True
    for r in scr.get("responses") or []:
        if not isinstance(r, dict):
            continue
        if "prompt" in r and r["prompt"] is None:
            return True
        for o in r.get("options") or []:
            if isinstance(o, dict) and "label" in o and o["label"] is None:
                return True
    return False


class _Gone:
    """What the opening log keeps of an unfinished session after the TTL dropped it: enough for score() to count it
    as an invalid unit (status None), nothing else."""
    status = None
    group = None

    def __init__(self, spec, pid):
        self.spec, self.pid = dict(spec), pid


class Server:
    """operator: None reads HSENV_MODE. assign: {study id: [arm ids]} the server may draw from (operator config;
    default: every runnable arm). base_seed: participant sessions' seeds derive from it (default: random, hidden).
    full_history: send whole States instead of diffs (operator config). require_key: bind sessions to a key.
    opens_per_client: cap on participant opens per client and study (None: no cap). A known client (the stdio
    client, an HTTP participant token) always gets the same arm of a study, so repeated opens cannot collect arms.
    participant_tokens: HTTP only; when set, opening a session needs one of them (X-Participant-Token)."""

    def __init__(self, studies_dir=None, operator=None, studies=None, assign=None, base_seed=None,
                 max_sessions=None, ttl=None, full_history=False, require_key=False, opens_per_client=None,
                 participant_tokens=None):
        if operator is None:
            operator = os.environ.get("HSENV_MODE", "participant").strip().lower() == "operator"
        self.operator = bool(operator)
        self.root = Path(studies_dir or os.environ.get("HSENV_STUDIES") or DEFAULT_STUDIES)
        only = studies if studies is not None else [x for x in os.environ.get("HSENV_ONLY", "").split(",") if x]
        self._only = set(only or [])
        ids = self._scan()
        missing = sorted(self._only - set(ids))
        if missing:
            raise ServeError("--only names studies not found in %s: %s" % (self.root, ", ".join(missing)))
        if not ids:
            raise ServeError("no studies found in %s: pass --studies DIR (or set HSENV_STUDIES) pointing at a "
                             "folder of <study>/protocol.json" % self.root)
        self._ids = ids
        self.assign = {k: list(v) for k, v in (assign or {}).items()}
        self.max_sessions = int(max_sessions or _env_int("HSENV_MAX_SESSIONS", MAX_SESSIONS))
        self.ttl = float(ttl or _env_int("HSENV_TTL", TTL_SECONDS))
        self.full_history = bool(full_history)
        self.require_key = bool(require_key)
        self.opens_per_client = int(opens_per_client) if opens_per_client else None
        self.participant_tokens = frozenset(participant_tokens or ())
        self._clients = {}     # (client, study id) -> {"arm": arm id, "opens": n}
        # opening log (review rewards-3 M4): score() counts every opened session in this order, including ones the TTL
        # later dropped. Compact: {session, study, arm, gid, members}; an expired unfinished member becomes a _Gone.
        # Created here so every view (as_operator / as_participant are shallow copies) shares the one list.
        self._opened = []
        self._baselines = {}   # (study, protocol version, planned n) -> baseline run (score; deterministic)
        self._salt = secrets.token_hex(16)
        self._protocols = {}   # study id -> Protocol (loaded lazily)
        self._envs = {}        # study id -> Env (one per study: shared balanced-randomiser counts)
        self.sessions = {}     # session id -> entry (see _new_entry)
        self._forming = {}     # study id -> [group record with free seats]
        self._ctr = {"n": 0, "arm": {}, "draw": {}}   # shared with operator views (as_operator is shallow)
        self._seed0 = base_seed if base_seed is not None else secrets.randbits(62)
        self._rng = random.Random(self._seed0) if base_seed is not None else secrets.SystemRandom()
        self.lock = threading.RLock()

    def as_operator(self):
        """An operator view sharing this server's sessions (for an operator token on the HTTP door)."""
        view = copy.copy(self)   # shallow: same session table, envs, counters and lock
        view.operator = True
        return view

    def as_participant(self):
        view = copy.copy(self)
        view.operator = False
        return view

    # ------------------------------------------------------------------ studies
    def _scan(self):
        if not self.root.is_dir():
            return []
        ids = sorted(d.name for d in self.root.iterdir() if (d / "protocol.json").is_file())
        return [i for i in ids if not self._only or i in self._only]

    def handle(self, sid):
        return study_handle(sid, self._salt)

    def _protocol(self, sid):
        if sid not in self._protocols:
            self._protocols[sid] = Protocol.load(self.root / sid)
            self._envs[sid] = Env(self._protocols[sid])
        return self._protocols[sid]

    def _resolve_study(self, study):
        if not isinstance(study, str) or not study:
            raise ServeError("study is required (a handle from list_studies)")
        for sid in self._ids:
            if _same(study, self.handle(sid)) or (self.operator and study == sid):
                return sid
        raise ServeError("unknown study", 404)

    @staticmethod
    def _runnable(p):
        return [a for a in p.arms if a.get("runnable") is not False]

    def _allowed(self, sid, p):
        arms = self._runnable(p)
        want = self.assign.get(sid)
        return [a for a in arms if a["id"] in want] if want else arms

    def list_studies(self):
        with self.lock:   # _protocol loads lazily; a concurrent first load must not replace a study's Env
            return self._list_studies()

    def _list_studies(self):
        out = []
        for sid in self._ids:
            try:
                p = self._protocol(sid)
            except (OSError, ValueError, KeyError):
                continue
            arms = self._runnable(p)
            if not arms:
                continue
            if self.operator:
                meta = p.raw.get("meta") or {}
                allowed = {a["id"] for a in self._allowed(sid, p)}
                out.append({"id": sid, "handle": self.handle(sid),
                            "title": meta.get("title") or meta.get("citation") or sid,
                            "arms": [{"id": a["id"], "n_paper": a.get("n_paper"), "group_size": a.get("group_size"),
                                      "assigned": a["id"] in allowed} for a in arms]})
            else:
                out.append({"study": self.handle(sid)})
        return {"studies": out}

    # ------------------------------------------------------------------ session table
    def _gc(self):
        now = time.monotonic()
        dead = [k for k, e in self.sessions.items() if now - e["last"] > self.ttl]
        gone, lists = [], []
        for k in dead:
            e = self.sessions.pop(k)
            g = e.get("grp")
            if g is not None:
                g["seats"].pop(e["pid"], None)
                forming = self._forming.get(g["study"], [])
                if g in forming:   # a member left: the group can never complete, so it ends for everyone
                    forming.remove(g)
                g["free"] = []
                g["ended"] = True
                if g["seats"]:
                    continue
                gone.extend(g["obj"].members)
            else:
                gone.extend(e["obj"].members if e["group"] else [e["obj"]])
            lists.append(e["log"])
        if gone:   # let the engine forget them too (Env.sessions only grows otherwise)
            ids = {id(m) for m in gone}
            for env in self._envs.values():
                env.sessions = [s for s in env.sessions if id(s) not in ids]
            for lst in lists:   # the log keeps finished members (the data) and a stub for unfinished ones
                for i, m in enumerate(lst):
                    if id(m) in ids and not m.status:
                        lst[i] = _Gone(m.spec, m.pid)

    def _new_id(self):
        while True:
            sid = "s-" + secrets.token_urlsafe(16)
            if sid not in self.sessions:
                return sid

    def _add(self, entry):
        session = self._new_id()
        entry.update(last=time.monotonic(), key=secrets.token_urlsafe(24), sent={"seen": [], "answered": 0})
        self.sessions[session] = entry
        g = entry.get("grp")
        if g is not None:   # seats share one member list (all of the group) and count once in score()
            entry["log"] = g.setdefault("log", list(g["obj"].members))
        else:
            entry["log"] = list(entry["obj"].members if entry["group"] else [entry["obj"]])
        self._opened.append({"session": session, "study": entry["study"], "arm": entry["arm"],
                             "gid": id(entry["log"]) if g is not None else None, "members": entry["log"]})
        return session

    def _entry(self, session, key=None):
        self._gc()
        e = self.sessions.get(session) if isinstance(session, str) else None
        if e is not None and self.require_key and not self.operator:
            if not isinstance(key, str) or not _same(key, e["key"]):
                e = None   # same answer as an unknown id: no oracle for valid ids
        if e is None:
            raise ServeError("unknown session (or wrong key)" if self.require_key else "unknown session", 404)
        e["last"] = time.monotonic()
        return e

    def _fail(self, e):
        if self.operator:
            raise ServeError("%s: %s" % (type(e).__name__, e), 500)
        raise ServeError(GENERIC_ERROR, 500)

    # ------------------------------------------------------------------ views
    def _trim(self, e, state, full):
        """The participant's State as a diff against what this session was last sent (full: everything)."""
        if not self.operator and _null_text(state):   # DESIGN §2 rule 2, last line of defence
            self._fail(ProtocolError("a screen shows a missing gap (null text)"))
        if self.operator or not isinstance(state, dict) or not isinstance(state.get("seen"), list):
            return state   # an operator always sees whole States, and looking does not move the participant's diff
        seen, ans = state["seen"], state.get("answered") or []
        sent = e["sent"]
        flags = [bool(x.get("reviewable")) for x in seen]
        k = len(sent["seen"]) if len(sent["seen"]) <= len(seen) else 0
        j = sent["answered"] if sent["answered"] <= len(ans) else 0
        if full or self.full_history:
            k = j = 0
        out = dict(state, seen=seen[k:], seen_from=k, answered=ans[j:], answered_from=j)
        upd = [{"n": i, "reviewable": flags[i]} for i in range(k) if flags[i] != sent["seen"][i]]
        if upd:
            out["seen_updates"] = upd
        e["sent"] = {"seen": flags, "answered": len(ans)}
        return out

    def _view(self, sid, e, state=None, full=False, opened=False):
        out = {"session": sid}
        if e.get("grp") is not None:   # a participant's seat in a group: its own State only
            m = e["member"]
            st = state if state is not None else m.state()
            if e["grp"].get("ended") and not (st or {}).get("done"):
                st = {"participant": m.pid, "done": True, "step": m.step_no,
                      "ended": "the session ended: another member of the group left"}
            out["state"] = self._trim(e, st, full)
        elif e["group"]:               # operator: the whole group
            obj = e["obj"]
            states = state if state is not None else obj.states()
            out["participants"] = [m.pid for m in obj.members]
            out["pending"] = obj.pending()
            out["states"] = states
            out["done"] = all((s or {}).get("done") for s in states.values())
        else:
            st = state if state is not None else e["obj"].state()
            out["state"] = st if self.operator else self._trim(e, st, full)
        if opened and self.require_key and not self.operator:
            out["key"] = e["key"]
        if self.operator:
            out.update(study=e["study"], arm=e["arm"], spec=e["spec"])
            if e.get("grp") is not None:
                out["participant"] = e["pid"]
        return _clean(out)

    # ------------------------------------------------------------------ sessions
    def _draw_arm(self, sid, arms):
        """Balanced: the allowed arm with the fewest sessions (groups) opened so far; ties broken at random."""
        counts = self._ctr["draw"]
        low = min(counts.get((sid, a["id"]), 0) for a in arms)
        pick = self._rng.choice([a for a in arms if counts.get((sid, a["id"]), 0) == low])
        counts[(sid, pick["id"])] = low + 1
        return pick

    def _spec(self, sid, env, a, seed):
        spec = dict(env.design(n=1, seed=seed, arms=[a["id"]])[0])
        k = self._ctr["arm"].get((sid, a["id"]), 0)
        self._ctr["arm"][(sid, a["id"])] = k + 1
        spec["index"] = k   # distinct records; the session seed stays a function of (seed, arm) only
        return spec

    def open_session(self, study, arm=None, seed=None, client=None):
        with self.lock:
            self._gc()
            if len(self.sessions) >= self.max_sessions:
                raise ServeError("the server is full (%d live sessions); try again later" % self.max_sessions, 503)
            sid_ = self._resolve_study(study)
            p = self._protocol(sid_)
            env = self._envs[sid_]
            if not self.operator:
                if arm is not None or seed is not None:
                    raise ServeError("arm and seed are assigned by the server")
                return self._open_participant(sid_, p, env, client)
            runnable = self._runnable(p)
            if not runnable:
                raise ServeError("no runnable arm", 404)
            self._ctr["n"] += 1
            if seed is None:
                seed = _seed(self._seed0, "session", self._ctr["n"])
            if isinstance(seed, bool) or not isinstance(seed, int):
                raise ServeError("seed must be an integer")
            if arm is None:
                a = runnable[random.Random(_seed(seed, "arm")).randrange(len(runnable))]
            else:
                a = next((x for x in runnable if arm == x["id"]), None)
                if a is None:
                    raise ServeError("unknown arm %r" % (arm,), 404)
            spec = self._spec(sid_, env, a, seed)
            try:
                obj = env.open(spec)
                state = obj.reset()
            except Exception as e:   # noqa: BLE001
                self._fail(e)
            entry = {"study": sid_, "arm": a["id"], "spec": spec, "obj": obj, "group": isinstance(obj, GroupSession)}
            session = self._add(entry)
            return self._view(session, entry, state, opened=True)

    def _open_participant(self, sid_, p, env, client=None):
        me = self._clients.setdefault((client, sid_), {"arm": None, "opens": 0}) if client is not None else None
        if me is not None and self.opens_per_client and me["opens"] >= self.opens_per_client:
            raise ServeError("this client has opened its %d session(s) of this study" % self.opens_per_client, 429)
        sticky = me["arm"] if me is not None else None
        forming = self._forming.setdefault(sid_, [])
        g = next((x for x in forming if x["free"] and sticky in (None, x["arm"])), None)
        if g is None:
            arms = self._allowed(sid_, p)
            if not arms:
                raise ServeError("no runnable arm", 404)
            a = next((x for x in arms if x["id"] == sticky), None) if sticky else None
            if a is None:
                a = self._draw_arm(sid_, arms)
            elif g is None:
                self._ctr["draw"][(sid_, a["id"])] = self._ctr["draw"].get((sid_, a["id"]), 0) + 1
            self._ctr["n"] += 1
            spec = self._spec(sid_, env, a, _seed(self._seed0, "session", self._ctr["n"]))
            try:
                obj = env.open(spec)
                state = obj.reset()
            except Exception as e:   # noqa: BLE001 - never leak protocol errors to a participant
                self._fail(e)
            if not isinstance(obj, GroupSession):
                entry = {"study": sid_, "arm": a["id"], "spec": spec, "obj": obj, "group": False}
                session = self._add(entry)
                if me is not None:
                    me.update(arm=a["id"], opens=me["opens"] + 1)
                return self._view(session, entry, state, opened=True)
            g = {"study": sid_, "arm": a["id"], "spec": spec, "obj": obj, "free": [m.pid for m in obj.members],
                 "seats": {}}
            forming.append(g)
        pid = g["free"].pop(0)
        if not g["free"]:
            forming.remove(g)
        member = next(m for m in g["obj"].members if m.pid == pid)
        entry = {"study": sid_, "arm": g["arm"], "spec": g["spec"], "obj": g["obj"], "group": True, "grp": g,
                 "pid": pid, "member": member}
        session = self._add(entry)
        g["seats"][pid] = session
        if me is not None:
            me.update(arm=g["arm"], opens=me["opens"] + 1)
        return self._view(session, entry, opened=True)

    def get_state(self, session, key=None, history=False):
        with self.lock:
            e = self._entry(session, key)
            return self._view(session, e, full=bool(history))

    def step(self, session, answers, participant=None, key=None):
        with self.lock:
            e = self._entry(session, key)
            obj = e["obj"]
            if answers is None:
                answers = {}
            if not isinstance(answers, dict):
                raise ServeError("answers must be an object {response id: value}")
            if e.get("grp") is not None:   # a participant seat
                if participant not in (None, e["pid"]):
                    raise ServeError("this session answers for its own participant only")
                participant = e["pid"]
                st = e["member"].state() or {}
                if st.get("done") or e["grp"].get("ended"):
                    return dict(self._view(session, e), error="session is done")
                if participant not in obj.pending():
                    return dict(self._view(session, e), error="nothing to answer now: waiting for the group")
                try:
                    states = obj.step(participant, answers)
                except Exception as ex:   # noqa: BLE001
                    self._fail(ex)
                out = self._view(session, e, states.get(participant))
                if (states.get(participant) or {}).get("error"):
                    out["error"] = states[participant]["error"]
                return out
            if e["group"]:   # operator: the whole group in one session
                pend = obj.pending()
                if participant is None and len(pend) == 1:
                    participant = pend[0]
                if not isinstance(participant, str) or participant not in [m.pid for m in obj.members]:
                    raise ServeError("participant is required (one of %s)" % ", ".join(pend or ["-"]))
                if participant not in pend:
                    out = self._view(session, e)
                    out["error"] = "participant %s has nothing to answer now" % participant
                    return out
                try:
                    states = obj.step(participant, answers)
                except Exception as ex:   # noqa: BLE001
                    self._fail(ex)
                out = self._view(session, e, states)
                if (states.get(participant) or {}).get("error"):
                    out["error"] = states[participant]["error"]
                return out
            if participant is not None:
                raise ServeError("participant applies to group sessions only")
            cur = obj.state() or {}
            if cur.get("done"):
                return dict(self._view(session, e), error="session is done")
            try:
                st = obj.step(answers)
            except Exception as ex:   # noqa: BLE001
                self._fail(ex)
            return self._view(session, e, st)

    def get_asset(self, session, ref, key=None):
        """Bytes of an image the State references as "asset:<id>" (what the human saw)."""
        with self.lock:
            e = self._entry(session, key)
            path = self._envs[e["study"]].asset_path(ref) if isinstance(ref, str) and ref.startswith("asset:") else None
            if not path or not Path(path).is_file():
                raise ServeError("unknown asset", 404)
            mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
            return {"mimeType": mime, "data": base64.b64encode(Path(path).read_bytes()).decode()}

    # ------------------------------------------------------------------ operator only
    def _require_operator(self, what):
        if not self.operator:
            raise ServeError("%s is not available in participant mode" % what, 403)

    def _members(self, e):
        if e.get("grp") is not None:
            return [e["member"]]
        return e["obj"].members if e["group"] else [e["obj"]]

    def get_record(self, session):
        self._require_operator("get_record")
        with self.lock:
            e = self._entry(session)
            return _clean({"session": session, "study": e["study"], "arm": e["arm"], "spec": e["spec"],
                           "records": [m.record() for m in self._members(e)]})

    def score(self, study, run="all"):
        """Rewards (DESIGN §8.7) on this server's sessions of a study. Every session the server opened for the study
        counts, in opening order, until the planned n (human analysed n; groups count once) of VALID units per arm
        is reached, as evaldata._truncate does. Unfinished, expired or excluded sessions before that point are scored
        as invalid (they enter the exclusion rate and the intention-to-treat view). A caller-chosen list of sessions is never scored (review rewards-2
        M2). The baseline is the State-only floor at the planned n."""
        self._require_operator("score")
        try:
            from . import rewards as R
            from .evaldata import EvalData, agent_n, baseline_run, run_from_env
        except Exception as ex:   # noqa: BLE001 - rewards are optional here
            return {"status": "not_available", "reason": "%s: %s" % (type(ex).__name__, ex)}
        if run not in (None, "all"):
            return {"status": "error", "error": "a caller-chosen list of sessions is not scored: every session "
                                                "opened for the study counts (first planned n per arm, in order)"}
        with self.lock:
            sid_ = self._resolve_study(study)
            p = self._protocol(sid_)
            planned, missing = agent_n(p)
            if missing:
                return {"status": "error", "error": "arms %s print no human n: no planned n" % missing}
            self._gc()
            log = [r for r in self._opened if r["study"] == sid_]   # opening order, expired sessions included
            ids = [r["session"] for r in log]
            expired = sum(1 for k in ids if k not in self.sessions)
            members, used, groups, opened, extra, valid = [], {}, set(), {}, 0, {}
            for e in log:
                if e["gid"] is not None:   # seats of one group count once, with all members
                    if e["gid"] in groups:
                        continue
                    groups.add(e["gid"])
                ms = e["members"]
                opened[e["arm"]] = opened.get(e["arm"], 0) + 1
                if valid.get(e["arm"], 0) >= planned.get(e["arm"], 0):
                    extra += 1   # after the planned n of valid units: recorded, not scored
                    continue
                used[e["arm"]] = used.get(e["arm"], 0) + 1   # invalid units before that are scored (as invalid)
                members += ms
                whole = {x["id"] for x in p.exclusions if x.get("applies_to") is None}
                if all(m.status == "completed" and not (set(m.record()["excluded"]) & whole) for m in ms):
                    valid[e["arm"]] = valid.get(e["arm"], 0) + 1
            if not members:
                raise ServeError("no sessions opened for this study")
            # snapshot (review serve-3 S2): a finished member no longer changes; an unfinished one, which a participant
            # may step while rewards are computed, is frozen as a stub that scores as invalid, as it would right now
            members = [m if m.status else _Gone(m.spec, m.pid) for m in members]
            bkey = (sid_, p.version, tuple(sorted(planned.items())))
            base = self._baselines.get(bkey)
        # the rewards are computed outside the lock: participants keep stepping while an operator scores
        try:
            env = Env(p)
            env.sessions = members   # unfinished members are rows with status incomplete (invalid)
            agent = run_from_env(env, seed=0, policy="outside")
            if base is None:   # deterministic per study, protocol version and planned n: computed once per server
                base = self._baselines.setdefault(bkey, baseline_run(p, planned, 0))
            ev = EvalData.build(p, [agent], baseline=copy.deepcopy(base), planned=planned, provenance={
                "policy": "outside agent via hsenv.serve", "opened_per_arm": opened, "scored_per_arm": used,
                "opened_beyond_plan": extra, "expired_by_ttl": expired, "planned_per_arm": planned,
                "baseline_seed": 0, "seeds": [0],
                "leaderboard": "not a leaderboard: the operator chooses arms and seeds; leaderboard runs need "
                               "their own server (DESIGN §8.7)",
                "rule": "opening order until the planned n of valid units per arm; earlier invalid ones counted"})
            out = {}
            for rid in R.DEFAULT:
                out[rid] = R.score(ev, rid).to_dict()
        except Exception as ex:   # noqa: BLE001
            return {"status": "error", "error": "%s: %s" % (type(ex).__name__, ex)}
        pl = ev.d.get("plan") or {}
        sp = [v.get("spec") or {} for v in out.values()]
        return _clean({"status": "ok", "study": sid_, "report_scope": R.REPORT_SCOPE,
                       "official": pl.get("official"), "official_n_basis": pl.get("official_n_basis"),
                       "human_n_basis": pl.get("human_n_basis"), "n_unverified_arms": pl.get("n_unverified_arms"),
                       "itt_unchecked": any(x.get("itt_unchecked") for x in sp),
                       "itt_not_applicable": any(x.get("itt_not_applicable") for x in sp),
                       "dropouts": next((x["exclusion_rates"].get("agent_dropouts") for x in sp
                                         if x.get("exclusion_rates")), None),
                       "planned_per_arm": planned,
                       "opened_per_arm": opened, "scored_per_arm": used, "expired_by_ttl": expired,
                       "rewards": out})


# ---------------------------------------------------------------------- tool table shared by both doors
def tools(operator, keyed=False):
    sess = {"type": "string", "description": "session id from open_session"}
    key = {"key": {"type": "string", "description": "the key open_session returned with this session"}} if keyed else {}
    kreq = ["key"] if keyed and not operator else []
    if operator:
        open_args = {"study": {"type": "string", "description": "study id or handle"},
                     "arm": {"type": "string", "description": "optional arm id"},
                     "seed": {"type": "integer", "description": "optional; same seed, same session"}}
        step_args = {"session": sess, "answers": {"type": "object"},
                     "participant": {"type": "string", "description": "group sessions: who is answering"}}
    else:
        open_args = {"study": {"type": "string", "description": "a study handle from list_studies"}}
        step_args = dict({"session": sess, "answers": {"type": "object"}}, **key)
    t = [
        ("list_studies", "List the studies that can be taken.", {}, []),
        ("open_session", "Start a session. Returns the session id and the first screen (State)%s." %
         (", and the key every later call on it needs" if keyed and not operator else ""), open_args, ["study"]),
        ("get_state", "The current State of a session. history=true resends everything seen and answered so far "
                      "(other responses carry only what is new).",
         dict({"session": sess, "history": {"type": "boolean"}}, **key), ["session"] + kreq),
        ("step", "Submit answers for the current screen as {response id: value}. Returns the next State, or the "
                 "same State with an error.", step_args, ["session", "answers"] + kreq),
        ("get_asset", "An image shown on screen, by its asset:<id> reference.",
         dict({"session": sess, "ref": {"type": "string"}}, **key), ["session", "ref"] + kreq),
    ]
    if operator:
        t += [
            ("get_record", "Operator: the session's record (answers, status, exclusions) and SessionSpec.",
             {"session": sess}, ["session"]),
            ("score", "Operator: rewards (DESIGN §8.7) on every session this server opened for a study (opening order, "
                      "expired ones included, up to the planned n of valid units per arm).",
             {"study": {"type": "string"},
              "run": {"enum": ["all"], "description": 'only "all": a chosen list of sessions is never scored'}},
             ["study"]),
        ]
    return [{"name": n, "description": d,
             "inputSchema": {"type": "object", "properties": props, "required": req, "additionalProperties": False}}
            for n, d, props, req in t]


def call(server, name, args, client=None):
    """Run one tool. Raises ServeError for anything the caller got wrong (unknown tool, bad argument types)."""
    if not isinstance(name, str):
        raise ServeError("tool name must be a string")
    if args is None:
        args = {}
    if not isinstance(args, dict):
        raise ServeError("arguments must be an object")
    table = {t["name"]: t for t in tools(server.operator, keyed=server.require_key)}
    if name not in table:
        if name in ("get_record", "score"):
            raise ServeError("%s is not available in participant mode" % name, 403)
        raise ServeError("unknown tool %r" % (name[:60],), 404)
    props = table[name]["inputSchema"]["properties"]
    extra = sorted(k for k in args if k not in props)
    if extra:
        if not server.operator and set(extra) & {"arm", "seed"}:
            raise ServeError("arm and seed are assigned by the server")
        raise ServeError("unknown argument(s): %s" % ", ".join(str(k)[:40] for k in extra))
    for k in ("study", "session", "participant", "ref", "key"):
        if k in args and args[k] is not None and not isinstance(args[k], str):
            raise ServeError("%s must be a string" % k)
    if "history" in args and not isinstance(args["history"], bool):
        raise ServeError("history must be true or false")
    a = args.get
    if name == "list_studies":
        return server.list_studies()
    if name == "open_session":
        return server.open_session(a("study"), a("arm"), a("seed"), client=client)
    if name == "get_state":
        return server.get_state(a("session"), a("key"), a("history", False))
    if name == "step":
        return server.step(a("session"), a("answers"), a("participant"), a("key"))
    if name == "get_asset":
        return server.get_asset(a("session"), a("ref"), a("key"))
    if name == "get_record":
        return server.get_record(a("session"))
    if name == "score":
        return server.score(a("study"), a("run", "all"))
    raise ServeError("unknown tool", 404)
