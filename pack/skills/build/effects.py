#!/usr/bin/env python3
"""Check effects.json: hypotheses -> effects -> the program nodes they bind, every reported number quoted.

Usage: python effects.py <project>           check; prints PASS or each problem, exits 1 on a problem
       python effects.py <project> --graph   the hypothesis graph (edges and unlinked program nodes)

The check also runs the package's run_sessions with a stand-in model (every reply "1", n=2, no network)
and fails when a built-in op reads a session field that the human sessions carry but AI-participant
sessions do not: human and AI sessions must be computed the same way. (With human data in human-data/
or $HUMANSTUDY_HUMAN_DATA the human side is read too; a field neither side has is only reported.)

The rules and the computation live in ../export/agent/effects_core.py (shipped with every agent export).
"""
import importlib.util
import json
import os
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "export" / "agent"))
import effects_core  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sandbox_run  # noqa: E402


def _module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(Path(path).parent))
    spec.loader.exec_module(mod)
    return mod


def field_gaps(root, effects):
    """(problems, notes): built-in-op fields AI sessions lack although human sessions have them."""
    packages = sorted(d for d in (root / "package").glob("*") if (d / "task/adapter.py").is_file()) \
        if (root / "package").is_dir() else []
    ops = [e for e in effects.get("effects") or [] if (e.get("compute") or {}).get("op") not in (None, "package")]
    if len(packages) != 1 or not ops:
        return [], []
    pkg = packages[0].resolve()
    # The researcher's own HUMANSTUDY_HUMAN_DATA is trusted; a human-data folder that came with the study is
    # opened to the package only when it is a real folder inside the study (not a link to ~/.aws, say).
    data = Path(os.environ["HUMANSTUDY_HUMAN_DATA"]).resolve() if os.environ.get("HUMANSTUDY_HUMAN_DATA") else \
        (root / "human-data")
    if not os.environ.get("HUMANSTUDY_HUMAN_DATA"):
        inside = data.is_dir() and not data.is_symlink() and Path(root).resolve() in data.resolve().parents
        data = data.resolve() if inside else Path(root).resolve() / "human-data-not-used"
    # The package's code runs only in a confined child (sandbox_run.py: no keys, no network, writes only in a
    # scratch folder), which prints the sessions as JSON.
    with sandbox_run.work_dir(prefix="effects-fields-") as work:
        run = sandbox_run.run_python(Path(__file__).resolve(), ["--field-sessions", str(pkg), str(data)], cwd=pkg,
                                     work=work, timeout=300, read=[data])
    lines = [l for l in run.stdout.splitlines() if l.startswith('{"fieldSessions":')]
    if not lines:
        why = "timed out" if run.timed_out else "exit %s: %s" % (run.returncode, (run.stderr or run.stdout).strip()[-300:])
        return [], ["AI-session fields not checked: the adapter did not run with a stand-in model (%s)" % why]
    got = json.loads(lines[-1])["fieldSessions"]
    if "aiError" in got:  # a blocked study or an adapter that needs real answers
        return [], ["AI-session fields not checked: the adapter did not run with a stand-in model (%s)" % got["aiError"]]
    if "humanError" in got:
        return [], ["human sessions not loaded (%s)" % got["humanError"]]
    sessions, human = got.get("ai") or [], got.get("human") or []
    problems, notes = [], []
    for e in ops:
        c = e["compute"]
        study = c.get("study", e.get("studyId"))
        same = lambda xs: [x for x in xs if study is None or x.get("study") is None or str(x.get("study")) == str(study)]
        ai, hu = same(sessions), same(human)
        if not ai:
            continue
        for path in [c.get("field")] + [c.get(k) for k in ("referenceField", "withField", "groupBy")] + list(c.get("where") or {}):
            if not path or any(_has(s, path) for s in ai):
                continue
            if not human or any(_has(h, path) for h in hu):
                problems.append("effect %s reads %r, which AI-participant sessions do not carry" % (e["id"], path))
            else:
                notes.append("effect %s reads %r, which neither human nor AI sessions carry (not computable)"
                             % (e["id"], path))
    return problems, notes


def field_sessions(pkg, data):
    """In the confined child: AI sessions from a stand-in model, and human sessions when there is data."""
    pkg, data, out = Path(pkg), Path(data), {}
    try:
        out["ai"] = list(_module(pkg / "task/adapter.py", "hs_fields_adapter").run_sessions(
            lambda prompt, *a, **k: "1", 20261015, 2) or [])
    except Exception as exc:
        out["aiError"] = str(exc)[:400]
        return out
    if (pkg / "human/human_sessions.py").is_file() and data.is_dir():
        try:
            out["human"] = list(_module(pkg / "human/human_sessions.py", "hs_fields_human").load(str(data)) or [])
        except Exception as exc:
            out["humanError"] = str(exc)[:400]
    return out


def _has(session, path):
    cur = session
    for part in str(path).split("."):
        if isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
            cur = cur[int(part)]
        elif isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return False
    return True


def main(args):
    if not args:
        print(__doc__)
        return 2
    if args[0] == "--field-sessions":
        print(json.dumps({"fieldSessions": field_sessions(args[1], args[2])}, ensure_ascii=False, default=str))
        return 0
    root = Path(args[0])
    if "--graph" in args:
        return effects_core.main(["graph", str(root)])
    effects = effects_core.load(root)
    if effects is None:
        print("effects.json is missing in %s" % root)
        return 1
    program = json.loads((root / "program.json").read_text(encoding="utf-8"))
    problems, warnings = effects_core.check(root, effects, program)
    gaps, notes = field_gaps(root, effects) if not problems else ([], [])
    problems += gaps
    for w in warnings + notes:
        print("warning: " + w)
    for p in problems:
        print("problem: " + p)
    print("FAIL" if problems else "PASS (%d hypotheses, %d effects)"
          % (len(effects.get("hypotheses") or []), len(effects.get("effects") or [])))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
