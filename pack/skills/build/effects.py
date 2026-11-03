#!/usr/bin/env python3
"""Check effects.json: hypotheses -> effects -> the program nodes they bind, every reported number quoted.

Usage: python effects.py <project>           check; prints PASS or each problem, exits 1 on a problem
       python effects.py <project> --graph   the hypothesis graph (edges and unlinked program nodes)

The check also runs the package's run_sessions with a stand-in model (every reply "1", n=2, no network)
and fails when a built-in op reads a session field that the human sessions carry but AI-participant
sessions do not: human and AI sessions must be computed the same way. (With human data in human-data/
or $HUMANSTUDY_HUMAN_DATA the human side is read too; a field neither side has is only reported.)

The rules and the computation live in ../export/agent/effects_core.py (shipped with every agent export).
Two build rules are checked here only (effects_core.py, which HumanStudy-Bench copies, is unchanged):

  sample size   an effect whose quotes print N (N = 40, n = 39, 120 participants), or whose study has a
                participant count in program.json, records it in reported.n (or cells.<arm>.n), or says in
                reported.missing why this effect's N is not printed (a subgroup, a different unit).
  sign          a difference-type estimate (d, dz, g, mean or risk difference, log odds ratio) is treatment
                minus reference: when the cells print both arms, its sign must be the sign of their
                difference; when they do not and the paper prints the value without a sign, the estimate
                states `signBasis` (the printed words that say which arm was higher). A sign is never
                chosen to match the prediction.
"""
import importlib.util
import json
import os
import re
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


SIGNED = ("mean_difference", "standardized_mean_difference", "hedges_g", "risk_difference", "log_odds_ratio",
          "percent_change")
DIRECTIONAL = ("two_groups", "paired")
PRINTED_N = re.compile(r"(?<![\w.])[Nn]\s*=\s*(\d[\d,]*)(?![\d.])|(?<![\w.])(\d[\d,]*)\s+(?:participants|subjects|"
                       r"respondents|volunteers|adults|children|students|individuals|patients|people|workers|players)\b")
N_MISSING = re.compile(r"(?<![\w])[Nn](?![\w])|sample size|number of (?:participants|subjects|respondents|"
                       r"observations|cases|people|individuals)", re.I)
N_FIELDS = ("n-analysed", "n-completed", "n-recruited")


def _num(x):
    return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None


def _first_number(value):
    if _num(value) is not None:
        return value
    m = re.search(r"(?<![\w.])(\d[\d,]*)(?![\w.])", value) if isinstance(value, str) else None
    return int(m.group(1).replace(",", "")) if m else None


def _study_n(program, study):
    """(where, value as printed) for the first participant count program.json records for the study."""
    for key in N_FIELDS:
        for n in program.get("nodes") or []:
            if not isinstance(n, dict) or n.get("kind") != "participants" or (study and n.get("studyIds") and study not in n["studyIds"]):
                continue
            for f in n.get("fields") or []:
                if isinstance(f, dict) and f.get("id") == key and f.get("state") != "missing" and _first_number(f.get("value")) is not None:
                    return "%s.%s" % (n.get("id"), key), str(f.get("value"))[:60]
    return None


def _share(cell):
    if _num(cell.get("mean")) is not None:
        return cell["mean"]
    if _num(cell.get("proportion")) is not None:
        return cell["proportion"]
    if _num(cell.get("percent")) is not None:
        return cell["percent"] / 100.0
    return None


def _printed_signed(value, quotes):
    """True when the quotes print this negative value with its minus sign (the paper itself signs it)."""
    return value < 0 and any(abs(x - value) < 1e-9 for q in quotes for x in effects_core.numbers_in(q))


def build_rules(effects, program):
    """Problems for the sample-size and sign rules (see the module docstring)."""
    evidence = {e.get("id"): e for e in program.get("evidence") or [] if isinstance(e, dict)}
    out = []
    for e in effects.get("effects") or []:
        rep = e.get("reported")
        if not isinstance(rep, dict) or (e.get("population") or {}).get("kind") not in (None, "human"):
            continue
        where = "effect %s" % e.get("id")
        ids = list(rep.get("evidenceIds") or []) + [i for est in rep.get("estimates") or [] for i in est.get("evidenceIds") or []]
        quotes = [evidence[i].get("quote") or "" for i in dict.fromkeys(ids) if i in evidence]
        cells = rep.get("cells") if isinstance(rep.get("cells"), dict) else {}
        has_n = _num(rep.get("n")) is not None or any(_num((c or {}).get("n")) is not None for c in cells.values())
        said = any(N_MISSING.search(str(m)) for m in rep.get("missing") or [])
        printed = [m.group(1) or m.group(2) for q in quotes for m in PRINTED_N.finditer(q)]
        printed_values = {int(x.replace(",", "")) for x in printed if x.replace(",", "").isdigit()}
        given = [_num(rep.get("n"))] + [_num((c or {}).get("n")) for c in cells.values()]
        given = [x for x in given if x is not None]
        if not has_n and printed and not said:
            out.append("%s: its quotes print N (%s) but reported.n and cells.<arm>.n are empty; record the N this "
                       "effect is computed on, as printed, or say in reported.missing why none of these is its N"
                       % (where, ", ".join(dict.fromkeys(printed))))
        elif has_n and printed_values and not said and _num(rep.get("n")) is not None \
                and rep["n"] not in printed_values and sum(given[1:]) != rep["n"]:
            out.append("%s: reported.n = %g but its quotes print N = %s; use the N printed for this effect, or say in "
                       "reported.missing where its N comes from" % (where, rep["n"], ", ".join(map(str, sorted(printed_values)))))
        elif not has_n and not said:
            study = _study_n(program, e.get("studyId"))
            if study:
                out.append("%s: reported.n is empty although program.json records the study's sample (%s = %r); add "
                           "the N as printed (cite the quote that prints it in reported.evidenceIds) or say in "
                           "reported.missing why this effect's N is not printed (a subgroup, another unit)" % ((where,) + study))
        con = e.get("contrast") or {}
        if con.get("kind") not in DIRECTIONAL:
            continue
        t, r = cells.get(con.get("treatment")) or {}, cells.get(con.get("reference")) or {}
        diff = _share(t) - _share(r) if _share(t) is not None and _share(r) is not None else None
        # cells too close to call (a mean of individual differences can disagree with the difference of means)
        for j, est in enumerate(rep.get("estimates") or []):
            value = _num(est.get("value"))
            if est.get("metric") not in SIGNED or not value:
                continue
            at = "%s reported.estimates[%d] (%s = %g)" % (where, j, est.get("metric"), value)
            ci = [_num(x) for x in est.get("ci") or []]
            if len(ci) == 2 and None not in ci and not min(ci) - 1e-9 <= value <= max(ci) + 1e-9:
                out.append("%s: the CI [%g, %g] does not contain the value; a value whose sign was changed needs its "
                           "CI negated as well ([-hi, -lo])" % (at, ci[0], ci[1]))
            sds = [c.get("sd") for c in (t, r) if _num(c.get("sd")) is not None and _num(c.get("mean")) is not None]
            # too close to call a sign: within a tenth of the printed SD, or (no SDs) within 2% of the cell values
            close = 0.1 * sum(sds) / len(sds) if len(sds) == 2 else 0.02 * max(abs(_share(t) or 0), abs(_share(r) or 0))
            if diff is not None and abs(diff) > close:
                if (value > 0) != (diff > 0):
                    out.append("%s: the value is treatment minus reference (%s), but the cells give %s - %s = %+.4g; "
                               "sign it as the cells show (negate the CI too: [-hi, -lo]), or swap treatment and "
                               "reference (and the prediction)"
                               % (at, con.get("valueMeans") or "%s minus %s" % (con.get("treatment"), con.get("reference")),
                                  con.get("treatment"), con.get("reference"), diff))
            elif diff is None and not _printed_signed(value, quotes) and not str(est.get("signBasis") or "").strip():
                out.append("%s: printed without a sign and no cells show which arm is higher; add `signBasis` with the "
                           "printed words that say it (\"LAC participants chose the risky option less often\") and "
                           "sign the value treatment minus reference; never pick the sign the prediction expects" % at)
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
    problems += build_rules(effects, program)
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
