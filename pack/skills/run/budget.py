#!/usr/bin/env python3
"""The model budget of a protocol run, measured rather than guessed. App-owned; the app runs it confined (no keys,
no network) from its own copy when protocol.json passes its checks, and sizes the relay with the result.

    python budget.py <project folder> <scratch folder> [--per-arm 3]

Plays a few participants per runnable arm through run_study.run() with the random+gates oracle (it passes every
gate, so every page is reached), and measures what the default renderer sends the model on each call: the system
text and the rendered page, which grows with every earlier page and answer. The system text is the longest a run
may send (participants.budget_system: the participant prompt with a persona of PERSONA_BUDGET_BYTES; app_run
refuses longer personas). Each call reserves the page's output limit (participants.output_limit: 768, or 2,048 on a
page asking for a long free-text answer), every earlier free-text answer adds CARRY_BYTES (a model writes longer
text than the oracle), and every picture on the page is reserved as an image the model may be shown
(participants.IMAGE_RESERVE_TOKENS, as the relay charges it), so the budget does not depend on
simulation/participants.json or the model chosen. The relay reserves, per call, the request body's bytes (JSON as
humanstudy_llm sends it, non-ASCII escaped) + 256 per message + the output limit; this counts the same. Prints one JSON line:

    {"arms": {"<arm>": {"group_size": g, "calls": c, "tokens_per_member": t}}, "output_tokens": 768}

`calls` and `tokens_per_member` are the largest over the members played, with a margin for answers the page
refuses and a model asked again (MARGIN, which includes about 10% of pages re-asked). Refused pages that the oracle never meets still cost a model
participant a call each; the margin covers a few.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import os

os.environ["HSENV_PRIVATE_CONFIG"] = ""   # never the engine's private sidecar in the app (before any hsenv import)
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

PER_MESSAGE = 256            # the relay's reserve per message
# refused answers, longer replies in the history, retries, and about 10% of pages asked once more because the reply
# could not be read (app_run's single re-ask): all inside this one margin
MARGIN = 1.5
CARRY_BYTES = 800            # a model's free-text answer as later prompts carry it (JSON-escaped), per earlier text answer


# The relay charges the HTTP body's bytes. humanstudy_llm.chat sends json.dumps(body) with ensure_ascii on, so a
# non-ASCII character costs its \\uXXXX escape (6 bytes, 12 for a surrogate pair), and newlines and quotes are
# escaped too: count that exact serialisation, with a model id as long as any the app offers.
MODEL_PLACEHOLDER = "m" * 120


def call_charge(system: str, page: str, images: int = 0, output: int | None = None) -> int:
    """What the relay reserves for one call of the default f: the request body exactly as humanstudy_llm.chat
    serialises it, + 256 per message + the page's output limit (participants.output_limit), + per picture the
    relay's image reserve and its part."""
    import participants
    output = output or participants.OUTPUT_TOKENS
    body = {"model": MODEL_PLACEHOLDER, "messages": [{"role": "system", "content": system}, {"role": "user", "content": page}],
            "temperature": 1.0, "max_tokens": output}
    pictures = images * (participants.IMAGE_RESERVE_TOKENS + participants.IMAGE_PART_BYTES) + (32 if images else 0)
    return len(json.dumps(body).encode("utf-8")) + 2 * PER_MESSAGE + output + pictures


def text_ids(state) -> set:
    """The free-text questions on this page (their answers are carried into later prompts)."""
    return {r.get("id") for r in (state.get("screen") or {}).get("responses", []) if r.get("kind") == "text"}


def carried_text(state, texts: set) -> int:
    """Headroom for free text a model writes and every later page shows again (the oracle's own texts are short):
    CARRY_BYTES per earlier free-text answer (a text question, or an option's text box)."""
    return CARRY_BYTES * sum(1 for a in state.get("answered") or [] if isinstance(a, dict)
                             and (a.get("response") in texts or a.get("text")))


def with_headroom(calls: int, tokens: int) -> tuple[int, int]:
    """(calls, tokens) per member with the margin (which includes the re-asks)."""
    return int(calls * MARGIN + 0.999), int(tokens * MARGIN + 0.999)


def pictures(state) -> int:
    """Pictures on the current screen (what make_chat_f(images=True) would send)."""
    return sum(1 for it in (state.get("screen") or {}).get("items", []) if isinstance(it.get("src"), str))


def measure(project: Path, scratch: Path, per_arm: int = 3) -> dict:
    import fspec
    import render
    import run_study
    import participants
    system = participants.budget_system()
    seen: dict[tuple, list[int]] = {}
    texts: set = set()
    original = fspec.random_f

    def counting(protocol, spec, assist=False):
        f, d = original(protocol, spec, assist)

        def g(state, ctx):
            texts.update(text_ids(state))
            charge = call_charge(system, render.render_state(state), pictures(state), participants.output_limit(state)) \
                + carried_text(state, texts)
            seen.setdefault((ctx.participant, ctx.member), []).append(charge)
            return f(state, ctx)
        g.needs_operator = getattr(f, "needs_operator", False)
        return g, d

    fspec.random_f = counting
    try:
        out = scratch / "budget-run"
        run_study.run(str(project), {"kind": "random+gates"}, n=per_arm, seeds=[1], out=out, workers=1,
                      do_eval=False, baseline=False, quiet=True, top_up=False)
    finally:
        fspec.random_f = original
    protocol, _, _, _ = run_study.load_protocol(str(project))
    groups = {a["id"]: int(a.get("group_size") or 1) for a in protocol.arms if a.get("runnable") is not False}
    arm_of = {}
    for line in (out / "operator.jsonl").read_text(encoding="utf-8").splitlines():
        if line.strip():
            r = json.loads(line)
            arm_of[(r["opaque_id"], r["member"])] = r["arm"]
    arms: dict[str, dict] = {}
    for key, charges in seen.items():
        arm = arm_of.get(key)
        if arm is None:
            continue
        a = arms.setdefault(arm, {"group_size": groups.get(arm, 1), "calls": 0, "tokens_per_member": 0})
        a["calls"] = max(a["calls"], len(charges))
        a["tokens_per_member"] = max(a["tokens_per_member"], sum(charges))
    for arm, a in arms.items():
        a["calls"], a["tokens_per_member"] = with_headroom(a["calls"], a["tokens_per_member"])
    missing = sorted(set(groups) - set(arms))
    if missing:
        raise SystemExit("no participant of arm(s) %s could be measured" % ", ".join(missing))
    import participants as P
    return {"arms": arms, "output_tokens": P.OUTPUT_TOKENS}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__.split("\n\n")[1])
    per = int(sys.argv[sys.argv.index("--per-arm") + 1]) if "--per-arm" in sys.argv else 3
    print(json.dumps(measure(Path(sys.argv[1]), Path(sys.argv[2]), per)))
