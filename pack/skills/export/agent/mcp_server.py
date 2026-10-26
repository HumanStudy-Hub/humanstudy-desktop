"""MCP server (stdio) for one HumanStudy program. Standard library only, Python 3.8+.

Each tool calls study_core.py, which reads program.json and the replay package in this folder; the
server adds no study facts and holds no model keys. The connected agent supplies AI participants'
replies itself (participant_prompt -> its own model -> parse_reply -> score_sessions).

    claude mcp add <name> -- python3 /path/to/server.py
"""
import contextlib
import json
import sys
import traceback
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
with contextlib.redirect_stdout(sys.stderr):
    from study_core import Study  # noqa: E402

PROTOCOL = "2025-06-18"
for stream in (sys.stdin, sys.stdout):
    try:
        stream.reconfigure(encoding="utf-8")  # MCP is UTF-8 JSON on every platform
    except (AttributeError, ValueError):
        pass
OUT = sys.stdout  # the protocol stream; package code that prints goes to stderr
STUDY = Study(HERE)
NAME = (STUDY.program.get("id") or "humanstudy-program")[:60]


def obj(props, required=()):
    return {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}


S = {"type": "string"}
TOOLS = [
    ("study_overview", "Title, authors, the studies in the paper, open issues and whether the study can be run.",
     obj({}), lambda a: STUDY.overview()),
    ("list_conditions", "Conditions of one study, with ids for participant_prompt.",
     obj({"study_id": S}, ["study_id"]), lambda a: STUDY.conditions(a["study_id"])),
    ("read_study", "One study in full: participants, design, conditions, verbatim materials, ordered procedure, "
     "variables, analysis, reported results and open issues, each with its page in the paper.",
     obj({"study_id": S}, ["study_id"]), lambda a: STUDY.study_markdown(a["study_id"])),
    ("read_paper_context", "Paper-level overview, background, findings and limitations.",
     obj({}), lambda a: STUDY.paper_markdown()),
    ("get_item", "One program node or step with every source quote it rests on.",
     obj({"id": S}, ["id"]), lambda a: STUDY.node(a["id"])),
    ("search_study", "Find text in the program fields and in the quoted source passages.",
     obj({"query": S, "limit": {"type": "integer", "minimum": 1, "maximum": 50}}, ["query"]),
     lambda a: STUDY.search(a["query"], a.get("limit", 20))),
    ("list_open_issues", "What the paper does not state or what still needs a decision. Never fill these in silently.",
     obj({"study_id": S}), lambda a: STUDY.open_issues(a.get("study_id"))),
    ("participant_prompt", "Exactly what one AI participant reads in a condition, from the replay package. "
     "Give it to a fresh model context with no other instructions, then pass the reply to parse_reply.",
     obj({"study_id": S, "condition_id": S}, ["study_id", "condition_id"]),
     lambda a: STUDY.participant_prompt(a["study_id"], a["condition_id"])),
    ("parse_reply", "Turn one participant's reply into the response format the paper used.",
     obj({"study_id": S, "condition_id": S, "reply": S}, ["study_id", "condition_id", "reply"]),
     lambda a: STUDY.parse_reply(a["study_id"], a["condition_id"], a["reply"])),
    ("plan_participants", "Every prompt the AI participants will read (n per condition, from the replay package), in "
     "order. Answer each one in a fresh model context that sees only that prompt (one per original participant), "
     "then send the replies, in the same order and with the same n, arms and seed, to score_replies.",
     obj({"n": {"type": "integer", "minimum": 1, "maximum": 500}, "arms": {"type": "array", "items": S},
          "seed": {"type": "integer"}}),
     lambda a: STUDY.plan(a.get("n", 5), a.get("arms"), a.get("seed", 20261015))),
    ("score_replies", "Rebuild the sessions from the participants' replies and run the paper's own analysis. "
     "Returns the evaluation and the sessions.",
     obj({"replies": {"type": "array", "items": S}, "n": {"type": "integer", "minimum": 1, "maximum": 500},
          "arms": {"type": "array", "items": S}, "seed": {"type": "integer"}}, ["replies"]),
     lambda a: STUDY.replay(a["replies"], a.get("n", 5), a.get("arms"), a.get("seed", 20261015))),
    ("score_sessions", "Run the paper's own analysis on a list of sessions (each with its condition and arm) "
     "and return the test, statistic and effect size, or what is missing.",
     obj({"sessions": {"type": "array", "items": {"type": "object"}}}, ["sessions"]),
     lambda a: STUDY.evaluate(a["sessions"])),
]
BY_NAME = {t[0]: t for t in TOOLS}


def reply(mid, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": mid}
    msg["error" if error else "result"] = error or result
    OUT.write(json.dumps(msg, ensure_ascii=False, default=str) + "\n")
    OUT.flush()


def handle(msg):
    method, mid, params = msg.get("method"), msg.get("id"), msg.get("params") or {}
    if mid is None:
        return  # notifications need no answer
    if method == "initialize":
        reply(mid, {"protocolVersion": params.get("protocolVersion") or PROTOCOL,
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": {"name": NAME, "version": "1"},
                    "instructions": "Tools for the study '%s'. Answers come only from the program and its "
                                    "sources. AI participants' answers are a simulation, not data from people."
                                    % STUDY.program.get("title")})
    elif method == "ping":
        reply(mid, {})
    elif method == "tools/list":
        reply(mid, {"tools": [{"name": n, "description": d, "inputSchema": s} for n, d, s, _ in TOOLS]})
    elif method == "tools/call":
        tool = BY_NAME.get(params.get("name"))
        if not tool:
            return reply(mid, error={"code": -32602, "message": "unknown tool %r" % params.get("name")})
        try:
            with contextlib.redirect_stdout(sys.stderr):
                out = tool[3](params.get("arguments") or {})
            body = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False, indent=2, default=str)
            reply(mid, {"content": [{"type": "text", "text": body}], "isError": False})
        except Exception as exc:  # report to the agent instead of dropping the connection
            detail = exc.args[0] if isinstance(exc, (KeyError, RuntimeError)) and exc.args else repr(exc)
            print(traceback.format_exc(), file=sys.stderr)
            reply(mid, {"content": [{"type": "text", "text": "error: %s" % detail}], "isError": True})
    else:
        reply(mid, error={"code": -32601, "message": "method not found: %s" % method})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except ValueError:
            reply(None, error={"code": -32700, "message": "parse error"})
            continue
        for m in msg if isinstance(msg, list) else [msg]:
            handle(m)


if __name__ == "__main__":
    main()
