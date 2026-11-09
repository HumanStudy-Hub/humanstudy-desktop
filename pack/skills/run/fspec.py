"""f-specs: the participant side of `answers = f(state)`.

We own the state and the step (the engine); f is the user's: a model + persona + how the State is rendered to it
+ memory + retries. An f-spec is a JSON object that describes f; run_study.py records it in run.json.

    {"kind": "random"}                                           # checks.random_answers on the State only
    {"kind": "random+gates"}                                     # random + answers that pass the page's gates:
                                                                 # an ORACLE (reads protocol internals); NOT the
                                                                 # scoring baseline (that is evaldata's State-only
                                                                 # `floor`, which `random` mirrors)
    {"kind": "keyed",  "name": "keyed"}                          # the protocol's keyed answers (an ORACLE)
    {"kind": "script", "callable": "my_f.py:answer"}             # a Python f(state[, ctx]) -> answers (tests)
    {"kind": "llm", "host": "host.py:make_f", "model": "…", "persona": "…", "renderer": "default",
     "retries": 2}                                               # host supplies the model call

Common fields: "name" (label), "retries" (re-calls of f when it raises; default 2 for llm, 0 otherwise),
"max_refusals" (a page that refuses this many answer sets in a row ends the participant as stuck; default 200
for random — the same 200 redraws as evaldata's floor baseline — and 20 otherwise).

f is called as f(state, ctx) (or f(state) if it takes one argument). ctx carries: rng (seeded per participant,
step and attempt, so a resumed run draws the same numbers), participant (an opaque id; never the condition),
member (p1, p2 … in groups), attempt (0 on first sight of a page, then 1, 2 … after the page refused answers —
the refusal message is in state["error"]), history (this participant's earlier [{state, answers}]), asset_path
(opaque image id -> local file), note (f may set a dict; it is stored with the step). Only the built-in baselines
(keyed, random+gates — both oracles) get ctx.operator (the session's internals) — a script or llm f never does.

API keys never go in an f-spec: a spec whose fields look like a key, token or secret is refused. An llm f-spec
names a host module whose factory returns the callable; the host reads its own credentials (environment).
"""
import hashlib
import importlib
import importlib.util
import inspect
import os
import random
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import render as _render   # noqa: E402

KINDS = ("random", "random+gates", "keyed", "script", "llm")
ORACLES = ("random+gates", "keyed")
# field names that hold a credential (whole names, case-insensitive; '-' == '_'); names ending in _env / _var /
# _name / _file only NAME where a credential lives and are allowed (e.g. api_key_env)
SECRET_NAMES = {"api_key", "apikey", "x_api_key", "key", "secret", "secret_key", "client_secret", "token",
                "access_token", "auth_token", "refresh_token", "bearer", "bearer_token", "password", "passwd",
                "authorization", "auth", "credential", "credentials", "private_key", "openrouter_api_key",
                "openai_api_key", "anthropic_api_key", "google_api_key", "gemini_api_key"}
SECRET_VAL = re.compile(
    r"(sk-[A-Za-z0-9_\-]{16,}|sk_(live|test)_[A-Za-z0-9]{10,}|AIza[0-9A-Za-z_\-]{30,}|"
    r"[Bb]earer\s+[A-Za-z0-9._\-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|"
    r"xox[abprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{20,}|"
    r"eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,})")


class SpecError(ValueError):
    pass


def check_no_secrets(obj, where="f-spec"):
    if isinstance(obj, dict):
        for k, v in obj.items():
            name = str(k).strip().lower().replace("-", "_")
            if name in SECRET_NAMES and v not in (None, "", False):
                raise SpecError("%s.%s looks like a credential; keys never go in files — the host supplies the "
                                "model callable and reads its own key" % (where, k))
            check_no_secrets(v, "%s.%s" % (where, k))
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            check_no_secrets(v, "%s[%d]" % (where, i))
    elif isinstance(obj, str) and SECRET_VAL.search(obj):
        raise SpecError("%s holds what looks like a credential; keys never go in files" % where)


def _sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_callable(ref, base):
    """'path/to/file.py:name' (relative to base) or 'package.module:name'."""
    mod, _, name = str(ref).rpartition(":")
    if not mod or not name:
        raise SpecError("callable %r must be 'file.py:name' or 'module:name'" % ref)
    if mod.endswith(".py"):
        path = Path(mod) if Path(mod).is_absolute() else (Path(base) / mod)
        path = path.resolve()
        if not path.is_file():
            raise SpecError("no file %s" % path)
        spec = importlib.util.spec_from_file_location("fspec_%s" % hashlib.sha1(str(path).encode()).hexdigest()[:8],
                                                      path)
        m = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(m)
        src = {"file": str(path), "sha256": _sha(path)}
    else:
        m = importlib.import_module(mod)
        f = getattr(m, "__file__", None)
        src = {"module": mod, "sha256": _sha(f) if f else None}
    if not hasattr(m, name):
        raise SpecError("%s has no %s" % (mod, name))
    return getattr(m, name), src


def in_process_source(fn):
    """sha256 of an in-process f's source (and its module file), so a changed f never resumes an old run. When
    the source cannot be read, a per-process id is used: such a run cannot be resumed."""
    out = {}
    try:
        out["source_sha256"] = hashlib.sha256(inspect.getsource(fn).encode()).hexdigest()
    except (OSError, TypeError):
        out["source_sha256"] = None
        out["unresumable"] = "%s-%s" % (os.getpid(), id(fn))
    try:
        mf = inspect.getsourcefile(fn)
        if mf and Path(mf).is_file():
            out["module_file"], out["module_sha256"] = mf, _sha(mf)
    except TypeError:
        pass
    cells = []   # functions and plain values the f closes over (e.g. the host's complete() in make_chat_f)
    for c in (getattr(fn, "__closure__", None) or ()):
        try:
            v = c.cell_contents
        except ValueError:
            continue
        if callable(v):
            try:
                cells.append(hashlib.sha256(inspect.getsource(v).encode()).hexdigest())
            except (OSError, TypeError):
                cells.append("unreadable:%s-%s" % (os.getpid(), id(v)))
                out["unresumable"] = out.get("unresumable") or "closure %r has no readable source" % (v,)
        elif isinstance(v, (str, int, float, bool, type(None), dict, list, tuple)):
            cells.append(_sha_obj(v))
    if cells:
        out["closure_sha256"] = _sha_obj(cells)
    for k in ("description",):
        if getattr(fn, k, None) is not None:
            out[k] = _sha_obj(getattr(fn, k))
    return out


def _sha_obj(o):
    import json as _j
    return hashlib.sha256(_j.dumps(o, sort_keys=True, default=str).encode()).hexdigest()


def arity(fn):
    try:
        ps = [p for p in inspect.signature(fn).parameters.values()
              if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
        return 2 if len(ps) >= 2 or any(p.kind == p.VAR_POSITIONAL for p in inspect.signature(fn).parameters.values()) else 1
    except (TypeError, ValueError):
        return 2


# ------------------------------------------------------------------------------------------------ built-ins
def _assist(p, s, page, state, ans, rng, pool):
    """Operator-side help to meet the page's own acceptance rules, exactly as checks.play does for its random and
    keyed policies: single-switch rows, constant sums, accepted values (validate equals/contains/min/max), free
    text drawn from the item's coding cases."""
    for n in page["names"]:
        ss = p.stages[n].get("single_switch")
        if ss and (ss.get("enforce", True) or rng.random() < 0.5):
            rs = [r for r in page["responses"] if r["stage"] == n and r["def"]["id"] in ss["responses"]]
            k = rng.randint(0, len(rs))
            for i, r in enumerate(rs):
                inv = {c: code for code, c in r["codes"].items()}
                want = ss["from"] if i < k else ss["to"]
                if want in inv:
                    ans[r["view"]["id"]] = inv[want]
        st_ = p.stages[n].get("sum_to")
        if st_:
            rs = [r for r in page["responses"] if r["stage"] == n and r["def"]["id"] in st_["responses"]]
            cuts = sorted(rng.randint(0, int(st_["total"])) for _ in range(len(rs) - 1))
            for r, v in zip(rs, [b - c for c, b in zip([0] + cuts, cuts + [int(st_["total"])])]):
                ans[r["view"]["id"]] = v
    for r in page["responses"]:
        rid = r["view"]["id"]
        ref = r["def"].get("coding_ref") or r["def"].get("coding")
        if r["def"]["kind"] == "text" and isinstance(ref, dict) and rid in ans:
            block = (p.raw.get("coding") or {}).get(ref.get("block"), {})
            own = [c["text"] for c in block.get("cases", []) if isinstance(c.get("text"), str)
                   and str(c.get("item")) == str(ref.get("item"))]
            if own and rng.random() < 0.85:
                t = rng.choice(own)
                ans[rid] = t + "x" * max(0, int(r["view"].get("min_chars", 1)) - len(t))
        v = r["def"].get("validate") or {}
        if rid in ans and "equals" in v:
            want = s.ev(v["equals"], r["bindings"]) if isinstance(v["equals"], dict) else v["equals"]
            if r["codes"]:
                inv = {c: k for k, c in r["codes"].items()}
                ans[rid] = [inv.get(w, w) for w in want] if isinstance(want, list) else inv.get(want, ans[rid])
            else:
                ans[rid] = want
        if rid in ans and "contains" in v and isinstance(ans[rid], str):
            ans[rid] = (ans[rid] + " " + v["contains"]).strip()
        if rid in ans and ("min" in v or "max" in v) and isinstance(ans[rid], (int, float)) \
                and not isinstance(ans[rid], bool):
            lo, hi = v.get("min", float("-inf")), v.get("max", float("inf"))
            if not lo <= ans[rid] <= hi:
                x = rng.uniform(max(lo, 0), min(hi, max(lo, 0) + 100))
                ans[rid] = int(round(x)) if (r["view"].get("integer") or r["def"]["kind"] == "scale") else round(x, 2)
    return ans


class _OwnRng:
    """An oracle evaluates protocol expressions (keyed answers, accepted values) in the session's context. Those
    may draw random numbers (bernoulli, choice); with the session's own rng they would shift the engine's later
    draws (e.g. balanced counterbalancing) and make a replayed run differ from the logged one. So the session's
    rng is swapped for one derived from ctx.rng for the duration of the oracle call."""

    def __init__(self, s, rng):
        self.s, self.rng = s, random.Random(rng.getrandbits(64))

    def __enter__(self):
        self.saved, self.s.rng = self.s.rng, self.rng
        return self.s

    def __exit__(self, *a):
        self.s.rng = self.saved
        return False


def _redraw_skip(attempt, skip):
    # first sight: the usual skip rate; after a refusal, redraw as checks.play does, sometimes leaving optional
    # answers empty so page rules such as "exactly one of these" can be met
    return skip if attempt == 0 else (0 if attempt % 2 else 0.5)


def random_f(protocol, spec, assist=False):
    """random: checks.random_answers on the State only — the random floor; a page it cannot satisfy by redrawing
    (a comprehension quiz, a typed agreement) ends the participant as stuck, and the completion rate says so.
    It mirrors evaldata's scoring baseline (policy `floor`: State only, 200 redraws).
    random+gates (assist): plus the operator-side help checks.play gives its `random` policy: it writes the
    accepted answers to the page's gates. That reads protocol internals, so it is an oracle like keyed — "random
    conditional on passing every gate" — never the random floor and not the scoring baseline."""
    from hsenv import checks
    skip = float(spec.get("skip", 0.05))
    pool = checks.text_pool(protocol) if assist else ()

    def f(state, ctx):
        ans = checks.random_answers(state, ctx.rng, skip=_redraw_skip(ctx.attempt, skip), pool=pool)
        if assist:
            with _OwnRng(ctx.operator(), ctx.rng) as s:
                ans = _assist(protocol, s, s._page, state, ans, ctx.rng, pool)
        return ans
    f.needs_operator = bool(assist)
    return f, {"what": "checks.random_answers" + (" + checks.play's operator-side help with the page's gates "
                                                  "(as checks.play's old random policy): an ORACLE, not the random "
                                                  "floor and not the scoring baseline" if assist else " on the State only: the random floor (mirrors evaldata's floor "
                                                  "baseline policy)"),
               "skip": skip, "oracle": bool(assist)}


def keyed_f(protocol, spec):
    """The protocol's keyed answers (protocol.keyed.answers, by stage.response), random elsewhere — the same
    oracle checks.play('keyed') uses. Reads operator-side keys; it is a sanity baseline, not a participant."""
    from hsenv import checks
    keyed = (protocol.raw.get("keyed") or {}).get("answers", {})
    if not keyed:
        raise SpecError("protocol %s has no keyed answers" % protocol.id)
    p = protocol
    pool = checks.text_pool(protocol)

    def f(state, ctx):
        with _OwnRng(ctx.operator(), ctx.rng) as s:
            return _keyed(s, state, ctx)

    def _keyed(s, state, ctx):
        page = s._page
        rng = ctx.rng
        ans = checks.random_answers(state, rng, skip=_redraw_skip(ctx.attempt, 0.05), pool=pool)
        ans.pop("_elapsed_ms", None)   # a keyed participant reports no screen times (RT rules must not exclude it)
        ans = _assist(p, s, page, state, ans, rng, pool)
        for r in page["responses"]:
            rid = r["view"]["id"]
            ref = "%s.%s" % (r["stage"], r["def"]["id"])
            if ref in keyed:
                want = s.ev({"expr": keyed[ref]}, r["bindings"])
                inv = {c: k for k, c in r["codes"].items()}
                ans[rid] = [inv.get(w, w) for w in want] if isinstance(want, list) else inv.get(want, want)
                vw = r["view"]
                if vw.get("kind") == "slider" and isinstance(vw.get("step"), (int, float)) and vw["step"] > 0 \
                        and isinstance(ans[rid], (int, float)) and not isinstance(ans[rid], bool):
                    lo_ = (vw.get("range") or [0])[0]
                    ans[rid] = round(lo_ + round((ans[rid] - lo_) / vw["step"]) * vw["step"], 10)
        return ans
    f.needs_operator = True
    return f, {"what": "protocol keyed answers (operator-side oracle, as checks.play 'keyed'); random elsewhere",
               "keyed_why": (protocol.raw.get("keyed") or {}).get("why")}


def build(spec, protocol, spec_dir=".", host_f=None):
    """-> (f, description). host_f: an in-process callable that overrides the spec's host/callable."""
    if not isinstance(spec, dict) or spec.get("kind") not in KINDS:
        raise SpecError("f-spec needs kind one of %s" % (KINDS,))
    check_no_secrets(spec)
    kind = spec["kind"]
    desc = {"kind": kind, "name": spec.get("name") or kind, "spec": spec}
    if "assist" in spec:
        raise SpecError("'assist' is gone: use kind \"random\" (State only) or \"random+gates\" (oracle)")
    if kind in ("random", "random+gates"):
        f, d = random_f(protocol, spec, assist=kind == "random+gates")
    elif kind == "keyed":
        f, d = keyed_f(protocol, spec)
    elif kind == "script":
        if host_f is not None:
            f, d = host_f, {"callable": getattr(host_f, "__qualname__", repr(host_f)), "in_process": True,
                            "source": in_process_source(host_f)}
        else:
            fn, src = load_callable(spec.get("callable", ""), spec_dir)
            f = fn(spec) if spec.get("factory") else fn
            d = {"callable": spec.get("callable"), "source": src}
    else:   # llm
        rname = spec.get("renderer", "default")
        if rname == "default":
            rend, rsrc = _render.render_state, {"file": str(HERE / "render.py"), "sha256": _sha(HERE / "render.py"),
                                                "name": "render.render_state (default)"}
        else:
            rend, rsrc = load_callable(rname, spec_dir)
            rsrc["name"] = rname
        if host_f is not None:
            f, hsrc = host_f, {"in_process": True, "callable": getattr(host_f, "__qualname__", repr(host_f)),
                               "source": in_process_source(host_f)}
        else:
            if not spec.get("host"):
                raise SpecError("an llm f-spec needs \"host\": \"file.py:make_f\" (a factory make_f(spec, render) "
                                "returning f(state[, ctx]) -> answers), or the host passes f in-process")
            factory, hsrc = load_callable(spec["host"], spec_dir)
            f = factory(spec, rend)
        fd = getattr(f, "description", None) or {}
        d = {"renderer": rsrc, "host": hsrc, "model": spec.get("model"), "persona": spec.get("persona"),
             "images": fd.get("images") or spec.get("images") or
             "not declared by the host: assume images are NOT shown (the default renderer gives only opaque ids)",
             "memory": spec.get("memory", "as the host's f implements it"),
             "f_description": getattr(f, "description", None)}
    desc.update(d)
    desc["retries"] = int(spec.get("retries", 2 if kind == "llm" else 0))
    desc["max_refusals"] = int(spec.get("max_refusals", 200 if kind == "random" else 20))
    desc["operator_access"] = kind in ORACLES and bool(getattr(f, "needs_operator", False))
    desc["oracle"] = kind in ORACLES
    if arity(f) == 1:
        one = f
        f = lambda state, ctx: one(state)   # noqa: E731
    return f, desc


class Ctx:
    def __init__(self, seed_key, attempt, participant, member, history, asset_path, operator=None):
        self.rng = random.Random(seed_key)
        self.attempt = attempt
        self.participant = participant
        self.member = member
        self.history = history
        self.asset_path = asset_path
        self._operator = operator
        self.note = None

    def operator(self):
        if self._operator is None:
            raise RuntimeError("operator access is for the keyed oracle only")
        return self._operator()
