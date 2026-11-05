#!/usr/bin/env python3
"""What each prompt carries: instruction screens before scored questions, rules in later rounds, identical arms.

check_validity.py runs the package with a stand-in model (sandbox_run.py, no network) and calls these
rules on what was sent. Every model call is stateless: a participant model sees only the prompt of that
call, so whatever an original participant had read before a question must be in the prompt itself.

  screens       instruction-sized verbatim texts of program.json material nodes (origin verbatim, at least
                SCREEN_WORDS words), ordered by the program's steps (children and `next` in order) and tagged
                with the steps' actorIds. A text shown only inside `branch` steps is a variant (one version per
                participant) and is never required. A screen is "in" a prompt when most of its sentences are.
  keyed         a question with an answer key (a comprehension quiz, an attention check: replies.Question
                key=...) is asked with the instruction screens that come before it in the program's flow and
                that this run shows the same participants anywhere (an instruction screen shown only after the
                quiz still counts: the participant read it before). The stand-in answers keys correctly, so the
                run gets past the quiz.
  rounds        a question asked again and again (the same question id: a contribution, a rating) keeps every
                instruction screen it was asked with in all its earlier asks (at least two): the rules of round 1 are still
                the rules of round 11 (a later part's screen that says "as in the first part" does not
                restate them).
  arms          two arms whose stand-in runs send identical prompts are the same simulation. An effect of
                effects.json that contrasts them (its treatment and reference name those arms, by arm id,
                task.json label or program condition node) cannot be tested by the replay.

Declarations (materials/materials.json, top-level "screenMemory"), each with evidenceIds of program.json:
  {"notCarried": [{"screen": "<material node id>", "reason": "...", "evidenceIds": ["ev-.."]}],
   "repeats":    [{"screen": "<material node id>", "text": "<the rule text the paper shows on the later
                   screen>", "evidenceIds": ["ev-.."]}]}
`notCarried`: the paper says participants could not see that screen again (later rounds need not carry it; a
keyed question still does, since the participant had read it just before). `repeats`: a prompt that contains `text` counts as carrying that screen.
For arms: capabilities.json `run.excluded` entry {"what", "reason", "effects": [<effect ids>]} marks an effect
not testable by the replay (a population difference is not a manipulation); a persona or population
difference that the adapter actually writes into the prompt makes the arms differ, and the rule does not fire.

Limits (heuristics): only screens transcribed into program.json material nodes are known; a rule text written
only in the adapter is not. "Same participants" is read from the steps' actorIds (no actors: everyone). A
screen whose text is shown only to other arms never counts, because each arm is read from its own run.
Identical prompts are judged on one deterministic stand-in run per arm that finished below the call cap (a
run stopped at the cap may differ later, as a debriefing in session 4 does): an adapter that randomises per arm
id, or a task too long for the cap, is never flagged. Standard library.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_quotes  # noqa: E402
import check_verbatim  # noqa: E402

SCREEN_WORDS = 25        # a material text at least this long is an instruction-sized screen
SHOWN = 0.6              # share of a screen's sentences a prompt must contain to show it
MAX_FINDINGS = 4


def _obj(value):
    return value if isinstance(value, dict) else {}


def _text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(_text(v) for v in value)
    if isinstance(value, dict):
        return "\n".join(_text(v) for k, v in value.items() if not re.search(r"(?i)id$|page|evidence|source", str(k)))
    return ""


def flow_order(program):
    """{step id: position}: depth first from the steps no other step contains or leads to, children then next."""
    steps = [s for s in program.get("steps") or [] if isinstance(s, dict) and isinstance(s.get("id"), str)]
    by_id = {s["id"]: s for s in steps}
    inner = {c for s in steps for c in s.get("children") or [] if isinstance(c, str)}
    inner |= {n.get("to") for s in steps for n in s.get("next") or [] if isinstance(n, dict)}
    order = {}

    def visit(sid):
        if sid in order or sid not in by_id:
            return
        order[sid] = len(order)
        s = by_id[sid]
        for c in s.get("children") or []:
            visit(c)
        for n in s.get("next") or []:
            if isinstance(n, dict):
                visit(n.get("to"))
    for s in steps:
        if s["id"] not in inner:
            visit(s["id"])
    for s in steps:
        visit(s["id"])
    return order


def branch_steps(program):
    """Step ids inside a `branch` step (its children and their descendants): one alternative per participant."""
    steps = {s.get("id"): s for s in program.get("steps") or [] if isinstance(s, dict)}
    inside, todo = set(), [c for s in steps.values() if s.get("kind") == "branch" for c in s.get("children") or []]
    while todo:
        sid = todo.pop()
        if sid in inside or sid not in steps:
            continue
        inside.add(sid)
        todo += list(steps[sid].get("children") or [])
    return inside


def screens(program):
    """{node id: {"segments", "position", "actors", "variant"}} for instruction-sized verbatim material texts.
    A screen shown only inside `branch` steps (or the branch step itself) is a variant: another participant may see
    another one, so it is never required of a prompt."""
    order = flow_order(program)
    branches = branch_steps(program) | {s.get("id") for s in program.get("steps") or []
                                        if isinstance(s, dict) and s.get("kind") == "branch"}
    where, actors, fixed = {}, {}, set()
    for s in program.get("steps") or []:
        if not isinstance(s, dict) or s.get("id") not in order:
            continue
        for mid in list(s.get("visibleIds") or []) + list(s.get("inputIds") or []):
            if isinstance(mid, str):
                where[mid] = min(where.get(mid, 10 ** 9), order[s["id"]])
                actors.setdefault(mid, set()).update(a for a in s.get("actorIds") or [] if isinstance(a, str))
                if s["id"] not in branches:
                    fixed.add(mid)
    out = {}
    for n in program.get("nodes") or []:
        if not isinstance(n, dict) or n.get("kind") not in ("material", "materials") or not isinstance(n.get("id"), str):
            continue
        text = "\n".join(_text(f.get("value")) for f in n.get("fields") or []
                         if isinstance(f, dict) and f.get("origin") == "verbatim")
        segs = [p for p in check_verbatim.segments(text) if len(p.split()) >= 3]
        if len(" ".join(segs).split()) < SCREEN_WORDS:
            continue
        out[n["id"]] = {"segments": sorted(set(segs)), "position": where.get(n["id"]),
                        "actors": sorted(actors.get(n["id"], ())),
                        "variant": n["id"] in where and n["id"] not in fixed}
    return out


def declarations(materials):
    memo = _obj(_obj(materials).get("screenMemory"))
    keep = lambda key: [d for d in memo.get(key) or [] if isinstance(d, dict) and isinstance(d.get("screen"), str)]
    return {"notCarried": keep("notCarried"), "repeats": keep("repeats")}


def probes(program, materials):
    """{probe id: normalised segments}: every screen, and each declared repeat text as "repeat:<screen>"."""
    out = {sid: s["segments"] for sid, s in screens(program).items()}
    for d in declarations(materials)["repeats"]:
        segs = [p for p in check_verbatim.segments(str(d.get("text") or "")) if len(p.split()) >= 3]
        if segs:
            out["repeat:" + d["screen"]] = segs
    return out


def present(prompt, table):
    """Probe ids whose text the prompt shows (at least SHOWN of the sentences)."""
    flat = " " + check_quotes.normalise(prompt) + " "
    return sorted(pid for pid, segs in table.items()
                  if segs and sum(1 for s in segs if " %s " % s in flat) >= SHOWN * len(segs))


def digest(prompts):
    """One hash of the prompts of a run, in order: identical arms send identical sequences."""
    h = hashlib.sha256()
    for p in prompts:
        h.update(p.encode("utf-8", "replace") + b"\x00")
    return h.hexdigest()


# ---- the rules ----------------------------------------------------------------------------------------

def _carried(shown, screen):
    return screen in shown or ("repeat:" + screen) in shown


def _same_people(a, b, table):
    x, y = set(table.get(a, {}).get("actors") or ()), set(table.get(b, {}).get("actors") or ())
    return not x or not y or bool(x & y)


def _label(run):
    return "arm %s" % run["arms"][0] if run.get("arms") else "the default run"


def _own_screen(call, table):
    own = [s for s in call.get("s") or [] if s in table and table[s].get("position") is not None]
    return max(own, key=lambda s: table[s]["position"]) if own else None


def quiz_screens(run, table):
    """Screens that hold a keyed question (the quiz itself): an earlier quiz is not an instruction a later one needs."""
    return {m for c in run.get("calls_meta") or [] if c.get("k") for m in [_own_screen(c, table)] if m}


def keyed_gaps(run, table, skip=()):
    """[(where, question ids, missing screens)]: a keyed question asked without the screens before it."""
    calls = run.get("calls_meta") or []
    skip = set(skip) | quiz_screens(run, table)
    shown_any = {s for c in calls for s in c.get("s") or [] if not s.startswith("repeat:")}
    out, seen = [], set()
    for i, c in enumerate(calls):
        if not c.get("k"):
            continue
        here = set(c.get("s") or [])
        mine = _own_screen(c, table)
        if mine is None:
            continue
        need = sorted(s for s in shown_any if s in table and s not in skip and not table[s].get("variant")
                      and table[s].get("position") is not None
                      and table[s]["position"] < table[mine]["position"] and not _carried(here, s)
                      and _same_people(s, mine, table))
        key = (tuple(c.get("q") or ()), tuple(need))
        if need and key not in seen:
            seen.add(key)
            out.append(("%s call %d" % (_label(run), i + 1), [q.split("#", 1)[0] for q in c.get("q") or []], need))
    return out


def round_gaps(run, table, skip=()):
    """[(where, question id, dropped screens)]: a repeated question asked without a screen that was in every one of
    its earlier asks (at least two). A stimulus that changes from trial to trial is in no such set."""
    calls = run.get("calls_meta") or []
    skip = set(skip) | quiz_screens(run, table)
    context, asks, out, done = {}, {}, [], set()
    for i, c in enumerate(calls):
        here = {s for s in c.get("s") or [] if not s.startswith("repeat:")}
        for q in c.get("q") or []:
            if asks.get(q, 0) >= 2 and q not in done:
                mine = [s for s in here if s in table]
                dropped = sorted(s for s in context.get(q, ()) if s in table and s not in skip
                                 and not _carried(set(c.get("s") or []), s)
                                 and (not mine or any(_same_people(s, m, table) for m in mine)))
                if dropped:
                    done.add(q)
                    out.append(("%s call %d" % (_label(run), i + 1), q.split("#", 1)[0], dropped))
            context[q] = set(here) if q not in context else context[q] & here
            asks[q] = asks.get(q, 0) + 1
    return out


def declaration_problems(materials, program):
    """Declarations need a known screen, a reason or text, and evidence ids of program.json."""
    evidence = {e.get("id") for e in program.get("evidence") or [] if isinstance(e, dict)}
    nodes = {n.get("id") for n in program.get("nodes") or [] if isinstance(n, dict)}
    out = []
    for kind, need in (("notCarried", "reason"), ("repeats", "text")):
        for d in declarations(materials)[kind]:
            where = "materials.json screenMemory.%s %s" % (kind, d.get("screen"))
            if d["screen"] not in nodes:
                out.append(("%s: %r is not a program.json material node" % (where, d["screen"]),
                            "name the material node whose text is (not) carried"))
            if not str(d.get(need) or "").strip():
                out.append(("%s: `%s` is empty" % (where, need), "say it in the paper's words"))
            ids = [i for i in d.get("evidenceIds") or [] if isinstance(i, str)]
            if not ids or any(i not in evidence for i in ids):
                out.append(("%s: needs evidenceIds of program.json evidence (the paper's own statement)" % where,
                            "cite the quote that says the screen was not visible again, or that the later screen "
                            "printed this text"))
    return out


# ---- arms --------------------------------------------------------------------------------------------

def arm_lookup(task, program_arms=()):
    """{name (case folded): {arm ids}}: arm ids, task.json condition labels, and their program condition nodes."""
    out = {}
    conditions = _obj(task).get("conditions") or []
    if isinstance(conditions, dict):
        conditions = [dict(v, id=k) if isinstance(v, dict) else {"id": k} for k, v in conditions.items()]
    for c in conditions:
        if not isinstance(c, dict) or not isinstance(c.get("id"), str):
            continue
        names = [c["id"], c.get("label")] + list(c.get("programNodes") or [])
        for name in names:
            if isinstance(name, str) and name.strip():
                out.setdefault(name.strip().casefold(), set()).add(c["id"])
    for arm in program_arms:
        out.setdefault(arm.casefold(), set()).add(arm)
    return out


def identical_contrasts(effects, task, arm_runs, excluded):
    """[(effect id, treatment arms, reference arms)]: effects whose two sides send identical prompts.

    arm_runs: {arm id: digest} (only arms whose own run finished or reached the call cap).
    excluded: effect ids that capabilities.json run.excluded marks as not testable by the replay."""
    lookup = arm_lookup(task, arm_runs)
    out = []
    for e in _obj(effects).get("effects") or []:
        if not isinstance(e, dict) or e.get("id") in excluded:
            continue
        con = _obj(e.get("contrast"))
        sides = []
        for key in ("treatment", "reference"):
            name = con.get(key)
            sides.append(lookup.get(name.strip().casefold(), set()) if isinstance(name, str) else set())
        t, r = sides
        if not t or not r or t == r or t & r or not all(a in arm_runs for a in t | r):
            continue
        if {arm_runs[a] for a in t} == {arm_runs[a] for a in r}:
            out.append((e.get("id"), sorted(t), sorted(r)))
    return out


def excluded_effects(capabilities):
    """Effect ids a capabilities.json run.excluded entry (with a reason) marks as not testable by the replay."""
    out = set()
    for item in (_obj(_obj(capabilities).get("run")).get("excluded")) or []:
        if isinstance(item, dict) and str(item.get("reason") or "").strip():
            out |= {x for x in item.get("effects") or [] if isinstance(x, str)}
    return out


if __name__ == "__main__":
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".")
    prog = json.loads((root / "program.json").read_text(encoding="utf-8"))
    for sid, s in sorted(screens(prog).items(), key=lambda kv: (kv[1]["position"] is None, kv[1]["position"] or 0)):
        print("%-24s position %-5s actors %s (%d sentences)" % (sid, s["position"], ",".join(s["actors"]) or "-",
                                                               len(s["segments"])))
