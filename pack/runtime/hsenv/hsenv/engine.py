"""One engine for every study: interprets protocol.json (DESIGN.md v3.1 §3–§4).

    env = make("studies/<id>")
    for spec in env.design(n=10, seed=7):
        s = env.open(spec); state = s.reset()
        while not state.get("done"):
            state = s.step(my_agent(state))      # {response id: value}
    table = env.records()

States carry only what was on the human's screen, what they had seen before, and their own answers, with
opaque per-session ids. Conditions, keys, flags and rules stay inside the session (operator side).
"""
import copy
import re
import hashlib
import json
import math
import random
from pathlib import Path

from .expr import ExprError, evaluate

KINDS = {"choice", "multi", "number", "scale", "slider", "text"}
DONE_STATUSES = {"completed", "screened_out", "excluded", "ended"}



SPAN_LIMITS = {"colspan": 100, "rowspan": 1000}   # the same limits the checker's grid uses (hsenv.checks)


def _cell_span(v, limit):
    """A served table cell's colspan / rowspan: an integer 1..limit, else None (not served; checks flag it)."""
    return v if isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= limit else None


def _state_cell(c):
    """A table cell as served in a State: its text, or {text, mark?, spans?, colspan?, rowspan?} when it has any of
    them (a spanning header covers the columns it spans in the source, not one)."""
    out = {k: _shown(c[k]) for k in ("text", "mark", "spans") if c.get(k) is not None}
    for k in ("colspan", "rowspan"):
        if _cell_span(c.get(k), SPAN_LIMITS[k]) is not None:
            out[k] = c[k]
    return out if (c.get("mark") or c.get("spans") or "colspan" in out or "rowspan" in out) else c.get("text")

# keys a State never shows: cites and notes are operator text (the protocol schema's own cite / note patterns)
_OPERATOR_KEY = re.compile(r"(^|_)cites?$|(^|_)note(s)?$|_note_|^note_")


def _shown(v):
    """What a participant may see of a value the engine passes through to a State (spans, prefix / suffix,
    na_option, anchors, columns, widget_params, prefill): the same value with every cite and note key removed,
    recursively. The one helper for every pass-through."""
    if isinstance(v, dict):
        return {k: _shown(x) for k, x in v.items() if not (isinstance(k, str) and _OPERATOR_KEY.search(k))}
    if isinstance(v, list):
        return [_shown(x) for x in v]
    return v


class ProtocolError(ValueError):
    pass


def _seed(*parts):
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12], 16)


# --------------------------------------------------------------------------------------------- protocol
class Protocol:
    def __init__(self, data, root=None):
        self.raw = data
        self.root = Path(root) if root else None
        self.id = data["id"]
        self.data = data.get("data", {})
        self.stages = data["stages"]
        self.flow = data["flow"]
        self.arms = data.get("arms") or [{"id": "main"}]
        self.vars = data.get("vars", {})
        self.exclusions = data.get("exclusions", [])
        self.units = data.get("units", {})
        self.version = hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()[:16]
        self._assets, self._asset_paths = {}, {}

    @classmethod
    def load(cls, path):
        path = Path(path)
        f = path / "protocol.json" if path.is_dir() else path
        return cls(json.loads(f.read_text(encoding="utf-8")), f.parent)

    def local_path(self, src):
        """The study-folder file a local `src` names, or ProtocolError: only relative paths inside the protocol's
        folder, no '..', no absolute or drive paths, no symlink that leaves the folder, and only regular files (no
        devices, FIFOs, folders). None when the file does not exist or the protocol has no folder (nothing is read)."""
        import ntpath
        import posixpath
        if not isinstance(src, str) or not src or "\x00" in src:
            raise ProtocolError("asset src %r is not a file name" % (src,))
        if posixpath.isabs(src) or ntpath.isabs(src) or ntpath.splitdrive(src)[0] or src.startswith("~"):
            raise ProtocolError("asset src %r is absolute: local files must sit in the study folder" % src)
        if ".." in re.split(r"[\\/]", src):
            raise ProtocolError("asset src %r leaves the study folder ('..')" % src)
        if self.root is None:
            return None
        root = self.root.resolve()
        path = self.root / src
        try:
            real = path.resolve(strict=True)
        except (OSError, RuntimeError):
            return None   # missing (or a symlink loop): nothing is read
        try:
            real.relative_to(root)
        except ValueError:
            raise ProtocolError("asset src %r resolves outside the study folder" % src)
        if not real.is_file():
            raise ProtocolError("asset src %r is not a regular file" % src)
        return real

    def asset_ref(self, src):
        """Local files are served by opaque id ("asset:<sha16>"); operators resolve them with Env.asset_path.
        Only regular files inside the study folder are read (local_path)."""
        if src.startswith(("http://", "https://")):
            return src
        if src not in self._assets:
            path = self.local_path(src)
            h = None
            if path is not None:
                try:
                    d = hashlib.sha256()
                    with open(path, "rb") as fh:
                        for chunk in iter(lambda: fh.read(1 << 20), b""):
                            d.update(chunk)
                    h = d.hexdigest()[:16]
                except OSError:
                    h = None
            if h is None:
                h = hashlib.sha256(src.encode()).hexdigest()[:16]
            self._assets[src] = h
            self._asset_paths[h] = str(path if path is not None else (self.root / src if self.root else src))
        return "asset:" + self._assets[src]

    def response(self, ref):
        stage, _, rid = ref.partition(".")
        for r in self.stages.get(stage, {}).get("responses", []):
            if r["id"] == rid:
                return r
        return None


# --------------------------------------------------------------------------------------------- session
class _End(Exception):
    def __init__(self, status):
        self.status = status


class Session:
    """One participant's run through the flow. `reset()`, then `step(answers)` until the state says done."""

    def __init__(self, protocol, spec, shared=None, pid="p1", group=None):
        self.p = protocol
        self.pid = pid
        self.group = group          # GroupSession or None
        self._waiting = None        # sync marker while waiting at a group barrier
        self.refused = []           # answers the page refused (validation): count and values per attempt
        self.shared = shared if shared is not None else {}   # counts for balanced randomisers across sessions
        self.spec = dict(spec)
        self.rng = random.Random(spec["seed"])
        self.vars = {}
        self.flags = []
        self.answers = []        # {stage, response, value, bindings, step, attempt}
        self.pages = []          # operator trace: {step, stages:[(stage, bindings)], items:[internal ids], back}
        self.seen = []           # participant view of earlier items
        self.answered = []       # participant view of earlier answers
        self.events = []
        self.step_no = 0
        self.status = None
        self._ids = {"i": 0, "r": 0}
        self._gen = None
        self._page = None        # current page being shown
        self._state = None
        self._last_spans = None
        self._typed = {}
        self._role = None   # set by _assign_role (protocol roles[].shown)

    # ---- expressions
    def _funcs(self, bindings):
        rng = self.rng

        def matches(a, filters, use_ctx):
            if a["stage"] != filters["_stage"] or a["response"] != filters["_resp"]:
                return False
            for k, v in filters.items():
                if not k.startswith("_") and a["bindings"].get(k) != v:
                    return False
            explicit = any(not k.startswith("_") for k in filters)
            if use_ctx and not explicit:   # explicit filters replace the current loop context
                for k, v in bindings.items():
                    if k in a["bindings"] and a["bindings"][k] != v and k not in filters:
                        return False
            return True

        def answer(ref, **flt):
            st, _, rs = ref.partition(".")
            flt.update(_stage=st, _resp=rs)
            hits = [a for a in self.answers if matches(a, flt, True)]
            return hits[-1]["value"] if hits else None

        def answers(ref, **flt):
            st, _, rs = ref.partition(".")
            flt.update(_stage=st, _resp=rs)
            return [a["value"] for a in self.answers if matches(a, flt, False)]

        def elapsed(ref, **flt):   # ms on the screen that answered ref (None if the simulator did not report it)
            st, _, rs = ref.partition(".")
            flt.update(_stage=st, _resp=rs)
            hits = [a for a in self.answers if matches(a, flt, True)]
            return hits[-1].get("elapsed_ms") if hits else None

        def elapsed_all(ref, **flt):
            st, _, rs = ref.partition(".")
            flt.update(_stage=st, _resp=rs)
            return [a.get("elapsed_ms") for a in self.answers if matches(a, flt, False)]

        def permutation(xs):
            xs = list(xs)
            rng.shuffle(xs)
            return xs

        def balanced(name, xs):
            xs = list(xs)
            counts = self.shared.setdefault(name, {})
            low = min(counts.get(str(x), 0) for x in xs)
            pick = rng.choice([x for x in xs if counts.get(str(x), 0) == low])
            counts[str(pick)] = counts.get(str(pick), 0) + 1
            return pick

        def group(ref, **flt):   # each member's answer to ref (same loop context), in member order
            if not self.group:
                return [answer(ref, **flt)]
            return [m._funcs(bindings)["_answer"](ref, **flt) for m in self.group.members]

        return {
            "refused": lambda stage=None: sum(1 for x in self.refused if stage is None or stage in x["stages"]),
            # wrong answers per question across refused attempts (e.g. "incorrect attempts in the six questions")
            "refused_errors": lambda stage=None: sum(len([e for e in x["errors"] if e != "page"]) for x in self.refused
                                                     if stage is None or stage in x["stages"]),
            "_answer": answer, "group": group,
            "balanced": balanced,
            "answer": answer, "answers": answers, "elapsed": elapsed, "elapsed_all": elapsed_all, "flagged": lambda name: name in self.flags,
            "permutation": permutation,
            "choice": lambda xs, weights=None: rng.choices(list(xs), weights=weights)[0],
            "uniform": rng.uniform, "normal": rng.gauss, "randint": rng.randint,
            "bernoulli": lambda p: rng.random() < p,
        }

    def _names(self, bindings):
        names = {"data": self.p.data, "arm": self.spec["arm"], "vars": self.vars,
                 "my_index": self.group.members.index(self) if self.group else 0,
                 "group_size": len(self.group.members) if self.group else 1}
        names.update(self.vars)
        names.update(bindings)
        return names

    def ev(self, spec, bindings):
        """A value spec: literal, or {"expr": "..."}."""
        if isinstance(spec, dict) and set(spec) == {"expr"}:
            return evaluate(spec["expr"], self._names(bindings), self._funcs(bindings))
        return spec

    def _text(self, spec, bindings):
        v = self.ev(spec, bindings)
        if isinstance(v, dict) and "text" in v:
            self._last_spans = v.get("spans")
            return v["text"], v.get("cite")
        self._last_spans = None
        return v, None

    # ---- flow interpreter (a generator: yields pages, receives nothing; answers are stored by step())
    def _run(self, node, b):
        if isinstance(node, list):
            node = {"seq": node}
        if "seq" in node:
            for n in node["seq"]:
                yield from self._run(n, b)
        elif "end" in node and "seq" not in node:   # before "page": an end may carry a terminal page
            if self.ev({"expr": node.get("if", "True")}, b):
                if node.get("page"):
                    yield self._make_page([node["page"]], b)
                raise _End(node["end"])
        elif "stage" in node or "page" in node:
            names = [node["stage"]] if "stage" in node else list(node["page"])
            if "if" in node and not self.ev({"expr": node["if"]}, b):
                return
            if node.get("shuffle") is True:   # stages on one page in random order
                self.rng.shuffle(names)
            yield self._make_page(names, b)
        elif isinstance(node.get("shuffle"), list):
            kids = list(node["shuffle"])
            self.rng.shuffle(kids)
            for n in kids[: node.get("pick", len(kids))]:
                yield from self._run(n, b)
        elif "for" in node:
            values = self.ev(node["in"], b) if isinstance(node["in"], dict) else list(node["in"])
            values = list(values)
            if node.get("shuffle"):
                self.rng.shuffle(values)
            for k, v in enumerate(values):
                nb = dict(b, **{node["for"]: v, node["for"] + "_index": k})
                for name, spec in (node.get("let") or {}).items():
                    nb[name] = self.ev(spec, nb)
                yield from self._run(node["do"], nb)
        elif "loop" in node:
            for i in range(int(self.ev(node["loop"], b))):
                yield from self._run(node["do"], dict(b, **{node.get("as", "i"): i}))
        elif "repeat" in node:
            for attempt in range(1, int(node.get("max", 1)) + 1):
                nb = dict(b, attempt=attempt)
                yield from self._run(node["repeat"], nb)
                if self.ev({"expr": node["until"]}, nb):
                    break
            else:   # the cap was reached without meeting the rule: the declared outcome applies
                om = node.get("on_max", "continue")
                if isinstance(om, str) and om.startswith("end:"):
                    raise _End(om[4:])
                if om == "flag":
                    self.flags.append("max_attempts")
        elif "if" in node and ("then" in node or "else" in node):
            branch = node.get("then") if self.ev({"expr": node["if"]}, b) else node.get("else")
            if branch is not None:
                yield from self._run(branch, b)
        elif "set" in node:
            for name, spec in node["set"].items():
                self.vars[name] = self.ev(spec, b)
        elif "flag" in node:
            if self.ev({"expr": node.get("if", "True")}, b):
                self.flags.append(node["flag"])
        elif "sync" in node:   # group barrier: wait for every member, then compute shared outcomes
            yield {"_sync": node["sync"], "node": node, "bindings": dict(b)}
        elif "end" in node:
            if self.ev({"expr": node.get("if", "True")}, b):
                if node.get("page"):   # a terminal page (e.g. "you cannot continue") shown before the session ends
                    yield self._make_page([node["page"]], b)
                raise _End(node["end"])
        else:
            raise ProtocolError("unknown flow node: %s" % sorted(node))

    def _new(self, kind):
        self._ids[kind] += 1
        return "%s%d" % (kind, self._ids[kind])

    def _make_page(self, names, b):
        items, responses, internal = [], [], []
        pres = {}
        for name in names:
            st = self.p.stages[name]
            pres = st.get("presentation", pres)
            for it in st.get("content", []):
                if "if" in it and not self.ev({"expr": it["if"]}, b):
                    continue
                raw = self.ev(it.get("value", it.get("text")), b)
                oid = self._new("i")
                if isinstance(raw, dict) and "text" not in raw:
                    # structured items (images): only what participants saw — the picture and verified text lines;
                    # never notes, copies, descriptions or cites
                    item = {"id": oid, "type": it.get("type", "image")}
                    if isinstance(raw.get("src"), str):
                        item["src"] = self.p.asset_ref(raw["src"])
                    if isinstance(raw.get("size"), dict):   # display size as shown, e.g. {"width": 500} (px)
                        item["size"] = {k: v for k, v in raw["size"].items() if k in ("width", "height")
                                        and isinstance(v, (int, float)) and not isinstance(v, bool)}
                    # a line is a string, or {text, spans} when part of it is styled (e.g. a bold amount)
                    lines = [({"text": x["text"], "spans": _shown(x["spans"])} if x.get("spans") else x.get("text"))
                             if isinstance(x, dict) else x for x in raw.get("lines", [])]
                    lines = [x for x in lines if isinstance(x, str) or (isinstance(x, dict) and isinstance(x["text"], str))]
                    if lines:
                        item["lines"] = lines
                    if isinstance(raw.get("rows"), list):   # a table as shown: rows of cell texts
                        item["type"] = it.get("type", "table")
                        item["rows"] = [[_state_cell(c) if isinstance(c, dict) else c for c in row]
                                        for row in raw["rows"]]
                    text, cite, self._last_spans = None, raw.get("cite"), None
                else:
                    text, cite = self._text(raw, b) if not isinstance(raw, str) else (raw, None)
                    if isinstance(raw, str):
                        self._last_spans = None
                    item = {"id": oid, "type": it.get("type", "text"), "text": text}
                if self._last_spans:
                    item["spans"] = _shown(self._last_spans)
                if it.get("style"):
                    item["style"] = it["style"]
                items.append(item)
                internal.append({"id": oid, "ref": "%s.%s" % (name, it["id"]), "bindings": dict(b), "cite": cite,
                                 "reviewable": it.get("reviewable"), "reviewable_on": it.get("reviewable_on")})
            for r in st.get("responses", []):
                if "if" in r and not self.ev({"expr": r["if"]}, b):
                    continue
                prompt, _ = self._text(r.get("prompt", ""), b)
                prompt_spans = self._last_spans
                view = {"id": self._new("r"), "kind": r["kind"], "prompt": prompt,
                        "required": bool(r.get("required", True))}
                if prompt_spans:
                    view["prompt_spans"] = _shown(prompt_spans)
                if r.get("prompt_style"):
                    view["prompt_style"] = r["prompt_style"]
                if "prefill" in r:   # value already in the box when the page opens (e.g. a retried page)
                    pv = self.ev(r["prefill"], b)
                    if pv is not None:
                        view["prefill"] = _shown(pv)
                if "instruction" in r:   # shown between the question text and the input (survey layout)
                    view["instruction"], _ = self._text(r["instruction"], b)
                opts = []
                for o in (self.ev(r["options"], b) if isinstance(r.get("options"), dict) else r.get("options", [])):
                    label, _ = self._text(o.get("label"), b)
                    opt = {"code": o["code"], "label": label}
                    if self._last_spans:
                        opt["spans"] = _shown(self._last_spans)
                    if o.get("text_entry"):
                        opt["text_entry"] = True
                    opts.append(opt)
                if r.get("shuffle_options"):   # options marked fixed keep their place (e.g. "None of these" last)
                    fixed = {k for k, o in enumerate(r.get("options") or []) if isinstance(o, dict) and o.get("fixed")} \
                        if isinstance(r.get("options"), list) else set()
                    movable = [o for k, o in enumerate(opts) if k not in fixed]
                    self.rng.shuffle(movable)
                    it_ = iter(movable)
                    opts = [opts[k] if k in fixed else next(it_) for k in range(len(opts))]
                if opts:
                    view["options"] = [dict({"code": "o%d" % (k + 1)}, **{x: y for x, y in o.items() if x != "code"})
                                       for k, o in enumerate(opts)]
                for key in ("range", "step", "anchors", "integer", "min_chars", "start", "columns", "widget",
                    "shows_value", "gridlines", "na_option", "prefix", "suffix", "soft_required", "widget_params"):
                    if key in r:
                        val = self.ev(r[key], b) if isinstance(r[key], dict) and "expr" in r[key] else r[key]
                        view[key] = _shown(val)
                hidden_range = None
                if r.get("range_visible") is False:
                    hidden_range = view.pop("range", None)   # a bound humans did not see never reaches the State
                if r.get("start_visible") is False:
                    view.pop("start", None)   # a hidden handle's start position (shown only once clicked)
                responses.append({"view": view, "stage": name, "def": r, "bindings": dict(b), "range": hidden_range,
                                  "text_entry": {"o%d" % (k + 1) for k, o in enumerate(opts) if o.get("text_entry")},
                                  "codes": {"o%d" % (k + 1): o["code"] for k, o in enumerate(opts)},
                                  "labels": {o["code"]: o["label"] for o in opts}})
        for name in names:
            if self.p.stages[name].get("shuffle_responses"):
                mine = [r for r in responses if r["stage"] == name]
                self.rng.shuffle(mine)
                it = iter(mine)
                responses = [next(it) if r["stage"] == name else r for r in responses]
        if any(self.p.stages[n].get("shuffle_responses") for n in names):
            # opaque ids follow the display order, so they do not reveal the declaration order
            ids = sorted((r["view"]["id"] for r in responses), key=lambda x: int(x[1:]))
            for r, new in zip(responses, ids):
                r["view"]["id"] = new
        order = []
        for name in names:
            lay = self.p.stages[name].get("layout")
            if not lay:
                if len(names) > 1:   # default on-screen order: each stage's texts, then its own questions
                    order += [i["id"] for i in internal if i["ref"].startswith(name + ".")]
                    order += [r["view"]["id"] for r in responses if r["stage"] == name]
                continue
            ids = {i["ref"].split(".", 1)[1]: i["id"] for i in internal if i["ref"].startswith(name + ".")}
            ids.update({r["def"]["id"]: r["view"]["id"] for r in responses if r["stage"] == name})
            ids["@button"] = "button"   # the page's continue button placed among the items (e.g. above a legal note)
            order += [ids[k] for k in lay if k in ids]
        return {"names": names, "bindings": dict(b), "items": items, "internal": internal,
                "responses": responses, "presentation": pres, "order": order}

    # ---- participant API
    def _advance(self):
        try:
            self._page = next(self._gen)
        except StopIteration:
            self._page, self.status = None, "completed"
        except _End as e:
            self._page, self.status = None, e.status
        if self._page is None:
            self._state = dict({"participant": self.pid, "done": True, "step": self.step_no}, **self._role_field())
            return self._state
        if isinstance(self._page, dict) and "_sync" in self._page:
            self._waiting, self._page = self._page, None
            self._state = dict({"participant": self.pid, "done": False, "waiting": True, "step": self.step_no},
                               **self._role_field())
            return self._state
        self.step_no += 1
        pg = self._page
        pres = pg["presentation"]
        self.pages.append({"step": self.step_no, "stages": [(n, pg["bindings"]) for n in pg["names"]],
                           "items": pg["internal"], "shown": pg["items"], "resp": [r["view"] for r in pg["responses"]], "back": pres.get("back", "not_allowed")})
        self._state = {
            "participant": self.pid, "done": False, "step": self.step_no, "page": self.step_no,
            **self._role_field(),
            "screen": dict({"items": pg["items"], "responses": [r["view"] for r in pg["responses"]]},
                           **({"order": pg["order"]} if pg.get("order") else {}),
                           **({"button": pres["button"]} if isinstance(pres.get("button"), str) else
                              {"button": self.ev(pres["button"], pg["bindings"])}
                              if isinstance(pres.get("button"), dict) and "expr" in pres["button"] else {})),
            # reviewable_on: an earlier item can be reopened only from the listed stages (e.g. an info icon)
            "seen": [dict({k: v for k, v in x.items() if k != "_rev_on"},
                          reviewable=(x["reviewable"] and not x.get("_rev_on")) or
                          bool(x.get("_rev_on") and set(x["_rev_on"]) & set(pg["names"])))
                     for x in self.seen],
            "answered": copy.deepcopy(self.answered),
            "events": list(self.events),
            "timing": {k: pres[k] for k in ("advance", "time_limit", "min_sec", "timer_shown")
                       if k in pres and isinstance(pres[k], (str, int, float, bool))},
            # only plain values, never cite objects or notes (they can carry the authors' interpretation)
            "navigation": {k: (pres[k] if isinstance(pres[k], (str, int, float, bool)) else
                               (pres[k].get("value") if isinstance(pres[k], dict) and
                                isinstance(pres[k].get("value"), (str, int, float, bool)) else "unknown"))
                           for k in ("back", "paging") if k in pres},
        }
        self.events = []
        return self._state

    def _role_field(self):
        return {"role": self._role} if self._role is not None else {}

    def _assign_role(self):
        """Protocol `roles: [{member, id, shown: {text, cite}, arms?}]`: what a participant was told about their own
        position (e.g. "Room A"), a fact of their situation. `member` is the 1-based seat in a group (1 for a solo
        session); the shown text reaches every State as `role`. Labels, ids and cites stay operator-side."""
        seat = (self.group.members.index(self) + 1) if self.group else 1
        for r in self.p.raw.get("roles") or []:
            if not isinstance(r, dict) or r.get("member", 1) != seat:
                continue
            if r.get("arms") and self.spec.get("arm") not in r["arms"]:
                continue
            shown = r.get("shown")
            text = shown.get("text") if isinstance(shown, dict) else shown
            if isinstance(text, str) and text:
                self._role = text
            return

    def reset(self):
        self._gen = self._run(self.p.flow, {})
        self._assign_role()
        try:
            return self._advance()
        except ExprError as e:
            raise ProtocolError(str(e))

    def state(self):
        return self._state

    def _validate(self, r, value):
        d, view = r["def"], r["view"]
        kind = d["kind"]
        if value == "NA" and d.get("na_option"):   # the Not Applicable box was ticked: distinct from skipping
            return "NA", None
        if value is None or value == "" or value == []:
            return (None, None) if not view["required"] else (None, d.get("required_message") or "an answer is required")
        if kind in ("choice", "multi") and not isinstance(value, (str, list, dict)):
            return None, "choose one of %s" % ", ".join(r["codes"])
        v = d.get("validate") or {}
        if kind == "choice" and isinstance(value, dict):
            code, extra = value.get("code"), value.get("text")
            if code not in r.get("text_entry", ()):
                return None, "this option has no text box"
            if not isinstance(extra, str):
                return None, "text is required"
            got, err = self._validate(r, code)
            return (None, err) if err else ({"code": got, "text": extra}, None)
        if kind == "choice":
            if not isinstance(value, str) or value not in r["codes"]:
                return None, "choose one of %s" % ", ".join(r["codes"])
            want_ = self.ev(v["equals"], r["bindings"]) if isinstance(v.get("equals"), dict) else v.get("equals")
            if "equals" in v and r["codes"][value] != want_:
                return None, v.get("message") or "this answer is not accepted"
            return r["codes"][value], None
        if kind == "multi":
            texts = {}
            if isinstance(value, list):   # a ticked option with a text box: {"code": "o3", "text": "..."}
                flat = []
                for x in value:
                    if isinstance(x, dict):
                        if x.get("code") not in r.get("text_entry", ()) or not isinstance(x.get("text"), str):
                            return None, "only options with a text box take text"
                        texts[r["codes"][x["code"]]] = x["text"]
                        flat.append(x["code"])
                    else:
                        flat.append(x)
                value = flat
            if not isinstance(value, list) or any(not isinstance(x, str) or x not in r["codes"] for x in value):
                return None, "choose any of %s" % ", ".join(r["codes"])
            got = [r["codes"][x] for x in value]
            if texts:
                self._multi_texts[r["view"]["id"]] = texts
            if "equals" in v and sorted(map(str, got)) != sorted(map(str, v["equals"])):
                return None, v.get("message") or "this answer is not accepted"
            return got, None
        if kind in ("number", "scale", "slider"):
            if kind == "number" and isinstance(value, str):   # typed text: keep exactly what was typed
                try:
                    num = float(value.strip().replace(",", ""))
                except ValueError:
                    return None, (d.get("validate") or {}).get("message") or "a number is required"
                got, err = self._validate(r, int(num) if num == int(num) and "." not in value else num)
                if err:
                    return None, err
                self._typed[r["view"]["id"]] = value.strip()
                return got, None
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                return None, "a number is required"
            acc = (d.get("validate") or {})
            if value in (acc.get("also") or []):   # extra accepted codes outside the range, e.g. 0-20 or 99
                return value, None
            if ("min" in acc and value < acc["min"]) or ("max" in acc and value > acc["max"]):
                return None, acc.get("message") or "this answer is not accepted"   # limits humans were not shown
            if acc.get("equals") is not None:   # the one accepted number, e.g. the base rate just shown
                want = self.ev(acc["equals"], r["bindings"]) if isinstance(acc["equals"], dict) else acc["equals"]
                if not isinstance(want, (int, float)) or abs(value - want) > 1e-9:
                    return None, acc.get("message") or "this answer is not accepted"
            rg = view.get("range") or r.get("range") or d.get("range")   # r["range"]: evaluated but not shown
            lo, hi = (rg if isinstance(rg, (list, tuple)) else [None, None])[:2]
            if (lo is not None and value < lo) or (hi is not None and value > hi):
                return None, (d.get("validate") or {}).get("message") or (
                    "a number of at least %s" % lo if hi is None else
                    "a number of at most %s" % hi if lo is None else "a number from %s to %s" % (lo, hi))
            if (view.get("integer") or kind == "scale") and value != int(value):
                return None, "a whole number"
            stp = d.get("step")
            if kind == "slider" and isinstance(stp, (int, float)) and not isinstance(stp, bool) and stp > 0:
                base = lo if lo is not None else 0
                k_ = (value - base) / stp
                if abs(k_ - round(k_)) > 1e-6:   # a slider handle can only rest on its grid
                    return None, "a value on the slider's steps of %s" % stp
            return value, None
        if kind == "text":
            if not isinstance(value, str):
                return None, "text is required"
            if len(value) < int(view.get("min_chars", 0)):
                return None, d.get("min_chars_message") or "at least %d characters" % view["min_chars"]
            v = d.get("validate")
            if v:   # the survey's own content validation, e.g. Qualtrics "contains"
                flags = re.I if v.get("ignore_case") else 0
                ok = (v["contains"].lower() in value.lower() if v.get("ignore_case") else v["contains"] in value) \
                    if "contains" in v else bool(re.search(v["pattern"], value, flags))
                if not ok:
                    return None, v.get("message") or "this answer is not accepted"
            return value, None
        raise ProtocolError("unknown response kind %s" % kind)

    def step(self, answers):
        if self._page is None:
            raise RuntimeError("session is done")
        answers = dict(answers or {})
        elapsed = answers.pop("_elapsed_ms", None)   # time on this screen, as reported by the simulator (optional)
        if elapsed is not None and (isinstance(elapsed, bool) or not isinstance(elapsed, (int, float)) or elapsed < 0):
            return dict(self._state, error={"_elapsed_ms": "must be a non-negative number of milliseconds"})
        stored, errors = [], {}
        self._typed = {}
        self._multi_texts = {}
        for r in self._page["responses"]:
            val, err = self._validate(r, answers.get(r["view"]["id"]))
            if err:
                errors[r["view"]["id"]] = err
            stored.append((r, val))
        unknown = set(answers) - {r["view"]["id"] for r in self._page["responses"]}
        if unknown:
            errors.update({k: "not on this screen" for k in unknown})
        if errors:
            self.refused.append({"step": self.step_no, "stages": list(self._page["names"]),
                                 "answers": {r["def"]["id"]: answers.get(r["view"]["id"]) for r in self._page["responses"]},
                                 "errors": sorted(errors)})
            # one message for the page when only answers are missing (e.g. a single line under the button)
            page_msg = next((self.p.stages[n].get("required_message_page") for n in self._page["names"]
                             if self.p.stages[n].get("required_message_page")), None)
            missing = {r["view"]["id"] for r in self._page["responses"]
                       if r["view"]["required"] and answers.get(r["view"]["id"]) in (None, "")}
            if page_msg and set(errors) <= missing:
                return dict(self._state, error={"page": page_msg})
            return dict(self._state, error=errors)
        for n in self._page["names"]:   # single-switch pages: rows go from one option to the other at most once
            ss = self.p.stages[n].get("single_switch")
            if ss and ss.get("enforce", True):   # enforce: false = the paper describes one switch, the screen allowed more
                seq = [v for r, v in stored if r["stage"] == n and r["def"]["id"] in ss["responses"]]
                ok = all(v in (ss["from"], ss["to"]) for v in seq) and \
                    all(not (a_ == ss["to"] and b_ == ss["from"]) for a_, b_ in zip(seq, seq[1:]))
                if not ok:
                    self.refused.append({"step": self.step_no, "stages": list(self._page["names"]), "errors": ["page"]})
                    return dict(self._state, error={"page": ss.get("message") or "please switch only once"})
        for n in self._page["names"]:   # constant-sum pages: the listed answers must add up to the total
            st_ = self.p.stages[n].get("sum_to")
            if st_:
                vals = [v for r, v in stored if r["stage"] == n and r["def"]["id"] in st_["responses"]]
                if any(v is None for v in vals) or abs(sum(vals) - st_["total"]) > 1e-9:
                    return dict(self._state, error={"page": st_.get("message") or "the total must equal %s" % st_["total"]})
        page_rules = [v for n in self._page["names"] for v in (self.p.stages[n].get("validate_page") or [])]
        if page_rules:
            tentative = [{"stage": r["stage"], "response": r["def"]["id"],
                          "value": val["code"] if isinstance(val, dict) and "code" in val else val,
                          "bindings": r["bindings"], "step": self.step_no, "attempt": 1} for r, val in stored]
            self.answers.extend(tentative)
            try:
                bad = [v for v in page_rules if not self.ev({"expr": v["if_valid"]}, self._page["bindings"])]
            finally:
                del self.answers[len(self.answers) - len(tentative):]
            if bad:
                self.refused.append({"step": self.step_no, "stages": list(self._page["names"]), "errors": ["page"]})
                return dict(self._state, error={"page": bad[0].get("message") or "this page is not complete"})
        for r, val in stored:
            typed = val.get("text") if isinstance(val, dict) and "code" in val else None
            if typed is None and r["view"]["id"] in self._typed:
                typed = self._typed.pop(r["view"]["id"])
                self.answers.append({"stage": r["stage"], "response": r["def"]["id"] + "_typed", "value": typed,
                                     "bindings": r["bindings"], "step": self.step_no,
                                     "attempt": r["bindings"].get("attempt", 1)})
            for code_, txt in self._multi_texts.pop(r["view"]["id"], {}).items():   # multi option text boxes
                self.answers.append({"stage": r["stage"], "response": "%s_text_%s" % (r["def"]["id"], code_),
                                     "value": txt, "bindings": r["bindings"], "step": self.step_no,
                                     "attempt": r["bindings"].get("attempt", 1)})
            if isinstance(val, dict) and "code" in val:   # option with a text box
                self.answers.append({"stage": r["stage"], "response": r["def"]["id"] + "_text", "value": val["text"],
                                     "bindings": r["bindings"], "step": self.step_no,
                                     "attempt": r["bindings"].get("attempt", 1)})
                val = val["code"]
            self.answers.append({"stage": r["stage"], "response": r["def"]["id"], "value": val,
                                 "bindings": r["bindings"], "step": self.step_no,
                                 "attempt": r["bindings"].get("attempt", 1), "elapsed_ms": elapsed})
            shown = r["labels"].get(val, val) if r["def"]["kind"] == "choice" else (
                [r["labels"].get(v, v) for v in val] if r["def"]["kind"] == "multi" and val else val)
            entry = {"response": r["view"]["id"], "prompt": r["view"]["prompt"], "value": shown, "step": self.step_no}
            if typed is not None:
                entry["text"] = typed   # what the person typed into the option's box
            self.answered.append(entry)
        back = self._page["presentation"].get("back", "not_allowed") == "allowed"
        rev = {i["id"]: i for i in self._page["internal"]}
        for it in self._page["items"]:
            meta = rev.get(it["id"], {})
            self.seen.append(dict(it, step=self.step_no, reviewable=bool(meta.get("reviewable")) or back,
                                  _rev_on=meta.get("reviewable_on")))
        try:
            return self._advance()
        except ExprError as e:
            raise ProtocolError(str(e))

    # ---- operator side
    def visible_refs(self):
        """Internal refs (stage.item, bindings) on screen now or seen before: for the answerability check."""
        out = []
        for pg in self.pages:
            out += [(i["ref"], i["bindings"]) for i in pg["items"]]
        return out

    def record(self):
        excluded, pending = [], []
        for ex in self.p.exclusions:
            if "population" in ex:
                continue   # computed on the analysed sample by Env.unit_tables
            try:
                if ex.get("pending_if") and self.ev({"expr": ex["pending_if"]}, {}):
                    pending.append(ex["id"])   # undecided until a declared step (e.g. a coder) resolves it
                elif self.ev({"expr": ex["if"]}, {}):
                    excluded.append(ex["id"])
            except ExprError as e:
                raise ProtocolError("exclusion %s: %s" % (ex.get("id"), e))
        return {"study": self.p.id, "version": self.p.version, "arm": self.spec["arm"], "seed": self.spec["seed"],
                "participant": self.pid, "group": self.group.spec["index"] if self.group else None,
                "refused": copy.deepcopy(self.refused),
                "index": self.spec["index"], "status": self.status, "flags": list(self.flags),
                "excluded": excluded, "pending": pending, "answers": copy.deepcopy(self.answers), "steps": self.step_no}

    def units(self):
        """Analysis rows (DESIGN §8 in v3): one table per protocol `units` entry."""
        rec = self.record()
        scoped = {ex["id"]: ex.get("applies_to") for ex in self.p.exclusions}
        base = {"session": "%s:%s" % (rec["arm"], rec["index"]), "arm": rec["arm"], "status": rec["status"],
                "excluded": any(scoped.get(x) is None for x in rec["excluded"]),
                "excluded_for": sorted({a for x in rec["excluded"] for a in (scoped.get(x) or [])}),
                # rows an undecided exclusion may still remove: not analysable until resolved
                "pending": sorted(rec["pending"]),
                "pending_for": sorted({a for x in rec["pending"] for a in (scoped.get(x) or ["*"])})}
        out = {}
        for name, u in self.p.units.items():
            if u.get("per") == "group":
                continue   # built once per group by Env.unit_tables
            if u.get("arms") and rec["arm"] not in u["arms"]:
                continue   # a unit scoped to some arms (their own fields would fail elsewhere)
            rows = []
            if u.get("per", "session") == "session":
                contexts = [{}]
            else:
                seen, contexts = set(), []
                for pg in self.pages:
                    for st, b in pg["stages"]:
                        key = json.dumps(b, sort_keys=True)
                        if st == u["per"] and key not in seen:
                            seen.add(key)
                            contexts.append(b)
            for b in contexts:
                row = dict(base)
                for f, spec in u["fields"].items():
                    try:   # earlier fields of the same row are readable by name
                        row[f] = self.ev({"expr": spec} if isinstance(spec, str) else spec,
                                         dict({k: v for k, v in row.items() if k not in base}, **b))
                    except ExprError as e:
                        raise ProtocolError("unit %s field %s: %s" % (name, f, e))
                rows.append(row)
            out[name] = rows
        return out


# --------------------------------------------------------------------------------------------- groups
class GroupSession:
    """A group of participants that act separately and meet at `sync` nodes (DESIGN §3.2).
    reset() / step(pid, answers) return {pid: State}; pending() lists who must act now."""

    def __init__(self, protocol, spec, shared):
        self.p = protocol
        self.spec = dict(spec)
        self.members = [Session(protocol, dict(spec, seed=_seed(spec["seed"], k), index="%s.%d" % (spec["index"], k)),
                                shared, pid="p%d" % (k + 1), group=self)
                        for k in range(int(spec["group_size"]))]

    def states(self):
        return {m.pid: m.state() for m in self.members}

    def pending(self):
        return [m.pid for m in self.members if m._page is not None]

    def _release(self):
        while True:
            live = [m for m in self.members if not (m.state() or {}).get("done")]
            if not live or not all(m._waiting for m in live):
                return
            ids = {(m._waiting["_sync"], json.dumps(m._waiting["bindings"], sort_keys=True)) for m in live}
            if len(ids) != 1:
                raise ProtocolError("group members wait at different barriers: %s" % sorted(ids))
            node = live[0]._waiting["node"]
            computed = []
            for m in live:   # compute everyone's values before anyone's vars change
                b = m._waiting["bindings"]
                vals = {k: m.ev({"expr": e}, b) for k, e in (node.get("compute") or {}).items()}
                evs = [m._text(e, dict(b, **vals))[0] for e in node.get("events", [])]
                computed.append((m, vals, evs))
            for m, vals, evs in computed:
                m.vars.update(vals)
                m.events.extend(evs)
                m._waiting = None
                try:
                    m._advance()
                except ExprError as e:
                    raise ProtocolError(str(e))

    def reset(self):
        for m in self.members:
            m.reset()
        self._release()
        return self.states()

    def step(self, pid, answers):
        m = next(x for x in self.members if x.pid == pid)
        st = m.step(answers)
        if st.get("error"):
            return dict(self.states(), **{pid: st})
        self._release()
        return self.states()


# --------------------------------------------------------------------------------------------- env
class Env:
    def __init__(self, protocol):
        self.p = protocol
        self.sessions = []
        self.shared = {}
        self.warnings = []

    def design(self, n="paper", seed=0, arms=None):
        """Session specs. n="paper": each arm's n_paper; n={arm: k}: exactly those; n=int: n per arm, except arms
        named in a `conditions[].ratio` ({arm: share}): those arms share n x (their number) sessions in the declared
        proportions (largest remainder, ties to the arm declared first), so design(n=1000) of a 2:1:1 design gives
        1500/750/750. Only the runnable, selected arms of a ratio share its sessions."""
        specs = []
        live = [a["id"] for a in self.p.arms if a.get("runnable") is not False and not (arms and a["id"] not in arms)]
        by_ratio = self._ratio_counts(n, live) if isinstance(n, int) and not isinstance(n, bool) else {}
        for arm in self.p.arms:
            if arm.get("runnable") is False or (arms and arm["id"] not in arms):
                continue
            k = arm.get("n_paper") if n == "paper" else (n.get(arm["id"], 0) if isinstance(n, dict) else
                                                         by_ratio.get(arm["id"], n))
            if k is None:
                raise ProtocolError("arm %s has no paper N" % arm["id"])
            gs = arm.get("group_size")
            for i in range(int(k)):
                spec = {"study": self.p.id, "arm": arm["id"], "index": i, "seed": _seed(seed, arm["id"], i)}
                if gs:
                    spec["group_size"] = int(gs)   # k counts groups for group arms
                specs.append(spec)
        return specs

    def _ratio_counts(self, n, live):
        out = {}
        for c in self.p.raw.get("conditions") or []:
            ratio = c.get("ratio") if isinstance(c, dict) else None
            if ratio is None:
                continue
            if not isinstance(ratio, dict) or not ratio or not all(
                    isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 for v in ratio.values()):
                raise ProtocolError("conditions %s: ratio must be {arm: positive share}" % c.get("id"))
            unknown = set(ratio) - {a["id"] for a in self.p.arms}
            if unknown:
                raise ProtocolError("conditions %s: ratio names unknown arms %s" % (c.get("id"), sorted(unknown)))
            ids = [a for a in live if a in ratio]
            if set(ids) & set(out):
                raise ProtocolError("arm %s is in two conditions ratios" % sorted(set(ids) & set(out)))
            if not ids:
                continue
            total = n * len(ids)
            w = sum(ratio[a] for a in ids)
            quota = [total * ratio[a] / w for a in ids]
            base = [int(math.floor(q + 1e-9)) for q in quota]
            order = sorted(range(len(ids)), key=lambda i: (-(quota[i] - base[i]), i))
            for i in order[: total - sum(base)]:
                base[i] += 1
            out.update(zip(ids, base))
        return out

    def asset_path(self, ref):
        return self.p._asset_paths.get(str(ref).replace("asset:", ""))

    def open(self, spec, allow_blocked=False):
        arm = next((a for a in self.p.arms if a["id"] == spec.get("arm")), None)
        if arm is not None and arm.get("runnable") is False and not allow_blocked:
            raise ProtocolError("arm %s is not runnable: %s" % (spec["arm"], arm.get("why") or arm.get("reason") or ""))
        if spec.get("group_size"):
            g = GroupSession(self.p, spec, self.shared)
            self.sessions.extend(g.members)   # records and units stay per participant
            return g
        s = Session(self.p, spec, self.shared)
        self.sessions.append(s)
        return s

    def records(self):
        return [s.record() for s in self.sessions if s.status]

    def unit_tables(self):
        out = {}
        done = [s for s in self.sessions if s.status]
        seen_groups = set()
        for s in done:   # per: group units — one row per group, evaluated in the first member's context
            if not s.group or id(s.group) in seen_groups:
                continue
            seen_groups.add(id(s.group))
            for name, u in self.p.units.items():
                if u.get("per") != "group":
                    continue
                if u.get("arms") and s.spec["arm"] not in u["arms"]:
                    continue   # a group unit scoped to some arms (as for per-session units)
                first = s.group.members[0]
                row = {"group": "%s:%s" % (s.spec["arm"], s.group.spec["index"]), "arm": s.spec["arm"],
                       "excluded": False, "size": len(s.group.members)}
                meta = set(row)
                for f, spec in u["fields"].items():   # earlier fields readable; row metadata is not (no shadowing)
                    row[f] = first.ev({"expr": spec} if isinstance(spec, str) else spec,
                                      {k: v for k, v in row.items() if k not in meta})
                out.setdefault(name, []).append(row)
        pop = self.population_exclusions(done)
        for s in done:
            key = "%s:%s" % (s.spec["arm"], s.spec["index"])
            for name, rows in s.units().items():
                for r in rows:
                    for ex in pop.get(key, []):
                        if ex["applies_to"] is None:
                            r["excluded"] = True
                        else:
                            r["excluded_for"] = sorted(set(r.get("excluded_for") or []) | set(ex["applies_to"]))
                out.setdefault(name, []).extend(rows)
        for name, u in self.p.units.items():
            for tr in u.get("trim") or []:
                self._trim(out.get(name, []), name, tr)
        return out

    def _trim(self, rows, unit, tr):
        """Row-level (trial) trimming computed on the analysed rows, e.g. 'trials outside the cell mean +- 3 IQR':
        {"id", "field", "group_by": [fields], "center": "mean"|"median", "spread": "iqr"|"sd", "k": 3,
         "fence": "center"|"quartiles"}. A trimmed row gets excluded_for [id, unit] (every analysis of the unit)."""
        cells = {}
        for r in rows:
            if r["excluded"] or not isinstance(r.get(tr["field"]), (int, float)) or isinstance(r.get(tr["field"]), bool):
                continue
            cells.setdefault(tuple(r.get(g) for g in tr.get("group_by", [])), []).append(r)
        k = float(tr.get("k", 3))
        for cell in cells.values():
            xs = sorted(r[tr["field"]] for r in cell)
            if len(xs) < 2:
                continue
            q1, q3 = _quantile(xs, 0.25), _quantile(xs, 0.75)
            if tr.get("spread", "iqr") == "iqr":
                spread = q3 - q1
            else:
                m_ = sum(xs) / len(xs)
                spread = math.sqrt(sum((x - m_) ** 2 for x in xs) / (len(xs) - 1))
            if tr.get("fence") == "quartiles":
                lo, hi = q1 - k * spread, q3 + k * spread
            else:
                c = sum(xs) / len(xs) if tr.get("center", "mean") == "mean" else _quantile(xs, 0.5)
                lo, hi = c - k * spread, c + k * spread
            for r in cell:
                x_ = r[tr["field"]]
                if (x_ <= lo or x_ >= hi) if tr.get("keep") == "open" else (x_ < lo or x_ > hi):   # open: R's lo < x < hi
                    r["excluded_for"] = sorted(set(r.get("excluded_for") or []) | {tr["id"], unit})

    def population_exclusions(self, sessions):
        """Exclusions whose cutoff is computed on the analysed sample (e.g. the paper's 'more than 3 SD above the
        mean across all conditions'): {"id", "population": {"values": expr -> list of numbers per session,
        "rule": "mean_plus_k_sd" | "mean_minus_k_sd", "k": 3, "two_sided": false}, "applies_to": [...]}."""
        out = {}
        for ex in self.p.exclusions:
            spec = ex.get("population")
            if not spec:
                continue
            per, grp = {}, {}
            after = set(spec.get("after_exclusions") or [])   # cutoff computed on the sample left by these rules
            for s in sessions:
                if s.status != "completed":
                    continue
                if after and after & set(s.record()["excluded"]):
                    continue
                try:
                    vals = s.ev({"expr": spec["values"]}, {})
                except ExprError as e:
                    raise ProtocolError("population exclusion %s: %s" % (ex.get("id"), e))
                key = "%s:%s" % (s.spec["arm"], s.spec["index"])
                per[key] = [v for v in (vals or []) if isinstance(v, (int, float))]
                grp[key] = str(s.ev({"expr": spec["group_by"]}, {})) if spec.get("group_by") else ""
            for gname in sorted(set(grp.values())):
              keys = [k_ for k_ in per if grp[k_] == gname]
              pooled = [v for k_ in keys for v in per[k_]]
              if len(pooled) < 2:
                  continue
              ran = {s.spec["arm"] for s in sessions}
              declared = {x["id"] for x in self.p.arms if x.get("runnable") is not False}
              if ran != declared and not spec.get("group_by"):   # a pooled rule only holds on the full design
                  self.warnings.append("population exclusion %s computed on arms %s, not the full design %s"
                                       % (ex.get("id"), sorted(ran), sorted(declared)))
              k = float(spec.get("k", 3))
              rule = spec.get("rule", "mean_plus_k_sd")
              if rule == "iqr_fence":   # Q1 - k*IQR, Q3 + k*IQR (two-sided); per_position: one fence per list index
                  def fence(xs):
                      xs = sorted(xs)
                      q1, q3 = _quantile(xs, 0.25), _quantile(xs, 0.75)
                      return q3 + k * (q3 - q1), q1 - k * (q3 - q1)
                  if spec.get("per_position"):
                      width = max(len(per[k_]) for k_ in keys)
                      fences = [fence([per[k_][i] for k_ in keys if i < len(per[k_])]) if
                                sum(1 for k_ in keys if i < len(per[k_])) >= 2 else (float("inf"), float("-inf"))
                                for i in range(width)]
                  else:
                      fences = None
                      hi, lo = fence(pooled)
              else:
                  m = sum(pooled) / len(pooled)
                  sd = math.sqrt(sum((v - m) ** 2 for v in pooled) / (len(pooled) - 1))
                  hi, lo = m + k * sd, m - k * sd
              for key in keys:
                vs = per[key]
                if rule == "iqr_fence":
                    fs = fences or [(hi, lo)] * len(vs)
                    bad = any(v > fs[i][0] or v < fs[i][1] for i, v in enumerate(vs))
                else:
                    bad = any((v > hi) if rule == "mean_plus_k_sd" else (v < lo) for v in vs)
                    if spec.get("two_sided"):
                        bad = any(v > hi or v < lo for v in vs)
                if bad:
                    out.setdefault(key, []).append({"id": ex["id"], "applies_to": ex.get("applies_to"),
                                                    "cutoff": None if rule == "iqr_fence" else
                                                    (hi if not rule == "mean_minus_k_sd" else lo)})
        return out


def _quantile(xs, q):   # linear interpolation (type 7, R/numpy default) on a sorted list
    pos = (len(xs) - 1) * q
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo)


def make(path):
    return Env(Protocol.load(path))
