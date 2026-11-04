#!/usr/bin/env python3
"""Estimate the size and cost of one simulation of a package at the paper's analysed N.

    python .opencode/skills/build/estimate_run.py package/<slug> --n 692 [--price-in 1 --price-out 5]
                                                 [--max-tokens 300] [--json out.json]

`--n` is the number of sessions at the paper's analysed N (participants for individual designs, groups or
pairs for group designs), summed over conditions. Prices are US dollars per million tokens; the defaults are
an example, so name the model and the price you assumed when you quote the result. `--max-tokens` is the
output limit the run script passes per call (none: the relay reserves its default, see below).

How: the prompts are captured exactly as check_validity.py captures them (`prompts_of`: run_sessions with an
offline stand-in model in a confined child, on a copy of the package; no network, no paid calls), once per
arm on its own. The calls and prompt lengths per session of each arm are averaged over arms and scaled to
`--n`. Tokens are estimated as characters / 4 (CHARS_PER_TOKEN), and each reply as OUTPUT_TOKENS_PER_CALL
tokens: a heuristic, not a tokenizer; free-text screens run longer.

It also says whether one run fits the hosted model relay of a macOS simulation (simulate/SKILL.md): the
relay reserves, per call, the request body's bytes + 256 per message + the call's output limit (4,096 when
none is given), never refunded, and stops at 200,000 reserved tokens or after 30 minutes. The numbers are the
RELAY_* constants below, copied from the app's relay (app/src/main/model-relay.ts, startModelRelay); change
them together. The time is a rough guess (RELAY_CONCURRENCY calls at once, SECONDS_PER_CALL each).

Prints the numbers and one `Run size: ...` line for the reply to the researcher. Not a check: it never fails a
package; it exits 1 only when the stand-in run produced no model calls.
"""
import argparse
import json
import math
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_validity  # noqa: E402

CHARS_PER_TOKEN = 4            # heuristic for English prompt text
OUTPUT_TOKENS_PER_CALL = 150   # a short answer
# The hosted model relay's per-run limits (app/src/main/model-relay.ts; stated in simulate/SKILL.md).
RELAY_TOKEN_CAP = 200_000      # reserved tokens per run
RELAY_MINUTES = 30             # the relay closes after this
RELAY_DEFAULT_MAX_TOKENS = 4096   # reserved per call when the request names no output limit
RELAY_PER_MESSAGE = 256        # reserved per message (framing)
BODY_FRAME = 80                # {"model": ..., "messages": [{"role": "user", "content": ...}]} around the prompt
RELAY_CONCURRENCY = 8          # humanstudy_llm's default HUMANSTUDY_LLM_CONCURRENCY
SECONDS_PER_CALL = 4           # rough model latency


def _agents(pkg):
    task = check_validity._json(Path(pkg) / "task/task.json") or {}
    memory = task.get("memory") if isinstance(task.get("memory"), dict) else {}
    for value in (task.get("agentsPerSession"), memory.get("agents_per_session"), memory.get("agentsPerSession")):
        if isinstance(value, int) and value >= 1:
            return value
    return 1


def estimate(capture, n, price_in=1.0, price_out=5.0, max_tokens=None, agents=1):
    """The run size at n sessions from a prompts_of capture."""
    runs = [r for r in capture.get("runs") or [] if r.get("calls")]
    arm_runs = [r for r in runs if r.get("arms")]
    use = arm_runs or runs
    use = [r for r in use if not r.get("error")] or use   # an arm that stopped early undercounts
    if not use:
        return None
    calls, chars, body = [], [], []
    for r in use:
        sessions = max(1, int(r.get("sessions") or r.get("n") or 1))
        calls.append(r["calls"] / sessions)
        chars.append(sum(r.get("lengths") or []) / sessions)
        body.append((r.get("bodyChars") or sum(r.get("lengths") or [])) / sessions)
    per_session = statistics.mean(calls)
    total_calls = per_session * n
    input_tokens = statistics.mean(chars) * n / CHARS_PER_TOKEN
    output_tokens = total_calls * OUTPUT_TOKENS_PER_CALL
    out_limit = max_tokens or RELAY_DEFAULT_MAX_TOKENS
    reserve_session = statistics.mean(body) + per_session * (BODY_FRAME + RELAY_PER_MESSAGE + out_limit)
    reserve = reserve_session * n
    minutes = total_calls * SECONDS_PER_CALL / RELAY_CONCURRENCY / 60
    return {
        "sessions": n,
        "participants": n * agents,
        "modelCalls": round(total_calls),
        "callsPerSession": round(per_session, 1),
        "inputTokens": round(input_tokens),
        "outputTokens": round(output_tokens),
        "costUsd": round(input_tokens / 1e6 * price_in + output_tokens / 1e6 * price_out, 2),
        "pricePerMillion": {"input": price_in, "output": price_out},
        "relay": {
            "reservedTokens": round(reserve),
            "tokenCap": RELAY_TOKEN_CAP,
            "outputLimitPerCall": out_limit,
            "minutes": round(minutes, 1),
            "minuteCap": RELAY_MINUTES,
            "fits": reserve <= RELAY_TOKEN_CAP and minutes <= RELAY_MINUTES,
            "sessionsPerRun": max(0, min(math.floor(RELAY_TOKEN_CAP / reserve_session) if reserve_session else n,
                                         math.floor(RELAY_MINUTES * 60 * RELAY_CONCURRENCY
                                                    / max(SECONDS_PER_CALL * per_session, 1e-9)))),
        },
        "armsMeasured": [r["arms"][0] for r in arm_runs] or None,
        "cutShort": [r["arms"][0] if r.get("arms") else "default run" for r in use if r.get("capped")],
    }


def run_size_line(e):
    relay = e["relay"]
    fits = ("fits one run of the hosted model relay (%s of %s reserved tokens, about %s of %s minutes)"
            % (format(relay["reservedTokens"], ","), format(relay["tokenCap"], ","), relay["minutes"], relay["minuteCap"])
            if relay["fits"] else
            "does not fit one run of the hosted model relay (%s reserved tokens of %s, about %s of %s minutes; "
            "about %s sessions per run)" % (format(relay["reservedTokens"], ","), format(relay["tokenCap"], ","),
                                            relay["minutes"], relay["minuteCap"], format(relay["sessionsPerRun"], ",")))
    who = "%s participants" % format(e["participants"], ",")
    if e["participants"] != e["sessions"]:
        who += " in %s sessions" % format(e["sessions"], ",")
    line = ("Run size: %s, about %s model calls (%s per session), %.2f million input and %.2f million output tokens "
            "(characters / 4), about $%s at $%g / $%g per million input / output tokens; it %s."
            % (who, format(e["modelCalls"], ","), e["callsPerSession"], e["inputTokens"] / 1e6, e["outputTokens"] / 1e6,
               format(e["costUsd"], ",.2f"), e["pricePerMillion"]["input"], e["pricePerMillion"]["output"], fits))
    if e["cutShort"]:
        line += " The stand-in run of %s hit its call cap, so the real count is higher." % ", ".join(map(str, e["cutShort"]))
    return line


def _package(path):
    root = Path(path).resolve()
    if (root / "task/adapter.py").is_file():
        return root
    found = [d for d in root.glob("*") if (d / "task/adapter.py").is_file()] if root.is_dir() else []
    found = found or ([d for d in (root / "package").glob("*") if (d / "task/adapter.py").is_file()]
                      if (root / "package").is_dir() else [])
    return found[0] if len(found) == 1 else None


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("package", help="package/<slug> (the folder that holds task/adapter.py)")
    ap.add_argument("--n", type=int, required=True, help="sessions at the paper's analysed N, over all conditions")
    ap.add_argument("--price-in", type=float, default=1.0, help="USD per million input tokens (example default)")
    ap.add_argument("--price-out", type=float, default=5.0, help="USD per million output tokens (example default)")
    ap.add_argument("--max-tokens", type=int, help="output limit per call the run script passes (default: none)")
    ap.add_argument("--json", help="write the numbers here")
    a = ap.parse_args(argv)
    pkg = _package(a.package)
    if pkg is None:
        print("PROBLEM give the package folder that holds task/adapter.py")
        return 1
    capture = check_validity.prompts_of(pkg)
    e = estimate(capture, a.n, a.price_in, a.price_out, a.max_tokens, _agents(pkg))
    if e is None:
        print("PROBLEM the stand-in run produced no model calls (%s); fix the adapter first"
              % (capture.get("error") or "no prompts"))
        return 1
    for r in capture.get("runs") or []:
        if r.get("error"):
            print("note    run_sessions%s stopped: %s" % (" arm %s" % r["arms"] if r.get("arms") else "", r["error"]))
    print(json.dumps(e, indent=2))
    if a.json:
        Path(a.json).write_text(json.dumps(e, indent=2) + "\n", encoding="utf-8")
    print(run_size_line(e))
    return 0


if __name__ == "__main__":
    sys.exit(main())
