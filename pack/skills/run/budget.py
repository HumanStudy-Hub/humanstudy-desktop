#!/usr/bin/env python3
"""The model budget of a protocol run, measured rather than guessed. App-owned; the app runs it confined (no keys,
no network) from its own copy when protocol.json passes its checks, and sizes the relay with the result.

    python budget.py <project folder> <scratch folder> [--per-arm 3]

Plays a few participants per runnable arm through run_study.run() with the random+gates oracle (it passes every
gate, so every page is reached), and measures what the default renderer sends the model on each call: the system
text and the rendered page, which grows with every earlier page and answer. The relay reserves, per call, the
request body's bytes (JSON as humanstudy_llm sends it, non-ASCII escaped) + 256 per message + the output limit;
this counts the same. Prints one JSON line:

    {"arms": {"<arm>": {"group_size": g, "calls": c, "tokens_per_member": t}}, "output_tokens": 512}

`calls` and `tokens_per_member` are the largest over the members played, with a margin for answers the page
refuses and a model asked again (MARGIN). Refused pages that the oracle never meets still cost a model
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

OUTPUT_TOKENS = 512          # humanstudy_llm's default output limit per call (the relay reserves it)
PER_MESSAGE = 256            # the relay's reserve per message
MARGIN = 1.5                 # refused answers, longer replies in the history, retries


# The relay charges the HTTP body's bytes. humanstudy_llm.chat sends json.dumps(body) with ensure_ascii on, so a
# non-ASCII character costs its \\uXXXX escape (6 bytes, 12 for a surrogate pair), and newlines and quotes are
# escaped too: count that exact serialisation, with a model id as long as any the app offers.
MODEL_PLACEHOLDER = "m" * 120


def call_charge(system: str, page: str) -> int:
    """What the relay reserves for one call of the default f: the request body exactly as humanstudy_llm.chat
    serialises it, + 256 per message + the output limit."""
    body = {"model": MODEL_PLACEHOLDER, "messages": [{"role": "system", "content": system}, {"role": "user", "content": page}],
            "temperature": 1.0, "max_tokens": OUTPUT_TOKENS}
    return len(json.dumps(body).encode("utf-8")) + 2 * PER_MESSAGE + OUTPUT_TOKENS


def measure(project: Path, scratch: Path, per_arm: int = 3) -> dict:
    import fspec
    import render
    import run_study
    system = render.make_chat_f(lambda messages: "{}").description["system"]
    seen: dict[tuple, list[int]] = {}
    original = fspec.random_f

    def counting(protocol, spec, assist=False):
        f, d = original(protocol, spec, assist)

        def g(state, ctx):
            charge = call_charge(system, render.render_state(state))
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
        a["calls"] = int(a["calls"] * MARGIN + 0.999)
        a["tokens_per_member"] = int(a["tokens_per_member"] * MARGIN + 0.999)
    missing = sorted(set(groups) - set(arms))
    if missing:
        raise SystemExit("no participant of arm(s) %s could be measured" % ", ".join(missing))
    return {"arms": arms, "output_tokens": OUTPUT_TOKENS}


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__.split("\n\n")[1])
    per = int(sys.argv[sys.argv.index("--per-arm") + 1]) if "--per-arm" in sys.argv else 3
    print(json.dumps(measure(Path(sys.argv[1]), Path(sys.argv[2]), per)))
