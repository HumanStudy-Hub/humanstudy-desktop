"""Mechanical checks for a protocol (DESIGN.md v3.1 §5). No model calls.

    python -m hsenv.checks studies/<id> [--sessions 1000] [--source-text survey=path.txt ...]
"""
import argparse
import hashlib
import json
import math
import random
import re
import sys
import unicodedata
from pathlib import Path

from . import effects_core
from .engine import Env, Protocol, ProtocolError
from .expr import ExprError, evaluate

ANSWER_REF = re.compile(r"answers?\(\s*'([^']+)'")


def text_pool(p):
    pool = []
    for c in (p.raw.get("coding") or {}).values():
        pool += [x["text"] for x in c.get("cases", []) if isinstance(x.get("text"), str)]
    return pool


def random_answers(state, rng, skip=0.05, pool=()):
    out = {"_elapsed_ms": int(rng.lognormvariate(8.3, 1.0))}   # random time on screen (median ~4 s), for RT rules
    for r in state["screen"]["responses"]:
        k = r["kind"]
        if not r.get("required", True) and rng.random() < skip:
            continue
        if r.get("na_option") and rng.random() < 0.05:
            out[r["id"]] = "NA"
            continue
        if k == "choice":
            out[r["id"]] = rng.choice(r["options"])["code"]
        elif k == "multi":
            pick = [o["code"] for o in r["options"] if rng.random() < 0.5]
            if not pick and r.get("required", True):
                pick = [rng.choice(r["options"])["code"]]
            out[r["id"]] = pick
        elif k in ("number", "scale", "slider"):
            lo, hi = (r.get("range") or [0, 100])[:2]
            lo = 0 if lo is None else lo
            hi = lo + 100 if hi is None else hi
            v = rng.uniform(lo, hi)
            if k == "slider" and isinstance(r.get("step"), (int, float)) and r["step"] > 0:   # a slider moves on its grid
                v = min(hi, lo + round((v - lo) / r["step"]) * r["step"])
                out[r["id"]] = round(v, 10) if not float(v).is_integer() else int(v)
            else:
                out[r["id"]] = int(round(v)) if (r.get("integer") or k == "scale") else round(v, 1)
        elif k == "text":
            t = rng.choice(pool) if pool and rng.random() < 0.8 else "x"
            out[r["id"]] = t + "x" * max(0, int(r.get("min_chars", 1)) - len(t))
    return out


def _walk_exprs(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("expr", "if", "until") and isinstance(v, str):
                yield v
            else:
                yield from _walk_exprs(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_exprs(v)
    elif isinstance(obj, str) and "answer(" in obj:
        yield obj


def check_refs(p):
    problems = []
    responses = {"%s.%s" % (s, r["id"]) for s, st in p.stages.items() for r in st.get("responses", [])}
    items = {"%s.%s" % (s, i["id"]) for s, st in p.stages.items() for i in st.get("content", [])}

    def flow_stages(n):
        if isinstance(n, list):
            for x in n:
                yield from flow_stages(x)
        elif isinstance(n, dict):
            if "stage" in n:
                yield n["stage"]
            if "page" in n:   # a page list, or the single terminal page of an end node
                yield from ([n["page"]] if isinstance(n["page"], str) else n["page"])
            for k in ("seq", "shuffle", "do", "then", "else", "repeat"):
                if isinstance(n.get(k), (list, dict)):
                    yield from flow_stages(n[k])

    def repeats(n):
        if isinstance(n, list):
            for x in n:
                yield from repeats(x)
        elif isinstance(n, dict):
            if "repeat" in n:
                yield n
            for v in n.values():
                if isinstance(v, (list, dict)):
                    yield from repeats(v)
    for r in repeats(p.flow):
        if "on_max" not in r:
            problems.append("repeat node (until %r) declares no on_max: what happens when the cap is reached "
                            "(continue | flag | end:<status>), with a cite" % r.get("until"))
    used = set(flow_stages(p.flow))
    problems += ["flow uses unknown stage %r" % s for s in used if s not in p.stages]
    problems += ["stage %r is never used in the flow" % s for s in p.stages if s not in used]
    for src in _walk_exprs([p.raw.get("flow"), p.raw.get("units"), p.raw.get("exclusions"), p.raw.get("keyed")]):
        for ref in ANSWER_REF.findall(src):
            if ref not in responses:
                problems.append("rule refers to unknown response %r" % ref)
    bare = re.compile(r"^\s*(?:[A-Za-z_][A-Za-z0-9_]*|answer\('[^']+'\))\s*$")
    for name, u in p.units.items():
        for f, spec in u.get("fields", {}).items():
            if isinstance(spec, str) and "answer(" in spec and not bare.match(spec) and f not in (u.get("cites") or {}):
                problems.append("unit %s field %s transforms answers without a cite (units.%s.cites)" % (name, f, name))
        if u.get("per", "session") not in ("session", "group") and u["per"] not in p.stages:
            problems.append("unit %s is per unknown stage %r" % (name, u["per"]))
    for s, st in p.stages.items():
        for r in st.get("responses", []):
            for d in r.get("depends_on", []):
                if d not in items and d not in p.stages:
                    problems.append("%s.%s depends_on unknown item %r" % (s, r["id"], d))
    def spans(o, where="data"):
        if isinstance(o, dict):
            if isinstance(o.get("text"), str) and isinstance(o.get("spans"), list):
                for sp in o["spans"]:
                    st, en = sp.get("start"), sp.get("end")
                    if not (isinstance(st, int) and isinstance(en, int) and 0 <= st < en <= len(o["text"])):
                        problems.append("span %s out of range in %r" % (sp, o["text"][:50]))
                    elif o["text"][st:en] != o["text"][st:en].strip():
                        problems.append("span %s has outer whitespace in %r" % (sp, o["text"][:50]))
            for v in o.values():
                spans(v)
        elif isinstance(o, list):
            for v in o:
                spans(v)
    spans(p.data)
    for sname, st in p.stages.items():   # widget names reach the State: plain interface words only
        for r in st.get("responses", []):
            w = r.get("widget")
            wt = w.get("type") if isinstance(w, dict) else w
            if wt is not None and not set(str(wt).lower().replace("-", "_").split("_")) <= WIDGET_WORDS:
                problems.append("%s.%s: widget %r is not a plain interface name (%s)" % (sname, r["id"], wt,
                                                                                         ", ".join(sorted(WIDGETS))))
    for sname, st in p.stages.items():   # a range on a typed-number box is shown in the State: it must be visible
        for r in st.get("responses", []):
            rg = r.get("range")
            if r.get("kind") == "number" and isinstance(rg, list) and len(rg) == 2 and rg[1] is not None \
                    and not r.get("range_visible"):
                problems.append("%s.%s: range %s on a typed-number box is served to participants; if the screen "
                                "did not show it, use validate.min/max (or set range_visible: true with a cite)"
                                % (sname, r["id"], rg))
    tags = [t for t in (p.raw.get("meta") or {}).get("export_tags", []) if isinstance(t, str) and t.strip()]
    if tags:
        def texts(o):
            if isinstance(o, dict):
                if isinstance(o.get("text"), str):
                    yield o["text"]
                for k, v in o.items():
                    if k not in ("cite", "note", "conflicts", "omitted", "operator"):
                        yield from texts(v)
            elif isinstance(o, list):
                for v in o:
                    yield from texts(v)
            elif isinstance(o, str):
                yield o
        for t in texts([p.data, p.stages]):
            for tag in tags:
                if t == tag or re.match(re.escape(tag) + r"[\s:.\-–]", t):
                    problems.append("served text starts with export tag %r: %r" % (tag, t[:60]))
    for sname, st in p.stages.items():   # a served prompt of 1-3 characters is usually a truncated sentence
        for r in st.get("responses", []):
            pr = r.get("prompt")
            if isinstance(pr, str) and 0 < len(pr.strip()) <= 3 and not r.get("short_prompt_ok"):
                problems.append("%s.%s: prompt %r is suspiciously short (truncated sentence?); set short_prompt_ok "
                                "with a cite if it is really what the screen showed" % (sname, r["id"], pr))
    # a sample-based cutoff (SD/IQR fence) changes with the sample it is computed on: when per-session exclusions also
    # exist, the protocol must say which of them run first (after_exclusions: [ids], or [] for "on everyone")
    if any(not ex.get("population") for ex in p.exclusions):
        for ex in p.exclusions:
            if ex.get("population") and "after_exclusions" not in ex["population"]:
                problems.append("exclusion %s: population rule without after_exclusions while other exclusions exist; "
                                "state which run first (cite), or [] if the cutoff uses everyone (LESSONS 203)" % ex["id"])
    # typed response fields reach the State as plain values: a note written into one is a leak (LESSONS 209)
    TYPED = {"start": lambda v: v is None or (isinstance(v, (int, float)) and not isinstance(v, bool)) or v in ("unknown", "hidden"),
             "step": lambda v: isinstance(v, (int, float)) and not isinstance(v, bool),
             "integer": lambda v: isinstance(v, bool), "shows_value": lambda v: isinstance(v, bool),
             "gridlines": lambda v: isinstance(v, (bool, int)), "soft_required": lambda v: isinstance(v, bool),
             "min_chars": lambda v: isinstance(v, int) and not isinstance(v, bool),
             "columns": lambda v: isinstance(v, int) and not isinstance(v, bool)}
    for sname, st in p.stages.items():
        for r in st.get("responses", []):
            for k, ok in TYPED.items():
                if k in r and not isinstance(r[k], dict) and not ok(r[k]):
                    problems.append("%s.%s: %s = %r is not a plain %s value (notes go in a cite)"
                                    % (sname, r.get("id"), k, r[k], k))
            wp = r.get("widget_params") or {}
            if "start" in wp and not isinstance(wp["start"], dict) and not TYPED["start"](wp["start"]):
                problems.append("%s.%s: widget_params.start = %r is not a number, \"unknown\" or \"hidden\" (notes go "
                                "in a cite; use start_visible false for a hidden handle)" % (sname, r.get("id"), wp["start"]))
    for cname, c in (p.raw.get("coding") or {}).items():   # replies left to a coder need a defined coder step
        if "needs_coder" in (c.get("codes") or []):
            cd = c.get("coder")
            if not isinstance(cd, dict) or not all(k in cd for k in ("rubric", "input", "output", "provenance")):
                problems.append("coding %s: needs_coder without a coder block {rubric, input (blind to condition), "
                                "output, provenance} (LESSONS 216)" % cname)
    for sname, st in p.stages.items():   # navigation words come from a fixed set
        bk = (st.get("presentation") or {}).get("back")
        bk = bk.get("value") if isinstance(bk, dict) else bk
        if bk is not None and bk not in ("allowed", "not_allowed", "unknown"):
            problems.append("%s.presentation.back = %r: use allowed, not_allowed or unknown" % (sname, bk))
    ROLES = {"test", "paper_claim", "descriptive", "robustness", "exploratory", "check"}
    an_ = p.raw.get("analysis") or {}
    for key in ("effects", "effects_means", "targets", "blocked_arm_effects", "blocked_arm_targets"):
        for e in an_.get(key, []):
            if "role" in e and e["role"] not in ROLES:
                problems.append("%s %s: role %r is not one of %s" % (key, e.get("id"), e["role"], sorted(ROLES)))
    for sname, st in p.stages.items():   # layout entries must name this stage's items/responses or @button
        known = {c.get("id") for c in st.get("content", [])} | {r.get("id") for r in st.get("responses", [])} | {"@button"}
        for k in st.get("layout") or []:
            if k not in known:
                problems.append("%s.layout: %r is not an item or response of this stage" % (sname, k))
    an = p.raw.get("analysis") or {}
    for x in an.get("pending_effects", []):   # an engine request closed: pending effects whose op now exists
        op = (x.get("compute") or {}).get("op")
        if op in effects_core.OP_FUNCS:
            problems.append("pending effect %s uses op %r, which now exists: move it to effects" % (x.get("id"), op))
    for x in list(an.get("targets", [])) + list(an.get("effects", [])) + list(an.get("effects_means", [])):
        if x.get("reference_mismatch") and x.get("scoring") not in ("direction_only", "not_comparable", "none"):
            problems.append("%s has reference_mismatch but no scoring status (direction_only | not_comparable | none)"
                            % x.get("id"))
    for x in list(an.get("effects", [])) + list(an.get("effects_means", [])):
        if x.get("direction_claimed") is False or x.get("scoring") in ("none", "not_comparable") or x.get("suspect"):
            continue
        if x.get("direction_claimed") is True and x.get("direction_cite"):
            continue   # the paper explicitly claims this direction despite the interval: recorded, scored on sign
        rep_ = x.get("reported") or {}
        ivs = [rep_.get("ci"), rep_.get("interval")] + [e.get("ci") or e.get("interval")
                                                        for e in (rep_.get("estimates") or []) if isinstance(e, dict)]
        for iv in ivs:
            if isinstance(iv, list) and len(iv) == 2 and all(isinstance(v, (int, float)) for v in iv) and iv[0] <= 0 <= iv[1]:
                problems.append("%s is scored on sign but its printed interval %s includes 0: set direction_claimed: "
                                "false (or scoring none) unless the paper claims a direction" % (x.get("id"), iv))
                break
    for x in list(an.get("targets", [])) + list(an.get("effects", [])) + list(an.get("effects_means", [])):
        if x.get("direction_unresolved") and not x.get("readings"):
            problems.append("%s is direction_unresolved but lists no alternative readings" % x.get("id"))
    for key in (p.raw.get("keyed") or {}).get("answers", {}):
        if key not in responses:
            problems.append("keyed answer for unknown response %r" % key)

    def srcs(o):   # local image files: regular files inside the study folder only (engine Protocol.local_path)
        if isinstance(o, dict):
            if isinstance(o.get("src"), str) and not o["src"].startswith(("http://", "https://")):
                yield o["src"]
            for v in o.values():
                yield from srcs(v)
        elif isinstance(o, list):
            for v in o:
                yield from srcs(v)
    for src in sorted(set(srcs([p.data, p.stages]))):
        try:
            p.local_path(src)
        except ProtocolError as e:
            problems.append(str(e))
    return problems


WIDGETS = {"dropdown", "slider", "bar", "hslider", "radio", "checkbox", "text", "textarea", "grid", "matrix",
           "timed_collection", "spinner", "buttons", "star", "rank", "autocomplete", "horizontal", "vertical",
           "likert", "number", "date", "file"}
WIDGET_WORDS = {"text", "box", "area", "textarea", "input", "line", "single", "multi", "radio", "check", "checkbox",
                "button", "buttons", "dropdown", "select", "choice", "list", "column", "row", "grid", "matrix", "table",
                "cell", "slider", "hslider", "bar", "scale", "likert", "star", "rank", "spinner", "number", "date",
                "file", "horizontal", "vertical", "auto", "complete", "autocomplete", "timed", "collection"}
ITEM_KEYS = {"id", "type", "text", "style", "spans", "src", "lines", "rows", "size"}
RESPONSE_KEYS = {"id", "kind", "prompt", "prefix", "suffix", "soft_required", "widget_params", "prefill", "prompt_style", "prompt_spans", "instruction", "required", "options", "range",
                 "step", "anchors", "integer", "min_chars", "start", "columns", "widget", "shows_value", "gridlines",
                 "na_option"}
OPTION_KEYS = {"code", "label", "spans", "text_entry"}


def operator_strings(p):
    """Strings that must never reach a participant: cite notes and evidence, conflicts, omissions, rules."""
    out = set()

    def walk(o, inside=False):
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v, inside or k in ("cite", "note", "evidence", "anchors_cite", "instruction_cite", "cites",
                                        "conflicts", "omitted", "why", "reason", "data_cites", "keyed", "rule"))
        elif isinstance(o, list):
            for v in o:
                walk(v, inside)
        elif inside and isinstance(o, str) and len(o) >= 25:
            out.add(o)
    walk(p.raw)
    return out


def screen_strings(p):
    """Texts meant for the screen: data texts and literal stage texts (a cite may legitimately quote them)."""
    out = []

    def walk(o, skip=False):
        if isinstance(o, dict):
            for k, v in o.items():
                walk(v, skip or k in ("cite", "note", "evidence", "conflicts", "omitted", "presentation", "validate", "depends_on", "if"))
        elif isinstance(o, list):
            for v in o:
                walk(v, skip)
        elif isinstance(o, str) and not skip:
            out.append(o)
    walk(p.data)
    walk(p.stages)
    return out


_EXPR_TEXT = re.compile(r"data\[|\banswers?\(\s*['\"]")


def state_expr_leaks(state, where="state"):
    """Unresolved protocol expressions in a served State, at any depth (fidelity review R1-M1, 2026-11-08): a dict key 'expr', or a
    string containing 'data[' or answer('…') / answers('…'). The participant's own replies (answered[].value/text)
    are not scanned. `seen` and `answered` are copies of earlier screens, which the fuzz already scanned when they were
    served, so they are skipped (scanning them on every step made long sessions quadratic). Returns 'path: snippet'."""
    out = []
    if isinstance(state, dict) and ("seen" in state or "answered" in state):
        state = {k: v for k, v in state.items() if k not in ("seen", "answered")}

    def walk(o, path):
        if isinstance(o, dict):
            for k, v in o.items():
                if k == "expr":
                    out.append("%s.expr: %s" % (path, str(v)[:60]))
                if path.endswith("answered]") and k in ("value", "text"):
                    continue
                walk(v, "%s.%s" % (path, k))
        elif isinstance(o, list):
            for i, v in enumerate(o):
                walk(v, "%s[%s]" % (path, "answered" if path.endswith(".answered") else i))
        elif isinstance(o, str) and _EXPR_TEXT.search(o):
            out.append("%s: %s" % (path, o[:60]))
    walk(state, where)
    return out


class _GroupTurns:
    """Presents a GroupSession to the fuzz loop as one session: each step answers the next pending member."""

    def __init__(self, g):
        self.g = g
        self.cur = None

    def _next(self, states):
        pend = self.g.pending()
        if not pend:
            if all(st.get("done") for st in states.values()):
                return {"done": True, "step": 0}
            raise ProtocolError("group stuck: nobody can act and not all members are done "
                                "(a member ended early while others wait at a barrier?)")
        self.cur = next(m for m in self.g.members if m.pid == pend[0])
        return states[self.cur.pid]

    def reset(self):
        return self._next(self.g.reset())

    def step(self, ans):
        states = self.g.step(self.cur.pid, ans)
        if states[self.cur.pid].get("error"):
            return states[self.cur.pid]
        return self._next(states)

    @property
    def _page(self):
        return self.cur._page

    def ev(self, spec, b):
        return self.cur.ev(spec, b)

    def visible_refs(self):
        return self.cur.visible_refs()


def play(p, n, seed, policy="random", explore=None):
    """Run n sessions; returns (env, problems, stats). policy: random | keyed | floor.
    floor = the §8.2 baseline: checks.random_answers on the State alone, redrawn when the State returns an error (as
    a person would), never helped by protocol internals (keys, coding cases, hidden limits, validation targets)."""
    env = Env(p)
    rng = random.Random(seed)
    keyed = (p.raw.get("keyed") or {}).get("answers", {})
    problems, reached, unanswerable = [], set(), []
    pool = text_pool(p) if policy != "floor" else ()
    secret = operator_strings(p)
    visible_texts = screen_strings(p)
    leaks = set()
    expr_leaks = set()
    foreign = set()
    lang = (p.raw.get("meta") or {}).get("language")
    lang_ok = {w.lower() for w in (p.raw.get("meta") or {}).get("foreign_text_allowed", [])}
    lang_re = re.compile(r"\b(?:[A-Za-z]*[äöüßÄÖÜ][A-Za-z]*|mit|und|einer|anderenfalls|Wahrsch\.?|Auszahlung|"
                         r"Ihre|Wahl|Stopp|Ereignis|Alternative|sichere|Boxen|verbleibenden|gesammelten)\b") \
        if lang in ("en", "english") else None
    for spec in env.design(n=n, seed=seed):
        s = env.open(spec)
        if spec.get("group_size"):
            s = _GroupTurns(s)
        try:
            state = s.reset()
            guard = 0
            while not state.get("done"):
                expr_leaks.update(state_expr_leaks(state))
                guard += 1
                if guard > 10000:
                    problems.append("session %s did not end after 10,000 steps" % spec["index"])
                    break
                page = s._page
                reached.update(page["names"])
                for it in page["internal"]:
                    c = it.get("cite") or {}
                    if isinstance(c, dict) and c.get("label") == "missing":
                        problems.append("stage %s serves an item labelled missing (DESIGN rule 2: the arm is not "
                                        "runnable)" % it["ref"])
                for it in state["screen"]["items"]:   # local images must be opaque asset ids
                    if isinstance(it.get("src"), str) and not it["src"].startswith(("asset:", "http://", "https://")):
                        leaks.add("image src is a local path: %s" % it["src"][:60])
                if lang_re is not None:   # declared language: flag foreign tokens humans would not have seen
                    for hit in lang_re.findall(json.dumps(state["screen"], ensure_ascii=False)):
                        if hit.lower() not in lang_ok:
                            foreign.add(hit)
                for it in state["screen"]["items"]:   # an item that renders empty lost its content
                    if not (it.get("text") or it.get("src") or it.get("lines") or it.get("rows")):
                        problems.append("empty item on page %s (%s)" % (state["step"], page["names"]))
                for it in state["screen"]["items"]:   # allow-list: nothing but participant-facing fields
                    extra = set(it) - ITEM_KEYS
                    if extra:
                        leaks.add("item fields %s" % sorted(extra))
                for rv in state["screen"]["responses"]:
                    extra = set(rv) - RESPONSE_KEYS
                    if extra:
                        leaks.add("response fields %s" % sorted(extra))
                    for o in rv.get("options", []):
                        if set(o) - OPTION_KEYS:
                            leaks.add("option fields %s" % sorted(set(o) - OPTION_KEYS))
                blob = json.dumps({k: state[k] for k in ("screen", "timing", "navigation", "events") if k in state},
                                  ensure_ascii=False)
                for x in secret:
                    if x in blob and not any(x in v for v in visible_texts):
                        leaks.add(x[:80])
                ans = random_answers(state, rng, pool=pool)
                if policy != "floor":   # the floor policy answers from the State only: no coding cases, no hidden limits,
                    # no validation targets, no constructed switch points or sums (coordinator 2026-11-08)
                    if explore is not None:   # coverage: pick the option chosen least often at this question so far
                        for r in page["responses"]:
                            if r["def"]["kind"] == "choice" and r["view"].get("options"):
                                key = "%s.%s" % (r["stage"], r["def"]["id"])
                                cnt = explore.setdefault(key, {})
                                opts = [o["code"] for o in r["view"]["options"]]
                                low = min(cnt.get(r["codes"][c], 0) for c in opts)
                                pick = rng.choice([c for c in opts if cnt.get(r["codes"][c], 0) == low])
                                cnt[r["codes"][pick]] = cnt.get(r["codes"][pick], 0) + 1
                                ans[r["view"]["id"]] = pick
                    for n in page["names"]:   # single-switch pages (price lists): a random valid switch point
                        ss = p.stages[n].get("single_switch")
                        if ss and (ss.get("enforce", True) or rng.random() < 0.5):   # unenforced: some multi-switchers too
                            rs = [r for r in page["responses"] if r["stage"] == n and r["def"]["id"] in ss["responses"]]
                            k = rng.randint(0, len(rs))
                            for i, r in enumerate(rs):
                                want = ss["from"] if i < k else ss["to"]
                                inv = {c: code for code, c in r["codes"].items()}
                                if want in inv:
                                    ans[r["view"]["id"]] = inv[want]
                    for n in page["names"]:   # constant-sum pages: random parts that add up to the total
                        st_ = p.stages[n].get("sum_to")
                        if st_:
                            rs = [r for r in page["responses"] if r["stage"] == n and r["def"]["id"] in st_["responses"]]
                            cuts = sorted(rng.randint(0, int(st_["total"])) for _ in range(len(rs) - 1))
                            parts = [b - a for a, b in zip([0] + cuts, cuts + [int(st_["total"])])]
                            for r, v in zip(rs, parts):
                                ans[r["view"]["id"]] = v
                    for r in page["responses"]:   # free text: draw from this item's own coding cases when declared
                        ref = r["def"].get("coding_ref") or r["def"].get("coding")
                        if r["def"]["kind"] == "text" and isinstance(ref, dict) and r["view"]["id"] in ans:
                            block = (p.raw.get("coding") or {}).get(ref.get("block"), {})
                            own = [c["text"] for c in block.get("cases", []) if isinstance(c.get("text"), str)
                                   and str(c.get("item")) == str(ref.get("item"))]
                            if own and rng.random() < 0.85:
                                t = rng.choice(own)
                                ans[r["view"]["id"]] = t + "x" * max(0, int(r["view"].get("min_chars", 1)) - len(t))
                    for r in page["responses"]:   # satisfy the survey's own content validation (operator-side knowledge)
                        v = r["def"].get("validate") or {}
                        if r["view"]["id"] in ans and "equals" in v and not r["codes"]:   # numeric: the accepted number
                            ans[r["view"]["id"]] = s.ev(v["equals"], r["bindings"]) if isinstance(v["equals"], dict) else v["equals"]
                        elif r["view"]["id"] in ans and "equals" in v:
                            inv = {c: k for k, c in r["codes"].items()}
                            want = s.ev(v["equals"], r["bindings"]) if isinstance(v["equals"], dict) else v["equals"]
                            ans[r["view"]["id"]] = [inv[w] for w in want] if isinstance(want, list) else inv[want]
                        if r["view"]["id"] in ans and ("min" in v or "max" in v) and \
                                isinstance(ans[r["view"]["id"]], (int, float)):
                            lo, hi = v.get("min", float("-inf")), v.get("max", float("inf"))
                            x = ans[r["view"]["id"]]
                            if not lo <= x <= hi:   # hidden limits: answer inside them most of the time
                                x = rng.uniform(max(lo, 0), min(hi, max(lo, 0) + 100))
                                ans[r["view"]["id"]] = int(round(x)) if (r["view"].get("integer") or
                                                                        r["def"]["kind"] == "scale") else round(x, 2)
                        if r["view"]["id"] in ans and "contains" in v:
                            ans[r["view"]["id"]] = (ans[r["view"]["id"]] + " " + v["contains"]).strip()
                keyed_ids = set()
                visible = s.visible_refs()
                for r in page["responses"]:
                    ref = "%s.%s" % (r["stage"], r["def"]["id"])
                    for d in r["def"].get("depends_on", []):
                        if not any((vr == d or vr.startswith(d + ".")) and all(vb.get(k) == r["bindings"].get(k) for k in vb if k in r["bindings"])
                                   for vr, vb in visible):
                            unanswerable.append("%s needs %s (bindings %s)" % (ref, d, r["bindings"]))
                    if policy == "keyed" and ref in keyed:
                        keyed_ids.add(r["view"]["id"])
                        want = s.ev({"expr": keyed[ref]}, r["bindings"])
                        inv = {v: k for k, v in r["codes"].items()}
                        ans[r["view"]["id"]] = [inv.get(w, w) for w in want] if isinstance(want, list) else inv.get(want, want)
                        v_ = r["view"]
                        if v_.get("kind") == "slider" and isinstance(v_.get("step"), (int, float)) and v_["step"] > 0 \
                                and isinstance(ans[v_["id"]], (int, float)) and not isinstance(ans[v_["id"]], bool):
                            lo_ = (v_.get("range") or [0])[0]   # the keyed value as the nearest grid point of the slider
                            ans[v_["id"]] = round(lo_ + round((ans[v_["id"]] - lo_) / v_["step"]) * v_["step"], 10)
                if policy == "keyed":   # a keyed participant reports no screen times: RT rules must not exclude it
                    ans.pop("_elapsed_ms", None)
                kept = dict(ans)
                state2 = s.step(ans)
                tries = 0
                while state2.get("error") and (set(state2["error"]) == {"page"} or policy == "floor") \
                        and tries < (5000 if policy != "floor" else 200):
                    # a page-level rule (e.g. a single switching point) refused random rows: redraw, as a person would
                    tries += 1
                    # redraw as a person would; optional answers are sometimes left empty, so page rules such as
                    # "exactly one of these" can be met (LESSONS 284)
                    ans = random_answers(state, rng, pool=pool, skip=0 if tries % 2 else 0.5)
                    if policy == "keyed":   # keep the keyed answers; redraw only the others
                        ans.update({k: kept[k] for k in keyed_ids if k in kept})
                        ans.pop("_elapsed_ms", None)
                    state2 = s.step(ans)
                if state2.get("error"):
                    if policy == "floor":   # the State's own errors could not be met by chance: session not completed
                        break
                    problems.append("valid answers refused: %s" % state2["error"])
                    break
                state = state2
        except (ProtocolError, ExprError) as e:
            problems.append("session %s: %s" % (spec["index"], e))
    only_blocked = set()
    blocked_problems = []
    blocked = [a for a in p.arms if a.get("runnable") is False] if policy != "floor" else []
    if blocked:
        benv = Env(p)
        n_blocked = 40 if (p.raw.get("analysis") or {}).get("blocked_arm_effects") else 10
        for a in blocked:
            for i in range(n_blocked):
                bspec = {"study": p.id, "arm": a["id"], "index": i, "seed": seed * 1000 + i}
                if a.get("group_size"):   # two-person / group arms run as group sessions, as runnable ones do
                    bspec["group_size"] = int(a["group_size"])
                bs = benv.open(bspec, allow_blocked=True)
                if bspec.get("group_size"):
                    bs = _GroupTurns(bs)
                try:
                    st = bs.reset()
                    while not st.get("done"):
                        expr_leaks.update(state_expr_leaks(st))
                        only_blocked.update(bs._page["names"])
                        ans = random_answers(st, rng, pool=pool)
                        for r in bs._page["responses"]:
                            v = r["def"].get("validate") or {}
                            rid = r["view"]["id"]
                            if rid in ans and "equals" in v and not r["codes"]:
                                ans[rid] = bs.ev(v["equals"], r["bindings"]) if isinstance(v["equals"], dict) else v["equals"]
                            elif rid in ans and "equals" in v:
                                inv = {c: k for k, c in r["codes"].items()}
                                eq_ = bs.ev(v["equals"], r["bindings"]) if isinstance(v["equals"], dict) else v["equals"]
                                ans[rid] = [inv[w] for w in eq_] if isinstance(eq_, list) else inv.get(eq_, ans[rid])
                            if rid in ans and "contains" in v:
                                ans[rid] = (str(ans[rid]) + " " + v["contains"]).strip()
                            if rid in ans and ("min" in v or "max" in v) and isinstance(ans[rid], (int, float)):
                                lo, hi = v.get("min", 0), v.get("max", v.get("min", 0) + 100)
                                if not lo <= ans[rid] <= hi:   # hidden limits: a random value inside them (a fixed
                                    x_ = rng.uniform(lo, hi)   # midpoint gave blocked effects no variance)
                                    ans[rid] = int(round(x_)) if (r["view"].get("integer") or
                                                                  r["def"]["kind"] == "scale") else round(x_, 2)
                        st2 = bs.step(ans)
                        tries = 0
                        while st2.get("error") and tries < 2000:   # page rules: redraw as a person would
                            tries += 1
                            st2 = bs.step(random_answers(st, rng, pool=pool, skip=0 if tries % 2 else 0.5))
                        if st2.get("error"):
                            break
                        st = st2
                except (ProtocolError, ExprError) as e:   # reported, never swallowed (the arm stays blocked)
                    blocked_problems.append("blocked arm %s session %s: %s" % (a["id"], i, e))
                    break
    blocked_not_computed = []
    if blocked and (p.raw.get("analysis") or {}).get("blocked_arm_effects"):   # effects kept for blocked arms
        btab = benv.unit_tables()
        rtab = env.unit_tables()   # a blocked effect may contrast a blocked arm with a runnable one
        for k_, rows_ in rtab.items():
            btab[k_] = list(btab.get(k_, [])) + list(rows_)
        for e in p.raw["analysis"]["blocked_arm_effects"]:
            if not e.get("compute"):   # reported-only (e.g. a model term): nothing to compute
                continue
            # as for runnable arms under random answers: whole-session exclusions are ignored (random answers trip
            # them), but row-level trims still apply (LESSONS 269)
            rows = [r for r in btab.get(e.get("unit"), [])
                    if not (set(r.get("excluded_for") or []) & {e.get("id"), e.get("unit")})]
            b = effects_core.compute({"effects": [e]}, rows)
            if not b or b[0]["status"] != "computed":
                blocked_not_computed.append(e.get("id"))
    unreached = sorted(set(p.stages) - reached - only_blocked)
    stats = {"sessions": len(env.sessions), "unreached_stages": unreached, "leaks": sorted(leaks),
             "state_expr_leaks": sorted(expr_leaks)[:20], "n_state_expr_leaks": len(expr_leaks),
             "foreign_language_tokens": sorted(foreign)[:20],
             "stages_only_in_blocked_arms": sorted(only_blocked - reached),
             "unanswerable": sorted(set(unanswerable))[:10], "n_unanswerable": len(unanswerable),
             "blocked_effects_not_computed": blocked_not_computed, "blocked_arm_problems": blocked_problems[:10]}
    return env, problems, stats


NO_SIGN = "no human cells or value to take a sign from"


def human_sign(e):
    """(signed human contrast, None) or (None, why): the human side's sign as the keyed check reads it
    (treatment - reference from printed cells, else the printed value, else the printed statistic). Effects that
    are never direction-scored (suspect, direction_claimed false, direction_unresolved) return (None, why)."""
    if e.get("suspect"):   # printed value implausible (e.g. duplicated column): never scored
        return None, "suspect: %s" % e["suspect"]
    if e.get("direction_claimed") is False:   # the paper reads it as no reliable relation (n.s.)
        return None, "direction_claimed: false (magnitude target only)"
    if e.get("direction_unresolved"):   # sources disagree on coding: no direction to check or score
        return None, "direction_unresolved: not direction-scored"
    rep = e.get("reported") or {}
    cells = rep.get("cells") or {}
    t, r = (e.get("contrast") or {}).get("treatment"), (e.get("contrast") or {}).get("reference")
    ct, cr = (cells.get(t) or {}) if t else {}, (cells.get(r) or {}) if r else {}
    if "k" in ct and "k" in cr:
        return ct["k"] / ct["n"] - cr["k"] / cr["n"], None
    if "mean" in ct and "mean" in cr:
        return ct["mean"] - cr["mean"], None
    if isinstance(rep.get("value"), (int, float)):
        return rep["value"], None
    if isinstance((rep.get("test") or {}).get("value"), (int, float)):
        return rep["test"]["value"], None   # sign of the printed statistic (treatment - reference)
    return None, NO_SIGN


def same_sign(keyed, human):
    """Strict sign agreement (LESSONS 301): a keyed value of exactly 0 matches neither a positive nor a negative human
    sign (only a human 0); NaN never matches."""
    if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and x == x for x in (keyed, human)):
        return False
    return (keyed > 0) - (keyed < 0) == (human > 0) - (human < 0)


def target_values(p, tables):
    out = []
    for t in (p.raw.get("analysis") or {}).get("targets", []):
        cand = [r for r in tables.get(t["unit"], []) if not r["excluded"]
                and not (set(r.get("excluded_for") or []) & {t["id"], t["unit"]})
                and all(r.get(k) == v for k, v in t.get("where", {}).items())]
        rows = [r for r in cand if not _pending(r, [t["id"], t["unit"]])]
        pending_share = round(1 - len(rows) / len(cand), 3) if cand else 0.0
        raw_vals = [r.get(t["field"]) for r in rows if r.get(t["field"]) is not None]
        missing = set(t.get("missing_values", ["uncoded"]))
        vals = [v for v in raw_vals if not (isinstance(v, str) and v in missing)]
        if t["stat"] == "median":
            xs = sorted(v for v in vals if isinstance(v, (int, float)))
            a = (xs[len(xs) // 2] if len(xs) % 2 else (xs[len(xs) // 2 - 1] + xs[len(xs) // 2]) / 2) if xs else None
        elif t["stat"] == "share":
            k = sum(1 for v in vals if v == t.get("success", 1))
            a = k / len(vals) if vals else None
        else:
            a = sum(vals) / len(vals) if vals else None
        k_ = sum(1 for v in vals if v == t.get("success", 1)) if t["stat"] == "share" else None
        num = [float(v) for v in vals if isinstance(v, (int, float)) and not isinstance(v, bool)]
        sd_ = math.sqrt(sum((v - sum(num) / len(num)) ** 2 for v in num) / (len(num) - 1)) \
            if t["stat"] == "mean" and len(num) > 1 else None
        h = t["human"]
        out.append({"id": t["id"], "agent": a, "n_agent": len(vals), "k_agent": k_, "sd_agent": sd_, "pending_share": pending_share,
                    "uncoded_share": round(1 - len(vals) / len(raw_vals), 3) if raw_vals else None,
                    "held_out": {m: round(sum(1 for v in raw_vals if v == m) / len(raw_vals), 3)
                                 for m in missing} if raw_vals else {}, "human": h["k"] / h["n"] if "k" in h else h.get("value")})
    return out


def all_effects(p):
    a = p.raw.get("analysis") or {}
    return list(a.get("effects", [])) + list(a.get("effects_means", []))


def _excluded(r, ids):
    return r["excluded"] or bool(set(r.get("excluded_for") or []) & set(ids)) or _pending(r, ids)


def _pending(r, ids):
    pf = set(r.get("pending_for") or [])
    return "*" in pf or bool(pf & set(ids))


def effect_blocks(p, tables, only_included=True):
    out = []
    for e in all_effects(p):
        rows = [r for r in tables.get(e["unit"], []) if not (only_included and _excluded(r, [e["id"], e["unit"]]))]
        out += effects_core.compute({"effects": [e]}, rows)
    return out


def paper_consistency(p):
    """Recompute each effect's printed test from its printed cells (2x2 chi-square without correction, Welch t).
    A mismatch is the paper's inconsistency: reported as a warning to record in meta.conflicts, not a failure."""
    out = []
    for e in all_effects(p):
        rep = e.get("reported") or {}
        cells, test = rep.get("cells") or {}, rep.get("test") or {}
        t, r = (e.get("contrast") or {}).get("treatment"), (e.get("contrast") or {}).get("reference")
        a, b = cells.get(t) or {}, cells.get(r) or {}
        stat, printed = None, test.get("value")
        if not isinstance(printed, (int, float)):
            continue
        if all(k in a and k in b for k in ("k", "n")) and str(test.get("statistic", "")).lower().startswith(("chi", "χ")) \
                and test.get("df", 1) in (1, "1") \
                and test.get("type", "independence") == "independence":
            table = [[a["k"], a["n"] - a["k"]], [b["k"], b["n"] - b["k"]]]
            n = sum(map(sum, table))
            rows, cols = [sum(x) for x in table], [table[0][j] + table[1][j] for j in range(2)]
            stat = sum((table[i][j] - rows[i] * cols[j] / n) ** 2 / (rows[i] * cols[j] / n)
                       for i in range(2) for j in range(2) if rows[i] * cols[j])
        elif all(k in a and k in b for k in ("mean", "sd", "n")) and str(test.get("statistic", "")).lower() == "t" \
                and test.get("type", "independence") == "independence":
            se = math.sqrt(a["sd"] ** 2 / a["n"] + b["sd"] ** 2 / b["n"])
            stat = (a["mean"] - b["mean"]) / se if se else None
        if stat is None:
            continue
        tol = max(0.05 * abs(printed), 0.1)
        if abs(abs(stat) - abs(printed)) > tol:
            out.append({"effect": e["id"], "printed": printed, "from_cells": round(stat, 2)})
    return out


def statistic_vocabulary(p):
    """Report (not a failure): reported.test.statistic values outside the effects vocabulary
    (effects_core.TEST_STATISTICS) in effects, effects_means and blocked_arm_effects — effects.json export and Bench
    refuse them."""
    out = []
    an = p.raw.get("analysis") or {}
    for key in ("effects", "effects_means", "blocked_arm_effects"):
        for e in an.get(key) or []:
            t = (e.get("reported") or {}).get("test") if isinstance(e, dict) else None
            if isinstance(t, dict) and t.get("statistic") not in effects_core.TEST_STATISTICS:
                out.append({"effect": e.get("id"), "statistic": t.get("statistic")})
    return out


def printed_item_tests(p):
    """Report (not a failure): when the protocol ships the paper's printed item-level data
    (analysis.printed_items = {unit: [rows]} or {unit: {"rows": [...], "cite": …}}), recompute every effect on that
    unit with effects_core and compare with the printed test statistic (tolerance 5% or 0.1) and printed value."""
    an = p.raw.get("analysis") or {}
    items = an.get("printed_items")
    if not isinstance(items, dict):
        return []
    out = []
    for e in all_effects(p) + list(an.get("blocked_arm_effects") or []):
        if not isinstance(e, dict) or not e.get("compute"):
            continue
        rows = items.get(e.get("unit"))
        rows = rows.get("rows") if isinstance(rows, dict) else rows
        if not isinstance(rows, list):
            continue
        try:
            b = effects_core.compute({"effects": [e]}, [r for r in rows if isinstance(r, dict)])
        except Exception as x:   # report the effect, never crash the checks
            out.append({"effect": e.get("id"), "status": "error: %s" % x})
            continue
        b = b[0] if b else {}
        rep = e.get("reported") or {}
        row = {"effect": e.get("id"), "status": b.get("status")}
        got_t = (b.get("test") or {}).get("value")
        want_t = (rep.get("test") or {}).get("value")
        if isinstance(got_t, (int, float)) and isinstance(want_t, (int, float)):
            row.update(printed_test=want_t, recomputed_test=round(got_t, 4),
                       test_ok=abs(abs(got_t) - abs(want_t)) <= max(0.05 * abs(want_t), 0.1))
        if isinstance(b.get("value"), (int, float)) and isinstance(rep.get("value"), (int, float)):
            row.update(printed_value=rep["value"], recomputed_value=round(b["value"], 4),
                       value_ok=abs(b["value"] - rep["value"]) <= max(0.05 * abs(rep["value"]), 0.01))
        out.append(row)
    return out


def run_coding_cases(p):
    out = {}
    for name, c in (p.raw.get("coding") or {}).items():
        if not isinstance(c, dict) or not c.get("apply"):
            continue
        mism = []
        codes = {x.get("code") for x in c.get("cases", [])}
        if c.get("free_text", True) and not c.get("closed_answers"):
            # DESIGN coding limits: mixed replies are never guessed, gibberish is never 'other'
            for need in ("needs_coder", "uncoded"):
                if need not in codes:
                    mism.append({"item": None, "text": None, "want": "a case coded %r" % need,
                                 "got": "coding %s has no %s path (DESIGN: free-text coding limits)" % (name, need)})
        for case in c.get("cases", []):
            try:
                got = evaluate(c["apply"], {"text": case.get("text"), "item": case.get("item"), "data": p.data})
            except ExprError as e:
                got = "ERROR: %s" % e
            if got != case.get("code"):
                mism.append({"item": case.get("item"), "text": case.get("text"), "want": case.get("code"), "got": got})
        out[name] = {"cases": len(c.get("cases", [])), "mismatches": mism[:20], "n_mismatches": len(mism)}
    return out


def fetch_images(p, env):
    """--fetch-images: every image src must return bytes whose sha256 matches the declared hash (network)."""
    import hashlib
    import urllib.request
    problems = []
    seen = set()

    def walk(o):
        if isinstance(o, dict):
            if isinstance(o.get("src"), str) and o["src"] not in seen:
                seen.add(o["src"])
                want = o.get("sha256")
                try:
                    if o["src"].startswith("http"):
                        with urllib.request.urlopen(o["src"], timeout=20) as r:
                            data = r.read()
                            cd = r.headers.get("Content-Disposition") or ""
                            if cd:
                                problems.append("note: %s sends Content-Disposition %r — operators must pass image "
                                                "bytes only (headers may name the condition)" % (o["src"], cd[:80]))
                    else:   # only regular files inside the study folder (engine Protocol.local_path)
                        lp = p.local_path(o["src"])
                        if lp is None:
                            raise OSError("no such file in the study folder")
                        data = lp.read_bytes()
                    got = hashlib.sha256(data).hexdigest()
                    if data[:15].lower().startswith((b"<!doctype", b"<html")):
                        problems.append("%s returns HTML, not an image" % o["src"])
                    elif want and got != want:
                        problems.append("%s sha256 %s != declared %s" % (o["src"], got[:12], want[:12]))
                    elif not want:
                        problems.append("%s has no declared sha256" % o["src"])
                except Exception as e:
                    problems.append("%s: %s" % (o["src"], e))
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(p.data)
    return problems


def _norm(s):
    """NFKC, curly quotes, U+2212 minus as '-', runs of underscores (printed blanks) folded to '__', whitespace,
    case."""
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"').replace("\u2212", "-")
    s = re.sub(r"_{2,}", "__", s)
    return re.sub(r"\s+", " ", s).strip().lower()


# a line with one of these marks is not agreement (Decided 5). [partial] too: the reader did not read the whole
# element (skills review-4 M6: "Agree [partial]" must not confirm "Agree").
_UNCERTAIN = re.compile(r"\[[^\]]*\b(?:uncertain|unclear|illegible|unreadable|guess|partial|continued)|\[\s*\?+\s*\]",
                        re.I)
# [partial] / [continued] only say that the element goes on in the next line or page: a join that completes the
# element ignores them (they still never confirm a text on their own)
_SOFT = re.compile(r"\[\s*(?:partial|continued)\s*\]", re.I)
def _private_config():
    """Study-specific pins live outside the public engine (owner 2026-11-08: engine code may be public, study data may
    not): a JSON file named by env HSENV_PRIVATE_CONFIG (empty = none), else <sandbox>/coordinator/engine-private.json
    next to this package's project folder. Absent file = no pins (a public copy has none). Keys:
    legacy_uncertain_readings {sha256: label}, legacy_cite_sources {protocol id: [sourcetext names]},
    fetch_images_study_prefixes [folder-name prefixes check_all always image-checks]."""
    import os
    env = os.environ.get("HSENV_PRIVATE_CONFIG")
    path = Path(env) if env else Path(__file__).resolve().parents[2] / "coordinator" / "engine-private.json"
    if env == "" or not path.is_file():
        return {}
    try:
        cfg = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise SystemExit("private engine config %s unreadable: %s" % (path, e))
    return cfg if isinstance(cfg, dict) else {}


PRIVATE = _private_config()
# Blind readings written before uncertain lines stopped counting as agreement (2026-11-08, skills review-1 S8),
# pinned by the sha256 of the reading's text. Texts confirmed only by an [uncertain] line of one of these files
# still count, but are reported in verbatim.image_uncertain_legacy until a third blind reader settles them. The pin
# ends by itself when the file changes. Never add new entries: new readings follow the strict rule. (Private config.)
LEGACY_UNCERTAIN_READINGS = dict(PRIVATE.get("legacy_uncertain_readings") or {})

# Studies built before cites had to name a meta.sources entry (skills review-2 S3'): they cite the names of their
# sourcetext files. Pinned by protocol id AND the exact names; any other unknown name in these studies blocks too.
# Never add entries: new studies cite meta.sources keys (README Decided 8). (Private config.)
LEGACY_CITE_SOURCES = {k: set(v) for k, v in (PRIVATE.get("legacy_cite_sources") or {}).items()}

def _strip_marks(f):
    f = re.sub(r"\[value [a-z]+: ([^\]]*)\]", r"\1", f)
    return re.sub(r"\s*\[(?:uncertain|partial|non-english|callout|radio|empty|dropdown|info icon|"
                  r"(?:[AB] )?(?:not )?selected|checked|10×10|note:)[^\]]*\]", "", f, flags=re.I)


def _cited_pages(page):
    """Pages an image-read cite may match: an integer page, or two consecutive pages ("3-4", a screen across a page
    break). Anything else (omitted, "p3", "1-40", "3, 5") is unparseable and matches NO page (skills review-3 S3)."""
    if isinstance(page, bool):
        return None
    if isinstance(page, int):
        return {page}
    if isinstance(page, str) and re.fullmatch(r"\d+", page.strip()):
        return {int(page)}
    if isinstance(page, str) and re.fullmatch(r"\d+-\d+", page.strip()):
        a, b = map(int, page.strip().split("-"))
        if 0 <= b - a <= 1:
            return set(range(a, b + 1))
    return None


def _covers(reading, page):
    """True when a blind reading has at least one 'p<N> |' line on the cited page(s), i.e. its reader read that page.
    An unparseable cite covers nothing."""
    pages = _cited_pages(page)
    if pages is None:
        return False
    for line in reading.splitlines():
        m = re.match(r"\s*p(\d+)\s*\|", line)
        if m and int(m.group(1)) in pages:
            return True
    return False


# Reader annotations stripped before comparing (skills review-4 M6): ONLY the closed vocabulary of prompts.md §1
# ([uncertain: …], [note: …], [partial], [non-english], widget marks [radio], [checked], [selected], [dropdown],
# [empty], [info icon]) and forms already used by pinned readings ([callout …], [A not selected], [radio, selected],
# [empty input], 10×10). Any other bracketed text stays part of the field and must match the served text: "I [do
# not] agree" does not confirm "I agree", "No [smudged]" does not confirm "No". A remark is written [note: …].
_MARK_BODY = (r"(?:uncertain|unclear|illegible|unreadable|guess|partial|continued)(?:\s*[:;,][^\]]*)?|\?+|note\s*:[^\]]*|"
              r"non-english(?:\s*:[^\]]*)?|callout\b[^\]]*|"
              r"(?:radio|checkbox)(?:\s*,?\s*(?:(?:[AB] )?(?:not )?selected|checked|empty))?|"
              r"(?:[AB] )?(?:not )?selected|checked|unchecked|dropdown|info icon|"
              r"empty(?: (?:input|text field|field|box|blank amount|blank|amount))?|10×10")
_MARKS = re.compile(r"\s*\[\s*(?:" + _MARK_BODY + r")\s*\]", re.I)
# element kinds that are one element each: never joined with a neighbouring line (an option, a button …)
_SINGLE_KINDS = re.compile(r"(?i)^(option|button|dropdown|slider[- ]?(left|right)?|cell|column|row( \d+)?|number|"
                           r"stat|domain|radio|checkbox|choice|scale|anchor|link|tab|menu)$")


# a list bullet / number, a scale-point number printed before its label ('0 Probably average …'), or a
# required-field asterisk ('*How many …') at the start of a field
_BULLET = re.compile(r"^(?:(?:[•·▪◦‣∙●○■□–—-]|\(?\d{1,2}[.)]|\(?[a-z][.)]|[-+]?\d{1,2}(?=\s+[^\d\s]))\s+|\*\s*)")
_UNITS = re.compile(r"(?<=[.!?:;])\s+")


def _units(field):
    """Whole units of one normalised field (reader marks already removed by _MARKS): the field, the field without a
    list bullet, and every contiguous run of its sentences / colon-separated parts ('Block 1:' and '(Task "orange")'
    of 'Block 1: (Task "orange")'). Never a word or phrase inside a sentence, and bracketed text is never dropped
    (skills review-4 M6)."""
    out = {field}
    nob = _BULLET.sub("", field)
    out.add(nob)
    for f in list(out):
        us = [u for u in _UNITS.split(f) if u]
        if 1 < len(us) <= 60:
            for i in range(len(us)):
                for j in range(i + 1, len(us) + 1):
                    out.add(_BULLET.sub("", " ".join(us[i:j])))
    return {x for x in out if x}


def _reading_lines(reading, pages, annots=()):
    """[(page, screen, kind, content fields)] of the reading's lines on <pages>, uncertain lines marked. annots:
    the protocol's declared printed-annotation regexes for this reading's source (meta.image_read
    .reading_annotations), removed from every content field before comparing."""
    return _reading_lines_c(reading, frozenset(pages), tuple(annots))


import functools as _functools   # noqa: E402  (kept inside the matcher section)

# a reader's mark for a picture inside a line ('outcome "[callout die image]" results in'): the text on either side
# is a separate printed fragment for the fragment-template rule (rule h, 2026-11-08)
_IMAGE_MARK = re.compile(r"\[\s*(?:(?:image|picture|photo|icon|logo|figure)\b[^\]]*|(?:note\s*:|callout\b)[^\]]*?"
                         r"\b(?:image|picture|photo|icon|logo|figure|pictogram)s?\b[^\]]*)\]", re.I)


def _clean_field(f):
    return _norm(_MARKS.sub("", re.sub(r"\[value [a-z]+: ([^\]]*)\]", r"\1", f)))


def _runs(field):
    """(prefix runs, suffix runs) of a field's sentences / colon parts, bullet stripped: the first piece of a
    multi-line served element must END its reading line, the last must START its reading line (review-5 M1)."""
    f = _BULLET.sub("", field)
    us = [u for u in _UNITS.split(f) if u]
    if not us or len(us) > 60:
        return {f}, {f}
    return ({" ".join(us[:j]) for j in range(1, len(us) + 1)}, {_BULLET.sub("", " ".join(us[i:])) for i in range(len(us))})


def _unquote(x):
    """The inside of a field wholly enclosed in one pair of double quotes (an article quoting the item), else None."""
    if len(x) > 2 and x[0] == '"' and x[-1] == '"' and '"' not in x[1:-1]:
        return x[1:-1].strip()
    return None


@_functools.lru_cache(maxsize=512)
def _reading_lines_c(reading, pages, annots=()):
    rx_ann = [re.compile(a) for a in annots]
    out = []
    for line in reading.splitlines():
        m = re.match(r"\s*p(\d+)\s*\|", line)
        if not m or int(m.group(1)) not in pages:
            continue
        parts = line.split("|")
        screen = _norm(parts[1]) if len(parts) > 2 else ""
        kind = _norm(re.sub(r"\[[^\]]*\]", "", parts[2])) if len(parts) > 3 else ""
        style = _norm(parts[3]) if len(parts) > 4 else ""
        # fixed fields p | screen | kind | [style |]; everything after them is content, even when it contains ' | '
        # (rule i): content without a style field, content after a style field, and with more than one '|' after the
        # kind, each '|'-separated piece (printed elements on one line, as with ' / ')
        if len(parts) <= 3:
            cands, pieces = [parts[-1]], []
        else:
            cands = ["|".join(parts[3:])] + (["|".join(parts[4:])] if len(parts) > 4 else [])
            pieces = parts[3:] if len(parts) > 4 else []
        changed = False
        if rx_ann:   # declared printed annotations (e.g. a result share printed after an option): stripped
            def strip(x):
                for rx in rx_ann:
                    x = rx.sub("", x)
                return x
            new = [strip(x) for x in cands], [strip(x) for x in pieces]
            changed = (new[0], new[1]) != (cands, pieces)
            cands, pieces = new
        fields, frags, wholes = [], set(), set()
        two_line = kind in ("label", "heading") or "line" in style
        for f in cands + pieces:
            fields.append(_clean_field(f))
            if " / " in f:   # a reader listing several elements of one line ("Yes / No"): each piece is a field
                fields += [_clean_field(x) for x in f.split(" / ")]
                if two_line:   # a label printed on two lines, written 'line 1 / line 2': space-joined
                    fields.append(_clean_field(" ".join(f.split(" / "))))
            if _IMAGE_MARK.search(f):
                frags |= {_clean_field(x) for x in _IMAGE_MARK.split(f)}
        fields = [x for x in fields if x]
        units, prefixes, suffixes, qunits = set(), set(), set(), set()
        for f in fields:
            units |= _units(f)
            wholes |= {f, _BULLET.sub("", f)}
            p_, s_ = _runs(f)
            prefixes |= p_
            suffixes |= s_
            q = _unquote(f)
            if q:
                qunits |= _units(q)
        contents = [x for x in (_clean_field(c) for c in cands) if x]
        hard = bool(_UNCERTAIN.search(_SOFT.sub("", line)))
        out.append({"page": int(m.group(1)), "screen": screen, "kind": kind, "style": style,
                    "units": frozenset(units), "qunits": frozenset(qunits), "wholes": frozenset(wholes),
                    "prefixes": frozenset(prefixes), "suffixes": frozenset(suffixes),
                    "frags": frozenset(x for x in frags if x),
                    # the label/value join reads the field after a style field when there is one
                    "content": contents[-1] if contents else "", "contents": tuple(contents),
                    "annotated": changed, "uncertain": bool(_UNCERTAIN.search(line)), "hard_uncertain": hard})
    return tuple(out)


def _joins(texts):
    """Joined forms of consecutive printed lines: ' '-joined, and 'x-' + 'y' without the space (a word hyphenated at
    the print line end). At most 8 variants."""
    outs = [""]
    for k, t in enumerate(texts):
        t = t.strip()
        if k == 0:
            outs = [t]
            continue
        nxt = []
        for o in outs:
            nxt.append(o + " " + t)
            if o.endswith("-"):
                nxt.append(o + t)
        outs = nxt[:8]
    return outs


# a computed value inside a composed element is a rendered number. A currency/unit word or a percent sign may
# precede/follow it only when the value's own expression contains that string (review-5 M2): "You will earn 5
# points." never confirms "You will" + V + "points.", and "GBP 3" never confirms a value rendered as "3".
_TPL_UNITS = ("gbp", "usd", "eur", "chf", "cad", "aud", "jpy", "pts", "£", "$", "€", "¥")
_TPL_NUM = r"[-+]?\d{1,9}(?:[.,]\d{1,4})?"


def _tpl_value_rx(consts):
    low = {_norm(c) for c in (consts or ())}
    units = [u for u in _TPL_UNITS if any(re.search(r"(?:^|\s)%s(?:\s|$)" % re.escape(u), c) for c in low)]
    pre = "(?:(?:%s) ?)?" % "|".join(map(re.escape, units)) if units else ""
    pct = " ?%?" if any("%" in c for c in low) else ""
    return "(" + pre + _TPL_NUM + pct + ")"


def _template_rx(parts):
    """parts: [('s', static text) | ('v', None)] of one composed element -> regex over a normalised unit, or None."""
    merged = []
    for kind, t in parts:
        if kind == "s" and merged and merged[-1][0] == "s":
            merged[-1] = ("s", merged[-1][1] + t)
        else:
            merged.append((kind, t))
    rx, nv = "", 0
    for kind, t in merged:
        if rx:
            rx += " ?"
        if kind == "s":
            st = _norm(t)
            if not st:
                rx = rx[:-2] if rx.endswith(" ?") else rx
                continue
            rx += re.escape(st)
        else:
            rx += _tpl_value_rx(t)
            nv += 1
    return re.compile("^" + rx + "$") if rx else None


def _template_ok(rx, unit):
    m = rx.match(unit)
    if not m:
        return False
    for v in m.groups():
        v = v.strip()
        if not v or len(v) > 24 or re.search(r"[.!?](?:\s|$)", v):
            return False
    return True


def _group_match(group, lines):
    """Rules of skills review-4 (image matcher) — both need WHOLE-unit equality with one reading line:
    ('join', texts, i): lines a..b (a <= i < b, at least two) of ONE served image item, same source and page,
      joined in order ('x-'+'y' also without a space) equal a unit of one reading line. Every joined line is
      confirmed only as part of that join.
    ('tpl', rx): the served element is composed by the protocol's own template from static fragments and computed
      values ([s1, V1, s2, ...]); the whole unit must be s1 V1 s2 ... with each V a short rendered number/currency/
      percent (<= 24 characters, no sentence end)."""
    units = [ln["units"] for ln in lines]
    if group[0] == "join":
        _, texts, i = group
        lo = i
        while lo > 0 and texts[lo - 1] is not None and i - (lo - 1) < 40:
            lo -= 1
        hi = i
        while hi + 1 < len(texts) and texts[hi + 1] is not None and hi + 1 - i < 40:
            hi += 1
        for a in range(lo, i + 1):
            for b in range(max(i, a + 1), hi + 1):
                for j in _joins(texts[a:b + 1]):
                    jn = _norm(j)
                    if any(jn in u for u in units):
                        return True
        return False
    if group[0] == "tpl":
        rx = group[1]
        return any(_template_ok(rx, u_) for ln in lines for u_ in (ln["units"] | ln["frags"]))
    return False


def _hit(want, ln):
    """Whole-unit equality with one reading line; a line wholly in double quotes (an article quoting the item) also
    matches its inside, only when the served text does not itself start with a quote."""
    return want in ln["units"] or (want[:1] != '"' and want in ln["qunits"])


def _join_eq(want, texts):
    """The served text equals the WHOLE join of consecutive reading lines (bullet stripped, or inside one pair of
    outer quotes when the served text has none)."""
    for j in _joins(texts):
        jn = _norm(j)
        if want in (jn, _BULLET.sub("", jn)):
            return True
        q = _unquote(jn)
        if q and want[:1] != '"' and want == q:
            return True
    return False


_CELL_LINE = re.compile(r",?\s*line \d+\s*$")


def _image_match(text, second, page, uncertain=False, groups=(), annots=()):
    """Reading lines are 'p<N> | screen | kind | [style |] text'. A served text matches a line on its cited page(s)
    only by WHOLE-FIELD EQUALITY after normalisation (NFKC, quotes, U+2212, underscore runs, whitespace, case, reader
    marks removed) — never as a substring or a word inside a longer field ("Agree" is not confirmed by "Strongly
    agree"; skills review-3 M4). A line wholly in double quotes also matches its inside (served text without quotes).
    Layout tolerances, each a whole-element equality:
    - a label and its value on two consecutive lines (the first ends with ':' or is of kind 'label'; same page and
      screen; neither an option/button/cell-like single element) match their join;
    - consecutive printed lines of ONE element (same page, screen and kind; not a single-element kind, not a label;
      note lines skipped; split by the print's line end or by a style change) match their whole join;
    - a served element printed on several lines ('A\nB') matches consecutive reading lines of one page and screen:
      the first piece ends the first line, the last piece starts the last line, middle pieces are whole fields
      (review-5 M1); single-element kinds only when every line is a line of the same cell ('…, line 1', '…, line 2');
    - groups (from _image_groups): one printed line of an image item, or one static fragment of a composed element,
      matches when its whole join / template matches one reading unit (_group_match);
    - cross-page join (rule e): a text whose cite spans two pages "p-q" also matches the join of the last line of p
      and the first line of q (note lines skipped; never a label or single element).
    A line the reader marked [uncertain …] / [partial] / [continued] is not agreement (Decided 5): skipped unless
    uncertain=True (used only to report why a text failed); in a join, [partial] / [continued] alone do not block
    (the join completes the element). An unparseable page cite matches nothing. annots: declared printed
    annotations stripped (_reading_lines)."""
    pages = _cited_pages(page)
    if pages is None:
        return False
    want = _norm(text)
    if not want:
        return False
    lines = _reading_lines(second, pages, annots)

    def ok(ln):
        return uncertain or not ln["uncertain"]

    def okj(ln):
        return uncertain or not ln["hard_uncertain"]
    usable = [ln for ln in lines if ok(ln)]
    if any(_hit(want, ln) for ln in usable):
        return True
    prev = None
    for ln in lines:
        if not ok(ln):
            prev = None
            continue
        if prev and prev["page"] == ln["page"] and prev["screen"] == ln["screen"] and prev["content"] \
                and ln["content"] and not _SINGLE_KINDS.match(prev["kind"]) and not _SINGLE_KINDS.match(ln["kind"]) \
                and (prev["content"].endswith(":") or prev["kind"] == "label") and ln["kind"] != "label":
            if want in (prev["content"] + " " + ln["content"], _BULLET.sub("", prev["content"]) + " " + ln["content"]):
                return True
        prev = ln
    printed = [ln for ln in lines if ln["kind"] != "note"]
    # consecutive printed lines of one element
    for i in range(len(printed)):
        a = printed[i]
        if _SINGLE_KINDS.match(a["kind"]) or a["kind"] == "label" or not okj(a):
            continue
        run = [a]
        for b in printed[i + 1:i + 12]:
            if (b["page"], b["screen"], b["kind"]) != (a["page"], a["screen"], a["kind"]) or not okj(b):
                break
            run.append(b)
            if _join_eq(want, [x["content"] for x in run]):
                return True
    # a served element printed on several lines (review-4 rule a, reading side; review-5 M1)
    pieces = [_norm(x) for x in str(text).split("\n") if _norm(x)]
    if len(pieces) >= 2:
        for j in range(len(printed) - len(pieces) + 1):
            run = printed[j:j + len(pieces)]
            if not all(ok(r) and r["page"] == run[0]["page"] and r["screen"] == run[0]["screen"] for r in run):
                continue
            cells = {_CELL_LINE.sub("", r["style"]) for r in run}
            same_cell = all(_CELL_LINE.search(r["style"]) for r in run) and len(cells) == 1 and "" not in cells
            if not same_cell and any(_SINGLE_KINDS.match(r["kind"]) for r in run):
                continue
            if pieces[0] in run[0]["suffixes"] and pieces[-1] in run[-1]["prefixes"] \
                    and all(pc in r["wholes"] for pc, r in zip(pieces[1:-1], run[1:-1])):
                return True
    if len(pages) == 2:
        a_, b_ = sorted(pages)
        last = [ln for ln in printed if ln["page"] == a_][-1:]
        first = [ln for ln in printed if ln["page"] == b_][:1]
        if last and first and last[0]["kind"] != "label" and \
                all(okj(ln) and not _SINGLE_KINDS.match(ln["kind"]) for ln in last + first):
            soft = last[0]["uncertain"] or first[0]["uncertain"]
            for x in last[0]["contents"]:
                for y in first[0]["contents"]:
                    if _join_eq(want, [x, y]) or (not soft and any(want in _units(_norm(j)) for j in _joins([x, y]))):
                        return True
    return any(_group_match(g, usable) for g in groups)


def _expr_parts(node, data, ids):
    """Flatten a template expression's '+' chain: data[A][B]['text'] -> ('s', text, obj); a string constant -> ('s',
    text, None); anything else (a computed value) -> ('v', None, None). None when a data ref does not resolve."""
    import ast
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        l_, r_ = _expr_parts(node.left, data, ids), _expr_parts(node.right, data, ids)
        return None if l_ is None or r_ is None else l_ + r_
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [("s", node.value, None)]
    keys, n = [], node
    while isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Constant):
        keys.append(n.slice.value)
        n = n.value
    if isinstance(n, ast.Name) and n.id == "data" and len(keys) == 3 and keys[0] == "text":
        obj = (data.get(keys[2]) or {}).get(keys[1]) if isinstance(data.get(keys[2]), dict) else None
        if isinstance(obj, dict) and isinstance(obj.get("text"), str):
            return [("s", obj["text"], obj)]
        return None
    consts = frozenset(n.value for n in ast.walk(node) if isinstance(n, ast.Constant) and isinstance(n.value, str))
    return [("v", consts, None)]   # a computed value; the string constants of its expression (rendered format)


def _image_groups(p):
    """id(served dict) -> groups for _group_match. 'join': the printed lines of one image item ({src, lines}) that
    cite the same source and page with read 'image' (other lines are barriers). 'tpl': static data fragments that a
    stage composes into ONE element (content value / response prompt / option label expr whose 'text' is a '+'
    chain of data[...]['text'] refs, string constants and computed values); all its refs must cite the same source
    and page. Composition is taken only from the protocol's own template, never from key names or neighbours."""
    import ast
    out = {}

    def walk(o):
        if isinstance(o, dict):
            if o.get("src") and isinstance(o.get("lines"), list):
                ls = o["lines"]
                cs = [x.get("cite") if isinstance(x, dict) else None for x in ls]
                for i, x in enumerate(ls):
                    c = cs[i]
                    if not (isinstance(x, dict) and isinstance(x.get("text"), str) and isinstance(c, dict)
                            and c.get("read") == "image"):
                        continue
                    key = (c.get("source"), str(c.get("page")))
                    texts = [y.get("text") if isinstance(y, dict) and isinstance(cs[k], dict)
                             and cs[k].get("read") == "image" and (cs[k].get("source"), str(cs[k].get("page"))) == key
                             and isinstance(y.get("text"), str) else None for k, y in enumerate(ls)]
                    out.setdefault(id(x), []).append(("join", texts, i))
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(p.data)

    def exprs(o):
        if isinstance(o, dict):
            if isinstance(o.get("expr"), str):
                yield o["expr"]
            for v in o.values():
                yield from exprs(v)
        elif isinstance(o, list):
            for v in o:
                yield from exprs(v)
    for e in set(exprs(p.stages)):
        if "+" not in e or "data[" not in e:
            continue
        try:
            tree = ast.parse(e, mode="eval").body
        except (SyntaxError, ValueError):
            continue
        if isinstance(tree, ast.Dict):
            tree = next((v for k, v in zip(tree.keys, tree.values)
                         if isinstance(k, ast.Constant) and k.value == "text"), None)
        if tree is None:
            continue
        parts = _expr_parts(tree, p.data, None)
        if not parts:
            continue
        refs = [obj for kind, _, obj in parts if obj is not None]
        cites = {(obj.get("cite") or {}).get("source") for obj in refs} if refs else set()
        pages_ = {str((obj.get("cite") or {}).get("page")) for obj in refs}
        if len(refs) < 2 and not any(k == "v" for k, _, _ in parts):
            continue
        if len(cites) != 1 or len(pages_) != 1 or not all((o.get("cite") or {}).get("read") == "image" for o in refs):
            continue
        rx = _template_rx([(k, t) for k, t, _ in parts])
        if rx is None:
            continue
        for obj in refs:
            out.setdefault(id(obj), []).append(("tpl", rx))
    return out


_STYLE_WORDS = ("bold", "italic", "underline")


def _style_tags(text, reading, page, annots=()):
    """Emphasis words (bold / italic / underline) in the style field of reading lines that confirm `text` whole."""
    pages = _cited_pages(page)
    want = _norm(text)
    out = set()
    for ln in _reading_lines(reading, pages or (), annots) if pages else ():
        if not ln["uncertain"] and _hit(want, ln):
            out |= {w for w in _STYLE_WORDS if w in ln["style"]}
    return out


def reading_annotations(meta):
    """Declared printed annotations of image sources (rule g): meta.image_read.reading_annotations, a list of
    {"source", "pattern", "why"/"cite"} (or plain regex strings when meta.image_read names one "source"). Each regex
    is removed from the content fields of that source's blind-reading lines only, e.g. a result share the print adds
    after an option ('\\s*\\[\\d+ percent\\]$'). Returns ({source: (patterns)}, report list); a bad declaration is
    reported with "error" and blocks."""
    ir = meta.get("image_read") if isinstance(meta, dict) else None
    decl = ir.get("reading_annotations") if isinstance(ir, dict) else None
    by_src, rep = {}, []
    if decl is None:
        return by_src, rep
    if not isinstance(decl, list):
        return by_src, [{"source": None, "pattern": None, "error": "reading_annotations must be a list"}]
    for d in decl:
        src, pat = (ir.get("source"), d) if isinstance(d, str) else \
            ((d.get("source"), d.get("pattern")) if isinstance(d, dict) else (None, None))
        row = {"source": src, "pattern": pat}
        if not isinstance(src, str) or not src:
            row["error"] = "no source named"
        elif not isinstance(pat, str) or not pat or len(pat) > 300:
            row["error"] = "pattern must be a regex of 1-300 characters"
        else:
            try:
                re.compile(pat)
            except re.error as e:
                row["error"] = "bad regex: %s" % e
        if "error" not in row:
            by_src.setdefault(src, []).append(pat)
        rep.append(row)
    return {k: tuple(v) for k, v in by_src.items()}, rep


def check_verbatim(p, source_texts, public=False):
    """Every cited verbatim data string is found in its source text (when a text is available)."""
    found, missing, unchecked, image_unconfirmed, image_uncertain_only, image_uncertain_legacy = 0, [], 0, [], [], []
    image_disputed, bad_source, unchecked_sources = [], [], set()
    style_unserved = []
    checked_privately = set()
    texts = {k: _norm(v) for k, v in source_texts.items()}
    raw = source_texts
    groups = _image_groups(p)
    meta = (getattr(p, "raw", None) or {}).get("meta") or {}
    known = set()
    srcs = meta.get("sources")
    if isinstance(srcs, dict):
        known |= set(srcs)
    elif isinstance(srcs, list):
        known |= {x[0] for x in srcs if isinstance(x, (list, tuple)) and x}
    for d in meta.get("designs") or []:
        for x in (d.get("sources") or []) if isinstance(d, dict) else []:
            if isinstance(x, dict) and x.get("name"):
                known.add(x["name"])

    sid = (getattr(p, "raw", None) or {}).get("id")   # the protocol's id (survives copies of the study folder)
    known |= LEGACY_CITE_SOURCES.get(sid if isinstance(sid, str) else "", set())

    def source_ok(s):
        return isinstance(s, str) and "#" not in s and s in known

    def readings(source):
        # independent blind readings of a source: <source>#second, #second-<k> (new pages, later rounds) and
        # #third, #third-<k> (third blind reader of disputed lines; skills README Decided 5)
        rx = re.compile(re.escape(str(source)) + r"#(?:second|third)(?:-\d+)?")
        return [v for k, v in sorted(raw.items()) if rx.fullmatch(k)]

    def legacy(r):
        return hashlib.sha256(r.encode("utf-8")).hexdigest() in LEGACY_UNCERTAIN_READINGS

    annots, annotations = reading_annotations(meta)
    for a in annotations:   # how many reading lines of that source each declared pattern changes (reviewed)
        if "error" not in a:
            rx = re.compile(a["pattern"])
            a["lines_changed"] = sum(1 for r in readings(a["source"]) for ln in r.splitlines()
                                     if re.match(r"\s*p\d+\s*\|", ln) and rx.sub("", ln) != ln)

    def walk(o):
        nonlocal found, unchecked
        if isinstance(o, dict):
            c = o.get("cite")
            if "text" in o and isinstance(c, dict) and c.get("label") == "verbatim":
                if not source_ok(c.get("source")):
                    # a cite must name a source of meta.sources (or meta.designs[*].sources); a blind reading
                    # (<source>#second/#third…) or a sourcetext file name is never a source (skills review-2 S3')
                    bad_source.append((c.get("source"), o["text"][:80]))
                    return
                if c.get("read") == "image":
                    # transcribed by the converter from a page image (= the served first reading). Decided 5:
                    rs = readings(c.get("source"))
                    # readings whose reader read this page; a byte-identical copy of a reading is one reading
                    rs = list(dict.fromkeys(r for r in rs if _covers(r, c.get("page"))))
                    if public and not rs:   # readings of non-open sources are not shipped: checked privately
                        checked_privately.add(str(c.get("source")))
                        return
                    g_ = groups.get(id(o), ())   # printed-line joins / composed templates (review-4)
                    an_ = annots.get(c.get("source"), ())
                    agree = [r for r in rs if _image_match(o["text"], r, c.get("page"), groups=g_, annots=an_)]
                    unsure = [r for r in rs if r not in agree
                              and _image_match(o["text"], r, c.get("page"), uncertain=True, groups=g_, annots=an_)]
                    disagree = [r for r in rs if r not in agree and r not in unsure]
                    key = (c.get("source"), c.get("page"), o["text"][:80])
                    if disagree:
                        image_disputed.append(key)
                    styles = set()
                    for r in agree:
                        styles |= _style_tags(o["text"], r, c.get("page"), an_)
                    note = json.dumps(c, ensure_ascii=False).lower()
                    miss = sorted(st for st in styles if not o.get("spans") and not o.get("style") and st not in note)
                    if miss:   # the reader saw emphasis the served text does not carry or declare (report only)
                        style_unserved.append(key + (miss,))
                    if not disagree and agree:
                        found += 1          # served + one blind reading (an [uncertain]-only reading settled)
                    elif disagree and len(agree) >= 2 and len(agree) > len(disagree):
                        found += 1          # dispute settled by two blind readings that agree with the served text
                    elif not disagree and not agree and any(legacy(r) for r in unsure):
                        found += 1
                        image_uncertain_legacy.append(key)
                    else:
                        image_unconfirmed.append(key)
                        if unsure and not disagree:
                            image_uncertain_only.append(key)
                    return
                src = texts.get(c.get("source"))
                if src is None and public:   # source text of a non-open source: checked privately, not here
                    checked_privately.add(str(c.get("source")))
                elif src is None:
                    unchecked += 1   # no source text to check against: blocking (skills review-2 S3')
                    unchecked_sources.add(str(c.get("source")))
                elif _norm(o["text"]) in src:
                    found += 1
                else:
                    missing.append((c.get("source"), o["text"][:80]))
                for sp in o.get("spans") or []:   # hover text on part of a line (title tooltip) is on-screen text too
                    if isinstance(sp, dict) and isinstance(sp.get("tooltip"), str):
                        walk({"text": sp["tooltip"], "cite": c})
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(p.data)
    for st in p.stages.values():   # literal on-screen text in stages
        for it in st.get("content", []):
            v_ = it.get("value", it.get("text"))
            if isinstance(v_, str) and isinstance(it.get("cite"), dict):
                walk({"text": v_, "cite": it["cite"]})
            elif isinstance(v_, dict) and "expr" not in v_:   # inline text dicts / images (LESSONS 246)
                walk(dict(v_, cite=v_.get("cite", it.get("cite"))) if "text" in v_ else v_)
        for r in st.get("responses", []):
            pr_ = r.get("prompt")
            if isinstance(pr_, str) and isinstance(r.get("prompt_cite") or r.get("cite"), dict):
                walk({"text": pr_, "cite": r.get("prompt_cite") or r.get("cite")})
            elif isinstance(pr_, dict) and "expr" not in pr_:
                walk(dict(pr_, cite=pr_.get("cite", r.get("prompt_cite") or r.get("cite"))) if "text" in pr_ else pr_)
            if isinstance(r.get("instruction"), str) and isinstance(r.get("instruction_cite"), dict):
                walk({"text": r["instruction"], "cite": r["instruction_cite"]})
            if isinstance(r.get("anchors"), dict) and isinstance(r.get("anchors_cite"), dict):
                for side, lab in r["anchors"].items():
                    walk({"text": lab, "cite": r["anchors_cite"]})
            for o in r.get("options", []) if isinstance(r.get("options"), list) else []:
                if isinstance(o.get("label"), str) and isinstance(o.get("cite"), dict):
                    walk({"text": o["label"], "cite": o["cite"]})
                elif isinstance(o.get("label"), dict) and "expr" not in o["label"]:
                    walk(dict(o["label"], cite=o["label"].get("cite", o.get("cite"))) if "text" in o["label"] else o["label"])
    return {"found": found, "not_found": missing, "unchecked": unchecked, "unchecked_sources": sorted(unchecked_sources),
            "bad_source": bad_source, "image_unconfirmed": image_unconfirmed, "image_disputed": image_disputed,
            "image_uncertain_only": image_uncertain_only, "image_uncertain_legacy": image_uncertain_legacy,
            "reading_annotations": annotations, "style_unserved": style_unserved[:40],
            "checked_privately": sorted(checked_privately)}


def unprompted_responses(sessions):
    """Report (not a failure), from rendered pages: an answer box with no prompt on a page that shows almost no text —
    nothing tells the person what to enter (LESSONS 226)."""
    out = set()
    for s in sessions:
        for pg in getattr(s, "pages", []):
            text = sum(len(str(i.get("text") or "")) + sum(len(str(x)) for x in (i.get("lines") or []))
                       + len(str(i.get("rows") or "")) for i in (pg.get("shown") or []))
            text += sum(len(str(r.get("prompt") or "")) + len(str(r.get("instruction") or ""))
                        + len(str(r.get("anchors") or "")) for r in (pg.get("resp") or []))   # whole page's words
            for r in pg.get("resp") or []:
                pr = r.get("prompt")
                if not (isinstance(pr, str) and pr.strip()) and text < 40 and not r.get("options"):
                    out.add("+".join(n for n, _ in pg["stages"]))
    return sorted(out)


def script_texts_not_served(p, source_texts):
    """Report (not a failure): text that page scripts write onto the screen (document.write, innerHTML, .html(),
    .text()) in the saved sources, which no served string contains (LESSONS 283)."""
    served = _norm(json.dumps(p.raw, ensure_ascii=False))
    pat = re.compile(r"""(?:document\.write(?:ln)?\s*\(|innerHTML\s*\+?=|\.html\s*\(|\.text\s*\()\s*(['"])(.*?)(?<!\\)\1""", re.S)
    out = []
    for name, txt in source_texts.items():
        for m in pat.finditer(txt):
            t = re.sub(r"<[^>]+>", " ", m.group(2))
            t = re.sub(r"\s+", " ", t).strip()
            if len(t) >= 12 and re.search(r"[A-Za-z\u00C0-\u024F]{3}", t) and _norm(t) not in served:
                out.append((name, t[:80]))
    return sorted(set(out))[:40]


def constant_images(sessions):
    """Report (not a failure) stages shown 3+ times in a session whose texts change but whose pictures never do —
    e.g. every product-pair page serving one picture (LESSONS 212). A fixed logo is fine; reviewers look here first."""
    out = {}
    for s in sessions:
        visits = {}
        for pg in getattr(s, "pages", []):
            key = "+".join(n for n, _ in pg["stages"])
            shown = pg.get("shown") or []
            srcs = tuple(i.get("src") for i in shown if i.get("src"))
            texts = tuple(str(i.get("text") or i.get("lines") or i.get("rows") or "") for i in shown if not i.get("src"))
            visits.setdefault(key, []).append((srcs, texts))
        for key, vs in visits.items():
            if len(vs) >= 3 and all(v[0] for v in vs) and len({v[0] for v in vs}) == 1 and len({v[1] for v in vs}) > 1:
                out[key] = out.get(key, 0) + 1
    return sorted(out)


def main(argv=None):
    if sys.version_info < (3, 11):   # coding rules use Python 3.11+ regex (atomic groups); LESSONS 286
        sys.exit("hsenv.checks needs Python 3.11+ (found %s)" % sys.version.split()[0])
    ap = argparse.ArgumentParser()
    ap.add_argument("study")
    ap.add_argument("--sessions", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--source-text", action="append", default=[], help="name=path to a text file of that source")
    ap.add_argument("--fetch-images", action="store_true", help="fetch every image src and compare its sha256")
    ap.add_argument("--public", action="store_true",
                    help="public release check (Bench CI): no private config, release_hold blocks, texts whose source "
                         "text / blind readings are not supplied are listed as checked privately instead of blocking")
    a = ap.parse_args(argv)
    p = Protocol.load(a.study)
    report, fail = {}, False
    from .schema_check import canonical_sha256
    report["protocol_sha256"] = canonical_sha256(p.raw)   # binds this report to the exact protocol (stale = fail)
    report["public"] = bool(a.public)
    if a.public:   # the private, study-specific exemptions never apply to a public check
        global LEGACY_UNCERTAIN_READINGS, LEGACY_CITE_SOURCES
        LEGACY_UNCERTAIN_READINGS, LEGACY_CITE_SOURCES = {}, {}
    report["refs"] = check_refs(p)
    fail |= bool(report["refs"])
    env, probs, stats = play(p, a.sessions, a.seed, "random")
    n, tries = a.sessions, 0
    # heavy screening (sessions ending early): run more sessions so every effect has data. Exclusions of completed
    # sessions do not count here: effects are computed on all completed sessions, and random answers tripping a
    # declared exclusion rule is expected (LESSONS 163)
    while sum(1 for r in env.records() if r["status"] == "completed") < 30 and tries < 5:
        n, tries = n * 2, tries + 1
        env, probs, stats = play(p, n, a.seed, "random")
    stats["sessions_run"] = n
    if stats["unreached_stages"]:   # rare branches (k consecutive choices): coverage-guided pass
        xenv, xprobs, xstats = play(p, n, a.seed + 7, "random", explore={})
        stats["unreached_stages"] = sorted(set(stats["unreached_stages"]) & set(xstats["unreached_stages"]))
        stats["coverage_pass"] = True
        probs = probs + xprobs
    report["fuzz"] = dict(stats, problems=probs[:10])
    tables = env.unit_tables()
    recs = env.records()
    report["fuzz"]["constant_images"] = constant_images(env.sessions[:50])
    report["script_texts_not_served"] = script_texts_not_served(
        p, {k: open(v, errors="replace").read() for k, v in (x.split("=", 1) for x in a.source_text)})
    report["fuzz"]["unprompted_responses"] = unprompted_responses(env.sessions[:50])
    report["fuzz"]["excluded_share"] = round(sum(1 for r in recs if r["excluded"]) / max(1, len(recs)), 3)
    pop = env.population_exclusions([x for x in env.sessions if x.status])
    report["fuzz"]["population_excluded_sessions"] = {ex["id"]: sum(1 for v in pop.values() for e in v if e["id"] == ex["id"])
                                                     for ex in p.exclusions if ex.get("population")}
    fail |= bool(stats.get("blocked_effects_not_computed"))
    fail |= bool(probs) or bool(stats["unreached_stages"]) or bool(stats["n_unanswerable"]) or bool(stats["leaks"])
    fail |= bool(stats["state_expr_leaks"])   # unresolved expressions in a served State (fidelity review R1-M1, 2026-11-08)
    blocks = effect_blocks(p, tables, only_included=False)
    report["fuzz"]["effects_not_computed"] = [b["effectId"] for b in blocks if b["status"] != "computed"]
    pend = {}   # effects whose rows wait on an undecided exclusion (e.g. replies left to a coder): never silent
    for e in all_effects(p):
        rows = [r for r in tables.get(e["unit"], []) if not r["excluded"]   # same base as targets' pending_share
                and not (set(r.get("excluded_for") or []) & {e["id"], e["unit"]})]
        k = sum(1 for r in rows if _pending(r, [e["id"], e["unit"]]))
        if k:
            pend[e["id"]] = round(k / len(rows), 3)
    report["fuzz"]["pending_share"] = pend
    fail |= bool(report["fuzz"]["effects_not_computed"])
    if p.raw.get("keyed"):
        kenv, kprobs, kstats = play(p, max(50, a.sessions // 5), a.seed + 1, "keyed")
        krecs = kenv.records()
        kt = kenv.unit_tables()
        kb = effect_blocks(p, kt)
        signs = []
        for e, b in zip(all_effects(p), kb):
            hs, why = human_sign(e)
            if hs is None:
                signs.append({"effect": e["id"], "human": None, "keyed": None, "same_sign": why != NO_SIGN, "why": why})
                continue
            ok = b["status"] == "computed" and same_sign(b["value"], hs)
            signs.append({"effect": e["id"], "human": round(hs, 3), "keyed": None if b["status"] != "computed" else round(b["value"], 3), "same_sign": ok})
        ex = round(sum(1 for r in krecs if r["excluded"]) / max(1, len(krecs)), 3)
        report["keyed"] = {"problems": kprobs[:10], "excluded_share": ex, "signs": signs,
                           "state_expr_leaks": kstats["state_expr_leaks"]}
        fail |= bool(kprobs) or ex > 0 or not all(s["same_sign"] for s in signs) or bool(kstats["state_expr_leaks"])
    texts = {}
    for st in a.source_text:
        name, _, path = st.partition("=")
        texts[name] = Path(path).read_text(encoding="utf-8", errors="replace")
    # control characters in a source text (e.g. ligatures stored as NUL) silently drop letters: report them
    report["source_text_control_chars"] = {n: len(re.findall(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", t))
                                           for n, t in texts.items() if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", t)}
    report["verbatim"] = check_verbatim(p, texts, public=a.public)
    # declared printed-annotation strips are listed in every output (reviewers check each pattern); a bad one blocks
    report["reading_annotations"] = report["verbatim"]["reading_annotations"]
    fail |= any("error" in a for a in report["reading_annotations"])
    fail |= bool(report["verbatim"]["not_found"]) or bool(report["verbatim"]["image_unconfirmed"])
    fail |= bool(report["verbatim"]["bad_source"]) or report["verbatim"]["unchecked"] > 0   # skills review-2 S3'
    report["coding"] = run_coding_cases(p)
    fail |= any(c["mismatches"] for c in report["coding"].values())
    report["paper_consistency_warnings"] = paper_consistency(p)
    report["statistic_vocabulary"] = statistic_vocabulary(p)   # report only
    report["printed_item_tests"] = printed_item_tests(p)       # report only
    report["second_readings"] = [t["id"] for t in (p.raw.get("analysis") or {}).get("targets", [])
                                 if t.get("second_reading") or t.get("readings")]
    if a.fetch_images:
        report["images"] = fetch_images(p, env)
        fail |= any(not x.startswith("note:") for x in report["images"])
    report["release_hold"] = [{"arm": x["id"], "why": x["release_hold"]} for x in p.arms if x.get("release_hold")]
    if a.public:
        fail |= bool(report["release_hold"])   # nothing on release_hold is ever published
    tv_ = target_values(p, tables)
    report["targets_random"] = tv_[:3]
    report["fuzz"]["targets_pending_share"] = {t["id"]: t["pending_share"] for t in tv_ if t.get("pending_share")}
    drop = {}
    for e in all_effects(p):
        f = (e.get("compute") or {}).get("field")
        rows = tables.get(e.get("unit"), [])
        if f and rows:
            none = sum(1 for r in rows if effects_core.field(r, f) is None)
            if none:
                drop[e["id"]] = round(none / len(rows), 3)
    report["effect_dropout_random"] = dict(sorted(drop.items(), key=lambda kv: -kv[1])[:15])
    report["PASS"] = not fail
    print(json.dumps(report, indent=1, ensure_ascii=False, default=str))
    return 0 if not fail else 1


if __name__ == "__main__":
    sys.exit(main())
