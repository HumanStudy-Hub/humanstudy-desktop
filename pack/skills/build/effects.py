#!/usr/bin/env python3
"""Check effects.json: hypotheses -> effects -> the program nodes they bind, every reported number quoted.

Usage: python effects.py <project>           check; prints PASS or each problem, exits 1 on a problem
       python effects.py <project> --graph   the hypothesis graph (edges and unlinked program nodes)

The check also runs the package's run_sessions with a stand-in model (every reply "1", n=2, no network)
and fails when a built-in op reads a session field that the human sessions carry but AI-participant
sessions do not: human and AI sessions must be computed the same way. (With human data in human-data/
or $HUMANSTUDY_HUMAN_DATA the human side is read too; a field neither side has is only reported.)

The rules and the computation live in ../export/agent/effects_core.py (shipped with every agent export).
These build rules are checked here only (effects_core.py, which HumanStudy-Bench copies, is unchanged):

  sample size   an effect whose quotes print N (N = 40, n = 39, 120 participants), or whose study has a
                participant count in program.json, records it in reported.n (or cells.<arm>.n), or says in
                reported.missing why this effect's N is not printed (a subgroup, a different unit). A recorded
                reported.n must be accounted for by its quotes (printed, a printed total minus a printed
                exclusion count, a per-group N times the arms when the quote says "per group", the sum of
                the cells, df + 1 or df + 2).
                Limit: a study N copied onto a subgroup passes when the subgroup's count is not printed as an N.
  sign          a difference-type estimate (d, dz, g, mean or risk difference, log odds ratio) is treatment
                minus reference: when the cells print both arms, its sign must be the sign of their
                difference; when they do not and the paper prints the value without a sign, the estimate
                states `signBasis` (the printed words that say which arm was higher). A sign is never
                chosen to match the prediction. A printed CI must contain its value (a flipped sign flips it).
  links         what an effect computes holds what its `reported` claims (from the same stand-in run; a package
                block is read from evaluate() + effect_estimates() on the stand-in sessions, its shape only):
                - kind: the computed metric is a reported estimate's metric (a correlation or alpha is never
                  checked by a t, a d never by a raw mean difference), or compute.compareAs says why they are the
                  same quantity, or it is the mean / risk difference of the reported cells; with only a test, the
                  same test; reported per-arm means and SDs need cells with sd. A package block not computed on
                  the stand-in run is read from evaluation/evaluation.py OUTPUT_KINDS = {"<key>": "correlation" |
                  {"kinds": "mean sd t", "unit": "share"}} (parsed as a literal, never imported) or compute.metric.
                - scale: a share or percentage is never checked against an amount in cents, points or seconds
                  (outcome.scale, the cells, compute.field and the block's or declaration's unit).
                - one value: several estimates of one metric without distinct `variant`s are several effects.
                - n: an arm whose n is the same in most of a study's effects but clearly smaller in one needs the
                  exclusion stated (compute.exclusion, a compute.where flag, or reported.missing / notes).
"""
import importlib.util
import json
import math
import os
import re
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "export" / "agent"))
import effects_core  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sandbox_run  # noqa: E402
import contract  # noqa: E402  older projects get the newer link rules as warnings


def _module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(Path(path).parent))
    spec.loader.exec_module(mod)
    return mod


def field_gaps(root, effects):
    """(problems, notes): built-in-op fields AI sessions lack although human sessions have them, and, under the
    current contract, effects whose computed block does not hold what `reported` claims (see field_report)."""
    problems, notes, _ = field_report(root, effects)
    return problems, notes


def field_report(root, effects, package=None):
    """(problems, notes, warnings). The link findings (link_problems, from the same stand-in run) were added with
    the shared reply reader: problems when `package` (package/<slug>; without it, any package of the project) is
    built under the current contract (contract.py), warnings for an older build, so a project that was ready
    stays ready."""
    problems, notes, links = _field_gaps(root, effects)
    if contract.current_contract(package) if package is not None else contract.project_current(root):
        return links + problems, notes, []
    return problems, notes, links


def _field_gaps(root, effects):
    """(field problems, notes, link problems)."""
    root = Path(root)
    packages = sorted(d for d in (root / "package").glob("*") if (d / "task/adapter.py").is_file()) \
        if (root / "package").is_dir() else []
    ops = [e for e in effects.get("effects") or [] if (e.get("compute") or {}).get("op") not in (None, "package")]
    keys = sorted({k for e in effects.get("effects") or [] if isinstance(e, dict)
                   for k in [_key(e.get("compute"))] if k and (e.get("compute") or {}).get("op") == "package"})
    if len(packages) != 1 or not (ops or keys):
        return [], [], []
    pkg = packages[0].resolve()
    declarations = output_kinds(pkg)
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
        run = sandbox_run.run_python(Path(__file__).resolve(), ["--field-sessions", str(pkg), str(data)] + keys,
                                     cwd=pkg, work=work, timeout=300, read=[data])
    lines = [l for l in run.stdout.splitlines() if l.startswith('{"fieldSessions":')]
    if not lines:
        why = "timed out" if run.timed_out else "exit %s: %s" % (run.returncode, (run.stderr or run.stdout).strip()[-300:])
        return [], ["AI-session fields not checked: the adapter did not run with a stand-in model (%s)" % why], \
            link_problems(effects, {}, declarations, False)
    got = json.loads(lines[-1])["fieldSessions"]
    if "aiError" in got:  # a blocked study or an adapter that needs real answers
        return [], ["AI-session fields not checked: the adapter did not run with a stand-in model (%s)"
                    % got["aiError"]], link_problems(effects, {}, declarations, False)
    blocks = got.get("blocks") if isinstance(got.get("blocks"), dict) else {}
    links = link_problems(effects, blocks, declarations, "blocks" in got)
    notes = ["package effect blocks not computed on the stand-in run (%s)" % got["blocksError"]] \
        if got.get("blocksError") else []
    if "humanError" in got:
        return [], notes + ["human sessions not loaded (%s)" % got["humanError"]], links
    sessions, human = got.get("ai") or [], got.get("human") or []
    problems = []
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
    return problems, notes, links


def field_sessions(pkg, data, keys=()):
    """In the confined child: AI sessions from a stand-in model, the package's effect blocks for `keys`
    (evaluate() then effect_estimates() on those sessions: what each block holds, not its values), and human
    sessions when there is data."""
    pkg, data, out = Path(pkg), Path(data), {}
    try:
        out["ai"] = list(_module(pkg / "task/adapter.py", "hs_fields_adapter").run_sessions(
            lambda prompt, *a, **k: "1", 20261015, 2) or [])
    except Exception as exc:
        out["aiError"] = str(exc)[:400]
        return out
    if keys and (pkg / "evaluation/evaluation.py").is_file():
        try:
            mod = _module(pkg / "evaluation/evaluation.py", "hs_fields_evaluation")
            blocks = mod.effect_estimates(mod.evaluate(out["ai"])) if hasattr(mod, "effect_estimates") else {}
            out["blocks"] = {k: _shape(blocks[k]) for k in keys if isinstance(blocks, dict) and k in blocks}
        except Exception as exc:
            out["blocksError"] = "%s: %s" % (type(exc).__name__, str(exc)[:300])
    if (pkg / "human/human_sessions.py").is_file() and data.is_dir():
        try:
            out["human"] = list(_module(pkg / "human/human_sessions.py", "hs_fields_human").load(str(data)) or [])
        except Exception as exc:
            out["humanError"] = str(exc)[:400]
    return out


def _shape(block):
    """What a result block holds (status, metric, unit, test statistic, cell keys), never its values."""
    if not isinstance(block, dict):
        return {"status": "not_ready"}
    test = block.get("test") if isinstance(block.get("test"), dict) else {}
    cells = block.get("cells") if isinstance(block.get("cells"), dict) else {}
    return {"status": block.get("status"), "metric": block.get("metric") if isinstance(block.get("metric"), str) else None,
            "unit": str(block.get("unit"))[:60] if block.get("unit") else None,
            "scale": str(block.get("scale"))[:60] if block.get("scale") else None,
            "test": {"statistic": test.get("statistic")},
            "cells": {str(a): {k: 1 for k, v in c.items() if _num(v) is not None} for a, c in list(cells.items())[:40]
                      if isinstance(c, dict)},
            "table": {"counts": 1} if isinstance(block.get("table"), dict) and block["table"].get("counts") else None}


SIGNED = ("mean_difference", "standardized_mean_difference", "hedges_g", "risk_difference", "log_odds_ratio",
          "percent_change")
DIRECTIONAL = ("two_groups", "paired")
PRINTED_N = re.compile(r"(?<![\w.])[Nn]\s*=\s*(\d[\d,]*)(?![\d.])|(?<![\w.])(\d[\d,]*)\s+(?:participants|subjects|"
                       r"respondents|volunteers|adults|children|students|individuals|patients|people|workers|players)\b")
# a `missing` entry about N ("n of the correlation", "N of the LAC subgroup", "sample size"), not "SDs n/a"
N_MISSING = re.compile(r"(?<![\w/])N(?![\w/])|sample size|number of (?:participants|subjects|respondents|observations|"
                       r"cases|people|individuals)", re.I)
DF = re.compile(r"\b(?:t|r|F\s*\(\s*\d+\s*,)\s*\(?\s*(\d+)(?:\.\d+)?\s*\)")
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


EXCLUDED = re.compile(r"(\d[\d,]*)\s+(?:\w+\s+){0,3}?(?:were|was)\s+(?:excluded|removed|dropped|discarded|omitted)|"
                      r"(?:excluded|excluding|removed|removing|dropped|discarded|omitted)\s+(?:\w+\s+){0,2}?(\d[\d,]*)|"
                      r"(\d[\d,]*)\s+(?:\w+\s+){0,3}?(?:did not|failed to) (?:complete|finish|pass)", re.I)
PER_GROUP = re.compile(r"\b(?:per|each|every|in each) (?:group|condition|cell|arm)\b|\bper (?:group|condition)\b", re.I)


def _n_follows(n, printed, cells, quotes, arms=2):
    """True when the quotes account for n: printed; a printed total minus a printed exclusion count ("30 were
    excluded"); a per-group N ("60 per group") times the number of arms; the sum of the cells' n; or
    df + 1 / df + 2 of a printed test."""
    if n in printed or (cells and sum(cells) == n):
        return True
    excluded = {int(x.replace(",", "")) for q in quotes for m in EXCLUDED.finditer(q) for x in m.groups() if x}
    if any(a - b == n for a in printed for b in excluded if b < a):
        return True
    if any(PER_GROUP.search(q) for q in quotes) and any(n == arms * p for p in printed):
        return True
    dfs = {int(m.group(1)) for q in quotes for m in DF.finditer(q)}
    return any(n in (d + 1, d + 2) for d in dfs)


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
    return value < 0 and any(math.isclose(x, value, rel_tol=1e-9, abs_tol=0.0)
                             for q in quotes for x in effects_core.numbers_in(q))


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
        elif has_n and printed_values and _num(rep.get("n")) is not None \
                and not _n_follows(rep["n"], printed_values, given[1:], quotes, max(2, len(cells))):
            out.append("%s: reported.n = %g, but its quotes print N = %s and nothing they print gives %g (a printed "
                       "N, a total minus a printed exclusion count, a per-group N times the arms, the sum of the cells, or df + 1 or "
                       "df + 2 of a printed test); record the N this effect is computed on and cite the quote that "
                       "prints it" % (where, rep["n"], ", ".join(map(str, sorted(printed_values))), rep["n"]))
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


# ---- links: the computed block holds what `reported` claims ------------------------------------------

TESTS = ("t", "F", "z", "chi_square", "W", "U")
# what each built-in op returns (effects_core.OP_FUNCS): metrics, test statistic, cell kinds
OP_HOLDS = {"mean_difference": ({"mean_difference"}, {"t"}, {"mean", "sd"}),
            "paired_difference": ({"mean_difference"}, {"t"}, {"mean", "sd"}),
            "proportion_difference": ({"risk_difference"}, {"chi_square"}, {"share"}),
            "contingency": ({"phi", "cramers_v"}, {"chi_square"}, {"share"}),
            "correlation": ({"correlation"}, {"t"}, set())}
# words an OUTPUT_KINDS declaration may use, besides the schema's metric names and x: extensions
KIND_WORDS = {"r": "correlation", "corr": "correlation", "pearson": "correlation", "spearman": "correlation",
              "rho": "correlation", "d": "standardized_mean_difference", "smd": "standardized_mean_difference",
              "g": "hedges_g", "md": "mean_difference", "diff": "mean_difference", "rd": "risk_difference",
              "or": "odds_ratio", "lor": "log_odds_ratio", "rr": "risk_ratio", "b": "regression_coefficient",
              "coef": "regression_coefficient", "beta": "standardized_coefficient", "eta2": "eta_squared",
              "pes": "partial_eta_squared", "v": "cramers_v", "bf": "bayes_factor", "m": "mean",
              "chi2": "test:chi_square", "chisq": "test:chi_square", "f": "test:F", "u": "test:U", "w": "test:W",
              "sd": "cell:sd", "share": "cell:share", "proportion": "cell:share", "percent": "cell:share",
              "rate": "cell:share", "counts": "cell:share"}
UNIT_WORDS = {"share": "share", "proportion": "share", "fraction": "share", "percent": "percent", "percentage": "percent",
              "pct": "percent", "%": "percent", "cents": "money", "cent": "money", "dollars": "money", "usd": "money",
              "euros": "money", "eur": "money", "pounds": "money", "pence": "money", "points": "money",
              "tokens": "money", "ecu": "money", "coins": "money", "money": "money", "ms": "time",
              "milliseconds": "time", "seconds": "time", "secs": "time", "minutes": "time", "hours": "time"}
EXCLUSION_WORDS = re.compile(r"(?i)exclu|drop|remov|omit|left out|leav\w* out|not (?:included|analy[sz]ed)|subset|"
                             r"only (?:those|participants|the)")


def _key(compute):
    """compute.key as the text the child and OUTPUT_KINDS use: a string, or an int compared as its text;
    None for any other value (a list, a bool, a dict), which no block can be looked up by."""
    key = compute.get("key") if isinstance(compute, dict) else None
    if isinstance(key, bool) or not isinstance(key, (str, int)):
        return None
    return str(key)


def output_kinds(pkg):
    """evaluation/evaluation.py's OUTPUT_KINDS, read without running it: {key: "kinds"} or {key: {"kinds",
    "unit"}} (a module-level literal; anything else is ignored). Keys are compared as text."""
    import ast
    try:
        tree = ast.parse((Path(pkg) / "evaluation/evaluation.py").read_text(encoding="utf-8"))
    except Exception:      # unreadable, not Python, nested too deep, null bytes ...
        return {}
    for node in tree.body:
        targets = node.targets if isinstance(node, ast.Assign) else [node.target] if isinstance(node, ast.AnnAssign) else []
        if any(isinstance(t, ast.Name) and t.id == "OUTPUT_KINDS" for t in targets) and node.value is not None:
            try:
                value = ast.literal_eval(node.value)
            except Exception:
                return {}
            if not isinstance(value, dict):
                return {}
            return {str(k): v for k, v in value.items() if isinstance(k, (str, int)) and not isinstance(k, bool)}
    return {}


def _declared(entry):
    """(metrics, tests, cells, units) an OUTPUT_KINDS entry names."""
    if isinstance(entry, dict):
        words, unit = entry.get("kinds", ""), entry.get("unit")
    else:
        words, unit = entry, None
    words = " ".join(map(str, words)) if isinstance(words, (list, tuple, set)) else str(words or "")
    metrics, tests, cells = set(), set(), set()
    for word in re.split(r"[\s,;|]+", words):
        if not word:
            continue
        kind = KIND_WORDS.get(word.lower(), word if (word in TESTS or effects_core.resolve("metric", word) or
                                                     word.startswith("x:")) else None)
        kind = "test:" + kind if kind in TESTS else kind
        if kind and kind.startswith("test:"):
            tests.add(kind[5:])
        elif kind and kind.startswith("cell:"):
            cells.add(kind[5:])
        elif kind == "mean":
            metrics.add("mean")
            cells.add("mean")
        elif kind:
            metrics.add(kind)
    if metrics & {"t", "F", "z"}:
        tests |= metrics & {"t", "F", "z"}
    return metrics, tests, cells, _units(unit) if isinstance(unit, str) else set()


def _units(text):
    return {UNIT_WORDS[w] for w in re.findall(r"[a-z]+|%", str(text or "").lower()) if w in UNIT_WORDS}


def _cell_kinds(cells):
    kinds = set()
    for c in (cells or {}).values() if isinstance(cells, dict) else []:
        if not isinstance(c, dict):
            continue
        if _num(c.get("mean")) is not None:
            kinds.add("mean")
        if _num(c.get("sd")) is not None:
            kinds.add("sd")
        if any(_num(c.get(k)) is not None for k in ("proportion", "percent", "k")):
            kinds.add("share")
    return kinds


def block_holds(effect, block, declarations):
    """(metrics, tests, cells, units, how) the computed block holds: a built-in op's fixed output; a package
    block computed on the stand-in run; else its OUTPUT_KINDS declaration or compute.metric (how = "declared");
    None when nothing says."""
    comp = effect.get("compute") if isinstance(effect.get("compute"), dict) else {}
    units = _units(comp.get("field"))
    if comp.get("op") in OP_HOLDS:
        metrics, tests, cells = OP_HOLDS[comp["op"]]
        return set(metrics), set(tests), set(cells), units, "op"
    key = _key(comp)
    if isinstance(block, dict) and block.get("status") == "computed":
        metrics = {block["metric"]} if isinstance(block.get("metric"), str) else set()
        test = (block.get("test") or {}).get("statistic") if isinstance(block.get("test"), dict) else None
        cells = _cell_kinds(block.get("cells"))
        if isinstance(block.get("table"), dict) and block["table"].get("counts"):
            cells.add("share")
        units |= _units(block.get("unit")) | _units(block.get("scale"))
        if key in declarations:
            units |= _declared(declarations[key])[3]
        return metrics, {test} if test in TESTS else set(), cells, units, "computed"
    if key in declarations:
        metrics, tests, cells, declared_units = _declared(declarations[key])
        return metrics, tests, cells, units | declared_units, "declared"
    metric = (block or {}).get("metric") if isinstance(block, dict) else None
    metric = metric or comp.get("metric")
    if isinstance(metric, str):
        return {metric}, set(), set(), units, "declared"
    return None


def link_problems(effects, blocks, declarations, ran):
    """The computed block holds what `reported` claims: the statistic kind, the scale, one value per effect,
    and the paper's n (see the module docstring). blocks: {key: block} from the stand-in run; ran: whether the
    package's evaluation ran on it (an undeclared not-ready block is only a problem then)."""
    out = []
    effs = [e for e in effects.get("effects") or [] if isinstance(e, dict) and isinstance(e.get("reported"), dict)
            and (e.get("population") if isinstance(e.get("population"), dict) else {}).get("kind") in (None, "human")]
    for e in effs:
        try:
            out += _effect_links(e, blocks, declarations, ran)
        except Exception:   # noqa: BLE001 - a malformed effect: effects_core reports its shape
            continue
    try:
        out += _n_problems(effs)
    except Exception:   # noqa: BLE001 - as above
        pass
    return out


def _effect_links(e, blocks, declarations, ran):
    """link_problems for one effect."""
    out = []
    rep, comp = e["reported"], e.get("compute") if isinstance(e.get("compute"), dict) else {}
    where = "effect %s" % e.get("id")
    if comp.get("op") == "package" and _key(comp) is None:
        return out           # a key that is not text: effects_core reports the effect's compute
    estimates = [x for x in rep.get("estimates") if isinstance(x, dict) and isinstance(x.get("metric"), str)] \
        if isinstance(rep.get("estimates"), list) else []
    reported_metrics = {x["metric"] for x in estimates}
    test = (rep.get("test") or {}).get("statistic") if isinstance(rep.get("test"), dict) else None
    cells = rep.get("cells") if isinstance(rep.get("cells"), dict) else {}
    cell_kinds = _cell_kinds(cells)
    # (c) several values of one kind: one block holds one value
    counts = {}
    for x in estimates:
        counts.setdefault(x["metric"], []).append(str(x.get("variant") or "").strip())
    for metric, variants in counts.items():
        if len(variants) >= 2 and (not all(variants) or len(set(variants)) < len(variants)):
            out.append("%s: reported holds %d %s values, but the effect computes one value; give each its own "
                       "effect (one per comparison, outcome or row), or name in each estimate's `variant` the model "
                       "or weighting that makes them the same quantity printed differently"
                       % (where, len(variants), metric))
    holds = block_holds(e, blocks.get(_key(comp)), declarations)
    if holds is None:
        if ran and comp.get("op") == "package":
            out.append("%s: compute key %r is not computed on the stand-in run (not ready, or no effect_estimates "
                       "entry), so the check cannot see what it returns; declare it in evaluation/evaluation.py: "
                       "OUTPUT_KINDS = {%r: \"<what the block returns, e.g. correlation | mean sd t | "
                       "risk_difference share chi2>\"} (read as text, never run), or set compute.metric"
                       % (where, _key(comp), _key(comp)))
        return out
    metrics, tests, block_cells, units, how = holds
    # (a) the kind: effects_core.compare can put the computed number next to a reported one (the same
    # metric, compute.compareAs, or the difference of the reported cell means / shares); else, with only a
    # test reported, the block holds the same test; else the cells' kinds
    def comparable(metric):
        return effects_core.compare(e, {"status": "computed", "metric": metric, "value": 0.0}).get("comparable")
    need = cell_kinds & {"mean", "share"}
    if any(comparable(m) for m in metrics):
        ok, claimed = True, ""
    elif estimates:
        ok, claimed = False, ", ".join(sorted(reported_metrics))
    elif test and test != "other":
        ok, claimed = test in tests or test in metrics, "a %s test" % test
    else:
        ok = not need or bool(need & block_cells)
        claimed = "cell " + " and ".join(sorted(need))
    if not ok:
        holds_text = ", ".join(sorted(metrics) + ["%s test" % t for t in sorted(tests)] +
                               ["cell %s" % c for c in sorted(block_cells)]) or "no named statistic"
        out.append("%s: reported holds %s, but the computed block (%s) holds %s: a correlation or an alpha is "
                   "never checked by a t test, a d never by a raw mean difference. Compute the statistic the paper "
                   "reports (op package with effect_estimates returning it), or, when they are the same quantity "
                   "under another name, set compute.compareAs {\"metric\", \"reason\"}"
                   % (where, claimed, "%s, %s" % (comp.get("op"), how) if comp.get("op") != "package"
                      else "key %s, %s" % (_key(comp), how), holds_text))
    # mean and SD printed per arm: the computed cells carry the SD too (visible blocks and declarations only)
    elif {"mean", "sd"} <= cell_kinds and not estimates and how != "op" and block_cells and "sd" not in block_cells:
        out.append("%s: reported cells hold means and SDs, but the computed block's cells hold no sd; return "
                   "each arm's n, mean and sd in the block's cells" % where)
    # (b) the scale: a share or percentage never checked against cents, points or seconds
    outcome = e.get("outcome") if isinstance(e.get("outcome"), dict) else {}
    rep_units = _units(outcome.get("scale")) | _units(outcome.get("higherMeans"))
    explicit = set(rep_units)
    if cell_kinds & {"share"}:
        rep_units |= {"percent" if any(_num((c or {}).get("percent")) is not None for c in cells.values())
                      else "share"}
    if "proportion" in reported_metrics or "risk_difference" in reported_metrics:
        rep_units.add("share")
    fraction = {"share", "percent"}
    clash = None
    if rep_units & fraction and not rep_units - fraction and units - fraction and not units & fraction:
        clash = ("a %s" % "/".join(sorted(rep_units & fraction)), "/".join(sorted(units - fraction)))
    elif rep_units - fraction and not rep_units & fraction and units & fraction and not units - fraction:
        clash = ("an amount in %s" % "/".join(sorted(rep_units - fraction)), "/".join(sorted(units & fraction)))
    elif explicit in ({"share"}, {"percent"}) and units & fraction and not units & explicit and how != "op":
        clash = ("a %s" % next(iter(explicit)), "/".join(sorted(units & fraction)))
    if clash:
        out.append("%s: reported is %s but the computed value is in %s; compute it on the paper's scale (the mean "
                   "share of the endowment, not the mean in cents; a percentage as a percentage)" % ((where,) + clash))
    return out


def _stated_exclusion(e):
    comp = e.get("compute") if isinstance(e.get("compute"), dict) else {}
    rep = e.get("reported") if isinstance(e.get("reported"), dict) else {}
    if len(re.findall(r"\w+", str(comp.get("exclusion") or ""))) >= 4 or comp.get("where"):
        return True
    missing = rep.get("missing")
    missing = missing if isinstance(missing, list) else [missing] if missing else []
    return any(EXCLUSION_WORDS.search(str(x)) for x in missing + [e.get("notes") or ""])


def _n_problems(effs):
    """An arm whose n is the same in most of a study's effects but clearly smaller in one: the paper dropped
    part of that group from this comparison, and the effect must say so."""
    by_arm = {}
    for e in effs:
        rep, con = e["reported"], e.get("contrast") if isinstance(e.get("contrast"), dict) else {}
        study = e.get("studyId") if isinstance(e.get("studyId"), (str, int, float, type(None))) else str(e.get("studyId"))
        for arm, cell in (rep.get("cells") or {}).items() if isinstance(rep.get("cells"), dict) else []:
            if isinstance(cell, dict) and _num(cell.get("n")) is not None:
                by_arm.setdefault((study, "arm " + str(arm)), []).append((e, cell["n"]))
        if _num(rep.get("n")) is not None and con.get("treatment") and con.get("reference"):
            by_arm.setdefault((study, "%s vs %s" % (con["treatment"], con["reference"])), []).append((e, rep["n"]))
    out = []
    for (study, what), values in by_arm.items():
        if len(values) < 4:
            continue
        ns = [n for _, n in values]
        mode = max(set(ns), key=ns.count)
        if ns.count(mode) < 3 or ns.count(mode) < len(ns) / 2:
            continue
        for e, n in values:
            if n < 0.9 * mode and mode - n >= 5 and not _stated_exclusion(e):
                out.append("effect %s: %s has n = %g where the study's other effects have %g; the paper drops part of "
                           "that group from this comparison (often said only in the text). Find why, drop the same "
                           "participants when computing it, and say so in compute.exclusion (\"<what the paper drops, "
                           "where it says so, where the computation drops it>\"), a compute.where flag, or "
                           "reported.missing" % (e.get("id"), what, n, mode))
    return list(dict.fromkeys(out))


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
        print(json.dumps({"fieldSessions": field_sessions(args[1], args[2], args[3:])}, ensure_ascii=False,
                         default=str))
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
    gaps, notes, older = field_report(root, effects) if not problems else ([], [], [])
    problems += gaps
    for w in warnings + notes:
        print("warning: " + w)
    for w in older:
        print("WARN    %s (older build: blocking once rebuilt with task/replies.py)" % w)
    for p in problems:
        print("problem: " + p)
    print("FAIL" if problems else "PASS (%d hypotheses, %d effects)"
          % (len(effects.get("hypotheses") or []), len(effects.get("effects") or [])))
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
