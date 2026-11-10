#!/usr/local/bin/python3
"""One self-contained HTML file: the protocol as participants saw it, screen by screen, per arm.

    /usr/local/bin/python3 skills/preview/build_preview.py <study_id> [--arms a b ...] [--out file.html]
                                                           [--seed 1] [--tries N] [--max-image-kb 1500]

Sessions are played by the checker's own play() (keyed answers where the protocol declares them, else random
valid answers), exactly as skills/refinery-handback/preview.py does; per arm the completed session with most
screens is shown (all members of its group for group arms). Not-runnable arms are walked with allow_blocked.
Every screen is what the State carried; provenance marks come from the engine's internal page record, which
participants never see. All played sessions feed the operator-only "Conditions" view (which screens differ by
arm or by a flow variable, and how).

Output: no network references; CSP like the artifact kit (pack/artifact-kit/inline.py); images are data: URIs
(over --max-image-kb, or remote, they are omitted with a marker); clicks on an item post the kit's
{type:'hs.openSource', page, quote, programId, file} to the parent. Private protocol text: never publish it.
Engine files are not modified (the recorder patches Session._advance in this process only).
"""
import os
import argparse
import base64
import copy
import gzip
import hashlib
import html
import json
import mimetypes
import random
import re
import sys
import time
from pathlib import Path

SANDBOX = Path(__file__).resolve().parents[2]
HSENV = SANDBOX / "hsenv"
sys.path.insert(0, str(HSENV))
from hsenv.engine import Env, Protocol, Session  # noqa: E402
from hsenv.checks import play, random_answers  # noqa: E402

HERE = Path(__file__).resolve().parent
# Same policy as the artifact kit's inline.py: nothing leaves the frame.
CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; "
       "font-src data:; media-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'")
CITE_KEYS = ("label", "source", "page", "file", "evidence", "quote", "note", "read")
GZIP_OVER = 1_500_000          # data block bytes above which it is gzipped (DecompressionStream in the page)


# ------------------------------------------------------------------------------------------- recording
def slim_cite(c):
    if not isinstance(c, dict):
        return None
    out = {k: c[k] for k in CITE_KEYS if c.get(k) not in (None, "")}
    for k in ("quote", "note"):
        if isinstance(out.get(k), str) and len(out[k]) > 600:
            out[k] = out[k][:600] + "…"
    return out or None


def _text_cite(s, spec, b):
    """The cite a text value carries ({text, cite} literal or an expression into data), without side effects."""
    saved = s._last_spans, s.rng.getstate(), copy.deepcopy(s.shared)   # re-evaluation must not draw or count
    try:
        _, c = s._text(spec, b)
    except Exception:
        c = None
    s._last_spans = saved[0]
    s.rng.setstate(saved[1])
    s.shared.clear()
    s.shared.update(saved[2])
    return c


def _item_def(p, ref):
    stage, _, iid = ref.partition(".")
    st = p.stages.get(stage) or {}
    for it in st.get("content", []):
        if it.get("id") == iid:
            return st, it
    return st, {}


def _simple(v):
    if isinstance(v, (str, int, float, bool)) or v is None:
        return v if not isinstance(v, str) or len(v) <= 80 else v[:80] + "…"
    t = json.dumps(v, ensure_ascii=False, default=str)
    return t if len(t) <= 80 else t[:80] + "…"


def install_recorder():
    """Record each served State with its operator-side provenance (this process only)."""
    orig = Session._advance

    def rec(self):
        st = orig(self)
        if st.get("done") or st.get("waiting") or not self._page:
            return st
        pg, p = self._page, self.p
        items = {}
        for i in pg["internal"]:
            c = i.get("cite")
            stdef, idef = _item_def(p, i["ref"])
            if not isinstance(c, dict):
                c = idef.get("cite") or stdef.get("content_cite") or stdef.get("cite")
            items[i["id"]] = {"ref": i["ref"], "cite": slim_cite(c)}
        resps = {}
        for r in pg["responses"]:
            d, b = r["def"], r["bindings"]
            pc = _text_cite(self, d.get("prompt", ""), b) if d.get("prompt") is not None else None
            pc = pc or d.get("prompt_cite") or d.get("cite")
            ocite = {}
            rs, sh = self.rng.getstate(), copy.deepcopy(self.shared)
            try:
                raw_opts = self.ev(d["options"], b) if isinstance(d.get("options"), dict) else d.get("options") or []
            except Exception:
                raw_opts = []
            self.rng.setstate(rs)
            self.shared.clear()
            self.shared.update(sh)
            for o in raw_opts if isinstance(raw_opts, list) else []:
                if not isinstance(o, dict):
                    continue
                code = o.get("code")
                oc = _text_cite(self, o.get("label"), b) or o.get("cite")
                ocite[json.dumps(code, default=str)] = slim_cite(oc)
            resps[r["view"]["id"]] = {
                "ref": "%s.%s" % (r["stage"], d["id"]),
                "cite": slim_cite(pc),
                "instruction_cite": slim_cite((_text_cite(self, d["instruction"], b) if d.get("instruction") is not None
                                               else None) or d.get("instruction_cite")),
                "anchors_cite": slim_cite(d.get("anchors_cite")),
                "start_cite": slim_cite(d.get("start_cite")),
                "options_cite": slim_cite(d.get("options_cite")),
                "option_cites": {oc: ocite.get(json.dumps(code, default=str)) for oc, code in r["codes"].items()},
                "shuffled": bool(d.get("shuffle_options")),
                "shuffled_with_others": bool(p.stages[r["stage"]].get("shuffle_responses")),
                "hidden": [k for k in ("range", "start") if d.get(k + "_visible") is False],
                "validate": bool(d.get("validate")),
            }
        stages = []
        for n in pg["names"]:
            sd = p.stages[n]
            pres = sd.get("presentation") or {}
            stages.append({"name": n, "pres_cite": slim_cite(sd.get("presentation_cite") or pres.get("timing_cite")
                                                             or sd.get("timing_cite")),
                           "note": _simple(pres.get("note")) if pres.get("note") else None})
        log = self.__dict__.setdefault("_preview", [])
        log.append({"state": copy.deepcopy(st), "items": items, "resps": resps, "stages": stages,
                    "names": list(pg["names"]), "bindings": {k: _simple(v) for k, v in pg["bindings"].items()},
                    "vars": {k: _simple(v) for k, v in (self.vars or {}).items()}})
        return st
    Session._advance = rec


def blocked_session(p, arm, seed):
    """A not-runnable arm, walked with random answers (as refinery-handback/preview.py)."""
    env = Env(p)
    s = env.open({"study": p.id, "arm": arm["id"], "index": 0, "seed": seed}, allow_blocked=True)
    if arm.get("group_size"):
        return None
    rng, state, n = random.Random(seed), s.reset(), 0
    while not state.get("done") and not state.get("waiting") and n < 2000:
        n += 1
        nxt = state
        for _ in range(200):
            nxt = s.step(random_answers(state, rng))
            if not nxt.get("error"):
                break
        if nxt.get("error"):
            break
        state = nxt
    return s


# ------------------------------------------------------------------------------------------- building
class Builder:
    def __init__(self, p, max_image_bytes):
        self.p = p
        self.screens = {}     # content key -> screen content (shared by arms / sessions)
        self.images = {}      # asset ref -> {"uri"} | {"omitted": reason}
        self.max_image = max_image_bytes
        self.image_budget = 1_800_000   # raw bytes; base64 adds a third, the kit caps files at 3 MB

    def image(self, ref):
        if ref in self.images:
            return
        if ref.startswith(("http://", "https://")):
            self.images[ref] = {"omitted": "remote image (not loaded: the preview works offline)", "why": "remote", "url": ref}
            return
        path = self.p._asset_paths.get(ref.replace("asset:", ""))
        if not path or not Path(path).is_file():
            self.images[ref] = {"omitted": "image file not found in the study folder", "why": "notfound"}
            return
        data = Path(path).read_bytes()
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if not mime.startswith("image/"):
            self.images[ref] = {"omitted": "not an image file (%s)" % Path(path).suffix, "why": "notimage",
                                "why_arg": Path(path).suffix}
        elif len(data) > self.max_image or len(data) > self.image_budget:
            why = ("image too large to embed (%d KB)" % (len(data) // 1024) if len(data) > self.max_image else
                   "image budget of this preview used up (%d KB image; earlier images filled the 1.8 MB budget)"
                   % (len(data) // 1024))
            self.images[ref] = {"omitted": why, "why": "toolarge" if len(data) > self.max_image else "budget",
                                "why_arg": len(data) // 1024, "file": Path(path).name}
        else:
            self.image_budget -= len(data)
            self.images[ref] = {"uri": "data:%s;base64,%s" % (mime, base64.b64encode(data).decode("ascii")),
                                "file": Path(path).name}

    def screen(self, rec):
        st = rec["state"]
        scr = st["screen"]
        items = []
        for it in scr["items"]:
            x = {k: v for k, v in it.items() if k != "id"}
            x["id"] = it["id"]
            x.update(rec["items"].get(it["id"], {}))
            if isinstance(it.get("src"), str):
                self.image(it["src"])
            items.append(x)
        resps = []
        for rv in scr["responses"]:
            x = dict(rv)
            meta = rec["resps"].get(rv["id"], {})
            x.update({k: v for k, v in meta.items() if v not in (None, False, [], {})})
            resps.append(x)
        content = {"items": items, "responses": resps, "order": scr.get("order"),
                   "button": scr.get("button"),
                   "timing": st.get("timing") or {}, "navigation": st.get("navigation") or {},
                   "names": rec["names"], "stages": rec["stages"]}
        key = hashlib.sha1(json.dumps(content, sort_keys=True, ensure_ascii=False,
                                      default=str).encode()).hexdigest()[:12]
        self.screens.setdefault(key, content)
        return key

    def fingerprint(self, key):
        """Content as seen, ignoring option order (shuffles) and opaque ids."""
        c = self.screens[key]
        parts = []
        for it in c["items"]:
            parts.append(json.dumps([it.get("text"), it.get("src"), it.get("lines"), it.get("rows"),
                                     it.get("spans"), it.get("style")], ensure_ascii=False, default=str))
        for r in c["responses"]:
            opts = [json.dumps([o.get("label"), o.get("spans")], ensure_ascii=False) for o in r.get("options") or []]
            if r.get("shuffled"):   # a declared per-participant shuffle is not a condition difference
                opts = sorted(opts)
            parts.append(json.dumps([r.get("kind"), r.get("widget"), r.get("prompt"), r.get("prompt_spans"),
                                     r.get("instruction"), opts, r.get("range"), r.get("anchors"), r.get("start"),
                                     r.get("prefill")], ensure_ascii=False, default=str))
        ids = {x["id"]: n for n, x in enumerate(c["items"])}
        ids.update({x["id"]: "r%d" % n for n, x in enumerate(c["responses"])})
        shuffled_q = any(r.get("shuffled_with_others") for r in c["responses"])
        layout = [str(ids.get(o, o)) for o in c.get("order") or []]
        parts.append(json.dumps([c.get("button"), c.get("timing"), c.get("navigation"),
                                 sorted(layout) if shuffled_q else layout], default=str))
        return hashlib.sha1("\n".join(parts).encode()).hexdigest()[:12]


def flow_names(flow):
    """Loop variables (identify which item a screen is about) and other flow variables (set/let)."""
    loops, others = set(), set()

    def walk(n):
        if isinstance(n, list):
            for x in n:
                walk(x)
        elif isinstance(n, dict):
            if "for" in n and isinstance(n["for"], str):
                loops.add(n["for"])
                others.add(n["for"] + "_index")
                others.update((n.get("let") or {}).keys())
            if "loop" in n:
                others.add(n.get("as", "i"))
            if "set" in n and isinstance(n["set"], dict):
                others.update(n["set"].keys())
            for v in n.values():
                walk(v)
    walk(flow)
    return loops, others


def static_dependencies(p, flow_vars):
    """Per stage: the flow variables and 'arm' its expressions read (complete, unlike sampled sessions)."""
    names = set(flow_vars) | {"arm", "my_index", "attempt"}
    out = {}
    for sn, st in p.stages.items():
        exprs = []

        def walk(o):
            if isinstance(o, dict):
                for k, v in o.items():
                    if k in ("expr", "if") and isinstance(v, str):
                        exprs.append(v)
                    elif not k.endswith("cite") and k not in ("note",):
                        walk(v)
            elif isinstance(o, list):
                for v in o:
                    walk(v)
        walk({k: v for k, v in st.items() if k in ("content", "responses", "presentation")})
        toks = set()
        for e in exprs:
            toks.update(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", re.sub(r"(['\"]).*?\1", "", e)))
            if re.search(r"answer\w*\(", e):
                toks.add("earlier answers")
        used = sorted(t for t in toks if t in names) + (["earlier answers"] if "earlier answers" in toks else [])
        if used:
            out[sn] = used
    return out


def explain(contexts, variants):
    """Which single key (or pair) determines the variant across the observed contexts."""
    keys = sorted({k for c in contexts for k in c["ctx"]})

    def determines(ks):
        """True when the key(s) map to one variant each, take >1 value, and some value recurs (a key unique to every
        context, e.g. a per-session random order, 'explains' anything and is rejected)."""
        seen, count = {}, {}
        for c in contexts:
            v = tuple(json.dumps(c["ctx"].get(k), default=str) for k in ks)
            count[v] = count.get(v, 0) + 1
            if seen.setdefault(v, c["variant"]) != c["variant"]:
                return False
        return len(count) > 1 and max(count.values()) > 1
    singles = [k for k in keys if determines([k])]
    if singles:
        pref = [k for k in singles if k == "arm"] or [k for k in singles if k != "participant"] or singles
        return [pref[0]]
    for i, a in enumerate(keys):
        for b_ in keys[i + 1:]:
            if determines([a, b_]):
                return [a, b_]
    return []


def build(study, arms_filter, seed, tries, max_image_kb):
    sd = HSENV / "studies" / study
    if not (sd / "protocol.json").is_file():
        sys.exit("no protocol: %s" % (sd / "protocol.json"))
    p = Protocol.load(str(sd))
    arms = [a for a in p.arms if not arms_filter or a["id"] in arms_filter]
    unknown = set(arms_filter or []) - {a["id"] for a in p.arms}
    if unknown:
        sys.exit("unknown arm(s): %s (arms: %s)" % (", ".join(sorted(unknown)), ", ".join(a["id"] for a in p.arms)))
    install_recorder()
    runnable = [a for a in arms if a.get("runnable") is not False]
    if tries is None:   # keep big multi-arm protocols to a few minutes
        tries = max(2, min(8, 40 // max(1, len(runnable))))
    policy = "keyed" if (p.raw.get("keyed") or {}).get("answers") else "random"
    t0 = time.time()
    problems, sessions = [], []
    if runnable:
        env, problems, _ = play(p, {a["id"]: tries for a in runnable}, seed, policy)
        sessions = list(env.sessions)
    blocked = {}
    for a in arms:
        if a.get("runnable") is False:
            try:
                blocked[a["id"]] = blocked_session(p, a, seed)
            except Exception as e:  # a finding, not a crash
                blocked[a["id"]] = e
    B = Builder(p, max_image_kb * 1024)

    # one shown session per arm (and its group members)
    def group_of(s):
        return s.group.members if getattr(s, "group", None) is not None else [s]
    shown, arm_out = {}, []
    for a in arms:
        entry = {"id": a["id"], "n_paper": a.get("n_paper"), "what": a.get("what"),
                 "language": a.get("language") or (p.raw.get("meta") or {}).get("language"),
                 "group_size": a.get("group_size"), "runnable": a.get("runnable") is not False,
                 "reason": a.get("not_runnable_reason") or a.get("why") or a.get("reason"),
                 "release_hold": a.get("release_hold"), "derived_on_screen": a.get("derived_on_screen"),
                 "assignment": a.get("assignment") if isinstance(a.get("assignment"), str) else None,
                 "cite": slim_cite(a.get("cite")), "participants": []}
        if a.get("runnable") is False:
            s = blocked.get(a["id"])
            members = [] if s is None or isinstance(s, Exception) else [s]
            if isinstance(s, Exception):
                entry["error"] = "%s: %s" % (type(s).__name__, s)
            policy_used = "random"
        else:
            cands = [s for s in sessions if s.spec["arm"] == a["id"] and s.pid == "p1"]
            best = max(cands, key=lambda s: (s.status == "completed", len(getattr(s, "_preview", []))), default=None)
            members = group_of(best) if best is not None else []
            policy_used = policy
        for s in members:
            shown[id(s)] = True
            entry["participants"].append({
                "pid": s.pid, "status": s.status or "stopped", "policy": policy_used,
                "screens": [{"key": B.screen(r), "step": r["state"]["step"],
                             "events": r["state"].get("events") or [],
                             "reviewable": sum(1 for x in r["state"].get("seen") or [] if x.get("reviewable")),
                             "bindings": r["bindings"]} for r in getattr(s, "_preview", [])]})
        arm_out.append(entry)

    # conditions: every played screen, grouped by stage names + loop item
    loops, others = flow_names(p.flow)
    groups = {}
    all_sessions = list(sessions) + [s for s in blocked.values() if isinstance(s, Session)]
    for s in all_sessions:
        if arms_filter and s.spec["arm"] not in arms_filter:
            continue
        for r in getattr(s, "_preview", []):
            item = {k: r["bindings"][k] for k in sorted(loops) if k in r["bindings"]}
            sig = json.dumps([r["names"], item], ensure_ascii=False, default=str)
            key = B.screen(r)
            ctx = {"arm": s.spec["arm"]}
            if getattr(s, "group", None) is not None:
                ctx["participant"] = s.pid
            ctx.update({k: v for k, v in r["bindings"].items() if k not in loops})
            ctx.update({k: v for k, v in r["vars"].items() if k not in ctx})
            g = groups.setdefault(sig, {"names": r["names"], "item": item, "variants": {}, "contexts": [],
                                        "first": len(groups), "sessions": set()})
            g["sessions"].add(id(s))
            fp = B.fingerprint(key)
            v = g["variants"].setdefault(fp, {"key": key, "arms": set(), "n": 0})
            v["arms"].add(s.spec["arm"])
            v["n"] += 1
            g["contexts"].append({"ctx": ctx, "variant": fp})
    differ, same, partial, sometimes = [], 0, {}, 0
    # not-runnable arms are walked with random answers and may stop early: they do not decide "only in" lists
    played = [s for s in all_sessions if getattr(s, "_preview", None) and (not arms_filter or s.spec["arm"] in arms_filter)
              and s.status == "completed"]
    played_arms = sorted({s.spec["arm"] for s in played})
    arm_sessions = {a: {id(s) for s in played if s.spec["arm"] == a} for a in played_arms}
    for sig, g in sorted(groups.items(), key=lambda kv: kv[1]["first"]):
        in_arms = sorted({a for v in g["variants"].values() for a in v["arms"]})
        # arm-specific only when every played session of those arms showed it (else: random draw / answers)
        in_arms = [a for a in in_arms if a in arm_sessions]   # only completed sessions decide "only in"
        always = bool(in_arms) and all(arm_sessions[a] <= g["sessions"] for a in in_arms)
        if len(played_arms) > 1 and len(in_arms) < len(played_arms) and not always:
            sometimes += 1
        elif len(played_arms) > 1 and len(in_arms) < len(played_arms):
            ent = partial.setdefault("|".join(in_arms), {"arms": in_arms, "screens": []})
            ent["screens"].append({"names": g["names"], "item": g["item"],
                                   "keys": [v["key"] for v in g["variants"].values()][:4]})
        if len(g["variants"]) < 2:
            same += 1
            continue
        by = explain(g["contexts"], g["variants"])
        vlist = []
        for fp, v in g["variants"].items():
            vals = {}
            for c in g["contexts"]:
                if c["variant"] == fp:
                    for k in by:
                        vals.setdefault(k, set()).add(json.dumps(c["ctx"].get(k), ensure_ascii=False, default=str))
            vlist.append({"key": v["key"], "arms": sorted(v["arms"]), "n": v["n"],
                          "when": {k: sorted(x) for k, x in vals.items()}})
        vlist.sort(key=lambda v: (-len(v["arms"]), -v["n"]))
        differ.append({"names": g["names"], "item": g["item"], "by": by, "variants": vlist, "in_arms": in_arms})
    shown_keys = {sc["key"] for a in arm_out for pp in a["participants"] for sc in pp["screens"]}
    partial = sorted(partial.values(), key=lambda e: (len(e["arms"]), e["arms"]))
    used_keys = shown_keys | {v["key"] for d in differ for v in d["variants"]} | \
        {k for e in partial for x in e["screens"] for k in x["keys"]}
    screens = {k: v for k, v in B.screens.items() if k in used_keys}
    images = {}
    for k in used_keys:
        for it in screens[k]["items"]:
            if isinstance(it.get("src"), str):
                images[it["src"]] = B.images.get(it["src"])
    meta = p.raw.get("meta") or {}
    data = {
        "study": p.id, "title": meta.get("title") or None, "version": p.version, "citation": meta.get("citation"), "language": meta.get("language"),
        "built": time.strftime("%Y-%m-%d %H:%M"), "seed": seed, "tries": tries, "policy": policy,
        "engine_problems": [str(x)[:300] for x in problems[:8]],
        "arms": arm_out, "screens": screens, "images": images,
        "conditions": {"differ": differ, "same": same, "partial": partial, "played_arms": played_arms, "sometimes": sometimes,
                       "sessions": len(all_sessions),
                       "static": static_dependencies(p, others | loops), "loops": sorted(loops)},
        "seconds": round(time.time() - t0, 1),
    }
    return data


# ------------------------------------------------------------------------------------------- page
UI_LANGS = ("en", "zh")
PAGE_TXT = {"en": {"title": "Participant preview — %s", "loading": "Loading preview…"},
            "zh": {"title": "参与者预览 — %s", "loading": "正在加载预览…"}}


def ui_lang(lang=None):
    """'en' or 'zh' from an app UI language such as 'zh-CN' or 'en-US' (default: env HS_UI_LANG, else 'en')."""
    lang = (lang or os.environ.get("HS_UI_LANG") or "en").strip().lower().replace("_", "-")
    return "zh" if lang.startswith("zh") else "en"


def page(data, lang=None):
    """The HTML page. lang: the UI language of the page's own words ('en' default, 'zh'); the participant's
    screens keep the protocol's language."""
    lang = ui_lang(lang)
    raw = json.dumps(data, ensure_ascii=False, separators=(",", ":"), default=str)
    if len(raw.encode()) > GZIP_OVER:
        blob = base64.b64encode(gzip.compress(raw.encode("utf-8"), 9)).decode("ascii")
        block = '<script type="application/json" id="hs-preview" data-encoding="gzip+base64">"%s"</script>' % blob
    else:
        safe = raw.replace("<", "\\u003c")   # no markup of any kind inside the data block
        block = '<script type="application/json" id="hs-preview">%s</script>' % safe
    css = (HERE / "preview.css").read_text("utf-8")
    js = (HERE / "preview.js").read_text("utf-8").replace("</script", "<\\/script")
    title = PAGE_TXT[lang]["title"] % (data.get("title") or data["study"])
    return ("<!doctype html>\n<html lang=\"%s\" data-ui-lang=\"%s\">\n<head>\n<meta charset=\"utf-8\">\n"
            '<meta http-equiv="Content-Security-Policy" content="%s">\n'
            '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
            '<meta name="hs-artifact" content="participant-preview">\n'
            "<title>%s</title>\n<style>\n%s</style>\n</head>\n<body>\n"
            '<div class="hs-page" id="app"><p class="hs-sub">%s</p></div>\n'
            "%s\n<script>\n%s</script>\n</body>\n</html>\n") % (lang, lang, CSP, html.escape(title), css,
                                                               PAGE_TXT[lang]["loading"], block, js)


def kit_module():
    """The artifact kit's inline.py, when installed: env HS_ARTIFACT_KIT, or a sibling artifact-kit folder
    (pack/skills/preview -> pack/artifact-kit; project .opencode/skills/preview -> .opencode/artifact-kit)."""
    here = Path(__file__).resolve().parent
    cands = [Path(os.environ["HS_ARTIFACT_KIT"]) / "inline.py"] if os.environ.get("HS_ARTIFACT_KIT") else []
    cands += [here.parent.parent / "artifact-kit" / "inline.py", here.parent / "artifact-kit" / "inline.py"]
    kit = next((c for c in cands if c.is_file()), None)
    if kit is None:
        return None
    import importlib.util
    spec = importlib.util.spec_from_file_location("hs_inline", kit)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def protocol_mode(mod):
    """The kit checks protocol artifacts against protocol.json (inline.py protocol mode, desktop v0.8)."""
    import inspect
    return mod is not None and "protocol" in inspect.signature(mod.inline).parameters


def finish(text, protocol_path, mod=None):
    """-> (page, problems). With a protocol-mode kit, the page gets the protocol's identity block (ids and SHA-256,
    never screen text) and is checked against protocol.json; with an older kit, the kit's offline check alone."""
    mod = kit_module() if mod is None else mod
    probs = []
    if mod is not None:
        if protocol_mode(mod):
            raw = Path(protocol_path).read_bytes()
            protocol = json.loads(raw.decode("utf-8"))
            text = mod.inline(text, None, (protocol, hashlib.sha256(raw).hexdigest()))
            probs, _ = mod.check(text, None, protocol)
        else:
            probs, _ = mod.check(text, None)
        probs = [x for x in probs if "kit script missing" not in x]
    if re.search(r"<(?:img|script|link|iframe)\b[^>]*\b(?:src|href)=[\"'](?!data:)", text, re.I):
        probs.append("an element loads a non-data URL")
    return text, probs


def main(argv=None):
    if sys.version_info < (3, 11):
        sys.exit("needs Python 3.11+; use /usr/local/bin/python3 (LESSONS 286)")
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("study")
    ap.add_argument("--arms", nargs="+", help="only these arms (default: all)")
    ap.add_argument("--out", help="output .html (default: hsenv/studies/<id>/preview/preview.html)")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--tries", type=int, default=None,
                    help="sessions per runnable arm (default: 2-8, fewer when there are many arms)")
    ap.add_argument("--max-image-kb", type=int, default=1500, help="embed images up to this size")
    ap.add_argument("--lang", default=None,
                    help="language of the page's own words: en (default) or zh; zh-CN etc. accepted (env HS_UI_LANG)")
    a = ap.parse_args(argv)
    data = build(a.study, a.arms, a.seed, a.tries, a.max_image_kb)
    out = Path(a.out) if a.out else HSENV / "studies" / a.study / "preview" / "preview.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    text, probs = finish(page(data, a.lang), HSENV / "studies" / a.study / "protocol.json")
    out.write_text(text, encoding="utf-8")
    n_scr = sum(len(pp["screens"]) for arm in data["arms"] for pp in arm["participants"])
    omitted = sum(1 for v in data["images"].values() if v and v.get("omitted"))
    print("%s %s — %d arm(s), %d screens shown, %d screens differ by condition, %d image(s)%s, %d KB, %.0fs"
          % ("FAIL" if probs else "PASS", out, len(data["arms"]), n_scr, len(data["conditions"]["differ"]),
             len(data["images"]), " (%d omitted)" % omitted if omitted else "", len(text.encode()) // 1024,
             data["seconds"]))
    for arm in data["arms"]:
        for pp in arm["participants"]:
            if arm["runnable"] and pp["status"] != "completed":
                print("  finding: arm %s %s did not complete (%s)" % (arm["id"], pp["pid"], pp["status"]))
        if not arm["participants"]:
            print("  finding: arm %s has no session to show%s" % (arm["id"], " (" + arm["error"] + ")" if arm.get("error") else ""))
    for x in data["engine_problems"]:
        print("  engine problem: " + x)
    for x in probs:
        print("  - " + x)
    return 1 if probs else 0


if __name__ == "__main__":
    sys.exit(main())
