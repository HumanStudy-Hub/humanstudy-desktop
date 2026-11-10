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
                                "state which run first (cite), or [] if the cutoff uses everyone" % ex["id"])
    # typed response fields reach the State as plain values: a note written into one is a leak
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
                                "output, provenance}" % cname)
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
                    # no validation targets, no constructed switch points or sums (maintainers 2026-11-08)
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
                    # "exactly one of these" can be met
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
            # them), but row-level trims still apply
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
    """Strict sign agreement: a keyed value of exactly 0 matches neither a positive nor a negative human
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
    """Study-specific pins live outside the public engine (engine code is public, study data may
    not): a JSON file named by env HSENV_PRIVATE_CONFIG (unset or empty = none). Absent file = no pins (a public
    install has none). Keys:
    legacy_uncertain_readings {sha256: label}, legacy_cite_sources {protocol id: [sourcetext names]},
    fetch_images_study_prefixes [folder-name prefixes check_all always image-checks]."""
    import os
    env = os.environ.get("HSENV_PRIVATE_CONFIG")
    if not env:
        return {}
    path = Path(env)
    if not path.is_file():
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


# v3 (review round 4 M2): only list glyphs are stripped, a leading number / letter enumerator only on option / slider
# lines or when a bullet / numbered note vouches for it (_enum_ok)
_GLYPH_BULLET = re.compile(r"^(?:[•·▪◦‣∙●○■□–—-]\s+|\*\s*)")
# round 10 S1: without a bullet clause a dash followed by a digit is a minus sign, never a glyph
_GLYPH_BULLET_ND = re.compile(r"^(?:[•·▪◦‣∙●○■□]\s+|[–—-]\s+(?![0-9])|\*\s*)")
_V3_GLYPHS = (_GLYPH_BULLET, _GLYPH_BULLET_ND)


_ENUM_UNIT = re.compile(r"\(?[a-z0-9]{1,2}[.):]")   # '3.', 'b)', '3:' — an enumerator, not a sentence / colon part


def _v3_bullet(kind, forms):
    """Round 9 S1: what a v3 line may strip at its start: option / slider lines a leading number or glyph (as before);
    under a 'numbered n' clause exactly 'n.' / 'n)'; otherwise (also under a bullet clause) only a list glyph."""
    if re.match(r"(?:option|slider)", kind):
        return _BULLET
    nums = [mm.group(1) for f, mm, _ in forms if f == "numbered"]
    if len(nums) == 1:
        return re.compile(r"^%s[.)]\s+" % re.escape(nums[0]))
    return _GLYPH_BULLET if any(f == "bullet" for f, _, _ in forms) else _GLYPH_BULLET_ND


def _enum_ok(kind, forms):
    """v3: may a leading number / letter be stripped from this line's fields?"""
    return bool(re.match(r"(?:option|slider)", kind)) or any(f in ("bullet", "numbered") for f, _, _ in forms)


def _units(field, bul=_BULLET):
    """Whole units of one normalised field (reader marks already removed by _MARKS): the field, the field without a
    list bullet, and every contiguous run of its sentences / colon-separated parts ('Block 1:' and '(Task "orange")'
    of 'Block 1: (Task "orange")'). Never a word or phrase inside a sentence, and bracketed text is never dropped
    (skills review-4 M6)."""
    out = {field}
    nob = bul.sub("", field)
    out.add(nob)
    for f in list(out):
        us = [u for u in _UNITS.split(f) if u]
        # v3 (strict bullets): a leading enumerator 'e.' / '3)' is not a sentence of its own
        # round 10 S1: the enumerator test looks at the first unit after the list glyph is stripped
        enum0 = bul in _V3_GLYPHS and bool(us) and bool(_ENUM_UNIT.fullmatch(_GLYPH_BULLET.sub("", us[0])))
        if 1 < len(us) <= 60:
            for i in range(len(us)):
                if i == 1 and enum0:
                    continue
                for j in range(i + 1, len(us) + 1):
                    out.add(bul.sub("", " ".join(us[i:j])))
    return {x for x in out if x}


_CONT_NEXT = re.compile(r"\[\s*continues on next page\s*\]", re.I)
_CONT_NEXT_END = re.compile(r"\s*\[\s*continues on next page\s*\]\s*$", re.I)
_V3_TOKEN = re.compile(r"format\s*:?\s*v3\b", re.I)
# LEGACY readings: the closed sha256 pin set of the reading files collected before the v3 reader prompt (private
# config key legacy_readings; a public copy has none, so every reading is v3)
LEGACY_READINGS = set(PRIVATE.get("legacy_readings") or ())


def reading_sha256(reading):
    """sha256 of a reading as text (UTF-8; line ends as read)."""
    return hashlib.sha256(reading.encode("utf-8")).hexdigest()


def reading_header_v3(reading):
    """True when line 1 of a reading carries the format token (NFKC; 'format v3', 'format: v3'); blind_reader_dir.py
    collect refuses a reading without it."""
    first = reading.split("\n", 1)[0]
    return bool(_V3_TOKEN.search(unicodedata.normalize("NFKC", first)))


def _is_v3(reading):
    """A reading is LEGACY only when its sha256 is pinned (LEGACY_READINGS); every other reading is read with the full
    closed grammar (DESIGN.md §3.5, pass 3 format gate)."""
    return reading_sha256(reading) not in LEGACY_READINGS


def _reading_lines(reading, pages, annots=()):
    """[(page, screen, kind, content fields)] of the reading's lines on <pages>, uncertain lines marked. annots:
    the protocol's declared printed-annotation regexes for this reading's source (meta.image_read
    .reading_annotations), removed from every content field before comparing."""
    return _reading_lines_c(reading, frozenset(pages), tuple(annots), _is_v3(reading))


import functools as _functools   # noqa: E402  (kept inside the matcher section)

# a reader's mark for a picture inside a line ('outcome "[callout die image]" results in'): the text on either side
# is a separate printed fragment for the fragment-template rule (rule h, 2026-11-08)
_IMAGE_MARK = re.compile(r"\[\s*(?:(?:image|picture|photo|icon|logo|figure)\b[^\]]*|(?:note\s*:|callout\b)[^\]]*?"
                         r"\b(?:image|picture|photo|icon|logo|figure|pictogram)s?\b[^\]]*)\]", re.I)


_MARKS_V3 = re.compile(_MARKS.pattern.replace(r"callout\b[^\]]*|", ""), re.I)   # v3: [callout …] is not stripped


def _clean_field(f, v3=False):
    return _norm((_MARKS_V3 if v3 else _MARKS).sub("", re.sub(r"\[value [a-z]+: ([^\]]*)\]", r"\1", f, flags=re.I)))


# Engine pass 3 (segmentation rules; every confirmation reports its match_rule). Reader notes are read with a CLOSED
# GRAMMAR (maintainers 2026-11-08, review round 2): a note is split into clauses on ';' and every clause must fully
# match one accepted form (_note_clause). A line whose notes hold any unrecognised clause gets no segmentation rule
# (list_marker, multiline_k, image_gap, column_rows); a '?' or a doubt word in any note makes the line uncertain for
# every rule. The same forms are the reader vocabulary of skills/refinery-review/prompts.md §1.
_GAP = ""     # one picture mark inside a reading line (rule 2); a private-use character no text contains
_BLOCK = ""   # a reader mark that may hide printed text: no gap rule can step over it
# a list glyph at the start of a served line ('• ', '- ', '* ', '1. '); rule 3. ASCII digits only.
_LIST_GLYPH = re.compile(r"^(?:([•·▪◦‣∙●○■□–—*-])|([0-9]{1,2})[.)])\s+")
_NOTE_BODY = re.compile(r"\[\s*note\s*:([^\]]*)\]", re.I)
_NUM = re.compile(r"-?[0-9]+(?:\.[0-9]+)?")
_NUMROW = re.compile(r"-?[0-9]+(?:\.[0-9]+)?(?: -?[0-9]+(?:\.[0-9]+)?)+")
_COLPOS = re.compile(r"\bcolumn\s+(\S+)\s+(top|bottom|upper|lower)\b")
_DELIMS = "\"'()[]«»"
# doubt about what is printed: uncertain for every rule (Decided 5)
_DOUBT = re.compile(r"\?|\b(?:could|maybe|may be|might|possibly|perhaps|probably|likely|unsure|not sure|uncertain|"
                    r"unclear|looks like|hard to read|faint|blurry|blurred|smudged?|illegible|either|vs|versus|"
                    r"cut off|cropped|seems?|partly|obscured|low resolution|i think)\b|"
                    r"[0-9]\s*(?:/|\bor\b)\s*[0-9]|[\"']\s*or\s*[\"']", re.I)
_PIC_FORBIDDEN = {"and", "word", "words", "text", "printed", "reads", "labelled", "labeled", "label", "says", "saying",
                  "missing", "absent", "instead", "without", "blank", "caption", "lettering", "letters", "heading",
                  "title", "inscribed", "written", "sign", "name"}


def _doubtful(s):
    """A reader's doubt in a note / kind / style text (format controls such as zero-width spaces removed first)."""
    return bool(_DOUBT.search(_nfold("".join(ch for ch in s if unicodedata.category(ch) != "Cf"))))
_CLAUSE_FORMS = (
    ("bullet", re.compile(r"(?:round |hollow |black )?bullet(?:ed)?(?: point| list(?: item)?| item)?")),
    ("numbered", re.compile(r"numbered(?: list)?(?: item)? \(?([0-9]{1,2})\)?")),
    ("picture", re.compile(r"(?:image|picture|photo|icon|logo|figure|die face|callout)"
                           r"(?: of (?:a|an|the) [a-z]+(?: [a-z]+){0,2})?")),
    ("picture_die", re.compile(r"die face showing (?:one|two|three|four|five|six|[0-9]) pips?")),
    ("position", re.compile(r"(?:sits |placed |shown )?between the (?:two )?(?:straight |curly )?(?:double |single )?"
                            r"quotes")),
    ("same_cell", re.compile(r"same cell(?: as \"([^\"]+)\")?(?:, printed on (?:two|[0-9]) lines)?")),
    ("column", re.compile(r"column ([0-9]{1,3})(?: of ([0-9]{1,3}))?")),   # rule 4 option pairs
    ("line", re.compile(r"line [0-9]+(?: of [0-9]+)?|(?:first|second|third|last) line")),   # rule k
    # style clauses: recognised, never vouch for anything
    ("style_q", re.compile(r"\"([^\"]+)\" in (?:bold|italic|underlined?)")),
    ("style", re.compile(r"(?:bold|italic|underlined|greyed|grey|small|large|centred|centered)(?: text)?")),
    ("style", re.compile(r"printed on (?:two|[0-9]) lines")),
    ("style", re.compile(r"wraps onto a second line")),
    ("style_q", re.compile(r"wraps onto a second line after \"([^\"]+)\"")),
    ("style", re.compile(r"footer below a horizontal rule")),
    ("style", re.compile(r"progress bar")),
    ("style", re.compile(r"salmon-shaded header spanning [0-9]+ columns")),
    ("style", re.compile(r"row label")),
)
_LINE_N = re.compile(r"line ([0-9]+)(?: of ([0-9]+))?|(first|second|third|last) line")   # used with fullmatch
_MENTION = re.compile(r"\b(?:row|rows|column|columns|col|head|heads|header|headers|heading|headings)\b")


def _nfold(s):
    """NFKC, curly quotes straight, whitespace collapsed, lower case (the form note clauses are matched in)."""
    return _norm(s)


def _note_clause(clause, content=None):
    """(form, match) when a note clause fully matches one accepted form, else None. A style clause quoting printed
    text ('"…" in bold', 'wraps onto a second line after "…"') is recognised only when the quote occurs in the same
    line's own printed content (content: its normalised contents; None = no check, used for style fields)."""
    c = _nfold(clause)
    upper = any(w[:1].isupper() for w in re.findall(r"[^\W\d_]+", clause)[1:])
    for name, rx in _CLAUSE_FORMS:
        m = rx.fullmatch(c)
        if m and name in ("picture", "picture_die") and upper:
            continue   # round 9 S5: a capitalised word inside a picture description may be printed text
        if not m or (name == "picture" and (_PIC_FORBIDDEN & set(c.split())
                                            or any(re.search(r"(?:ing|ed)$", w) for w in c.split()[1:]))):
            continue   # a picture description holds no verb / participle (stamped, showing, …) and no printed-text word
        if name == "picture_die":
            return "picture", m
        if name == "style_q":
            if content is not None and not any(m.group(1) in x for x in content):
                return None
            return "style", m
        return name, m
    return None


def _clauses(body):
    return [x for x in (_nfold(p) for p in body.split(";")) if x]


def _raw_clauses(body):
    """The ';' clauses of a note as written (case kept, for the picture form's upper-case check)."""
    return [p.strip() for p in body.split(";") if p.strip()]


def _picture_mark(mark):
    """Rule 2: a bracketed mark that stands for one picture and nothing printed — [image], [picture …], [callout …]
    or [note: …] whose body (every ';' clause) is the picture form, optionally with a position clause."""
    body = mark.strip()[1:-1].strip()
    if re.match(r"(?i)note\s*:", body):
        body = re.sub(r"(?i)^note\s*:", "", body)
    cl = _raw_clauses(body)
    kinds = [(_note_clause(x) or (None,))[0] for x in cl]
    return bool(kinds) and kinds.count("picture") == 1 and all(k in ("picture", "position") for k in kinds)


def _line_info(line, kind, style, screen="", contents=(), v3=False):
    """Grammar facts of one reading line: its note clauses, whether all are recognised, doubt (notes, kind and style
    fields), the rule-k line number (a line-marker part of the kind / style field or a whole line-marker note clause),
    note clauses mentioning a row / column / head, and 'partish' (v3, S1: a screen / kind / style part or note clause
    speaking of lines or parts that is not an exact marker or a recognised whole-element style clause)."""
    raw_notes = [m.group(1) for m in _NOTE_BODY.finditer(line)]
    notes = [_nfold(x) for x in raw_notes]
    forms, unknown, mention, any_mention = [], False, False, False
    for n in raw_notes:
        for cl_raw in _raw_clauses(n):
            cl = _nfold(cl_raw)
            f = _note_clause(cl_raw, contents)
            if f is None:
                unknown = True
                mention = mention or bool(_MENTION.search(cl))
            any_mention = any_mention or bool(_MENTION.search(cl))
            forms.append((f[0], f[1], cl) if f else (None, None, cl))
    callouts = [m.group(0) for m in re.finditer(r"\[\s*callout\b[^\]]*\]", line, re.I)]
    pics = [m.group(0) for m in _IMAGE_MARK.finditer(line) if not re.match(r"(?i)\[\s*note\s*:", m.group(0))]
    if any(not _picture_mark(x) for x in callouts + pics):   # a picture / callout mark outside the grammar
        unknown = True
    doubt = any(_doubtful(n) for n in notes) or any("?" in x for x in callouts) or _doubtful(kind) \
        or _doubtful(style)
    # rule k: only a clause that IS a line marker — a ','-part of the kind or style field, or a whole note clause
    # ('at the start of line 3' inside a remark is no marker)
    ln_ = None
    # a kind / style field holding a bracketed remark ('[photo 3: banner, line 1, cropped]') is a remark, not clauses
    # (legacy: ','-parts as before; v3: clauses split on ';' and ',' as everywhere else in v3)
    parts = [x for fld in (kind, style) if "[" not in fld
             for x in (_field_parts(fld) if v3 else [y.strip() for y in fld.split(",")])] + \
        [cl for f, _, cl in forms if f == "line"]
    for where in parts:
        m = _LINE_N.fullmatch(where)
        if m:
            n_ = int(m.group(1)) if m.group(1) else {"first": 1, "second": 2, "third": 3, "last": -1}[m.group(3)]
            ln_ = (n_, int(m.group(2)) if m.group(2) else None)
            break
    exact = lambda x: bool(_LINE_N.fullmatch(x)) or (_note_clause(x, contents) or (None,))[0] in ("style", "same_cell")
    pieces = [x for fld in (kind, style) for x in _field_parts(fld, contents)] + [cl for _, _, cl in forms]
    partish = any(re.search(r"\blines?\b|\bln [0-9]|\bpart [0-9]", x) and not exact(x) for x in pieces if x) \
        or bool(re.search(r"\blines?\b|\bln [0-9]|\bpart [0-9]", screen))   # rule k never reads the screen field
    return {"forms": forms, "notes_ok": not unknown and not doubt, "doubt": doubt, "line_n": ln_, "unknown": unknown,
            "note_mention": mention, "any_note_mention": any_mention, "partish": partish}


_ANCHOR_FORBIDDEN = _PIC_FORBIDDEN | {"followed", "then"}


# maintainer ruling (round 7): the narrow extra legacy forms - an optional article before the picture keyword,
# 'callout' directly followed by a picture phrase, and the die-face phrases, each optionally followed by a position
# clause; nothing broader
_ANCHOR_POS = r"(?:sits |placed |shown )?between the (?:two )?(?:straight |curly )?(?:double |single )?quotes"
_ANCHOR_DIE = (r"(?:die face|die image|image of a die face|picture of a die face)"
               r"(?: showing (?:one|two|three|four|five|six|[0-9]) pips?)?")
_ANCHOR_KW_FORM = r"(?:image|picture|photo|icon|logo|figure|die face)(?: of (?:a|an|the) [a-z]+(?: [a-z]+){0,2})?"
_ANCHOR_NARROW = re.compile(r"(?:(?:a|an|the) )?(?:callout )?(?:%s|%s)(?: %s)?" % (_ANCHOR_DIE, _ANCHOR_KW_FORM,
                                                                                    _ANCHOR_POS))


def _anchor_picture(mark):
    """v3 anchor (review rounds 6-7): a legacy mark counts as the picture only if it fully matches _IMAGE_MARK, holds no
    quote or digit, and every ';' / ',' / '/' part is the bare picture keyword, the v3 picture form ('<kw>( of a/an/the
    w{1,3})?', 'die face showing <n> pips'), '<kw>: <one to three lower-case words>' or a position clause — with at
    least one picture part, no upper-case word after the keyword, and none of the forbidden words."""
    if not _IMAGE_MARK.fullmatch(mark) or re.search(r"[\"“”'‘’`«»„]|[0-9]", mark[1:-1]):
        return False
    body = re.sub(r"(?i)^\s*note\s*:\s*", "", mark[1:-1].strip())
    kw = r"(?:image|picture|photo|icon|logo|figure|die face|callout)"
    pic = 0
    for part in (x.strip() for x in re.split(r"[;,/]", body)):
        if not part:
            continue
        if any(w[:1].isupper() for w in re.findall(r"[^\W\d_]+", part)[1:]):
            return False
        p = _nfold(part)
        words = set(re.findall(r"[a-z]+", p))
        if (_ANCHOR_FORBIDDEN | {"letter", "and"}) & words:
            return False
        # round 8 S1: no participle (-ing / -ed), except the die phrases' own 'showing'
        if any(re.search(r"(?:ing|ed)$", w) for w in words - {"showing", "placed"}):   # 'placed': position clause
            return False
        if "showing" in words and not re.search(r"(?:die face|die image) showing (?:one|two|three|four|five|six|[0-9]) "
                                                 r"pips?", p):
            return False
        form = (_note_clause(p) or (None,))[0]
        if form == "picture" or re.fullmatch(kw + r"(?:\s*:\s*[a-z]+(?: [a-z]+){0,2})?", p) or _ANCHOR_NARROW.fullmatch(p):
            pic += 1
        elif form != "position":
            return False
    return pic >= 1


def _gapform(c, anchor=False):
    """Rule 2: one reading content with each picture mark (_picture_mark) replaced by _GAP; any other bracketed mark
    inside the text becomes _BLOCK (it may hide printed text); at the edges marks are dropped (a line whose notes
    are not all recognised gets no gapform at all). Picture marks are never merged: [image][image] is two."""
    out, pos = [], 0
    for m in re.finditer(r"\[[^\]]*\]", c):
        out.append(("t", c[pos:m.start()]))
        out.append(("m", m.group(0)))
        pos = m.end()
    out.append(("t", c[pos:]))
    texts = [i for i, (k, x) in enumerate(out) if k == "t" and _clean_field(x)]
    lo, hi = (texts[0], texts[-1]) if texts else (len(out), -1)
    s = ""
    for i, (k, x) in enumerate(out):
        if k == "t":
            s += x
        elif re.fullmatch(r"\[value [a-z]+: [^\]]*\]", x, re.I):
            s += x
        elif anchor:   # v3 anchor: a picture remark inside -> the gap, at an edge -> dropped; anything else blocks
            if not _anchor_picture(x):
                s += _BLOCK
            elif lo < i < hi:
                s += _GAP
        elif lo < i < hi:
            s += _GAP if _picture_mark(x) else _BLOCK
    g_ = _clean_field(s)
    g_ = re.sub(r"\s*(%s)\s*" % _GAP, r"\1", g_)
    return g_.strip(" ")


_NAME_TAIL = r"(?:,\s*(?:bold|italic|underlined?|line [0-9]+(?: of [0-9]+)?|printed on \w+ lines?))*"


def _naming(*fields, screen=""):
    """The cell a reading line names (rule j): in its kind or style field ('rc', row label, column head) for 'row X /
    column Y[, line n][, bold]', ('head', k) for 'column head k', ('rowlabel', k) for 'row label k', ('grid', r, c)
    for 'row r col c' (1-based grid position); in its screen field ('row', n) for '… table row n' (n-th row under
    the head row) and ('row', 0) for '… table header'; else None."""
    for f in fields:
        m = re.fullmatch(r"row ([0-9]+),? col(?:umn)? ([0-9]+)" + _NAME_TAIL, f)
        if m:
            return ("grid", int(m.group(1)), int(m.group(2)))
        m = re.fullmatch(r"row (.+?) / column (.+?)" + _NAME_TAIL, f)
        if m:
            return ("rc", m.group(1).strip(), m.group(2).strip())
        m = re.fullmatch(r"column head ([0-9]+)" + _NAME_TAIL, f)
        if m:
            return ("head", int(m.group(1)))
        m = re.fullmatch(r"row label ([0-9]+)" + _NAME_TAIL, f)
        if m:
            return ("rowlabel", int(m.group(1)))
    m = re.search(r"\btable (?:row ([0-9]+)|(header))$", screen)
    if m and not _MENTION.search(screen[:m.start()]):
        return ("row", 0 if m.group(2) else int(m.group(1)))
    return None


def _field_parts(fld, contents=None):
    """Clauses of a kind / style field: split on ';'; a part that is one recognised clause stays whole (a quote in it
    may hold commas), any other part is split on ','. A quoted style clause counts only when its quote is in the
    line's content (contents; None = unchecked)."""
    out = []
    for part in (x.strip() for x in fld.split(";")):
        if not part:
            continue
        if _note_clause(part, contents):
            out.append(part)
        else:
            out += [x.strip() for x in part.split(",") if x.strip()]
    return out


_KINDS = {"text", "cell", "label", "note", "heading", "subheading", "headline", "title", "option", "question",
          "instruction", "button", "number", "caption", "dropdown", "column", "slider", "slider-left", "slider-right",
          "stat", "domain", "radio", "checkbox", "choice", "scale", "anchor", "link", "tab", "menu", "footer", "lede",
          "byline", "logo", "picture", "photo text", "interface", "procedure", "story"}


def _fields_ok(kind_raw, kind, style, contents=None):
    """Round 7 S2: the kind field is a kind word (or a cell name / line marker / rule-4 column position) plus recognised
    clauses, with no bracketed remark; the style field is empty, a cell name, or recognised clauses (style clauses,
    line markers, column positions)."""
    if "[" in kind_raw:
        return False

    def clause_ok(x):
        return bool(_LINE_N.fullmatch(x)) or (_note_clause(x, contents) or (None,))[0] == "style" or bool(_naming(x)) \
            or bool(re.fullmatch(r"column \S+ (?:top|bottom|upper|lower)", x))   # rule 4 column positions
    if kind and not _naming(kind):
        kp = _field_parts(kind)
        if not kp or not (kp[0] in _KINDS or re.fullmatch(r"row [0-9]+", kp[0]) or clause_ok(kp[0])) \
                or not all(clause_ok(x) for x in kp[1:]):
            return False
    if style and not _naming(style):
        if not all(clause_ok(x) for x in _field_parts(style, contents)):
            return False
    return True


def _style_field_ok(style, contents=None):
    """The style branch of _fields_ok: a cell name, or clauses that are all recognised (style clauses, line markers,
    rule-4 column positions)."""
    return _fields_ok("", "", style, contents)


def _style_ok(style):
    """A style field that is empty, one recognised style clause, or a list of them (', ' / '; '), or a line marker."""
    if not style:
        return True
    parts = _field_parts(style)
    return all((_note_clause(x) or (None,))[0] == "style" or _LINE_N.fullmatch(x) for x in parts)


def _colpos(screen, kind, style):
    """('<table key>', column label, 'top'|'bottom') when a reading line names a column position (rule 4)."""
    for where, f in (("s", screen), ("k", kind), ("y", style)):
        m = _COLPOS.search(f)
        if m:
            key = (where, _COLPOS.sub("", f).strip(), screen if where != "s" else "")
            return (key, m.group(1), "top" if m.group(2) in ("top", "upper") else "bottom")
    return None


def _colnote(forms):
    """(k, N or None) when exactly one note clause is a 'column k [of N]' form; 'bad' when more than one; None."""
    cols = [m for f, m, _ in forms if f == "column"]
    if not cols:
        return None
    if len(cols) > 1:
        return "bad"
    return (int(cols[0].group(1)), int(cols[0].group(2)) if cols[0].group(2) else None)


def _runs(field, bul=_BULLET):
    """(prefix runs, suffix runs) of a field's sentences / colon parts, bullet stripped: the first piece of a
    multi-line served element must END its reading line, the last must START its reading line (review-5 M1)."""
    f = bul.sub("", field)
    us = [u for u in _UNITS.split(f) if u]
    if not us or len(us) > 60:
        return {f}, {f}
    enum0 = bul in _V3_GLYPHS and bool(_ENUM_UNIT.fullmatch(_GLYPH_BULLET.sub("", us[0])))
    return ({" ".join(us[:j]) for j in range(1, len(us) + 1)},
            {bul.sub("", " ".join(us[i:])) for i in range(len(us)) if not (i == 1 and enum0)})


def _unquote(x):
    """The inside of a field wholly enclosed in one pair of double quotes (an article quoting the item), else None."""
    if len(x) > 2 and x[0] == '"' and x[-1] == '"' and '"' not in x[1:-1]:
        return x[1:-1].strip()
    return None


@_functools.lru_cache(maxsize=512)
def _reading_lines_c(reading, pages, annots=(), v3=True):
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
        if v3 and style and not _style_field_ok(style, (_clean_field("|".join(parts[4:]), True),)):
            style = ""   # round 10 M1: not a recognised style field -> it is part of the printed content
        # fixed fields p | screen | kind | [style |]; everything after them is content, even when it contains ' | '
        # (rule i): content without a style field, content after a style field, and with more than one '|' after the
        # kind, each '|'-separated piece (printed elements on one line, as with ' / ')
        if len(parts) <= 3:
            cands, pieces = [parts[-1]], []
        elif v3:   # round 9/10 M1: v3 content: the text after a recognised style field, else everything after the kind
            cands, pieces = ["|".join(parts[4:]) if style else "|".join(parts[3:])], []
        else:
            cands = ["|".join(parts[3:])] + (["|".join(parts[4:])] if len(parts) > 4 else [])
            pieces = parts[3:] if len(parts) > 4 else []
        # v3 (round 8 M1): '[continues on next page]' only at the very end of a line; it marks the line's element as
        # going on over the page break (page_join only), never anything else
        cont_next, cont_bad = False, False
        if v3 and _CONT_NEXT.search(line):
            cont_next = bool(_CONT_NEXT_END.search(cands[-1]))
            cont_bad = len(_CONT_NEXT.findall(line)) > 1 or not cont_next
            cands = [_CONT_NEXT_END.sub("", x) for x in cands]
            pieces = [_CONT_NEXT_END.sub("", x) for x in pieces]
        changed = False
        if rx_ann:   # declared printed annotations (e.g. a result share printed after an option): stripped
            def strip(x):
                for rx in rx_ann:
                    x = rx.sub("", x)
                return x
            new = [strip(x) for x in cands], [strip(x) for x in pieces]
            changed = (new[0], new[1]) != (cands, pieces)
            cands, pieces = new
        def cf(x):
            return _clean_field(x, v3)
        contents = [x for x in (cf(c) for c in cands) if x]
        # quotes in style clauses are checked against the printed content only (after the style field)
        info = _line_info(line, kind, style, screen, tuple(contents[-1:]), v3)
        bul = _BULLET if not v3 else _v3_bullet(kind, info["forms"])
        fields, frags, wholes = [], set(), set()
        two_line = kind in ("label", "heading") or "line" in style
        for f in cands + pieces:
            fields.append(cf(f))
            if " / " in f and not v3:   # a reader listing several elements of one line ("Yes / No"): each piece is a field
                fields += [cf(x) for x in f.split(" / ")]
                if two_line:   # a label printed on two lines, written 'line 1 / line 2': space-joined
                    fields.append(cf(" ".join(f.split(" / "))))
            if _IMAGE_MARK.search(f):
                frags |= {cf(x) for x in _IMAGE_MARK.split(f)}
        fields = [x for x in fields if x]
        units, prefixes, suffixes, qunits = set(), set(), set(), set()
        for f in fields:
            units |= _units(f, bul)
            wholes |= {f, bul.sub("", f)}
            p_, s_ = _runs(f, bul)
            prefixes |= p_
            suffixes |= s_
            q = _unquote(f)
            if q:
                qunits |= _units(q, bul)
        # '?', 'could be 26', 'maybe', '5 or 6': uncertain for every rule (v3 and legacy readings)
        # v3: a note clause outside the closed grammar makes the line uncertain too (review round 4)
        doubt = info["doubt"] or (v3 and info["unknown"])
        # v3 (round 8 M1): [partial] / [continued] are hard for every rule (never joined over)
        hard = bool(_UNCERTAIN.search(line if v3 else _SOFT.sub("", line))) or doubt or cont_bad
        # rule 2: only lines whose notes are all recognised
        # round 7 S2: a segmentation rule also needs every kind / style clause recognised (kind word, style clause,
        # line marker or cell name); the field rule is unaffected
        fields_ok = _fields_ok(parts[2] if len(parts) > 3 else "", kind, style, tuple(contents[-1:])) \
            and (not v3 or bool(re.fullmatch(r"screen [0-9]+", screen)))   # v3: the screen field is exactly screen k
        info["notes_ok"] = info["notes_ok"] and fields_ok
        gapforms = {g_ for g_ in (_gapform(c) for c in cands) if g_} if info["notes_ok"] else set()
        # v3 anchor (legacy lines only): every mark inside the text is a gap position, an edge mark only a picture
        # remark (no quote, no digit); anything else blocks — used only when a v3 reading vouched for the gaps
        agapforms = {g_ for g_ in (_gapform(c, anchor=True) for c in cands) if g_} if not v3 and fields_ok else set()
        lnum = info["line_n"]   # rule k: a line 'n' of a multi-line element (detected in kind, style or notes)
        last = contents[-1] if contents else ""
        lprefixes, lsuffixes = set(), set()
        for x in contents:   # rule 1: whole printed contents only (no ' / ' or '|' pieces, no style field)
            p_, s_ = _runs(x, bul)
            lprefixes |= p_
            lsuffixes |= s_
        forms = info["forms"]
        naming = _naming(kind, style, screen=screen)
        if naming and naming[0] in ("grid", "row") and not v3:   # v3 names only
            naming = None
        # a position named in a form the grammar does not parse ('row 1 col 2' aside): 'X / Y' in the style field
        slash_pos = bool(re.fullmatch(r"[^/|]+ / [^/|]+", style)) and not _style_ok(style)
        pos_words = bool(re.search(r"\b(?:top|bottom|left|right|upper|lower|box|position|first|second|third|last)\b",
                                   " ".join((kind, style)))) and not _style_ok(style)
        mention = v3 and ((bool(_MENTION.search(" ".join((screen, kind, style)))) or slash_pos or pos_words)
                          and not naming
                          or info["note_mention"]
                          # M3: on a cell / option / label line any note clause about a row / column / head
                          or (bool(re.match(r"(cell|option|label)\b", kind)) and info["any_note_mention"]))
        out.append({"page": int(m.group(1)), "screen": screen, "kind": kind, "style": style,
                    "fields": frozenset(contents), "gapforms": frozenset(gapforms), "agapforms": frozenset(agapforms),
                    "forms": tuple(forms),
                    "notes_ok": info["notes_ok"], "v3": v3,
                    "bullet_note": info["notes_ok"] and any(f == "bullet" for f, _, _ in forms)
                    and not any(f == "numbered" for f, _, _ in forms),
                    "numbered": tuple(mm.group(1) for f, mm, _ in forms if f == "numbered"),
                    # M5: 'same cell as "…"' vouches only with a quote (checked against the previous line in the matcher)
                    "same_cell_quote": next((_norm(mm.group(1)) for f, mm, _ in forms if f == "same_cell"
                                             and mm.group(1)), None) if info["notes_ok"] else None,
                    "partish": v3 and info["partish"],
                    "naming": naming, "naming_bad": mention, "style_ok": _style_ok(style),
                    "cell_base": (_LINE_N.sub("", kind).strip(" ,"), _LINE_N.sub("", style).strip(" ,"))
                    if lnum else None,
                    "cell_line": lnum[0] if lnum else None, "cell_of": lnum[1] if lnum else None,
                    "colpos": _colpos(screen, kind, style), "colnote": _colnote(forms),
                    "num": last if _NUM.fullmatch(last) else None, "bul": bul,
                    "pure_note": kind == "note" and not contents,
                    "soft_end": bool(_SOFT.search(line)),
                    "lprefixes": frozenset(lprefixes), "lsuffixes": frozenset(lsuffixes),
                    "units": frozenset(units), "qunits": frozenset(qunits), "wholes": frozenset(wholes),
                    "prefixes": frozenset(prefixes), "suffixes": frozenset(suffixes),
                    "frags": frozenset(x for x in frags if x),
                    # the label/value join reads the field after a style field when there is one
                    "content": contents[-1] if contents else "", "contents": tuple(contents),
                    "cont_next": cont_next,
                    # the printed content as written (case kept), for the unmarked-continuation test
                    "rawc": unicodedata.normalize("NFKC", _MARKS.sub("", cands[-1] if cands else "")).strip(),
                    "annotated": changed, "uncertain": bool(_UNCERTAIN.search(line)) or doubt or cont_next or cont_bad,
                    "hard_uncertain": hard or cont_next, "hard_wo_cont": hard})
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
    if group[0] == "gap":   # rule 2: the whole reading line, picture marks as one sentinel each
        rx = group[1]
        return any(rx.fullmatch(g_) for ln in lines for g_ in ln["gapforms"])
    return False


def _hit(want, ln):
    """Whole-unit equality with one reading line; a line wholly in double quotes (an article quoting the item) also
    matches its inside, only when the served text does not itself start with a quote."""
    return want in ln["units"] or (want[:1] != '"' and want in ln["qunits"])


def _join_eq(want, texts, bul=_BULLET):
    """The served text equals the WHOLE join of consecutive reading lines (bullet stripped, or inside one pair of
    outer quotes when the served text has none)."""
    for j in _joins(texts):
        jn = _norm(j)
        if want in (jn, bul.sub("", jn)):
            return True
        q = _unquote(jn)
        if q and want[:1] != '"' and want == q:
            return True
    return False


_CELL_LINE = re.compile(r",?\s*line \d+\s*$")


def _named_ok(ln, cell, named=frozenset()):
    """Rule j, for a served table cell (cell: from _cell_positions; a served text outside a table, cell None, has no
    row / column to swap and is not position-checked): a reading line naming a cell ('row X / column Y', 'column head
    k', 'row label k', kind or style field) counts only for the cell at that position, never when that row label /
    column head occurs twice in the served table; a line that mentions a row / column / head / header (screen, kind,
    style or an unrecognised note clause) without such a parseable name never counts; and once the reading names cells
    of a sort on the page (named: the sorts it uses), a served cell of that sort needs a line naming its position."""
    if not cell:
        return True
    nm = ln["naming"]
    if ln["v3"] and (not nm or nm[0] == "row"):
        return False   # v3 (review round 4 M1): every table cell only from a line naming its exact position
    if not nm:
        if ln["naming_bad"]:
            return False
        sort = "head" if cell["r"] == 0 else ("rowlabel" if cell["c"] == 0 else "rc")
        return sort not in named and not (named & {"grid", "row"})
    if nm[0] == "rc":
        return cell["r"] >= 1 and cell["c"] >= 1 and (nm[1], nm[2]) == (cell["row"], cell["col"]) \
            and not cell["row_dup"] and not cell["col_dup"]
    if nm[0] == "head":
        return cell["gr"] == 0 and cell.get("head_k") == nm[1]
    if nm[0] == "grid":   # the cell's top-left grid square, spans honoured (1-based)
        return (cell["gr"] + 1, cell["gc"] + 1) == (nm[1], nm[2])
    if nm[0] == "row":
        return cell["r"] == nm[1]
    return cell["gc"] == 0 and cell.get("row_k") == nm[1]


def _piece_eq(pc, ln):
    """Rule 1/3: one served line equals one WHOLE printed content of a reading line, literally (a list glyph must be
    on both sides), or — rule 3 — a served line with a list glyph equals a reading line without it whose notes are
    all recognised clauses (closed grammar) and vouch for the glyph: '•', '-', '*' … a bullet clause (and no
    numbered clause), a number 'n.' a 'numbered n' clause with exactly that number; never on a heading or label
    line. Returns 'eq', 'marker' or None."""
    if pc in ln["fields"]:
        return "eq"
    g = _LIST_GLYPH.match(pc)
    if not g or ln["kind"] in ("heading", "label", "title") or not ln["notes_ok"]:
        return None
    body = pc[g.end():]
    if not body or body not in ln["fields"]:
        return None
    if g.group(1) and ln["bullet_note"]:
        return "marker"
    if g.group(2) and list(ln["numbered"]) == [g.group(2)]:
        return "marker"
    return None


def _partition_eq(pieces, contents):
    """True when contents (consecutive element lines) split into len(pieces) runs of whole lines whose joins equal the
    served pieces in order."""
    if not pieces:
        return not contents
    for j in range(1, len(contents) - len(pieces) + 2):
        if any(_norm(x) == pieces[0] for x in _joins(contents[:j])) and _partition_eq(pieces[1:], contents[j:]):
            return True
    return False


def _cell_full(run, printed):
    """Lines of ONE multi-line element marked line 1 … line k (any kind; rule k marks in kind, style or notes), in
    order, covering every line the reading gives that element ('line n of N': exactly N)."""
    if any(r["cell_of"] not in (None, len(run)) for r in run):
        return False
    return any(len(el) == len(run) and all(a is b for a, b in zip(el, run)) for el in _marker_elements(printed))


def _marker_elements(lines):
    """Round 9 S4: multi-line elements = contiguous runs of lines marked line 1, 2, … N (same page, screen, kind and
    base); a new 'line 1' starts a new element, anything else ends the run."""
    out, cur, bad = [], None, set()
    for ln in lines:
        n = ln["cell_line"]
        if n == 1:
            cur = [ln]
            out.append(cur)
        elif n is not None and cur and n == cur[-1]["cell_line"] + 1 and \
                (ln["page"], ln["screen"], ln["kind"], ln["cell_base"]) == \
                (cur[0]["page"], cur[0]["screen"], cur[0]["kind"], cur[0]["cell_base"]):
            cur.append(ln)
        else:
            # round 10 S2: the element is invalid when the next line of the same page / screen / kind carries a
            # marker other than 'line 1' (a duplicate or skipped line) or is an unmarked continuation (it starts
            # with a lower-case letter)
            if cur and (ln["page"], ln["screen"], ln["kind"]) == (cur[0]["page"], cur[0]["screen"], cur[0]["kind"]) \
                    and (n is not None or re.match(r"[a-z]", ln.get("rawc") or "")):
                bad.add(id(cur))
            cur = None
    return [el for el in out if id(el) not in bad]


def _numrow_tables(printed, ok):
    """Rule 4: (top row, bottom row) of numbers that a reading gives column by column. (a) lines naming 'column C top'
    / 'column C bottom' (screen, kind or style) of one table, contiguous among printed lines, every column exactly
    one top and one bottom, columns in reading order; (b) option pairs: an option line whose notes name exactly
    'column k [of N]' (no pointer elsewhere) followed by an unmarked option line, k = 1, 2, 3 … in order, as many
    pairs as N says, and no further unmarked option line after the last pair. Every entry must be one number of a
    usable line, otherwise the table yields nothing (it can never confirm)."""
    out = []
    i = 0
    while i < len(printed):   # (a)
        cp = printed[i]["colpos"]
        if not cp:
            i += 1
            continue
        j = i
        while j < len(printed) and printed[j]["colpos"] and printed[j]["colpos"][0] == cp[0] \
                and printed[j]["page"] == printed[i]["page"]:
            j += 1
        cols, good = {}, True
        for ln in printed[i:j]:
            c_ = cols.setdefault(ln["colpos"][1], {})
            if ln["colpos"][2] in c_ or not ok(ln) or ln["num"] is None or not ln["notes_ok"]:
                good = False
            c_[ln["colpos"][2]] = ln["num"]
        if good and cols and all(set(c_) == {"top", "bottom"} for c_ in cols.values()):
            out.append((" ".join(c_["top"] for c_ in cols.values()), " ".join(c_["bottom"] for c_ in cols.values())))
        i = j
    i = 0
    while i < len(printed):   # (b)
        cn = printed[i]["colnote"]
        if printed[i]["kind"] != "option" or not isinstance(cn, tuple) or cn[0] != 1:
            i += 1
            continue
        tops, bots, k, good, of_n = [], [], 1, True, cn[1]
        where = (printed[i]["page"], printed[i]["screen"])
        if i and printed[i - 1]["kind"] == "option" and (printed[i - 1]["page"], printed[i - 1]["screen"]) == where:
            good = False   # a stray option before column 1
        j = i
        while j + 1 < len(printed):
            a, b = printed[j], printed[j + 1]
            if not (a["kind"] == b["kind"] == "option" and a["colnote"] == (k, of_n) and b["colnote"] is None
                    and (a["page"], a["screen"]) == (b["page"], b["screen"]) == where):
                break
            if not (ok(a) and ok(b)) or a["num"] is None or b["num"] is None or not (a["notes_ok"] and b["notes_ok"]):
                good = False
            tops.append(a["num"])
            bots.append(b["num"])
            k += 1
            j += 2
        if j < len(printed) and printed[j]["kind"] == "option" and (printed[j]["page"], printed[j]["screen"]) == where:
            good = False   # an option left over after the last pair (or a pair broken off): not this table form
        if of_n is not None and len(tops) != of_n:
            good = False
        if good and len(tops) >= 2:
            out.append((" ".join(tops), " ".join(bots)))
        i = max(j, i + 1)
    return out


def _reading_body_key(reading):
    """A reading's body without its header (first non-blank line), line ends / trailing blanks / blank lines folded."""
    reading = reading.lstrip("\ufeff")   # a byte-order mark never makes another reader (round 7 S4)
    lines = [x.rstrip() for x in reading.replace("\r\n", "\n").replace("\r", "\n").split("\n") if x.strip()]
    if lines and not re.match(r"\s*p\d+\s*\|", lines[0]):   # a header line, not a reading line
        lines = lines[1:]
    return "\n".join(lines)


def _v3_gap_vouch(reading, page, gap_groups, annots=()):
    """The gap compositions (regex patterns) a v3 reading confirms by the strict image_gap rule itself (whatever rule
    it reported first)."""
    pages = _cited_pages(page)
    if not gap_groups or pages is None:
        return set()
    usable = [ln for ln in _reading_lines(reading, pages, annots) if not ln["uncertain"] and not ln["partish"]]
    return {g[1].pattern for g in gap_groups if _group_match(g, usable)}


def _image_match(text, second, page, uncertain=False, groups=(), annots=(), cell=None, anchor=frozenset()):
    """Reading lines are 'p<N> | screen | kind | [style |] text'. A served text matches a line on its cited page(s)
    only by WHOLE-FIELD EQUALITY after normalisation (NFKC, quotes, U+2212, underscore runs, whitespace, case, reader
    marks removed) — never as a substring or a word inside a longer field ("Agree" is not confirmed by "Strongly
    agree"; skills review-3 M4). A line wholly in double quotes also matches its inside (served text without quotes).
    Returns the name of the rule that matched (the check output reports it as match_rule), else False:
    - 'field': whole-field equality with one line;
    - 'list_marker' (rule 3): a served line with a leading list glyph equals a reading line without the glyph only
      when a note of that line vouches for that glyph type (_piece_eq);
    - 'label_value': a label and its value on two consecutive lines (the first ends with ':' or is of kind 'label';
      same page and screen; neither an option/button/cell-like single element nor a line 'n' of an element) match
      their join;
    - 'element_join': consecutive printed lines of ONE element (same page, screen and kind; not a single-element kind,
      not a label; pure note lines skipped, a 'note' line holding printed text is a barrier; split by the print's
      line end or by a style change; the last line not [partial] / [continued]; lines 'n' of an element only all of
      them) match their whole join;
    - 'multiline' (review-5 M1): a served element printed on several lines ('A\\nB') matches consecutive reading lines
      of one page and screen, no single-element kinds and no lines 'n': the first piece ends the first line's printed
      content, the last piece starts the last line's, middle pieces are whole contents (never ' / ' or '|' pieces or
      style fields);
    - 'multiline_k' (rule 1): a served text of k lines equals k consecutive reading lines of one page and screen (only
      pure note lines between), each served line one WHOLE printed content, in order (list glyphs per rule 3,
      reported as 'multiline_k+list_marker'); cell lines only as the whole of one element named '…, line 1' … '…,
      line k', or as an unnamed label+content cell (each break after a served line ending in ':' and before a line
      ending a sentence, or before a line whose own vouching note says 'same cell');
    - 'page_join' (rule e): a text whose cite spans two pages "p-q" also matches the join of the last line of p and
      the first line of q (note lines skipped; never a label or single element);
    - groups (from _image_groups): 'image_join' (lines of one image item), 'template' (fragments of one composed
      element; a computed value there is any short rendered number — unchanged, see DESIGN §3.5 pass 3), 'image_gap'
      (rule 2: texts separated on one stage only by images / computed values, one reading line), 'column_rows'
      (rule 4: a numeric row and its companion row given column by column).
    Rule j: a line naming its cell counts only for the served cell at that position (_named_ok); rule k: a line 'n'
    of a multi-line element never confirms anything on its own. A line the reader marked [uncertain …] / [partial] /
    [continued], or whose note doubts the print ('could be', 'maybe', '5 or 6'), is not agreement (Decided 5): skipped
    unless uncertain=True (used only to report why a text failed); in a join, [partial] / [continued] alone do not
    block. An unparseable page cite matches nothing. annots: declared printed annotations stripped (_reading_lines)."""
    pages = _cited_pages(page)
    if pages is None:
        return False
    want = _norm(text)
    if not want:
        return False
    lines = _reading_lines(second, pages, annots)

    v3 = _is_v3(second)
    named = frozenset(ln["naming"][0] for ln in lines if ln["naming"]) if v3 else frozenset()

    # v3 S1: a line whose fields / notes speak of lines or parts in a non-marker form never counts
    # round 9 S3: a v3 line ending in [continues on next page] counts only in page_join — for any other text it is a
    # disagreement (never uncertain-only)
    def ok(ln):
        return (uncertain or not ln["uncertain"]) and _named_ok(ln, cell, named) and not ln["partish"] \
            and not ln.get("cont_next")

    def okj(ln):
        return (uncertain or not ln["hard_uncertain"]) and _named_ok(ln, cell, named) and not ln["partish"] \
            and not ln.get("cont_next")
    usable = [ln for ln in lines if ok(ln) and ln["cell_line"] is None]
    if v3 and cell is not None:   # round 8 S2: a v3 table cell equals the named line's whole content only
        if any(want in ln["fields"] for ln in usable):
            return "field"
    elif any(_hit(want, ln) for ln in usable):
        return "field"
    if "\n" not in str(text).strip() and _LIST_GLYPH.match(want) \
            and any(_piece_eq(want, ln) == "marker" for ln in usable):
        return "list_marker"
    prev = None
    for ln in lines:
        if not ok(ln) or ln["cell_line"] is not None:
            prev = None
            continue
        if prev and not (v3 and cell is not None) and prev["page"] == ln["page"] and prev["screen"] == ln["screen"] \
                and prev["content"] and ln["content"] and not _SINGLE_KINDS.match(prev["kind"]) \
                and not _SINGLE_KINDS.match(ln["kind"]) \
                and (prev["content"].endswith(":") or prev["kind"] == "label") and ln["kind"] != "label":
            if want in (prev["content"] + " " + ln["content"], prev["bul"].sub("", prev["content"]) + " " + ln["content"]):
                return "label_value"
        prev = ln
    printed = [ln for ln in lines if not ln["pure_note"]]
    # v3 (M1): a pure note line whose clauses are not all recognised ends an element join
    ej = [ln for ln in lines if not (ln["pure_note"] and (ln["notes_ok"] or not v3))]
    # consecutive printed lines of one element
    for i in range(len(ej)):
        a = ej[i]
        if _SINGLE_KINDS.match(a["kind"]) or a["kind"] in ("label", "note") or not okj(a):
            continue
        run = [a]
        for b in ej[i + 1:i + 12]:
            if (b["page"], b["screen"], b["kind"]) != (a["page"], a["screen"], a["kind"]) or not okj(b):
                break
            run.append(b)
            if b["soft_end"] or (any(x["cell_line"] is not None for x in run) and not _cell_full(run, printed)):
                continue
            if v3 and not _cell_full(run, printed):   # round 9 S2: v3 joins only the lines of one marked element
                continue
            if _join_eq(want, [x["content"] for x in run], run[0]["bul"]):
                return "element_join"
    # a served element printed on several lines (review-4 rule a, reading side; review-5 M1; rule 1). A note line
    # whose clauses are not all recognised is a barrier here (it may stand for printed text).
    pieces = [_norm(x) for x in str(text).split("\n") if _norm(x)]
    mlines = [ln for ln in lines if not (ln["pure_note"] and (ln["notes_ok"] or not v3))]
    if len(pieces) >= 2:
        for j in range(len(mlines) - len(pieces) + 1):
            run = mlines[j:j + len(pieces)]
            if not all(ok(r) and r["page"] == run[0]["page"] and r["screen"] == run[0]["screen"]
                       and r["kind"] != "note" for r in run):
                continue
            same_cell = _cell_full(run, printed)
            singles = any(_SINGLE_KINDS.match(r["kind"]) for r in run)
            lines_n = any(r["cell_line"] is not None for r in run)
            if not singles and not lines_n and pieces[0] in run[0]["lsuffixes"] \
                    and pieces[-1] in run[-1]["lprefixes"] \
                    and all(pc in r["fields"] or pc in {r["bul"].sub("", x) for x in r["fields"]}
                            for pc, r in zip(pieces[1:-1], run[1:-1])):
                return "multiline"
            # rule 1: every served line one whole printed content; every note of the run (and of note lines between
            # its lines) in the closed grammar
            if (lines_n and not same_cell) or not all(r["notes_ok"] for r in run):
                continue
            i0, i1 = lines.index(run[0]), lines.index(run[-1])
            if any(not x["notes_ok"] for x in lines[i0:i1 + 1]):
                continue
            if singles and not same_cell:
                if cell is not None and not v3 and "cell" not in anchor:
                    continue   # S4: legacy unnamed cells never confirm a served table cell here (unless v3-anchored)
                # unnamed cells: no style field may name a position (only recognised style clauses)
                if not all(r["kind"] == "cell" and not r["naming"] and not r["naming_bad"] and r["style_ok"]
                           for r in run):
                    continue
                # M5: a same-cell note quotes exactly the previous line's content
                if not all((pieces[k - 1].endswith(":") and re.search(r"[.!?]$", pieces[k]))
                           or (run[k]["same_cell_quote"] is not None
                               and run[k]["same_cell_quote"] in run[k - 1]["contents"]) for k in range(1, len(run))):
                    continue
            eqs = [_piece_eq(pc, r) for pc, r in zip(pieces, run)]
            if all(eqs):
                tag = "+v3_anchor" if singles and not same_cell and cell is not None and not v3 else ""
                return ("multiline_k+list_marker" if "marker" in eqs else "multiline_k") + tag
    # a marked multi-line element (lines 1 … m, all of them, contiguous) printed on MORE lines than the served text has:
    # each served line must be the join of a run of whole consecutive element lines (the print wraps inside a served
    # line; every served line break is an element line break) — review rounds 5 and 9 (a single-line served text too)
    if pieces:
        for el in _marker_elements(mlines):
            if len(el) <= len(pieces) or any(x["cell_of"] not in (None, len(el)) for x in el):
                continue
            if not all(ok(x) and x["notes_ok"] for x in el):
                continue
            if _partition_eq(pieces, [x["content"] for x in el]):
                return "multiline_k"
    if len(pages) == 2:
        a_, b_ = sorted(pages)
        last = [ln for ln in printed if ln["page"] == a_ and ln["kind"] != "note"][-1:]
        first = [ln for ln in printed if ln["page"] == b_ and ln["kind"] != "note"][:1]
        def okp(ln, is_last):   # v3: the last line of page p may carry the continuation mark, nothing else soft
            if is_last and ln.get("cont_next") and not ln["hard_wo_cont"]:
                return (uncertain or True) and _named_ok(ln, cell, named) and not ln["partish"]
            return okj(ln)
        if v3 and not (last and last[0].get("cont_next")):   # round 9 S2: v3 joins pages only after the mark
            last = []
        if last and first and last[0]["kind"] != "label" and okp(last[0], True) and okp(first[0], False) and \
                all(not _SINGLE_KINDS.match(ln["kind"]) and ln["cell_line"] is None for ln in last + first):
            soft = last[0]["uncertain"] or first[0]["uncertain"]
            for x in last[0]["contents"]:
                for y in first[0]["contents"]:
                    bul_ = last[0]["bul"]
                    if _join_eq(want, [x, y], bul_) or (not soft and any(want in _units(_norm(j), bul_)
                                                                         for j in _joins([x, y]))):
                        return "page_join"
    for g in groups:
        if g[0] == "numrow":
            if any((_norm(g[1]), _norm(g[2])) == t for t in _numrow_tables(printed, ok)):
                return "column_rows"
        elif v3 and cell is not None and g[0] == "tpl":   # round 10 S3: a v3 cell matches a template whole
            if any(_template_ok(g[1], f_) for ln in usable for f_ in ln["fields"]):
                return "template"
        elif _group_match(g, usable):
            return {"join": "image_join", "tpl": "template", "gap": "image_gap"}[g[0]]
        elif g[0] == "gap" and ("gap", g[1].pattern) in anchor and not v3 \
                and any(g[1].fullmatch(x) for ln in usable for x in ln["agapforms"]):
            return "image_gap+v3_anchor"
    return False


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
                    # rule 4: a numeric row and the next / previous numeric row of the same item (its companion)
                    for a_, b_ in ((i, i + 1), (i - 1, i)):
                        if 0 <= a_ and b_ < len(texts) and all(isinstance(texts[k], str) and
                                                               _NUMROW.fullmatch(_norm(texts[k])) for k in (a_, b_)) \
                                and len(_norm(texts[a_]).split()) == len(_norm(texts[b_]).split()):
                            out[id(x)].append(("numrow", texts[a_], texts[b_]))
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
    _gap_groups(p, out)
    return out


def _parts_src(node, data):
    """Like _expr_parts, but a computed value keeps its source: ('v', consts, source)."""
    import ast
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        l_, r_ = _parts_src(node.left, data), _parts_src(node.right, data)
        return None if l_ is None or r_ is None else l_ + r_
    keys, n = [], node
    while isinstance(n, ast.Subscript) and isinstance(n.slice, ast.Constant):
        keys.append(n.slice.value)
        n = n.value
    if isinstance(n, ast.Name) and n.id == "data" and len(keys) == 2:   # a whole served text object data[A][B]
        obj = (data.get(keys[1]) or {}).get(keys[0]) if isinstance(data.get(keys[1]), dict) else None
        if isinstance(obj, dict) and isinstance(obj.get("text"), str) and "src" not in obj:
            return [("s", obj["text"], obj)]
        return None
    one = _expr_parts(node, data, None)
    if one is None or len(one) != 1:
        return None
    if one[0][0] == "v":
        return [("v", one[0][1], ast.unparse(node))]
    return one


def _value_renderings(src, p):
    """Rule 2: every rendering of a computed value that depends on ONE answer: evaluated for each option code of that
    response, or for each integer of its declared 'range' [lo, hi] (at most 1001 values). None when that cannot be
    told or any rendering is not digits only: the gap rule then confirms nothing (strict)."""
    from .expr import evaluate
    keys = set(re.findall(r"answer\(\s*['\"]([^'\"]+)['\"]\s*\)", src))
    if len(keys) != 1:
        return None
    sid, _, rid = next(iter(keys)).partition(".")
    st = (p.stages or {}).get(sid) if isinstance(getattr(p, "stages", None), dict) else None
    resp = next((r for r in (st or {}).get("responses", []) if isinstance(r, dict) and r.get("id") == rid), None)
    if not isinstance(resp, dict):
        return None
    opts, rng = resp.get("options"), resp.get("range")
    if isinstance(opts, list) and opts and all(isinstance(o, dict) and o.get("code") is not None for o in opts):
        codes = [o["code"] for o in opts]
    elif isinstance(rng, list) and len(rng) == 2 and all(isinstance(x, int) and not isinstance(x, bool) for x in rng) \
            and 0 <= rng[1] - rng[0] <= 1000:
        codes = list(range(rng[0], rng[1] + 1))
    else:
        return None
    out = set()
    for c in codes:
        try:
            v = evaluate(src, {"data": p.data}, funcs={"answer": lambda k, c=c: c})
        except Exception:
            return None
        v = str(v)
        if not re.fullmatch(r"\d{1,9}", v):
            return None
        out.add(v)
    return out


def _gap_rx(items, p):
    """items: [('s', raw static) | ('img',) | ('v', source)] of one stage run -> regex over one reading line's
    gapform (rule 2), or None. Static texts in order, nothing skipped, a space exactly where the composition has
    one; an image gap is one picture mark (the sentinel) or, only between delimiters the served texts themselves
    end / start with, nothing; a computed gap is one of the value's renderings (digits only)."""
    merged = []
    for it in items:
        if it[0] == "s" and merged and merged[-1][0] == "s":
            merged[-1] = ("s", merged[-1][1] + it[1])
        else:
            merged.append(it)
    SP = object()
    toks = []
    for k, it in enumerate(merged):
        if it[0] == "s":
            for part in re.split(r"(\s+)", it[1]):
                if not part:
                    continue
                if part.isspace():
                    toks.append(SP)
                elif _norm(part):
                    toks.append(re.escape(_norm(part)))
        elif it[0] == "img":
            before = merged[k - 1][1].rstrip() if k and merged[k - 1][0] == "s" else ""
            after = merged[k + 1][1].lstrip() if k + 1 < len(merged) and merged[k + 1][0] == "s" else ""
            delim = bool(before and after and before[-1] in _DELIMS and after[0] in _DELIMS)
            while toks and toks[-1] is SP:
                toks.pop()
            toks.append(("img", "(?:%s)%s" % (re.escape(_GAP), "?" if delim else "")))
        else:
            r_ = _value_renderings(it[1], p)
            if not r_:
                return None
            toks.append("(?:%s)" % "|".join(map(re.escape, sorted(r_))))
    rx, prev = "", None
    for t in toks:
        if t is SP:
            if prev is not None and prev is not SP and not isinstance(prev, tuple):
                prev = SP
            continue
        if isinstance(t, tuple):
            rx += t[1]
        else:
            rx += (" " if prev is SP else "") + t
        prev = t
    return re.compile(rx) if rx else None


def _shown_images(grp, p):
    """How many pictures consecutive image items show (each is one gap; never merged): all unconditional -> their
    number; all conditional on ONE choice answer ('answer(K) == "code"'), one item per option code of that response,
    each code once -> exactly 1; anything else -> 0 (cannot be told: no gap rule)."""
    if all(it.get("if") is None for it in grp):
        return len(grp)
    keys, codes = set(), []
    for it in grp:
        m = re.fullmatch(r"\s*answer\(\s*['\"]([^'\"]+)['\"]\s*\)\s*==\s*['\"]([^'\"]*)['\"]\s*", str(it.get("if") or ""))
        if not m:
            return 0
        keys.add(m.group(1))
        codes.append(m.group(2))
    if len(keys) != 1 or len(set(codes)) != len(codes):
        return 0
    sid, _, rid = next(iter(keys)).partition(".")
    st = (p.stages or {}).get(sid) if isinstance(getattr(p, "stages", None), dict) else None
    resp = next((r for r in (st or {}).get("responses", []) if isinstance(r, dict) and r.get("id") == rid), None)
    opts = resp.get("options") if isinstance(resp, dict) else None
    want = {str(o.get("code")) for o in opts if isinstance(o, dict)} if isinstance(opts, list) else set()
    return 1 if want and set(codes) == want and resp.get("required") else 0


def _gap_groups(p, out):
    """Rule 2 groups: on one stage, plain served texts (data refs read off an image of one source page) separated only
    by image items or computed values — text A, image, text B, computed number, text C — form one run; each text of
    the run gets ('gap', regex). A text item next to another text item (no gap between), a conditional text item or
    anything else ends a run."""
    import ast
    for st in (p.stages or {}).values() if isinstance(getattr(p, "stages", None), dict) else ():
        seq = []
        content = st.get("content", []) if isinstance(st, dict) else []
        k_ = 0
        while k_ < len(content):
            it = content[k_]
            if not isinstance(it, dict):
                seq.append(("bar",))
                k_ += 1
                continue
            if it.get("type") == "image":
                grp = [it]
                while k_ + len(grp) < len(content) and isinstance(content[k_ + len(grp)], dict) \
                        and content[k_ + len(grp)].get("type") == "image":
                    grp.append(content[k_ + len(grp)])
                k_ += len(grp)
                n_img = _shown_images(grp, p)
                seq.extend([("img",)] * n_img if n_img else [("bar",)])
                continue
            k_ += 1
            v = it.get("value", it.get("text"))
            parts = None
            if it.get("if") is None and isinstance(v, dict) and isinstance(v.get("expr"), str):
                try:
                    tree = ast.parse(v["expr"], mode="eval").body
                except (SyntaxError, ValueError):
                    tree = None
                if isinstance(tree, ast.Dict):
                    tree = next((y for x, y in zip(tree.keys, tree.values)
                                 if isinstance(x, ast.Constant) and x.value == "text"), None)
                parts = _parts_src(tree, p.data) if tree is not None else None
            if not parts:
                seq.append(("bar",))
                continue
            if seq and seq[-1][0] == "s" and parts[0][0] == "s":
                seq.append(("bar",))   # two text elements side by side: not this rule
            seq.extend(parts)
        run = []
        for it in seq + [("bar",)]:
            if it[0] != "bar":
                run.append(it)
                continue
            while run and run[0][0] in ("img", "v"):
                run.pop(0)
            while run and run[-1][0] in ("img", "v"):
                run.pop()
            objs = [x[2] for x in run if x[0] == "s" and x[2] is not None]
            cites = {json.dumps([(o.get("cite") or {}).get(k) for k in ("source", "page", "read")], default=str)
                     for o in objs}
            if len(objs) >= 2 and any(x[0] in ("img", "v") for x in run) and len(cites) == 1 \
                    and all((o.get("cite") or {}).get("read") == "image" for o in objs):
                rx = _gap_rx([("s", x[1]) if x[0] == "s" else (("img",) if x[0] == "img" else ("v", x[2]))
                              for x in run], p)
                if rx is not None:
                    for o in objs:
                        out.setdefault(id(o), []).append(("gap", rx))
            run = []


from .engine import SPAN_LIMITS as _SPAN_MAX   # noqa: E402  (engine and checker share the span limits)


def _table_grid(rows):
    """{(r, c): (grid row, grid column)} of a served table's cells, 0-based, honouring integer 'colspan' / 'rowspan'
    (a cell spanning columns 2-3 sits at grid column 2; the next cell of its row at grid column 4)."""
    return _table_layout(rows)[0]


def _table_layout(rows):
    """(cell -> top-left grid square, grid square -> covering cell (r, c), cell -> (rowspan, colspan))."""
    owner, out, span = {}, {}, {}
    for r, row in enumerate(rows):
        gc = 0
        for c, x in enumerate(row):
            while (r, gc) in owner:
                gc += 1
            out[(r, c)] = (r, gc)
            cs = x.get("colspan", 1) if isinstance(x, dict) else 1
            rs = x.get("rowspan", 1) if isinstance(x, dict) else 1
            cs = cs if isinstance(cs, int) and not isinstance(cs, bool) and 1 <= cs <= _SPAN_MAX["colspan"] else 1
            rs = rs if isinstance(rs, int) and not isinstance(rs, bool) and 1 <= rs <= _SPAN_MAX["rowspan"] else 1
            span[(r, c)] = (rs, cs)
            for dr in range(rs):
                for dc in range(cs):
                    owner[(r + dr, gc + dc)] = (r, c)
            gc += cs
    return out, owner, span


def _cell_positions(p):
    """id(served cell dict) -> its position in a served table ({'rows': [[cell, ...], ...]}, in data or inline in a
    stage's content): row r, column c, the
    row label (normalised text of rows[r][0]), the column head (rows[0][c]), and for heads / row labels their rank
    among the non-empty heads / row labels (1-based), as readers number them ('column head k', 'row label k')."""
    out = {}

    def txt(x):
        return _norm(x.get("text")) if isinstance(x, dict) and isinstance(x.get("text"), str) else ""

    def walk(o):
        if isinstance(o, dict):
            rows = o.get("rows")
            if isinstance(rows, list) and rows and all(isinstance(r, list) for r in rows):
                head = rows[0]
                rl = [txt(r[0]) if r else "" for r in rows[1:]]
                ch = [txt(x) for x in head[1:]]
                # round 6 S2: the row label / column head of a cell are the cells covering its grid square in
                # grid column 0 / grid row 0 (spans honoured); a spanning label / head is ambiguous (duplicate)
                grid, owner, span = _table_layout(rows)
                # round 7: heads are the non-empty cells of grid row 0 (from grid column 1), row labels the non-empty
                # cells of grid column 0 (from grid row 1), each numbered in grid order
                hk = {rc: k + 1 for k, rc in enumerate(sorted(
                    (rc for rc, g in grid.items() if g[0] == 0 and g[1] >= 1 and rc[1] < len(rows[rc[0]])
                     and txt(rows[rc[0]][rc[1]])), key=lambda rc: grid[rc][1]))}
                rk = {rc: k + 1 for k, rc in enumerate(sorted(
                    (rc for rc, g in grid.items() if g[1] == 0 and g[0] >= 1 and rc[1] < len(rows[rc[0]])
                     and txt(rows[rc[0]][rc[1]])), key=lambda rc: grid[rc][0]))}

                def cover(sq):
                    rc = owner.get(sq)
                    if rc is None or rc[1] >= len(rows[rc[0]]):
                        return "", False
                    return txt(rows[rc[0]][rc[1]]), span.get(rc, (1, 1)) != (1, 1)
                for r, row in enumerate(rows):
                    for c, x in enumerate(row):
                        if isinstance(x, dict):
                            gr, gc = grid.get((r, c), (r, c))
                            rlab, rspan = cover((gr, 0))
                            chd, cspan = cover((0, gc))
                            out[id(x)] = {"r": r, "c": c, "row": rlab, "col": chd, "gr": gr, "gc": gc,
                                          "row_dup": rspan or (bool(rlab) and rl.count(rlab) > 1),
                                          "col_dup": cspan or (bool(chd) and ch.count(chd) > 1),
                                          "head_k": hk.get((r, c)), "row_k": rk.get((r, c))}
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(getattr(p, "data", None))
    walk(getattr(p, "stages", None))   # inline table values of stage content (review round 5 MF2)
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
    cells = _cell_positions(p)
    matches, rule_counts = [], {}   # match_rule of every confirmed image text (rules other than 'field' listed)
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

    def legacy(r):   # pinned uncertain-only legacy reading; never a v3 reading (review round 4)
        return hashlib.sha256(r.encode("utf-8")).hexdigest() in LEGACY_UNCERTAIN_READINGS and not _is_v3(r)

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
                    # one reader once: readings whose bodies (line 1, the header, removed) are the same count once
                    # (round 6 S3: a re-filed reading with a new header is never a second reader)
                    rs = list({_reading_body_key(r): r for r in reversed([r for r in rs if _covers(r, c.get("page"))])}
                              .values())[::-1]
                    if public and not rs:   # readings of non-open sources are not shipped: checked privately
                        checked_privately.add(str(c.get("source")))
                        return
                    g_ = groups.get(id(o), ())   # printed-line joins / composed templates (review-4)
                    an_ = annots.get(c.get("source"), ())
                    cl_ = cells.get(id(o))
                    rules = {}
                    for r in rs:
                        m_ = _image_match(o["text"], r, c.get("page"), groups=g_, annots=an_, cell=cl_)
                        if m_:
                            rules[r] = m_
                    # v3 anchor (maintainer ruling after review round 5): a legacy reading may add an agreeing vote
                    # through multiline_k (table cell) / image_gap only when a v3 reading confirms this same text by
                    # that strict rule; the legacy vote never confirms alone and never supplies a position
                    v3r = [rules[r] for r in rs if r in rules and _is_v3(r)]
                    gap_g = [g for g in g_ if g[0] == "gap"]
                    # S1 (round 6): the anchor is bound to the gap composition(s) the v3 reading vouched for
                    gap_v = set().union(*[_v3_gap_vouch(r, c.get("page"), gap_g, an_)
                                          for r in rs if r in rules and _is_v3(r)])
                    anchor = frozenset({("gap", x) for x in gap_v}
                                       | ({"cell"} if cl_ and any(x.startswith("multiline_k") for x in v3r) else set()))
                    if anchor:
                        for r in rs:
                            if r not in rules and not _is_v3(r):
                                m_ = _image_match(o["text"], r, c.get("page"), groups=g_, annots=an_, cell=cl_,
                                                  anchor=anchor)
                                if m_ and m_.endswith("v3_anchor"):
                                    rules[r] = m_
                    agree = [r for r in rs if r in rules]
                    unsure = [r for r in rs if r not in agree
                              and _image_match(o["text"], r, c.get("page"), uncertain=True, groups=g_, annots=an_,
                                               cell=cl_)]
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
                    ok_ = (not disagree and agree) or (disagree and len(agree) >= 2 and len(agree) > len(disagree))
                    if ok_:
                        mr = ", ".join(rules[r] for r in agree)
                        for r in agree:
                            rule_counts[rules[r]] = rule_counts.get(rules[r], 0) + 1
                        if any(rules[r] != "field" for r in agree):
                            matches.append({"source": c.get("source"), "page": c.get("page"), "text": o["text"][:80],
                                            "match_rule": mr})
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
            elif isinstance(v_, dict) and "expr" not in v_:   # inline text dicts / images
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
            "image_matches": matches, "image_match_rules": dict(sorted(rule_counts.items())),
            "checked_privately": sorted(checked_privately)}


def unprompted_responses(sessions):
    """Report (not a failure), from rendered pages: an answer box with no prompt on a page that shows almost no text —
    nothing tells the person what to enter."""
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
    .text()) in the saved sources, which no served string contains."""
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


def sample_sessions(sessions, k=10):
    """Sessions for the sampled page checks: the first k sessions of every arm, plus, for every stage some session
    reached, the first k sessions that reached it (arm-ordered designs put whole arms after one another, so the first
    sessions alone may never show a later arm's pages)."""
    out, seen, per_arm, per_stage = [], set(), {}, {}

    def add(s):
        if id(s) not in seen:
            seen.add(id(s))
            out.append(s)
    for s in sessions:
        arm = (getattr(s, "spec", None) or {}).get("arm")
        if per_arm.get(arm, 0) < k:
            per_arm[arm] = per_arm.get(arm, 0) + 1
            add(s)
        for st in {n for pg in getattr(s, "pages", []) for n, _ in pg.get("stages", [])}:
            if per_stage.get(st, 0) < k:
                per_stage[st] = per_stage.get(st, 0) + 1
                add(s)
    return out


def table_spans_unserved(p, sessions):
    """Blocking: a protocol table cell with a colspan / rowspan (integer >= 1, not 1) that the rendered State cell
    lacks — the spanning header would be shown over the wrong columns. Rendered tables are matched to protocol tables
    by their cell texts; the spans are compared through the checker's own grid (_table_layout)."""
    def txt(c):
        return _norm(c.get("text") or "") if isinstance(c, dict) else _norm(c if isinstance(c, str) else "")

    want, bad = {}, set()

    def walk(o):
        if isinstance(o, dict):
            rows = o.get("rows")
            if isinstance(rows, list) and rows and all(isinstance(r, list) for r in rows):
                for r_ in rows:   # a span that is present but not an integer within the limits is never served
                    for c_ in r_:
                        for k in ("colspan", "rowspan"):
                            v = c_.get(k) if isinstance(c_, dict) else None
                            if v is not None and not (isinstance(v, int) and not isinstance(v, bool)
                                                      and 1 <= v <= _SPAN_MAX[k]):
                                bad.add("invalid %s %r on cell %r" % (k, v, txt(c_)[:40]))
                key = tuple(tuple(txt(c) for c in r) for r in rows)
                lay = _table_layout(rows)
                if any(v != (1, 1) for v in lay[2].values()):
                    want[key] = lay
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(getattr(p, "data", None))
    walk(getattr(p, "stages", None))
    out = set(bad)
    if not want:
        return sorted(out)
    for s in sessions:
        for pg in getattr(s, "pages", []):
            for it in pg.get("shown") or []:
                rows = it.get("rows") if isinstance(it, dict) else None
                if not isinstance(rows, list):
                    continue
                key = tuple(tuple(txt(c) for c in r) for r in rows if isinstance(r, list))
                if key in want and _table_layout(rows)[:3:2] != want[key][:3:2]:
                    out.add("+".join(n for n, _ in pg["stages"]))
    return sorted(out)


def constant_images(sessions):
    """Report (not a failure) stages shown 3+ times in a session whose texts change but whose pictures never do —
    e.g. every product-pair page serving one picture. A fixed logo is fine; reviewers look here first."""
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
    if sys.version_info < (3, 11):   # coding rules use Python 3.11+ regex (atomic groups)
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
        global LEGACY_UNCERTAIN_READINGS, LEGACY_CITE_SOURCES, LEGACY_READINGS
        LEGACY_UNCERTAIN_READINGS, LEGACY_CITE_SOURCES, LEGACY_READINGS = {}, {}, set()
    report["refs"] = check_refs(p)
    fail |= bool(report["refs"])
    env, probs, stats = play(p, a.sessions, a.seed, "random")
    n, tries = a.sessions, 0
    # heavy screening (sessions ending early): run more sessions so every effect has data. Exclusions of completed
    # sessions do not count here: effects are computed on all completed sessions, and random answers tripping a
    # declared exclusion rule is expected
    while sum(1 for r in env.records() if r["status"] == "completed") < 30 and tries < 5:
        n, tries = n * 2, tries + 1
        env, probs, stats = play(p, n, a.seed, "random")
    stats["sessions_run"] = n
    stats["coverage_pass"] = False
    if stats["unreached_stages"]:   # rare branches (k consecutive choices): coverage-guided pass
        xenv, xprobs, xstats = play(p, n, a.seed + 7, "random", explore={})
        stats["unreached_stages"] = sorted(set(stats["unreached_stages"]) & set(xstats["unreached_stages"]))
        stats["coverage_pass"] = True
        probs = probs + xprobs
    report["fuzz"] = dict(stats, problems=probs[:10])
    tables = env.unit_tables()
    recs = env.records()
    sample = sample_sessions(env.sessions)   # every arm and every reached stage (fidelity review 8)
    report["fuzz"]["constant_images"] = constant_images(sample)
    report["fuzz"]["table_spans_unserved"] = table_spans_unserved(p, sample)
    fail |= bool(report["fuzz"]["table_spans_unserved"])   # a spanning cell served without its span (blocking)
    report["script_texts_not_served"] = script_texts_not_served(
        p, {k: open(v, errors="replace").read() for k, v in (x.split("=", 1) for x in a.source_text)})
    report["fuzz"]["unprompted_responses"] = unprompted_responses(sample)
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
