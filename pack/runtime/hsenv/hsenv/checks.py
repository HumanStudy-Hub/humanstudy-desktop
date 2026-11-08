"""Mechanical checks for a protocol (DESIGN.md v3.1 §5). No model calls.

    python -m hsenv.checks studies/hall2024gettier [--sessions 1000] [--source-text survey=path.txt ...]
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
    """Run n sessions; returns (env, problems, stats). policy: random | keyed."""
    env = Env(p)
    rng = random.Random(seed)
    keyed = (p.raw.get("keyed") or {}).get("answers", {})
    problems, reached, unanswerable = [], set(), []
    pool = text_pool(p)
    secret = operator_strings(p)
    visible_texts = screen_strings(p)
    leaks = set()
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
                while state2.get("error") and set(state2["error"]) == {"page"} and tries < 5000:
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
                    problems.append("valid answers refused: %s" % state2["error"])
                    break
                state = state2
        except (ProtocolError, ExprError) as e:
            problems.append("session %s: %s" % (spec["index"], e))
    only_blocked = set()
    blocked = [a for a in p.arms if a.get("runnable") is False]
    if blocked:
        benv = Env(p)
        n_blocked = 40 if (p.raw.get("analysis") or {}).get("blocked_arm_effects") else 10
        for a in blocked:
            for i in range(n_blocked):
                bs = benv.open({"study": p.id, "arm": a["id"], "index": i, "seed": seed * 1000 + i}, allow_blocked=True)
                try:
                    st = bs.reset()
                    while not st.get("done"):
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
                                ans[rid] = int(round((lo + hi) / 2)) if r["view"].get("integer") else (lo + hi) / 2
                        st2 = bs.step(ans)
                        tries = 0
                        while st2.get("error") and tries < 2000:   # page rules: redraw as a person would
                            tries += 1
                            st2 = bs.step(random_answers(st, rng, pool=pool, skip=0 if tries % 2 else 0.5))
                        if st2.get("error"):
                            break
                        st = st2
                except (ProtocolError, ExprError):
                    break
    blocked_not_computed = []
    if blocked and (p.raw.get("analysis") or {}).get("blocked_arm_effects"):   # effects kept for blocked arms
        btab = benv.unit_tables()
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
             "foreign_language_tokens": sorted(foreign)[:20],
             "stages_only_in_blocked_arms": sorted(only_blocked - reached),
             "unanswerable": sorted(set(unanswerable))[:10], "n_unanswerable": len(unanswerable),
             "blocked_effects_not_computed": blocked_not_computed}
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
                    else:
                        data = (p.root / o["src"]).read_bytes()
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
    s = unicodedata.normalize("NFKC", s)
    s = s.replace("’", "'").replace("‘", "'").replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip().lower()


_UNCERTAIN = re.compile(r"\[[^\]]*\buncertain\b", re.I)
# Blind readings written before uncertain lines stopped counting as agreement (2026-11-08, skills review-1 S8),
# pinned by the sha256 of the reading's text. Texts confirmed only by an [uncertain] line of one of these files
# still count, but are reported in verbatim.image_uncertain_legacy until a third blind reader settles them. The pin
# ends by itself when the file changes. Never add new entries: new readings follow the strict rule.
LEGACY_UNCERTAIN_READINGS = {
    "3670d57f27b0762bea2b51462a9d1219262e53c6dfb910867143e918c45534f6": "arechar2018online esm#second",
    "d5de1e0ac2cc205e1400c30f139a7c8cb35d5f10c718b28f0ee944bcd79381ac": "huber2023manydesigns GFL12_ctl_print#second",
    "cbe4bd88ba6a4fecefd9ec47af6c3e4d09b1dfa4ba6c2d719f2f7414872a8e03": "huber2023manydesigns GFL12_cmp_print#second",
    "c91b7dca0c0fe920878dafbe83a0fa6965fcfe9e787bcca701167d73b89af711": "manylabs2 images#second",
    "aa6356edfd129caa5c3013faf53b577ab2f167b47f0a77e5ddc09ca9e2106052": "vlasceanu2024climate master#second",
}

# Studies built before cites had to name a meta.sources entry (skills review-2 S3'): they cite the names of their
# sourcetext files. Pinned by protocol id AND the exact names; any other unknown name in these studies blocks too.
# Never add entries: new studies cite meta.sources keys (README Decided 8).
LEGACY_CITE_SOURCES = {
    "burtonchellew2022pgg": {"nhb_si", "osf", "paper"},
    "chandrashekar2021blindspot": {"docx_s1a", "docx_s1b", "docx_s2", "docx_s3", "qsf_s1a", "qsf_s1b", "qsf_s2",
                                   "qsf_s3"},
    "huber2023manydesigns": {"LEU04_logo", "LGT85_images", "LGT85_py", "LGT85_tpl", "MUE79_pages", "MUE79_php",
                             "NJJ10_py", "NJJ10_tpl", "PRF65_py", "PRF65_tpl", "RDP12_cmp_js", "RDP12_ctl_js",
                             "RPZ39_cmp_pages", "RPZ39_ctl_pages", "RPZ39_py", "TVX41_pages", "TVX41_php",
                             "WDO94_cmp_pages", "WDO94_cmp_py", "WDO94_cmp_raw", "WDO94_ctl_pages", "WDO94_ctl_raw",
                             "YPZ45_py", "YPZ45_tpl"},
    "pennycook2020covid": {"images"},
}

def _strip_marks(f):
    f = re.sub(r"\[value [a-z]+: ([^\]]*)\]", r"\1", f)
    return re.sub(r"\s*\[(?:uncertain|partial|non-english|callout|radio|empty|dropdown|info icon|"
                  r"(?:[AB] )?(?:not )?selected|checked|10×10|note:)[^\]]*\]", "", f, flags=re.I)


def _cited_pages(page):
    if isinstance(page, int):
        return {page}
    if isinstance(page, str) and re.fullmatch(r"\d+", page.strip()):
        return {int(page)}
    if isinstance(page, str) and re.fullmatch(r"\d+-\d+", page):
        a, b = map(int, page.split("-"))
        return set(range(a, b + 1))
    return None


def _covers(reading, page):
    """True when a blind reading has at least one 'p<N> |' line on the cited page(s), i.e. its reader read that page."""
    pages = _cited_pages(page)
    for line in reading.splitlines():
        m = re.match(r"\s*p(\d+)\s*\|", line)
        if m and (pages is None or int(m.group(1)) in pages):
            return True
    return False


def _image_match(text, second, page, uncertain=False):
    """Second-reading files have lines 'p<N> | screen | kind | [style |] text'. Match on the cited page(s);
    labels under 25 characters must equal a whole field. A line the reader marked [uncertain …] is not agreement
    (skills README Decided 5): it is skipped unless uncertain=True (used only to report why a text failed)."""
    pages = _cited_pages(page)
    want = _norm(text)
    prev = None   # (screen field, content field) of the previous line on the cited page(s)
    for line in second.splitlines():
        m = re.match(r"\s*p(\d+)\s*\|", line)
        if not m or (pages and int(m.group(1)) not in pages):
            continue
        if not uncertain and _UNCERTAIN.search(line):
            prev = None
            continue
        # layout tolerance: a reader may put a label and its value on two consecutive lines of the same screen
        # ("Requester:" / "Studies on MTurk"); the served text matches their join (same words, same order)
        parts_ = line.split("|")
        cur = (_norm(parts_[1]) if len(parts_) > 1 else "", _norm(_strip_marks(parts_[-1])))
        if prev and prev[0] == cur[0] and prev[1] and cur[1]:
            joined = prev[1] + " " + cur[1]
            if (len(want) < 25 and want == joined) or (len(want) >= 25 and want in joined):
                return True
        prev = cur
        raw_fields = []
        for f in line.split("|")[1:]:
            # reading notes and marks only — brackets can be real screen text ("[right/wrong]")
            f = re.sub(r"\[value [a-z]+: ([^\]]*)\]", r"\1", f)   # "[value plain: X]" → X (reader's label/value notation)
            f = re.sub(r"\s*\[(?:uncertain|partial|non-english|callout|radio|empty|dropdown|info icon|"
                       r"(?:[AB] )?(?:not )?selected|checked|10×10|note:)[^\]]*\]", "", f, flags=re.I)
            raw_fields += [f] + ([x for x in f.split(" / ")] if " / " in f else [])
        parts = line.split("|")
        if len(parts) > 4:   # printed text containing "|": also try everything after the kind field as one field
            raw_fields.append("|".join(parts[3:]))
        fields = [_norm(re.sub(r"\s*\[(?:uncertain|partial|non-english)[^\]]*\]", "", f, flags=re.I)) for f in raw_fields]
        if len(want) < 25:
            if want in fields:
                return True
            # line breaks differ between readings: a label of 4+ characters may match at word boundaries
            if len(want) >= 4 and any(re.search(r"(?:^|\s)" + re.escape(want) + r"(?:\s|$)", f) for f in fields):
                return True
        elif any(want in f for f in fields):
            return True
    return False


def check_verbatim(p, source_texts):
    """Every cited verbatim data string is found in its source text (when a text is available)."""
    found, missing, unchecked, image_unconfirmed, image_uncertain_only, image_uncertain_legacy = 0, [], 0, [], [], []
    image_disputed, bad_source, unchecked_sources = [], [], set()
    texts = {k: _norm(v) for k, v in source_texts.items()}
    raw = source_texts
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
                    agree = [r for r in rs if _image_match(o["text"], r, c.get("page"))]
                    unsure = [r for r in rs if r not in agree and _image_match(o["text"], r, c.get("page"), uncertain=True)]
                    disagree = [r for r in rs if r not in agree and r not in unsure]
                    key = (c.get("source"), c.get("page"), o["text"][:80])
                    if disagree:
                        image_disputed.append(key)
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
                if src is None:
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
            "image_uncertain_only": image_uncertain_only, "image_uncertain_legacy": image_uncertain_legacy}


def unprompted_responses(sessions):
    """Report (not a failure), from rendered pages: an answer box with no prompt on a page that shows almost no text —
    nothing tells the person what to enter (LESSONS 226; review of Huber RDP12)."""
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
    a = ap.parse_args(argv)
    p = Protocol.load(a.study)
    report, fail = {}, False
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
            ok = b["status"] == "computed" and (b["value"] > 0) == (hs > 0)
            signs.append({"effect": e["id"], "human": round(hs, 3), "keyed": None if b["status"] != "computed" else round(b["value"], 3), "same_sign": ok})
        ex = round(sum(1 for r in krecs if r["excluded"]) / max(1, len(krecs)), 3)
        report["keyed"] = {"problems": kprobs[:10], "excluded_share": ex, "signs": signs}
        fail |= bool(kprobs) or ex > 0 or not all(s["same_sign"] for s in signs)
    texts = {}
    for st in a.source_text:
        name, _, path = st.partition("=")
        texts[name] = Path(path).read_text(encoding="utf-8", errors="replace")
    # control characters in a source text (e.g. ligatures stored as NUL) silently drop letters: report them
    report["source_text_control_chars"] = {n: len(re.findall(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", t))
                                           for n, t in texts.items() if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", t)}
    report["verbatim"] = check_verbatim(p, texts)
    fail |= bool(report["verbatim"]["not_found"]) or bool(report["verbatim"]["image_unconfirmed"])
    fail |= bool(report["verbatim"]["bad_source"]) or report["verbatim"]["unchecked"] > 0   # skills review-2 S3'
    report["coding"] = run_coding_cases(p)
    fail |= any(c["mismatches"] for c in report["coding"].values())
    report["paper_consistency_warnings"] = paper_consistency(p)
    report["second_readings"] = [t["id"] for t in (p.raw.get("analysis") or {}).get("targets", [])
                                 if t.get("second_reading") or t.get("readings")]
    if a.fetch_images:
        report["images"] = fetch_images(p, env)
        fail |= any(not x.startswith("note:") for x in report["images"])
    report["release_hold"] = [{"arm": a["id"], "why": a["release_hold"]} for a in p.arms if a.get("release_hold")]
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
