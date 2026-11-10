"""Evaluation data (DESIGN.md §8.7): everything a reward may read, built once per run and kept with it.

    ev = EvalData.build(protocol, runs, baseline=run_random)      # runs: one per seed (see run_from_env)
    ev.to_dict()                                                  # JSON; EvalData.from_dict(...) re-scores later

For every effect and target of the protocol's `analysis`:
- human side: value, SE, n, p, direction, test, cite, each with a `*_basis` saying where it came from
  (printed / derived from printed cells / derived from a printed test) or a reason in `not_computable`;
- agent side: the same op (effects_core via checks.effect_blocks / checks.target_values), per seed and pooled;
- baseline: the same op on random-answer sessions (checks.random_answers) at the agent n, with a fixed seed.
Nothing missing is filled in: an undeterminable number is None and its reason is listed. No per-study code.

Scales (§8.2): correlations are compared on Fisher's z, target shares on the empirical logit; other metrics on
their own scale. `value` is the metric's own number; `value_s` / `se_s` are on the scoring scale.
"""
import copy
import hashlib
import json
import math
import re
from pathlib import Path

from . import checks
from .engine import Env

SCHEMA = "hsenv-evaldata-1"
SCORED_ROLES = ("test", "paper_claim")
ROLES = ("test", "paper_claim", "descriptive", "robustness", "exploratory", "check")
# the metric each op computes, and the printed metric names that are the same quantity
OP_METRICS = {
    "mean_difference": ("mean_difference", "difference", "raw_mean_difference"),
    "paired_difference": ("mean_difference", "difference", "raw_mean_difference"),
    "proportion_difference": ("risk_difference", "proportion_difference"),
    "proportion_vs_chance": ("share_minus_chance",),
    "smd": ("cohens_d", "smd", "d"),
    "correlation": ("correlation", "r", "pearson_r"),
    "spearman": ("spearman", "spearman_rho", "rho", "correlation"),
    "contingency": ("phi", "cramers_v"),
    "rank_sum": ("rank_biserial",),
    "interaction": ("interaction", "mean_difference", "difference_of_differences"),
}
Z95 = 1.959964


# ---------------------------------------------------------------------------------------------- numbers
def _num(x):
    if isinstance(x, bool) or not isinstance(x, (int, float)) or x != x or x in (float("inf"), float("-inf")):
        return None
    return float(x)


_P = re.compile(r"^\s*(p\s*)?(?P<rel>[<>=≤≥]?)\s*=?\s*(?P<v>\d*\.?\d+(?:e[-+]?\d+)?)(?![\d.])", re.I)


STARS = {"***": (0.001, "<"), "**": (0.01, "<"), "*": (0.05, "<"), "+": (0.05, ">"), "†": (0.05, ">"),
         "ns": (0.05, ">"), "n.s.": (0.05, ">")}


def parse_p(x, relation=None):
    """A printed p: number or text ('<.001', '.051 (Table 14) ...') -> (p, relation) with relation '=', '<', '>'."""
    if _num(x) is not None:
        rel = {"<": "<", "<=": "<", "≤": "<", ">": ">", ">=": ">", "≥": ">"}.get(str(relation or "").strip(), "=")
        return float(x), rel
    if not isinstance(x, str):
        return None, None
    if x.strip().lower().rstrip(".") in ("ns", "n.s", "ns (no star)"):
        return STARS["ns"]
    m = _P.match(re.sub(r"(?i)^\s*p\s*=", "", x))
    if not m or not 0 <= float(m.group("v")) <= 1:
        return None, None
    rel = {"<": "<", "≤": "<", ">": ">", "≥": ">"}.get(m.group("rel"), "=")
    if relation and rel == "=":
        rel = {"<": "<", ">": ">"}.get(str(relation).strip()[:1], "=")
    return float(m.group("v")), rel



def p_normal(z):
    return math.erfc(abs(z) / math.sqrt(2)) if z is not None else None


def _sign(v):
    return None if v is None else (v > 0) - (v < 0)


def _n_total(x):
    if isinstance(x, dict):
        vals = [_num(v) for v in x.values()]
        return sum(vals) if vals and all(v is not None for v in vals) else None
    return _num(x)


# ---------------------------------------------------------------------------------------------- scales
def scale_of(item_kind, op_or_stat):
    if item_kind == "effect" and op_or_stat in ("correlation", "spearman"):
        return "fisher_z"
    if item_kind == "target" and op_or_stat == "share":
        return "logit"
    return "raw"


def fisher(r, n, spearman=False):
    """(z, se_z) for a correlation; se from n only."""
    if r is None or abs(r) >= 1:
        return None, None
    z = math.atanh(r)
    se = math.sqrt((1.06 if spearman else 1.0) / (n - 3)) if n and n > 3 else None
    return z, se


def elogit(k, n):
    """Empirical logit of a share and its SE (finite at 0 and 1)."""
    if n is None or k is None or n <= 0:
        return None, None
    return math.log((k + 0.5) / (n - k + 0.5)), math.sqrt(1 / (k + 0.5) + 1 / (n - k + 0.5))


# ---------------------------------------------------------------------------------------------- human side
def _cells(e):
    rep = e.get("reported") or {}
    con = e.get("contrast") or {}
    cells = rep.get("cells") if isinstance(rep.get("cells"), dict) else {}
    t, r = con.get("treatment"), con.get("reference")
    ct = cells.get(str(t)) if t is not None else None
    cr = cells.get(str(r)) if r is not None else None
    return (ct if isinstance(ct, dict) else {}), (cr if isinstance(cr, dict) else {}), cells


def _share(c):
    k, n, pr = _num(c.get("k")), _num(c.get("n")), _num(c.get("proportion"))
    if k is not None and n:
        return k / n, k, n
    if pr is not None and n and 0 <= pr <= 1:   # a printed percentage is not read as a share
        return pr, pr * n, n
    return None, None, None


def _reported_metric(rep):
    if rep.get("metric"):
        return str(rep["metric"])
    v = _num(rep.get("value"))
    for est in rep.get("estimates") or []:
        if isinstance(est, dict) and v is not None and _num(est.get("value")) == v and est.get("metric"):
            return str(est["metric"])
    return None


def declared_basis(rep, what, default):
    """A supplied number keeps the protocol's own label: reported.<what>_basis if given, else 'derived (<note>)'
    when reported.<what>_note starts with 'derived' (e.g. an SE the converter computed from printed counts)."""
    if rep.get(what + "_basis"):
        return str(rep[what + "_basis"])
    note = str(rep.get(what + "_note") or "")
    if note.strip().lower().startswith("derived"):
        return "derived (%s)" % note.strip()[:200]
    cite = rep.get("cite")
    labels = [c.get("label") for c in (cite if isinstance(cite, list) else [cite]) if isinstance(c, dict)]
    if labels and all(x == "derived" for x in labels):
        return "derived (cite label: derived)"
    return default


UNSIGNED_STATS = ("chi_square", "chi2", "F", "W", "V", "U", "H", "binomial", "fisher_exact", "mann_whitney",
                  "kruskal_wallis", "kruskal")
BAYES = re.compile(r"(?i)\bbayes|credible|posterior|\bbrms\b|\bBF(?:10|01|-0|r0)?\b")


def _ac_se(cells):
    """Agresti-Caffo SE for shares when a cell is at 0% or 100% (DESIGN §8.2: no zero SE at 0 or 1)."""
    return math.sqrt(sum(((k + 1) / (n + 2)) * (1 - (k + 1) / (n + 2)) / (n + 2) for k, n in cells))


def human_effect(e):
    """The human side of one effect in the op's own metric. Never imputes: anything not printed or derivable from
    printed numbers is None with a reason in `not_computable`."""
    rep = e.get("reported") or {}
    comp = e.get("compute") or {}
    op = comp.get("op")
    test = rep.get("test") if isinstance(rep.get("test"), dict) else {}
    ct, cr, cells = _cells(e)
    nc = {}
    nu_declared = bool(e.get("no_uncertainty") or rep.get("no_uncertainty"))   # the printed test is not this estimand
    stat0 = str(test.get("statistic") or "")
    bayes = stat0.upper().startswith("BF") or bool(BAYES.search(json.dumps(
        {k: rep.get(k) for k in ("test", "estimates", "no_uncertainty", "note", "value_note")}, default=str)))
    one_cell = cells.get("share") if isinstance(cells.get("share"), dict) else \
        (next(iter(cells.values())) if len(cells) == 1 and isinstance(next(iter(cells.values())), dict) else {})
    out = {"value": None, "value_basis": None, "se": None, "se_basis": None, "n": None, "n_basis": None,
           "p": None, "p_relation": None, "p_basis": None, "direction": None, "direction_basis": None,
           "metric": None, "test": test or None, "cite": rep.get("cite"),
           "label": (rep.get("cite") or {}).get("label") if isinstance(rep.get("cite"), dict) else None}
    # ---- n
    n = _n_total(rep.get("n"))
    if n is not None:
        out["n"], out["n_basis"] = n, "printed n"
    elif op == "paired_difference" and ct and _num(ct.get("n")):   # the same people in both cells
        out["n"], out["n_basis"] = _num(ct["n"]), "printed cell n (paired: one cell)"
    elif op != "paired_difference" and all(_num(c.get("n")) for c in (ct, cr)) and ct and cr:
        out["n"], out["n_basis"] = _num(ct["n"]) + _num(cr["n"]), "derived: sum of printed cell n"
    elif op == "interaction" and len(cells) == 4 and all(isinstance(c, dict) and _num(c.get("n")) for c in cells.values()):
        out["n"], out["n_basis"] = sum(_num(c["n"]) for c in cells.values()), "derived: sum of printed cell n"
    elif op == "proportion_vs_chance" and _share(one_cell)[2]:
        out["n"], out["n_basis"] = _share(one_cell)[2], "printed cell n"
    elif _n_total(rep.get("n_participants")) is not None:
        out["n"], out["n_basis"] = _n_total(rep["n_participants"]), "printed n_participants"
    elif _num(test.get("n")) is not None:
        out["n"], out["n_basis"] = _num(test["n"]), "printed test n"
    elif _num(test.get("df")) is not None and test.get("statistic") in ("t", "r") and not nu_declared:
        extra = 1 if op == "paired_difference" else 2
        out["n"], out["n_basis"] = _num(test["df"]) + extra, "derived: t df + %d" % extra
    else:
        nc["human_n"] = "human n not printed"
    n = out["n"]
    # ---- value, in the op's metric
    metric_ok = OP_METRICS.get(op, ())
    rmetric = _reported_metric(rep)
    v = _num(rep.get("value"))
    why_not = None
    if comp.get("compareAs"):
        ca = comp["compareAs"]
        why_not = "compareAs: the printed estimate is a %s, not the computed %s (%s)" % (
            (ca.get("metric") if isinstance(ca, dict) else ca), op,
            (ca.get("reason", "")[:120] if isinstance(ca, dict) else ""))
    elif op in ("mean_difference", "paired_difference", "interaction"):
        if op != "interaction" and _num(ct.get("mean")) is not None and _num(cr.get("mean")) is not None:
            out["value"], out["value_basis"] = _num(ct["mean"]) - _num(cr["mean"]), "derived: printed cell means"
        elif v is not None and (rmetric is None or rmetric in metric_ok):
            out["value"], out["value_basis"] = v, "printed value"
        elif v is not None:
            why_not = "printed metric %s is not the computed %s" % (rmetric, op)
    elif op == "smd":
        if all(_num(c.get(k)) is not None for c in (ct, cr) for k in ("mean", "sd", "n")) and ct and cr:
            n1, n2 = _num(ct["n"]), _num(cr["n"])
            sp = math.sqrt(((n1 - 1) * ct["sd"] ** 2 + (n2 - 1) * cr["sd"] ** 2) / (n1 + n2 - 2)) if n1 + n2 > 2 else 0
            if sp:
                out["value"], out["value_basis"] = (ct["mean"] - cr["mean"]) / sp, "derived: Cohen's d from printed cells"
        if out["value"] is None and v is not None and (rmetric is None or rmetric in metric_ok):
            out["value"], out["value_basis"] = v, "printed value"
        elif out["value"] is None and _num(test.get("cohens_d")) is not None:
            out["value"], out["value_basis"] = _num(test["cohens_d"]), "printed test cohens_d"
        elif out["value"] is None and v is not None:
            why_not = "printed metric %s is not Cohen's d" % rmetric
    elif op == "proportion_difference":
        pt, _, _ = _share(ct)
        pr, _, _ = _share(cr)
        if pt is not None and pr is not None:
            out["value"], out["value_basis"] = pt - pr, "derived: printed cell shares"
        elif v is not None and (rmetric is None or rmetric in metric_ok) and abs(v) <= 1:
            out["value"], out["value_basis"] = v, "printed value"
        elif v is not None:
            why_not = "printed value %s is not a risk difference on the 0-1 scale (metric %s)" % (v, rmetric)
    elif op == "proportion_vs_chance":
        ps, _, _ = _share(one_cell)
        chance = _num(comp.get("chance"))
        chance = 0.5 if chance is None else chance
        if ps is not None:
            out["value"], out["value_basis"] = ps - chance, "derived: printed share minus chance"
        elif v is not None and rmetric in (None,) + metric_ok and abs(v) <= 1:
            out["value"], out["value_basis"] = v, "printed value"
        elif v is not None:
            why_not = "printed metric %s is not share minus chance" % rmetric
    elif op in ("correlation", "spearman"):
        if v is not None and (rmetric is None or rmetric in metric_ok) and abs(v) < 1:
            out["value"], out["value_basis"] = v, "printed value"
        elif v is not None:
            why_not = "printed metric %s is not a correlation" % rmetric
    elif op == "contingency":
        if v is not None and rmetric in metric_ok:
            out["value"], out["value_basis"] = v, "printed value"
        elif _num(test.get("cramers_v")) is not None:
            out["value"], out["value_basis"] = _num(test["cramers_v"]), "printed test cramers_v"
        elif v is not None:
            why_not = "printed metric %s is not phi / Cramer's V" % rmetric
    elif op == "rank_sum":
        if v is not None and (rmetric in metric_ok or (rmetric is None and re.search(
                r"(?i)rank[- ]biserial", str(rep.get("value_note") or "")))):
            out["value"], out["value_basis"] = v, "printed value"
        else:
            why_not = "no printed rank-biserial r (the op's metric)"
    if out["value"] is None:
        nc["human_value"] = why_not or "no printed value or cells in the computed metric"
    out["metric"] = op
    if out["value_basis"] in ("printed value", "printed test cohens_d", "printed test cramers_v"):
        out["value_basis"] = declared_basis(rep, "value", out["value_basis"])
    # ---- SE (raw scale) — §8.3 rules
    nu = e.get("no_uncertainty") or rep.get("no_uncertainty")
    h = out["value"]
    if out["value"] is None:
        pass
    elif nu:
        nc["human_se"] = "no_uncertainty: %s" % (nu if isinstance(nu, str) else rep.get("no_uncertainty_why") or "declared")
    else:
        se, basis = None, None
        ci = rep.get("ci") if isinstance(rep.get("ci"), list) and len(rep.get("ci")) == 2 else None
        ci_ok = ci is not None and all(_num(c) is not None for c in ci) and float(rep.get("ciLevel", 95) or 95) in (95, 0.95)
        if ci_ok and bayes and rep.get("ci_type") != "confidence":   # a credible interval is not a sampling CI
            ci_ok = False
        if op == "mean_difference" and all(_num(c.get(k)) for c in (ct, cr) for k in ("sd", "n")) and ct and cr:
            se, basis = math.sqrt(ct["sd"] ** 2 / ct["n"] + cr["sd"] ** 2 / cr["n"]), "derived: Welch SE from printed cell SD and n"
        elif op == "interaction" and len(cells) == 4 and all(isinstance(c, dict) and _num(c.get("sd")) and _num(c.get("n")) for c in cells.values()):
            se, basis = math.sqrt(sum(c["sd"] ** 2 / c["n"] for c in cells.values())), "derived: SE from printed cell SD and n"
        elif op == "smd" and out["value_basis"] != "printed value" and all(_num(c.get("n")) for c in (ct, cr)) and ct and cr:
            n1, n2 = _num(ct["n"]), _num(cr["n"])
            se, basis = math.sqrt((n1 + n2) / (n1 * n2) + h * h / (2 * (n1 + n2))), "derived: SE of d from printed cell n"
        elif op == "proportion_difference" and _share(ct)[0] is not None and _share(cr)[0] is not None:
            (a, ka, na), (b, kb, nb) = _share(ct), _share(cr)
            if min(a, b) <= 0 or max(a, b) >= 1:
                se, basis = _ac_se([(ka, na), (kb, nb)]), "derived: Agresti-Caffo SE from printed cells (a 0%/100% cell)"
            else:
                se, basis = math.sqrt(a * (1 - a) / na + b * (1 - b) / nb), "derived: Wald SE from printed cell shares"
        elif op == "proportion_vs_chance" and _share(one_cell)[0] is not None:
            ps, ks, ns = _share(one_cell)
            if 0 < ps < 1:
                se, basis = math.sqrt(ps * (1 - ps) / ns), "derived: binomial SE from printed share"
            else:
                pt = (ks + 2) / (ns + 4)
                se, basis = math.sqrt(pt * (1 - pt) / (ns + 4)), "derived: Agresti-Coull SE (share at 0%/100%)"
        elif op in ("correlation", "spearman"):
            basis = "derived: Fisher z SE from n" if n and n > 3 else None
            if basis is None and ci_ok and all(abs(c) < 1 for c in ci):
                basis = "derived: Fisher z SE from printed 95% CI"
            if basis is None:
                nc["human_se"] = "correlation without n or CI"
        elif _num(rep.get("se")) is not None and rep.get("se") > 0:
            se, basis = float(rep["se"]), "printed SE"
        elif ci_ok and ci[1] > ci[0]:
            se, basis = (ci[1] - ci[0]) / (2 * Z95), "derived: printed 95% CI / 3.92"
        elif op == "smd" and all(_num(c.get("n")) for c in (ct, cr)) and ct and cr:
            n1, n2 = _num(ct["n"]), _num(cr["n"])
            se, basis = math.sqrt((n1 + n2) / (n1 * n2) + h * h / (2 * (n1 + n2))), "derived: SE of d from printed cell n"
        elif op in ("mean_difference", "paired_difference") and test.get("statistic") in ("t", "z") \
                and _num(test.get("value")) and (test.get("statistic") == "z" or _num(test.get("df"))) \
                and not (op == "mean_difference" and "paired" in str(test.get("type") or "").lower()) \
                and not (op == "paired_difference" and re.search(r"(?i)independent|welch|between",
                                                                 str(test.get("type") or ""))):
            se, basis = abs(h) / abs(float(test["value"])), "derived: |value| / printed %s (%s)" % (
                test["statistic"], "paired" if op == "paired_difference" else "between")
        elif op in ("contingency", "rank_sum"):
            nc["human_se"] = "§8.3: %s gives no SE for its metric unless printed" % op
        else:
            nc["human_se"] = "no printed SE, CI, cell SD or exact t/z for this estimand"
        if basis and op not in ("correlation", "spearman") and not (se and se > 0):
            nc["human_se"] = "derived SE is %s (%s; rounded printed numbers)" % (se, basis)
            basis = None
        if basis and op not in ("correlation", "spearman"):
            out["se"] = se
        out["se_basis"] = basis
        if basis and op in ("correlation", "spearman") and basis.endswith("CI"):
            out["_se_s_ci"] = (math.atanh(ci[1]) - math.atanh(ci[0])) / (2 * Z95)
    if out["se_basis"] == "printed SE":
        out["se_basis"] = declared_basis(rep, "se", "printed SE")
    # ---- p
    p, rel, pb = None, None, None
    for src, x in (("printed test p", test.get("p")), ("printed p", rep.get("p")), ("printed test p", test.get("p_printed")),
                   ("printed test p", test.get("p_text")), ("printed test p", test.get("pText"))):
        p, rel = parse_p(x, test.get("pRelation"))
        if p is not None:
            pb = src
            break
    if p is None and isinstance(rep.get("sig"), str) and rep["sig"].strip() in STARS:
        p, rel = STARS[rep["sig"].strip()]
        pb = "printed significance mark %r" % rep["sig"]
    stat, tv, df = str(test.get("statistic") or ""), _num(test.get("value")), test.get("df")
    if p is None and bayes:
        nc["human_p"] = "Bayesian analysis (BF / posterior): no p printed, and none is derived from a credible interval"
    if p is None and tv is not None and not nu_declared and not bayes:
        if stat == "t" and _num(df):
            p, rel, pb = checks.effects_core.p_t(tv, float(df)), "=", "derived: printed t and df"
        elif stat == "z":
            p, rel, pb = p_normal(tv), "=", "derived: printed z"
        elif stat in ("chi_square", "chi2") and _num(df):
            p, rel, pb = checks.effects_core.p_chi2(tv, float(df)), "=", "derived: printed chi-square and df"
        elif stat == "F" and isinstance(df, list) and len(df) == 2 and _num(df[0]) == 1 and _num(df[1]):
            p, rel, pb = checks.effects_core.p_t(math.sqrt(tv), float(df[1])), "=", "derived: printed F(1, df)"
    if p is None and not bayes and op in ("correlation", "spearman") and h is not None and n and n > 2 and abs(h) < 1:
        t_ = h * math.sqrt((n - 2) / (1 - h * h))
        p, rel, pb = checks.effects_core.p_t(t_, n - 2), "=", "derived: printed r and n"
    if p is None and not bayes and h is not None and out["se"] and out["se_basis"] and "|value|" not in out["se_basis"]:
        p, rel, pb = p_normal(h / out["se"]), "=", "derived: z = value / SE (%s)" % (
            "derived SE" if out["se_basis"].startswith("derived") else out["se_basis"])
    out["declared_ns"] = e.get("direction_claimed") is False   # the paper's reading; never turned into a p
    if p is None:
        nc.setdefault("human_p", "no printed p, significance mark or test statistic with df")
    tail_txt = " ".join(str(test.get(k) or "") for k in ("tail", "p_note", "note", "type")) + " " + str(rep.get("note") or "")
    out.update(p=p, p_relation=rel, p_basis=pb, bayesian=bayes,
               p_tail="one-sided" if (pb or "").startswith("printed") and
               re.search(r"(?i)one[- ]?(?:sided|tailed)", tail_txt) else "two-sided")
    # ---- direction: the keyed check's reading (checks.human_sign)
    hs, why = checks.human_sign(e)
    unsigned_stat = str(test.get("statistic") or "") in UNSIGNED_STATS
    out["direction_na"] = bool((op == "contingency" and "success" not in comp)
                               or (not (ct and cr) and _num(rep.get("value")) is None and unsigned_stat)
                               or (not (ct and cr) and _num(rep.get("value")) is not None
                                   and str(rmetric) in checks.effects_core.UNSIGNED_METRICS))
    if hs is not None and op == "contingency" and "success" not in comp:
        hs, why = None, "contingency without success levels: the metric has no sign"
    elif hs is not None and not (ct and cr) and _num(rep.get("value")) is None and unsigned_stat:
        hs, why = None, "the only number is an unsigned %s statistic" % test.get("statistic")
    elif hs is not None and not (ct and cr) and _num(rep.get("value")) is not None and \
            str(rmetric) in checks.effects_core.UNSIGNED_METRICS:
        hs, why = None, "the printed %s has no sign" % rmetric
    if hs is None:
        nc["human_direction"] = why
    else:
        out["direction"], out["direction_basis"] = _sign(hs), "sign of printed contrast (checks.human_sign)"
    # spread (review rewards-3 M1): printed cell SDs, and the SD of paired differences = SE x sqrt(n)
    out["arm_sd"] = {}
    if op in ("mean_difference", "smd", "paired_difference", "interaction"):
        for k, c in cells.items():
            if isinstance(c, dict) and _num(c.get("sd")) and _num(c.get("n")):
                out["arm_sd"][str(k)] = [float(c["sd"]), float(c["n"])]
            elif isinstance(c, dict) and _num(c.get("sd")) and op == "paired_difference" and n:
                out["arm_sd"][str(k)] = [float(c["sd"]), float(n)]
    if op == "paired_difference" and out["se"] and n and out["se_basis"]:
        out["arm_sd"]["difference"] = [out["se"] * math.sqrt(n), float(n)]
    return out, nc


def human_target(t):
    hum = t.get("human") or {}
    stat = t.get("stat")
    nc = {}
    out = {"value": None, "value_basis": None, "se": None, "se_basis": None, "n": _num(hum.get("n")),
           "n_basis": "printed n" if _num(hum.get("n")) is not None else None, "k": None,
           "p": None, "p_relation": None, "p_basis": None, "direction": None, "direction_basis": None,
           "metric": stat, "test": None, "cite": hum.get("cite"),
           "label": (hum.get("cite") or {}).get("label") if isinstance(hum.get("cite"), dict) else None}
    if stat == "share":
        k, n = _num(hum.get("k")), _num(hum.get("n"))
        if k is not None and n:
            out.update(value=k / n, value_basis="derived: printed k / n", k=k)
        elif _num(hum.get("value")) is not None and 0 <= hum["value"] <= 1:
            out.update(value=float(hum["value"]), value_basis="printed share")
            if n:
                out["k"] = out["value"] * n
        else:
            nc["human_value"] = "no printed k/n or share on the 0-1 scale"
    elif _num(hum.get("value")) is not None:
        out.update(value=float(hum["value"]), value_basis="printed value")
    elif stat == "mean" and _num(hum.get("k")) is not None and _num(hum.get("n")):   # mean of a 0/1 field
        out.update(value=hum["k"] / hum["n"], value_basis="derived: printed k / n (mean of a 0/1 field)")
    else:
        nc["human_value"] = "no printed value"
    if out["n"] is None:
        nc["human_n"] = "human n not printed"
    out["arm_sd"] = {"all": [float(hum["sd"]), out["n"]]} if stat == "mean" and _num(hum.get("sd")) and out["n"] else {}
    nu = t.get("no_uncertainty") or hum.get("no_uncertainty")
    if out["value"] is not None:
        if nu:
            nc["human_se"] = "no_uncertainty: %s" % (nu if isinstance(nu, str) else "declared")
        elif stat == "share":
            if out["n"] and out["k"] is not None:
                out["se_basis"] = "derived: empirical-logit SE from k and n"
            else:
                nc["human_se"] = "share without n"
        elif stat == "median":
            if _num(hum.get("se")):
                out.update(se=float(hum["se"]), se_basis="printed SE")
            else:
                nc["human_se"] = "§8.2: a median needs a printed SE or individual data (Kind B bootstrap)"
        elif _num(hum.get("se")):
            out.update(se=float(hum["se"]), se_basis="printed SE")
        elif _num(hum.get("sd")) is not None and out["n"]:
            out.update(se=hum["sd"] / math.sqrt(out["n"]), se_basis="derived: printed SD / sqrt(n)")
        elif isinstance(hum.get("ci"), list) and len(hum["ci"]) == 2 and all(_num(c) is not None for c in hum["ci"]) \
                and float(hum.get("ciLevel", 95) or 95) in (95, 0.95):
            out.update(se=(hum["ci"][1] - hum["ci"][0]) / (2 * Z95), se_basis="derived: printed 95% CI / 3.92")
        else:
            nc["human_se"] = "no printed SE, SD or CI"
    return out, nc


def _to_scale(side, scale, op_or_stat):
    """Fill value_s / se_s on the scoring scale for one side (human, agent seed, baseline)."""
    v, n = side.get("value"), side.get("n")
    if v is None:
        side["value_s"], side["se_s"] = None, None
    elif scale == "fisher_z":
        z, se = fisher(v, n, op_or_stat == "spearman")
        if side.get("_se_s_ci") is not None:
            se = side.pop("_se_s_ci")
        side["value_s"], side["se_s"] = z, (se if side.get("se_basis", True) else None)
        if "se_basis" in side and side["se_basis"] is None:
            side["se_s"] = None
    elif scale == "logit":
        k = side.get("k")
        z, se = elogit(k, n) if k is not None and n else (None, None)
        side["value_s"] = z
        side["se_s"] = se if side.get("se_basis", True) else None
    else:
        side["value_s"], side["se_s"] = v, side.get("se")
    side.pop("_se_s_ci", None)
    return side


# ---------------------------------------------------------------------------------------------- scoring status
def scoring_of(x, kind):
    """'full' | 'direction_only' | 'none' and why — from the protocol's own declarations."""
    if x.get("suspect"):
        return "none", "suspect: %s" % x["suspect"]
    if x.get("provisional"):
        pass   # provisional values are still the paper's numbers; reported in the item
    if x.get("direction_unresolved"):
        return "none", "direction_unresolved: neither direction nor level is scored"
    sc = x.get("scoring")
    if sc in ("none", "not_comparable"):
        return "none", "scoring: %s (%s)" % (sc, str(x.get("reference_mismatch") or x.get("scoring_why") or "")[:160])
    if sc == "direction_only" or (x.get("reference_mismatch") and not sc):
        if kind == "target":
            return "none", "direction_only target (a level has no direction)"
        return "direction_only", "reference_mismatch: %s" % str(x.get("reference_mismatch") or "")[:160]
    return "full", None


# ---------------------------------------------------------------------------------------------- agent side
def _unit_validity(env, sessions, base=None):
    """{unit id: valid} for the given sessions, with per-session AND population exclusions (cutoffs computed on these
    sessions' completed members, as Env.unit_tables does): the one definition of valid shared by _truncate,
    run_status and valid_counts. base: {id(session): per-session validity} cache."""
    whole = {ex["id"] for ex in env.p.exclusions if ex.get("applies_to") is None}
    has_pop = any(ex.get("population") and ex.get("applies_to") is None for ex in env.p.exclusions)
    done = [s for s in sessions if s.status]
    pop = env.population_exclusions(done) if (done and has_pop) else {}
    units = {}
    for s in sessions:
        u = id(s.group) if s.group else id(s)
        key = "%s:%s" % (s.spec["arm"], s.spec["index"])
        b = base.get(id(s)) if base is not None and id(s) in base else \
            (s.status == "completed" and not (set(s.record()["excluded"]) & whole))
        if base is not None:
            base[id(s)] = b
        ok = b and not any(x["applies_to"] is None for x in pop.get(key, []))
        units[u] = units.get(u, True) and ok
    return units


def _truncate(env, planned):
    """The first units per arm, in opening order, until the planned number of VALID units is reached (groups count
    once); later sessions are dropped (over-n runs; review rewards-3). Valid = completed and no whole-session
    exclusion, population cutoffs included (they are recomputed on the kept prefix until the selection is stable;
    integration review 1 M2)."""
    order, by_unit = [], {}
    for s in env.sessions:
        u = id(s.group) if s.group else id(s)
        if u not in by_unit:
            by_unit[u] = []
            order.append((u, s.spec["arm"]))
        by_unit[u].append(s)
    per_arm = {}
    for u, arm in order:
        per_arm.setdefault(arm, []).append(u)
    take = {a: min(len(us), planned.get(a, 0)) for a, us in per_arm.items()}
    base = {}
    has_pop = any(ex.get("population") and ex.get("applies_to") is None for ex in env.p.exclusions)
    if not has_pop:   # validity does not depend on the sample: one pass over every unit
        val = _unit_validity(env, env.sessions, base)
        for a, us in per_arm.items():
            c, k = 0, 0
            for u in us:
                if c >= planned.get(a, 0):
                    break
                k += 1
                c += bool(val.get(u))
            take[a] = k
    for _ in range(50 if has_pop else 0):
        keep_units = set(u for a, us in per_arm.items() for u in us[:take[a]])
        kept = [s for u, _a in order if u in keep_units for s in by_unit[u]]
        val = _unit_validity(env, kept, base)
        changed = False
        for a, us in per_arm.items():
            v = sum(1 for u in us[:take[a]] if val.get(u))
            want = planned.get(a, 0)
            if v < want and take[a] < len(us):
                take[a] = min(len(us), take[a] + (want - v))
                changed = True
            elif v > want:   # a cutoff moved: drop trailing units beyond the planned valid count
                k, c = 0, 0
                for u in us[:take[a]]:
                    k += 1
                    c += bool(val.get(u))
                    if c == want:
                        break
                if k < take[a]:
                    take[a], changed = k, True
        if not changed:
            break
    keep_units = {u for a, us in per_arm.items() for u in us[:take[a]]}
    dropped = sum(1 for u, _a in order if u not in keep_units)
    if not dropped:
        return env, 0
    env2 = Env(env.p)
    env2.sessions, env2.shared = [s for s in env.sessions if (id(s.group) if s.group else id(s)) in keep_units], env.shared
    return env2, dropped


def valid_counts(protocol, runs):
    """Per run: {arm: valid units} after ALL exclusions (per-session and population cutoffs; groups count once),
    read from run_from_env rows. A runner tops up until each arm reaches its plan, then calls run_from_env(...,
    planned=plan) so the kept prefix is exactly the plan (integration review 1 M2)."""
    out = []
    for run in runs:
        units = {}
        for r in run.get("sessions") or []:
            parts = r["session"].split(":")
            key = ":".join(parts[:2])   # arm:index (group members share it)
            ok = r["status"] == "completed" and not r["excluded"]
            units[(r["arm"], key)] = units.get((r["arm"], key), True) and ok
        counts = {}
        for (arm, _k), ok in units.items():
            counts[arm] = counts.get(arm, 0) + bool(ok)
        out.append(counts)
    return out


def _itt(tables, exclusion_ids):
    """Intention to treat: every completed row, session-level exclusions ignored (row trims and pending kept)."""
    t2 = copy.deepcopy(tables)
    for rows in t2.values():
        for r in rows:
            r["excluded"] = False
            r["excluded_for"] = [x for x in (r.get("excluded_for") or []) if x not in exclusion_ids]
    return t2


def run_from_env(env, seed, policy=None, planned=None):
    """One seed's run as plain data: unit tables (analysed, and intention-to-treat), per-session validity summary.
    planned ({arm: n}): keep the first sessions per arm until n valid units, drop the rest (recorded)."""
    truncated = 0
    if planned:
        env, truncated = _truncate(env, planned)
    done = [s for s in env.sessions if s.status]
    pop = env.population_exclusions(done)
    scoped = {ex["id"]: ex.get("applies_to") for ex in env.p.exclusions}
    sessions = []
    for s in env.sessions:
        rec = s.record() if s.status else None
        key = "%s:%s" % (s.spec["arm"], s.spec["index"])
        sid = key + (":%s" % rec["participant"] if rec and rec.get("group") is not None else "")
        if rec is None:
            sessions.append({"session": sid, "arm": s.spec["arm"], "status": "incomplete", "excluded": [],
                             "excluded_scoped": [], "pending": []})
            continue
        ex_all = list(rec["excluded"]) + [x["id"] for x in pop.get(key, [])]
        sessions.append({"session": sid, "arm": rec["arm"], "status": rec["status"],
                         "excluded": sorted({x for x in ex_all if scoped.get(x) is None}),
                         "excluded_scoped": sorted({x for x in ex_all if scoped.get(x) is not None}),
                         "pending": list(rec["pending"])})
    tables = env.unit_tables()
    ex_ids = {ex["id"] for ex in env.p.exclusions}
    return {"seed": seed, "policy": policy, "tables": tables, "tables_itt": _itt(tables, ex_ids),
            "sessions": sessions, "truncated_sessions": truncated}


def _simulate_once(protocol, policy, n, seed, planned=None):
    env, problems, _ = checks.play(protocol, n, seed, policy)
    run = run_from_env(env, seed, policy, planned)
    run["problems"] = problems[:10]
    return run


def simulate(protocol, policy, n, seed, top_up=True, max_factor=10):
    """Run sessions with a built-in policy (checks.play: random | keyed | floor) at n per arm ({arm: n units}).
    top_up: as §8.2 says agent sessions are topped up after exclusions, units are added per arm until the valid
    units after ALL exclusions (valid_counts, population cutoffs included) reach n, up to max_factor times n; the
    run keeps the first n valid units in order (_truncate). The run records the n it opened."""
    want, cur = dict(n), dict(n)
    run = _simulate_once(protocol, policy, cur, seed, want)
    for _ in range(8 if top_up else 0):
        v = valid_counts(protocol, [run])[0]
        short = {a: want[a] - v.get(a, 0) for a in want if v.get(a, 0) < want[a]}
        if not short:
            break
        nxt = dict(cur)
        for a, miss in short.items():
            units = len({":".join(r["session"].split(":")[:2]) for r in run["sessions"] if r["arm"] == a}) or 1
            share = max(v.get(a, 0) / units, 1.0 / max_factor)
            nxt[a] = min(cur[a] + int(math.ceil(miss / share)) + 1, want[a] * max_factor)
        if nxt == cur:
            break
        cur = nxt
        run = _simulate_once(protocol, policy, cur, seed, want)
    run["n_per_arm"] = cur
    run["n_target_per_arm"] = want
    return run


def baseline_run(protocol, n, seed=0, max_factor=10):
    """The random-answer baseline at the agent n (§8.2), topped up like agent sessions; fixed seed. Policy `floor`:
    answers from the State only (checks.random_answers + redraws on State errors), never helped by protocol
    internals; exclusions apply as for agents. An effect it cannot reach is baseline_not_computable."""
    return simulate(protocol, "floor", n, seed, True, max_factor)


def _completion(run):
    rows = run.get("sessions") or []
    n = len(rows)
    done = sum(r["status"] == "completed" for r in rows)
    valid = sum(r["status"] == "completed" and not r["excluded"] for r in rows)
    return {"sessions": n, "completed": done, "valid": valid,
            "completion_rate": round(done / n, 3) if n else None, "valid_rate": round(valid / n, 3) if n else None}


def arm_count(arm, field):
    """A structured per-arm count {value, cite} (DESIGN §8.7; schema arms[].n_analysed / n_recruited), or a legacy
    bare integer. Returns (value, basis) or (None, None). Prose notes are never parsed (review rewards-5)."""
    v = arm.get(field)
    if isinstance(v, dict) and _num(v.get("value")) is not None:
        return int(v["value"]), field + (" (cited)" if v.get("cite") else " (no cite)")
    if _num(v) is not None and not isinstance(v, bool):
        return int(v), field + " (legacy bare count, no cite)"
    return None, None


def analysed_n(arm):
    """The human analysed n of an arm (§8.2 plans on it): arms[].n_analysed; else n_paper, labelled
    'n_paper_unverified' (it may be the recruited n)."""
    n, basis = arm_count(arm, "n_analysed")
    if n is not None:
        return n, basis
    if _num(arm.get("n_paper")) is not None:
        return int(arm["n_paper"]), "n_paper_unverified"
    return None, None


def agent_n(protocol, sessions=None, cap=None):
    """Agent n per runnable arm: the human analysed n (§8.2; analysed_n), unless overridden (sessions: N per arm)
    or capped (cap: min(human n, cap); arms without a printed n get cap). Arms with no n at all are listed."""
    out, missing = {}, []
    for a in protocol.arms:
        if a.get("runnable") is False:
            continue
        hn, _ = analysed_n(a)
        if sessions is not None:
            out[a["id"]] = int(sessions)
        elif hn is not None:
            out[a["id"]] = hn if cap is None else min(hn, int(cap))
        elif cap is not None:
            out[a["id"]] = int(cap)
        else:
            missing.append(a["id"])
    return out, missing


def _agent_effect_side(e, block, scale, op):
    side = {"value": None, "se": None, "n": None, "p": None, "p_relation": None, "direction": None,
            "status": block.get("status"), "reason": block.get("reason")}
    if block.get("status") != "computed":
        return _to_scale(side, scale, op)
    v = _num(block.get("value"))
    se = _num(block.get("se"))
    if se is None and op == "proportion_vs_chance":   # binomial SE of the share (= SE of share - chance)
        c = ((block.get("cells") or {}).get("share") or {})
        if c.get("n"):
            se = math.sqrt(c["proportion"] * (1 - c["proportion"]) / c["n"])
    side["arm_sd"] = {str(a): [c["sd"], c["n"]] for a, c in (block.get("cells") or {}).items()
                      if isinstance(c, dict) and c.get("sd") is not None and c.get("n")}
    zv = zero_variance(e, block, op)
    if zv:   # maintainers 2026-11-08: zero within-arm variance is an agent-side failure for every op, never p = 0
        side.update(status="zero_variance", reason="zero within-arm variance: %s" % zv, value_degenerate=v)
        return _to_scale(side, scale, op)
    test = block.get("test") or {}
    p = _num(test.get("p"))
    p_basis = "op test" if p is not None else None
    if p is None and op == "smd" and v is not None:   # t from d and the cell n (df = n1 + n2 - 2), not a normal z
        ns = [c.get("n") for c in (block.get("cells") or {}).values() if isinstance(c, dict)]
        if len(ns) == 2 and all(ns) and sum(ns) > 2:
            t_ = v * math.sqrt(ns[0] * ns[1] / (ns[0] + ns[1]))
            p, p_basis = checks.effects_core.p_t(t_, sum(ns) - 2), "derived: t = d sqrt(n1 n2 / (n1 + n2)), df n1 + n2 - 2"
    if p is None and v is not None and se:
        p, p_basis = p_normal(v / se), "derived: z = value / SE"
    direction = _sign(v)
    if op == "contingency" and not block.get("signed"):
        direction = None
    side.update(value=v, se=se, n=_num(block.get("n")), p=p, p_relation="=" if p is not None else None,
                p_basis=p_basis, direction=direction, test=test or None)
    return _to_scale(side, scale, op)


def _human_cell_extreme(e, arm):
    """True when the paper's own cell for this arm is at 0% or 100% (then an agent cell there is no failure)."""
    ct = ((e.get("reported") or {}).get("cells") or {}).get(str(arm))
    if not isinstance(ct, dict):
        return False
    share, _, _ = _share(ct)
    return share is not None and share in (0.0, 1.0)


def zero_variance(e, block, op):
    """A reason when an agent arm (or the paired differences) has no within-arm variance, else None."""
    cells = block.get("cells") or {}
    if op in ("mean_difference", "smd", "interaction"):
        bad = [a for a, c in cells.items() if isinstance(c, dict) and (c.get("n") or 0) >= 2 and c.get("sd") == 0]
        return ("every answer identical in %s" % ", ".join(map(str, bad))) if bad else None
    if op == "paired_difference":
        d = cells.get("difference") or {}
        return "every paired difference identical" if (d.get("n") or 0) >= 2 and d.get("sd") == 0 else None
    if op in ("proportion_difference", "proportion_vs_chance"):
        bad = [a for a, c in cells.items() if isinstance(c, dict) and c.get("n") and c.get("proportion") in (0, 1)
               and not _human_cell_extreme(e, a if op == "proportion_difference" else "share")]
        return ("every answer the same in %s (a 0%%/100%% cell the paper does not have)" % ", ".join(map(str, bad))) \
            if bad else None
    return None


def _agent_target_side(tv, t):
    side = {"value": tv.get("agent"), "n": tv.get("n_agent"), "k": tv.get("k_agent"),
            "se": (tv["sd_agent"] / math.sqrt(tv["n_agent"])) if tv.get("sd_agent") is not None and tv.get("n_agent") else None,
            "p": None, "direction": None, "pending_share": tv.get("pending_share"),
            "uncoded_share": tv.get("uncoded_share"), "status": "computed" if tv.get("agent") is not None else "not_ready",
            "reason": None if tv.get("agent") is not None else "no analysable rows",
            "arm_sd": {"all": [tv["sd_agent"], tv["n_agent"]]} if tv.get("sd_agent") is not None and tv.get("n_agent") else {}}
    hum = t.get("human") or {}
    h_ext = (_num(hum.get("k")) is not None and _num(hum.get("n")) and hum["k"] in (0, hum["n"])) or \
        (_num(hum.get("value")) is not None and hum["value"] in (0, 1) and _num(hum.get("n")))   # printed 0% / 100%
    if side["value"] is not None and (
            (t.get("stat") == "mean" and tv.get("sd_agent") == 0 and (side["n"] or 0) >= 2)
            or (t.get("stat") == "share" and side["value"] in (0, 1) and not h_ext)):
        side.update(value=None, status="zero_variance", value_degenerate=tv.get("agent"),
                    reason="zero within-arm variance: every analysed answer identical")
    return _to_scale(side, scale_of("target", t.get("stat")), t.get("stat"))


def _rows_per_session(p, tables, x, kind):
    """Analysed rows per participant (session or group) for one effect / target; > 1 means trials or ratings."""
    rows = [r for r in tables.get(x.get("unit"), []) if not r["excluded"]
            and not (set(r.get("excluded_for") or []) & {x["id"], x.get("unit")})]
    if kind == "effect":
        rows = checks.effects_core._rows(rows, x)
    else:
        rows = [r for r in rows if all(r.get(k) == v for k, v in (x.get("where") or {}).items())]
    keys = {r.get("session", r.get("group")) for r in rows}
    return round(len(rows) / len(keys), 3) if keys else None


def _pending_shares(p, tables):
    out = {}
    for e in checks.all_effects(p):
        rows = [r for r in tables.get(e["unit"], []) if not r["excluded"]
                and not (set(r.get("excluded_for") or []) & {e["id"], e["unit"]})]
        k = sum(1 for r in rows if checks._pending(r, [e["id"], e["unit"]]))
        out[e["id"]] = round(k / len(rows), 3) if rows else None
    return out


def _pool_tables(runs):
    pooled = {}
    for i, run in enumerate(runs):
        for name, rows in run["tables"].items():
            for r in rows:
                r2 = dict(r)
                for key in ("session", "group"):
                    if key in r2:
                        r2[key] = "s%s:%s" % (run["seed"], r2[key])
                pooled.setdefault(name, []).append(r2)
    return pooled


# ---------------------------------------------------------------------------------------------- EvalData
class EvalData:
    def __init__(self, d):
        self.d = d

    # convenient views
    @property
    def items(self):
        return self.d["items"]

    @property
    def seeds(self):
        return self.d["seeds"]

    @property
    def sessions(self):
        return self.d["sessions"]

    def to_dict(self):
        return self.d

    @classmethod
    def from_dict(cls, d):
        if d.get("schema") != SCHEMA:
            raise ValueError("not an EvalData dict (schema %r)" % d.get("schema"))
        return cls(d)

    @classmethod
    def build(cls, protocol, runs, baseline=None, provenance=None, planned=None):
        """protocol: engine.Protocol. runs: [run_from_env(...) or simulate(...)] one per seed. baseline: a random-
        answer run at the agent n (simulate(protocol, 'random', n, seed)) or None."""
        p = protocol
        a = p.raw.get("analysis") or {}
        effects = checks.all_effects(p)
        targets = a.get("targets", [])
        per_seed_blocks = [checks.effect_blocks(p, run["tables"]) for run in runs]
        per_seed_pending = [_pending_shares(p, run["tables"]) for run in runs]
        per_seed_tv = [{x["id"]: x for x in checks.target_values(p, run["tables"])} for run in runs]
        itt_blocks = [checks.effect_blocks(p, run.get("tables_itt") or run["tables"]) for run in runs]
        itt_tv = [{x["id"]: x for x in checks.target_values(p, run.get("tables_itt") or run["tables"])} for run in runs]
        pooled_tables = _pool_tables(runs) if runs else {}
        pooled_blocks = checks.effect_blocks(p, pooled_tables) if runs else []
        pooled_tv = {x["id"]: x for x in checks.target_values(p, pooled_tables)} if runs else {}
        base_blocks, base_tv = None, None
        if baseline is not None:
            base_blocks = checks.effect_blocks(p, baseline["tables"])
            base_tv = {x["id"]: x for x in checks.target_values(p, baseline["tables"])}
            comp = _completion(baseline)
            base_why = ("baseline_not_computable: the State-only random floor completed %s and stayed valid in %s of "
                        "%d sessions (no protocol internals are used to help it)" % (
                            comp["completion_rate"], comp["valid_rate"], comp["sessions"]))
        items = []
        for i, e in enumerate(effects):
            op = (e.get("compute") or {}).get("op")
            scale = scale_of("effect", op)
            hum, nc = human_effect(e)
            _to_scale(hum, scale, op)
            if hum["value"] is not None and hum["se_s"] is None and "human_se" not in nc and hum.get("se_basis"):
                nc["human_se"] = "SE not on the scoring scale (n missing)"
            role = e.get("role")
            scoring, scoring_why = scoring_of(e, "effect")
            seeds_side = []
            for run, blocks, pend in zip(runs, per_seed_blocks, per_seed_pending):
                s_ = _agent_effect_side(e, blocks[i], scale, op)
                s_["seed"], s_["pending_share"] = run["seed"], pend.get(e["id"])
                s_["rows_per_session"] = _rows_per_session(p, run["tables"], e, "effect")
                seeds_side.append(s_)
            pooled = _agent_effect_side(e, pooled_blocks[i], scale, op) if runs else None
            base = None
            if base_blocks is not None:
                bb = base_blocks[i]
                base = _agent_effect_side(e, bb, scale, op)
                base.update(seed=baseline["seed"], basis="State-only random answers (floor), exclusions applied")
                if base.get("value") is None:
                    base["reason"] = "%s; %s" % (base_why, bb.get("reason") or bb.get("status"))
            items.append(_item("effect", e, role, scoring, scoring_why, scale, hum, nc, seeds_side, pooled, base,
                               group=e["id"], unit_per=(p.units.get(e.get("unit")) or {}).get("per", "session")))
            items[-1]["agent"]["per_seed_itt"] = [dict(_agent_effect_side(e, b[i], scale, op), seed=run["seed"])
                                                  for run, b in zip(runs, itt_blocks)]
        for t in targets:
            scale = scale_of("target", t.get("stat"))
            hum, nc = human_target(t)
            _to_scale(hum, scale, t.get("stat"))
            if hum["value"] is not None and hum["se_s"] is None and "human_se" not in nc:
                nc["human_se"] = "no SE on the scoring scale"
            scoring, scoring_why = scoring_of(t, "target")
            seeds_side = []
            for run, tvs in zip(runs, per_seed_tv):
                s_ = _agent_target_side(tvs.get(t["id"], {}), t)
                s_["seed"] = run["seed"]
                s_["rows_per_session"] = _rows_per_session(p, run["tables"], t, "target")
                seeds_side.append(s_)
            pooled = _agent_target_side(pooled_tv.get(t["id"], {}), t) if runs else None
            base = None
            if base_tv is not None:
                base = _agent_target_side(base_tv.get(t["id"], {}), t)
                base.update(seed=baseline["seed"], basis="State-only random answers (floor), exclusions applied")
                if base.get("value") is None:
                    base["reason"] = "%s; no analysable rows" % base_why
            items.append(_item("target", t, t.get("role"), scoring, scoring_why, scale, hum, nc, seeds_side, pooled,
                               base, group=t.get("effect") or ("target:" + t["id"]),
                               unit_per=(p.units.get(t.get("unit")) or {}).get("per", "session")))
            items[-1]["agent"]["per_seed_itt"] = [dict(_agent_target_side(tv.get(t["id"], {}), t), seed=run["seed"])
                                                  for run, tv in zip(runs, itt_tv)]
        # never-scored lists (kept visible)
        blocked = [{"id": x.get("id"), "kind": k, "reason": "arm not runnable (blocked_arm_%s)" % k}
                   for k, key in (("effects", "blocked_arm_effects"), ("targets", "blocked_arm_targets"))
                   for x in a.get(key, [])]
        sess = []
        for run in runs:
            rows = run.get("sessions") or []
            by_arm = {}
            for r in rows:
                b = by_arm.setdefault(r["arm"], {"run": 0, "completed": 0, "excluded": 0, "pending": 0})
                b["run"] += 1
                b["completed"] += r["status"] == "completed"
                b["excluded"] += bool(r["excluded"])
                b["pending"] += bool(r["pending"])
            excl_ids = {}
            for r in rows:
                for x in r["excluded"] + r["excluded_scoped"]:
                    excl_ids[x] = excl_ids.get(x, 0) + 1
            sess.append({"seed": run["seed"], "policy": run.get("policy"), "n": len(rows),
                         "completed": sum(r["status"] == "completed" for r in rows),
                         "excluded": sum(bool(r["excluded"]) for r in rows),
                         "pending": sum(bool(r["pending"]) for r in rows),
                         "by_arm": by_arm, "by_exclusion": excl_ids, "problems": run.get("problems", []),
                         "rows": rows})
        human_n = {x["id"]: x.get("n_paper") for x in p.arms if x.get("runnable") is not False}
        plan = plan_of(p, runs, planned)
        for s_, run in zip(sess, runs):
            s_["run_status"], s_["valid_per_arm"], s_["short_arms"] = run_status(p, run, plan["per_arm"])
        d = {"schema": SCHEMA, "study": p.id, "version": p.version, "seeds": [r["seed"] for r in runs],
             "policy": runs[0].get("policy") if runs else None,
             "baseline": dict(_completion(baseline), seed=baseline["seed"], policy="floor",
                              n_per_arm=baseline.get("n_per_arm"),
                              rule="checks.random_answers on the State only (redrawn on State errors), at the agent n "
                                   "topped up after exclusions, one fixed seed, same for every model; no protocol "
                                   "internals (keys, coding cases, hidden limits, validation targets)")
             if baseline else None,
             "items": items,
             "sessions": {"per_seed": sess, "human_n_per_arm": human_n,
                          "exclusion_ids": [x["id"] for x in p.exclusions],
                          "whole_session_exclusion_ids": [x["id"] for x in p.exclusions if x.get("applies_to") is None]},
             "not_scored": {"blocked": blocked, "unsupported": a.get("unsupported", []),
                            "reference_only": a.get("reference_only", []), "not_comparable": a.get("not_comparable", [])},
             "plan": plan,
             "provenance": dict(provenance or {}, scales={"correlation": "fisher_z", "target share": "empirical logit"},
                                protocol_sha16=p.version, code_sha16=code_hash())}
        return cls(d)


CODE_FILES = ("engine.py", "expr.py", "checks.py", "effects_core.py", "evaldata.py", "rewards.py", "serve.py",
              "score.py")


def code_hash():
    h = hashlib.sha256()
    for name in CODE_FILES:
        h.update((Path(__file__).parent / name).read_bytes())
    return h.hexdigest()[:16]


def plan_of(p, runs, planned=None):
    """The planned agent n per arm and the factor planned / human that sets n_a = N_h * factor for every item,
    independent of how many agent rows actually arrived.

    Caller contract (skills/run/run_study.py and any outside runner): pass the run's own plan as
    EvalData.build(..., planned={arm: n}) and run_from_env(env, seed, policy, planned={arm: n}) (n = units: groups
    for group arms). Arms left out are not run. A plan that equals the human analysed n of every runnable arm is
    `official`; any other n or a subset of arms is `non_official` (values, no verdict). `underpowered_run` means the
    run fell short of ITS OWN plan (valid < 0.9 x planned in a planned arm), never that the caller chose a smaller n.
    Without `planned`, a run's n_target_per_arm, else the human analysed n of every arm."""
    if planned is None:
        planned = next((r.get("n_target_per_arm") for r in runs if r.get("n_target_per_arm")), None)
    if planned is None:
        planned, _ = agent_n(p)
    human = {a["id"]: analysed_n(a)[0] for a in p.arms if a.get("runnable") is not False}
    basis = {a["id"]: analysed_n(a)[1] for a in p.arms if a.get("runnable") is not False}
    both = [a for a in planned if human.get(a)]
    factor = sum(planned[a] for a in both) / sum(human[a] for a in both) if both else None
    official = bool(both) and set(planned) == set(human) and all(planned.get(a) == human.get(a) for a in human)
    unverified = sorted(a for a in planned if basis.get(a) == "n_paper_unverified")
    recruited = {a["id"]: arm_count(a, "n_recruited")[0] for a in p.arms if a.get("runnable") is not False}
    analysed_given = {a["id"]: arm_count(a, "n_analysed")[0] is not None
                      for a in p.arms if a.get("runnable") is not False}
    return {"per_arm": dict(planned), "human_per_arm": human, "human_n_basis": basis, "factor": factor,
            "recruited_per_arm": recruited, "analysed_structured": analysed_given,
            "official": official, "n_unverified_arms": unverified,
            "official_n_basis": ("unverified" if unverified else "verified") if official else None,
            "subset_of_arms": sorted(set(human) - set(planned)),
            "official_rule": "official (verifiers, scoreboard) only when planned n = human analysed n in every arm; "
                             "any other n is a non_official report",
            "rule": "n_a(item) = N_h(item) * sum(planned n) / sum(human n) over arms with a printed n; a seed whose "
                    "valid sessions fall below 0.9 x planned in any arm is an underpowered_run (not scored)"}


def run_status(p, run, planned):
    """ok | underpowered_run: valid units per arm (valid_counts: all exclusions, groups once) < 0.9 x the plan."""
    valid = valid_counts(p, [run])[0]
    short = {a: {"valid": valid.get(a, 0), "planned": k} for a, k in planned.items() if valid.get(a, 0) < 0.9 * k}
    return ("underpowered_run" if short else "ok"), valid, short


def _item(kind, x, role, scoring, scoring_why, scale, hum, nc, seeds_side, pooled, base, group, unit_per=None):
    role_eff = role if role in ROLES else "test"
    agent_nc = None
    if seeds_side and all(s["value"] is None for s in seeds_side):
        agent_nc = "; ".join(sorted({str(s.get("reason") or s.get("status")) for s in seeds_side}))[:200]
    vals = [s["value_s"] for s in seeds_side if s.get("value_s") is not None]
    ses = [s["se_s"] for s in seeds_side if s.get("se_s") is not None]
    se_a = None
    if vals and len(ses) == len(vals):
        m = sum(vals) / len(vals)
        between = sum((v - m) ** 2 for v in vals) / (len(vals) - 1) if len(vals) > 1 else 0.0
        se_a = math.sqrt(sum(s * s for s in ses) / len(ses) + between)
    nc = dict(nc)
    if agent_nc:
        nc["agent"] = agent_nc
    if base is not None and base.get("value") is None:
        nc["baseline"] = str(base.get("reason") or base.get("status") or "not computed")
    where = dict((x.get("compute") or {}).get("where") or {}, **(x.get("where") or {}))
    arms = where.get("arm")
    arms = [arms] if isinstance(arms, str) else (list(arms) if isinstance(arms, list) else None)
    comp, con = x.get("compute") or {}, x.get("contrast") or {}
    if arms is None and comp.get("groupBy") == "arm" and con.get("treatment") and con.get("reference"):
        arms = [str(con["treatment"]), str(con["reference"])]   # a contrast between arms
    return {"key": "%s:%s" % (kind, x["id"]), "id": x["id"], "kind": kind, "group": group, "arms": arms,
            "role": role_eff, "role_declared": role in ROLES, "default_scored": role_eff in SCORED_ROLES,
            "scoring": scoring, "scoring_why": scoring_why, "scale": scale, "unit_per": unit_per,
            "op": (x.get("compute") or {}).get("op") if kind == "effect" else x.get("stat"),
            "direction_claimed": x.get("direction_claimed"), "provisional": bool(x.get("provisional")),
            "human": hum, "agent": {"per_seed": seeds_side, "pooled": pooled, "se_a": se_a},
            "baseline": base, "not_computable": nc}
