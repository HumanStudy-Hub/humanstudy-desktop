"""Rewards and verifiers (DESIGN.md §8.7). A reward is a pure function of EvalData, registered by a versioned id.

    from hsenv.rewards import score, Verifier
    r = score(ev, "significance_match", alpha=0.05)     # Reward(value, passed, per_effect, not_computable, spec)
    Verifier("human_noise_score", threshold=0.5).evaluate(ev)

Rules every reward follows (v1, maintainer decisions of 2026-11-08 after review-rewards-1):
- it reads EvalData only (never sessions);
- a missing *human* number (or baseline) makes the item `not_computable` with a reason: it leaves the denominator,
  is never scored 0 and never imputed;
- an item whose *agent* side cannot be computed (no variance, constant answers, empty cell, no test) scores 0 for
  that reward with reason `agent_side_failed: ...` (listed in spec.agent_side_failed); it never leaves the
  denominator, so a policy cannot drop the items it would fail;
- se_h(n_a) and every status use the PLANNED agent n (human n per arm unless the run overrode it), never the
  observed one; a run whose valid sessions fall below 0.9 x planned in any arm is refused (`underpowered_run`);
- population rewards are computed per seed and averaged; the per-seed values and their SD are in `spec`, with the
  scoring constants, EvalData's protocol and code hashes;
- the default scored set is every effect (and, for level rewards, target) whose role is `test` or `paper_claim`
  (an item without a declared role counts as `test`: §3.5 marks the ones that are not tests). Other roles are
  computed and reported in `spec.reported_only`, not aggregated;
- `suspect`, `direction_unresolved`, `scoring: none / not_comparable` are never scored; `scoring: direction_only`
  (reference mismatch) is scored by direction_match only.
"""
import fnmatch
import math
import random
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Optional

REGISTRY = {}
SCOPES = ("step", "session", "population")
CONST = {"ceiling_z": 0.674, "range_z": 1.96, "uninformative_z": 2.8, "s_null_draws": 4000,
         "underpowered_share": 0.9}
FAILED = "agent_side_failed: "
REPORT_SCOPE = "offline_report — not a leaderboard"   # v0.8 (maintainers 2026-11-08; DESIGN §8.7 leaderboard item)


@dataclass(frozen=True)
class Reward:
    value: Optional[float]                       # None = not computable (never 0 by default)
    passed: Optional[bool]                       # verifier view
    per_effect: Mapping[str, Optional[float]]
    not_computable: Mapping[str, str]            # item key -> reason (human / baseline side only)
    spec: Mapping[str, Any] = field(default_factory=dict)

    def to_dict(self):
        return {"value": self.value, "passed": self.passed, "per_effect": dict(self.per_effect),
                "not_computable": dict(self.not_computable), "spec": dict(self.spec)}


@dataclass(frozen=True)
class RewardFn:
    id: str
    name: str
    version: str
    scope: str
    fn: Callable
    threshold: Optional[float]
    doc: str


def reward(id, version=None, scope="population", threshold=None):
    """Register a reward. id 'name-v0' (or name + version)."""
    if scope not in SCOPES:
        raise ValueError("scope must be one of %s" % (SCOPES,))
    name, _, ver = id.rpartition("-") if version is None else (id, None, version)
    if version is None and not re.fullmatch(r"v\d+", ver):
        raise ValueError("reward id needs a version suffix, e.g. %s-v0" % id)
    full = "%s-%s" % (name, ver)

    def deco(fn):
        if full in REGISTRY:
            raise ValueError("reward %s already registered" % full)
        REGISTRY[full] = RewardFn(full, name, ver, scope, fn, threshold, (fn.__doc__ or "").strip())
        return fn
    return deco


def get(rid):
    if rid in REGISTRY:
        return REGISTRY[rid]
    cands = [k for k in REGISTRY if k.rpartition("-")[0] == rid]
    if cands:   # latest version by number (v10 after v2)
        return REGISTRY[max(cands, key=lambda k: int(k.rpartition("-v")[2]))]
    raise KeyError("unknown reward %r (known: %s)" % (rid, ", ".join(sorted(REGISTRY))))


class _View:
    """EvalData with the agent side swapped for its intention-to-treat rows (every completed session)."""
    def __init__(self, ev):
        self.d = dict(ev.d, items=[dict(it, agent=dict(it["agent"], per_seed=it["agent"].get("per_seed_itt")
                                                       or it["agent"]["per_seed"])) for it in ev.items])

    items = property(lambda self: self.d["items"])
    seeds = property(lambda self: self.d["seeds"])
    sessions = property(lambda self: self.d["sessions"])


def exclusion_rates(ev):
    """Agent whole-session exclusion rate against the human rate (review rewards-5).
    - human rate = (n_recruited - n_analysed) / n_recruited from the structured arm fields only, when every planned
      arm has both; otherwise 'unknown': the intention-to-treat view is not applied and the run is itt_unchecked.
    - agent rate = excluded / completed sessions pooled over seeds; incomplete sessions are dropouts, reported
      separately (score after all sessions finish).
    - margin = 1.96 sqrt(r (1 - r) (1/n_agent + 1/n_human_recruited)), with r(1-r) >= 1/n_agent.
    Returns (itt_applies, detail)."""
    plan = ev.d.get("plan") or {}
    rec, ana = plan.get("recruited_per_arm") or {}, plan.get("human_per_arm") or {}
    given = plan.get("analysed_structured") or {}
    arms = list((plan.get("per_arm") or {}).keys())
    rows = [r for s in ev.sessions.get("per_seed", []) for r in s.get("rows", [])]
    done = [r for r in rows if r["status"] == "completed"]
    n_a = len(done)
    agent = sum(1 for r in done if r["excluded"]) / n_a if n_a else None
    det = {"agent_rate": agent, "agent_completed": n_a, "agent_opened": len(rows), "agent_dropouts": len(rows) - n_a,
           "dropout_rate": (len(rows) - n_a) / len(rows) if rows else None,
           "dropout_note": "dropouts are reported, never part of the intention-to-treat decision (DESIGN §8.7)"}
    whole = ev.sessions.get("whole_session_exclusion_ids")
    if whole is not None and not whole:   # nothing can exclude a whole session: both views are the same
        det.update(human_rate="not applicable", itt_unchecked=False, itt_not_applicable=True,
                   note="the protocol declares no whole-session exclusion")
        return False, det
    known = bool(arms) and all(rec.get(a) and given.get(a) and ana.get(a) is not None and rec[a] >= ana[a]
                               for a in arms)
    if not known or agent is None:
        det.update(human_rate="unknown", itt_unchecked=True,
                   note="no structured n_recruited and n_analysed for every arm: the intention-to-treat decision "
                        "was not possible (analysed view kept)")
        return False, det
    n_h = sum(rec[a] for a in arms)
    human = sum(rec[a] - ana[a] for a in arms) / n_h
    var = max(human * (1 - human), 1.0 / n_a)
    margin = CONST["range_z"] * math.sqrt(var * (1.0 / n_a + 1.0 / n_h))
    det.update(human_rate=human, human_recruited=n_h, margin=margin, threshold=human + margin, itt_unchecked=False)
    return agent > human + margin, det


def _min_of_views(ev, rf, params):
    """Score the analysed rows (after the paper's exclusions) and all completed rows (intention to treat). The lower
    value is kept only when the agent's whole-session exclusion rate exceeds the human rate by more than the
    binomial noise at the planned n (review rewards-4 M2); otherwise the analysed view. Both are always reported."""
    pp = rf.fn(ev, **params)
    itt = rf.fn(_View(ev), **params)
    applies, det = exclusion_rates(ev)
    pick = pp
    if applies:
        if pp.value is not None and itt.value is not None:
            pick = itt if itt.value < pp.value else pp
        elif itt.spec.get("status") == "agent_side_failed" and pp.value is not None:
            pick = itt
    spec = dict(pick.spec, value_analysed=pp.value, value_itt=itt.value, exclusion_rates=det, itt_applies=applies,
                itt_unchecked=det.get("itt_unchecked"), itt_not_applicable=det.get("itt_not_applicable", False),
                view="intention_to_treat" if pick is itt else "analysed",
                view_rule="min(analysed, all completed rows) only when the agent's whole-session exclusion rate "
                          "exceeds the human rate (structured n_recruited / n_analysed) + 1.96 two-sample SE; else "
                          "analysed; unknown human rate -> analysed, itt_unchecked")
    return Reward(pick.value, pick.passed, pick.per_effect, pick.not_computable, spec)


def underpowered(ev):
    """{seed: short arms} for seeds whose valid sessions fall below 0.9 x planned in some arm."""
    return {str(s["seed"]): s.get("short_arms") for s in ev.sessions.get("per_seed", [])
            if s.get("run_status") == "underpowered_run"}


def score(ev, rid, **params):
    rf = get(rid)
    meta = {"id": rf.id, "name": rf.name, "version": rf.version, "scope": rf.scope, "params": params,
            "study": ev.d.get("study"), "study_version": ev.d.get("version"), "constants": dict(CONST),
            "protocol_sha16": (ev.d.get("provenance") or {}).get("protocol_sha16"),
            "code_sha16": (ev.d.get("provenance") or {}).get("code_sha16"), "plan": ev.d.get("plan")}
    plan = ev.d.get("plan") or {}
    official = bool(plan.get("official"))   # every scope, validity included (integration review 2)
    labels = {"official": official, "report_scope": REPORT_SCOPE}
    if not official:
        labels["label"] = "non_official: planned n differs from the human analysed n per arm, or a subset of arms " \
                          "(report only, no verdict)"
    elif plan.get("official_n_basis") == "unverified":
        labels["label"] = "verdict on an unverified n: n_paper_unverified for %s (no structured n_analysed)" % \
            ", ".join(plan.get("n_unverified_arms") or [])
        labels["verdict_on_unverified_n"] = True
    if rf.scope == "population" and underpowered(ev):   # labels kept; no verdict on a non_official run
        spec = dict(meta, status="underpowered_run", **labels)
        return Reward(None, False if official else None, {},
                      {"*": "underpowered_run: valid units < 0.9 x the run's own plan %s" % underpowered(ev)}, spec)
    if rf.scope == "population":
        r = _min_of_views(ev, rf, params)
    else:
        r = rf.fn(ev, **params)
    spec = dict(r.spec, **meta)
    spec.update(labels)
    spec.setdefault("status", "scored" if r.value is not None else "not_computable")
    passed = r.passed
    if passed is None and rf.threshold is not None and r.value is not None and official:
        passed = r.value >= rf.threshold
        spec["pass_rule"] = "value >= %s" % rf.threshold
    return Reward(r.value, passed if official else None, r.per_effect, r.not_computable, spec)


@dataclass(frozen=True)
class Verifier:
    """A reward plus a pass rule: value >= threshold, or (rule='all') every selected item computable and passing
    (per-item value >= item_threshold). Not-computable items fail rule 'all' unless allow_not_computable."""
    reward_id: str
    threshold: Optional[float] = None
    rule: str = "threshold"
    item_threshold: float = 1.0
    allow_not_computable: bool = False
    params: Mapping[str, Any] = field(default_factory=dict)

    def evaluate(self, ev):
        r = score(ev, self.reward_id, **dict(self.params))
        if r.spec.get("status") == "underpowered_run" or not r.spec.get("official", True):
            return r   # refused, or a non_official report: no verdict
        if self.rule == "all":
            vals = [v for v in r.per_effect.values() if v is not None]
            passed = bool(vals) and all(v >= self.item_threshold for v in vals) and \
                (self.allow_not_computable or not r.not_computable)
            rule = "every selected item computable and >= %s%s" % (
                self.item_threshold, " (not computable allowed)" if self.allow_not_computable else "")
        else:
            th = self.threshold if self.threshold is not None else get(self.reward_id).threshold
            passed = None if (r.value is None or th is None) else r.value >= th
            rule = "value >= %s" % th
        return Reward(r.value, passed, r.per_effect, r.not_computable, dict(r.spec, pass_rule=rule))


# ---------------------------------------------------------------------------------------------- helpers
def select(ev, effects="default", kinds=("effect",)):
    """(scored, reported_only) item lists. effects: 'default' (roles test/paper_claim), 'all', or a list of
    id / key globs."""
    pool = [it for it in ev.items if it["kind"] in kinds]
    if effects == "default":
        return [it for it in pool if it["default_scored"]], [it for it in pool if not it["default_scored"]]
    if effects == "all":
        return pool, []
    pats = [effects] if isinstance(effects, str) else list(effects)
    hit = [it for it in pool if any(fnmatch.fnmatch(it["id"], x) or fnmatch.fnmatch(it["key"], x) for x in pats)]
    return hit, [it for it in pool if it not in hit]


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def _sd(xs):
    xs = [x for x in xs if x is not None]
    if len(xs) < 2:
        return None
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def _population(ev, items, reported, per_item, grouped=False, extra=None):
    """per_item(item, seed_index) -> (value | None, reason | None, detail). None = human-side not computable (the
    item leaves the denominator); a reason starting 'agent_side_failed' comes with value 0 and stays in it.
    grouped: items of one effect group are averaged first (each effect weighted 1, §8.6)."""
    n_seeds = len(ev.seeds)
    per_effect, nc, details, seed_vals, failed = {}, {}, {}, [], {}
    rep_vals = {}

    def agg(vals_by_item, its):
        if not grouped:
            return _mean([vals_by_item.get(it["key"]) for it in its])
        groups = {}
        for it in its:
            if vals_by_item.get(it["key"]) is not None:
                groups.setdefault(it["group"], []).append(vals_by_item[it["key"]])
        return _mean([_mean(v) for v in groups.values()])

    planned_arms = set(((ev.d.get("plan") or {}).get("per_arm") or {}).keys())
    for si in range(n_seeds):
        vals = {}
        for it in items:
            off = [x for x in (it.get("arms") or []) if planned_arms and x not in planned_arms]
            if off:   # the caller's plan did not run this arm: not an agent failure
                v, why, det = None, "arm(s) %s not in this run's plan" % ", ".join(off), None
            else:
                v, why, det = per_item(it, si)
            if v is None:
                nc.setdefault(it["key"], why or "not computable")
            elif why and why.startswith(FAILED):
                failed.setdefault(it["key"], {})[str(ev.seeds[si])] = why
            vals[it["key"]] = v
            if det is not None:
                details.setdefault(it["key"], []).append(det)
        seed_vals.append(agg(vals, items))
        for it in items:
            if vals[it["key"]] is not None:
                per_effect.setdefault(it["key"], []).append(vals[it["key"]])
        for it in reported:
            v, _, _ = per_item(it, si)
            if v is not None:
                rep_vals.setdefault(it["key"], []).append(v)
    per_effect_m = {it["key"]: _mean(per_effect.get(it["key"], [])) for it in items}
    for k, v in per_effect_m.items():   # human side is seed-independent; defensive only
        if v is not None:
            nc.pop(k, None)
    value = _mean(seed_vals)
    spec = {"per_seed": dict(zip([str(s) for s in ev.seeds], seed_vals)), "sd_across_seeds": _sd(seed_vals),
            "n_scored": sum(1 for v in per_effect_m.values() if v is not None), "n_selected": len(items),
            "agent_side_failed": failed, "n_agent_side_failed": len(failed),
            "reported_only": {k: _mean(v) for k, v in rep_vals.items()},
            "default_set": "roles test + paper_claim (missing role counted as test); others reported, not aggregated",
            "details": details}
    spec.update(extra or {})
    return Reward(value, None, {k: v for k, v in per_effect_m.items() if v is not None}, nc, spec)


def _sig(p, rel, alpha):
    """True / False / None (undecidable from a bound)."""
    if p is None:
        return None
    if rel == "<":
        return True if p <= alpha else None
    if rel == ">":
        return False if p >= alpha else None
    return p < alpha


def _seed_side(it, si):
    s = it["agent"]["per_seed"]
    return s[si] if si < len(s) else None


def item_factor(ev, it):
    """Planned / human analysed n for the item's own arms (compute.where / where arm), else over all arms."""
    plan = ev.d.get("plan") or {}
    arms = it.get("arms")
    pa, ha = plan.get("per_arm") or {}, plan.get("human_per_arm") or {}
    if arms and all(pa.get(x) and ha.get(x) for x in arms):
        return sum(pa[x] for x in arms) / sum(ha[x] for x in arms)
    return plan.get("factor")


def _short(ev, it, a):
    """Effect-scoped exclusions: the item's analysed agent n below 0.9 x its planned n (N_h x plan factor) is an
    agent-side failure (rows-per-participant 1 only, where both n count participants)."""
    factor = item_factor(ev, it)
    h = it["human"]
    plan = ev.d.get("plan") or {}
    if not (plan.get("official") or it.get("arms")):   # a global factor is only exact on official plans
        return None
    if it["scoring"] != "full" or not factor or not h.get("n") or not a or a.get("n") is None:
        return None
    if (a.get("rows_per_session") or 1) > 1.001:
        return None
    want = h["n"] * factor
    if a["n"] < CONST["underpowered_share"] * want:
        return FAILED + "analysed agent n %d < %.1f x planned %.0f (scoped exclusions or missing answers)" % (
            a["n"], CONST["underpowered_share"], want)
    return None


def _agent_reason(a, it):
    return (a or {}).get("reason") or (a or {}).get("status") or it["not_computable"].get("agent") or "no agent rows"


# ---------------------------------------------------------------------------------------------- built-ins
@reward("significance_match-v1", scope="population", threshold=0.8)
def significance_match(ev, alpha=0.05, effects="default", declared_ns=False):
    """Per effect 1 if (agent p < alpha) == (human p < alpha) and, when both are significant, the directions agree
    (for an unsigned / omnibus human test, significance alone); mean over effects. A one-sided printed p is compared
    with the agent's one-sided p in the human direction. declared_ns=True also scores effects with no printed p that
    the paper reads as n.s. (direction_claimed: false). Agent side without a test scores 0 (agent_side_failed)."""
    items, rep = select(ev, effects)

    def one(it, si):
        if it["scoring"] != "full":
            return None, "scoring %s: %s" % (it["scoring"], it["scoring_why"] or "") + \
                ("; the printed p belongs to another sample" if it["scoring"] == "direction_only" else ""), None
        h = it["human"]
        hs = _sig(h["p"], h["p_relation"], alpha)
        if hs is None and declared_ns and h.get("declared_ns"):   # opt-in: the paper's own n.s. reading, no p
            hs = False
        if hs is None:
            return None, (it["not_computable"].get("human_p") or "human p %s%s does not decide p < %s" % (
                h["p_relation"], h["p"], alpha)), None
        na = bool(h.get("direction_na"))
        if hs and h["direction"] is None and not na:   # decided before looking at the agent: symmetric
            return None, "human significant but its direction is unknown: %s" % it["not_computable"].get("human_direction"), None
        a = _seed_side(it, si)
        if a is None or a.get("p") is None:
            return 0.0, FAILED + "no agent test (%s)" % _agent_reason(a, it), None
        if _short(ev, it, a):
            return 0.0, _short(ev, it, a), None
        ap = a["p"]
        one_sided = h.get("p_tail") == "one-sided" and h["direction"] not in (None, 0)
        if one_sided:   # the agent's one-sided p in the claimed direction
            ap = ap / 2 if a.get("direction") == h["direction"] else 1 - ap / 2
        as_ = ap < alpha
        det = {"seed": ev.seeds[si], "human_sig": hs, "agent_sig": as_, "one_sided": one_sided}
        if as_ != hs:
            return 0.0, None, det
        if hs and not na:
            if a.get("direction") is None:
                return 0.0, FAILED + "agent metric has no sign", det
            return float(a["direction"] == h["direction"]), None, dict(det, direction_ok=a["direction"] == h["direction"])
        return 1.0, None, det
    r = _population(ev, items, rep, one, extra={"alpha": alpha})
    r.spec["one_sided_rule"] = "a one-sided printed p is compared with the agent's one-sided p in the human direction"
    return r


@reward("direction_match-v2", scope="population", threshold=0.8)
def direction_match(ev, effects="default", alpha=0.05):
    """Per effect 1 if the sign of the agent contrast equals the printed human sign; mean over effects. Only
    effects whose human result is significant (p < alpha) or whose direction the paper explicitly claims
    (direction_claimed: true) are scored: the sign of a human n.s. contrast is noise. Includes direction_only
    effects (reference mismatch); skips direction_claimed: false and unsigned human tests. An agent value that
    cannot be computed or has no sign scores 0 (agent_side_failed)."""
    items, rep = select(ev, effects)

    def one(it, si):
        if it["scoring"] == "none":
            return None, "scoring none: %s" % it["scoring_why"], None
        hum = it["human"]
        if not (_sig(hum.get("p"), hum.get("p_relation"), alpha) or it.get("direction_claimed") is True):
            return None, "human contrast not significant at %s (p %s%s) and its direction is not claimed: its sign " \
                         "is not scored" % (alpha, hum.get("p_relation") or "", hum.get("p")), None
        h = it["human"]["direction"]
        if h is None:
            return None, it["not_computable"].get("human_direction") or "no human direction", None
        if h == 0:
            return None, "the printed human contrast is exactly 0", None
        a = _seed_side(it, si)
        if a is None or a.get("value") is None:
            return 0.0, FAILED + "agent value not computed (%s)" % _agent_reason(a, it), None
        if a.get("direction") is None:
            return 0.0, FAILED + "agent value has no sign (unsigned metric)", None
        if _short(ev, it, a):
            return 0.0, _short(ev, it, a), None
        return float(a["direction"] == h), None, None
    return _population(ev, items, rep, one, extra={"alpha": alpha})


@reward("effect_gap-v1", scope="population")
def effect_gap(ev, effects="default"):
    """Per effect -|agent - human| in the effect's own metric (higher is better; 0 = identical). The aggregate
    mean mixes metrics across effects; read per_effect for comparisons. The gap has no worst value, so an agent
    side that cannot be computed makes the whole value None with status agent_side_failed (never dropped silently).
    No pass rule unless a Verifier sets one."""
    items, rep = select(ev, effects)

    def one(it, si):
        if it["scoring"] != "full":
            return None, "scoring %s: %s" % (it["scoring"], it["scoring_why"]), None
        if it["human"]["value"] is None:
            return None, it["not_computable"].get("human_value", "no human value"), None
        a = _seed_side(it, si)
        if a is None or a.get("value") is None:
            return float("-inf"), FAILED + "agent value not computed (%s)" % _agent_reason(a, it), None
        return -abs(a["value"] - it["human"]["value"]), None, None
    r = _population(ev, items, rep, one, extra={"metric_note": "mean over effects of mixed metrics"})
    if r.spec["agent_side_failed"]:
        pe = {k: (None if v == float("-inf") else v) for k, v in r.per_effect.items()}
        return Reward(None, False, pe, r.not_computable, dict(r.spec, status="agent_side_failed",
                                                              per_seed={k: None for k in r.spec["per_seed"]}))
    return r


def noise_terms(ev, it, si, baseline_needed=True):
    """§8.2 for one item and seed at the PLANNED agent n. Returns (terms, reason): terms None = human/baseline side
    not computable (reason); terms with 'agent_failed' = agent side failed (reason starts agent_side_failed)."""
    h, nc = it["human"], it["not_computable"]
    if it["scoring"] != "full":
        return None, "scoring %s: %s" % (it["scoring"], it["scoring_why"])
    if h.get("value_s") is None:
        return None, nc.get("human_value") or "human value not on the scoring scale"
    if h.get("se_s") is None:
        return None, "no_uncertainty: " + (nc.get("human_se") or "no human SE")
    if not h.get("n"):
        return None, nc.get("human_n") or "human n unknown (needed to scale the human SE to the agent n)"
    factor = item_factor(ev, it)
    if not factor:
        return None, "no planned agent n relative to the human n (arms print no n): se_h(n_a) undefined"
    se_hN = h["se_s"]
    n_a = h["n"] * factor
    se_hn = se_hN * math.sqrt(h["n"] / n_a)
    tot = math.sqrt(se_hN ** 2 + se_hn ** 2)
    out = {"h": h["value_s"], "se_hN": se_hN, "se_hn": se_hn, "n_agent_planned": n_a, "n_human": h["n"],
           "ceiling": CONST["ceiling_z"] * tot, "range": CONST["range_z"] * tot}
    b = it.get("baseline")
    if b is None or b.get("value_s") is None or b.get("se_s") is None:
        # one floor rule (review rewards-3 M3): without a usable floor (value and SE) the noise score is not
        # computable, and the range is scored only when the human side alone is informative: a contrast whose
        # |h| / se_h >= 2.8 against no effect (0). A level (target) has no null, so it is not scored.
        floor_why = nc.get("baseline") or ("baseline SE unknown" if b is not None and b.get("value_s") is not None
                                           else "no baseline: baseline run missing")
        if baseline_needed:
            return None, floor_why
        if it["kind"] != "effect":
            return None, "uninformative without a floor (%s): a level has no null to test the human value " \
                         "against" % floor_why
        z0 = abs(h["value_s"]) / se_hN
        if z0 < CONST["uninformative_z"]:
            return None, "uninformative without a floor (%s): |h| / se_h = %.2f < %s" % (
                floor_why, z0, CONST["uninformative_z"])
        out["informative_basis"] = "human side alone (|h| / se_h = %.2f; no floor)" % z0
    else:
        B = abs(b["value_s"] - h["value_s"])
        z = B / math.sqrt(se_hN ** 2 + b["se_s"] ** 2)
        out.update(b=b["value_s"], se_b=b["se_s"], B=B, informative_z=z)
        if z < CONST["uninformative_z"]:
            out["status"] = "uninformative"
            return None, "uninformative: |b - h| / sqrt(se_h^2 + se_b^2) = %.2f < %s (the floor is " \
                         "indistinguishable from humans)" % (z, CONST["uninformative_z"])
        if B <= out["ceiling"]:
            out["status"] = "uninformative"
            return None, "uninformative: |b - h| = %.3g is within the ceiling c = %.3g (a fresh human sample " \
                         "is not expected to be closer than the floor)" % (B, out["ceiling"])
    a = _seed_side(it, si)
    if a is None or a.get("value_s") is None:
        return dict(out, agent_failed=True, status="outside_human_range"), \
            FAILED + "agent value not computed (%s)" % _agent_reason(a, it)
    if _short(ev, it, a):
        return dict(out, agent_failed=True, status="outside_human_range"), _short(ev, it, a)
    out.update(a=a["value_s"], d=abs(a["value_s"] - h["value_s"]), n_agent_observed=a.get("n"))
    out["status"] = "within_human_range" if out["d"] <= out["range"] else "outside_human_range"
    if "B" in out:
        out["s_unclipped"] = (out["B"] - out["d"]) / (out["B"] - out["ceiling"])
        out["s"] = min(1.0, max(0.0, out["s_unclipped"]))
    # spread is a separate diagnostic (spread_check-v0); it does not change s or the status (review rewards-4 M1)
    out["direction_match"] = None if (it["kind"] != "effect" or h.get("direction") in (None, 0)) \
        else a.get("direction") == h["direction"]
    return out, None


def spread_check(it, a, factor):   # noqa: C901

    """Agent SD per arm against the printed human SD (review rewards-3 M1), with the same human-noise rule as the
    value: on ln SD, se = 1 / sqrt(2 (n - 1)) for the human n and for the planned agent n = n_h x factor; the arm
    fails when |ln sd_a - ln sd_h| > 1.96 sqrt(se_h^2 + se_h(n_a)^2). Paired items also compare the SD of the
    differences (human: SE x sqrt(n)). Arms without a printed SD are not checked (listed as unchecked)."""
    out = []
    if (a.get("rows_per_session") or 1) > 1.001:   # rating- / trial-level rows: SDs are not comparable
        return out
    hs, as_ = (it["human"].get("arm_sd") or {}), (a.get("arm_sd") or {})
    for arm, (sd_h, n_h) in hs.items():
        if arm not in as_ or not sd_h or n_h is None or n_h < 3:
            continue
        sd_a = as_[arm][0]
        if not sd_a or sd_a <= 0:
            continue   # exact zero is already agent_side_failed (zero_variance)
        n_a = max(3.0, n_h * (factor or 1.0))
        rng = CONST["range_z"] * math.sqrt(1 / (2 * (n_h - 1)) + 1 / (2 * (n_a - 1)))
        d = abs(math.log(sd_a) - math.log(sd_h))
        out.append({"arm": arm, "agent_sd": sd_a, "human_sd": sd_h, "d": round(d, 4), "range": round(rng, 4),
                    "ok": d <= rng})
    return out


def s_null(t, draws=CONST["s_null_draws"], seed=0):
    """Expected clipped score of a fresh human sample of the planned agent size (§8.2 reference value)."""
    rng = random.Random(seed)
    sd = math.sqrt(t["se_hN"] ** 2 + t["se_hn"] ** 2)
    tot = 0.0
    for _ in range(draws):
        d = abs(rng.gauss(0, sd))
        tot += min(1.0, max(0.0, (t["B"] - d) / (t["B"] - t["ceiling"])))
    return tot / draws


@reward("human_noise_score-v1", scope="population", threshold=0.5)
def human_noise_score(ev, effects="default", kinds=("effect", "target")):
    """§8.2 score s = (|b-h| - d) / (|b-h| - c), clipped to [0, 1], at the planned agent n: 0 = State-only random
    floor, 1 = as close as a typical fresh human sample. Uninformative items are listed, not scored; an agent side
    that cannot be computed scores 0. Effects weighted 1 (targets of an effect averaged first). spec.s_null = the
    expected score of a fresh human sample."""
    items, rep = select(ev, effects, kinds)
    nulls = {}

    def one(it, si):
        t, why = noise_terms(ev, it, si)
        if t is None:
            return None, why, None
        nulls.setdefault(it["key"], []).append(s_null(t, seed=si))
        if t.get("agent_failed"):
            return 0.0, why, {"seed": ev.seeds[si], "status": "agent_side_failed"}
        return t["s"], None, {"seed": ev.seeds[si], "status": t["status"], "s_unclipped": round(t["s_unclipped"], 3),

                              "d": round(t["d"], 4), "ceiling": round(t["ceiling"], 4), "B": round(t["B"], 4),
                              "direction_match": t["direction_match"]}
    r = _population(ev, items, rep, one, grouped=True)
    groups = {}
    for it in items:
        if it["key"] in nulls:
            groups.setdefault(it["group"], []).append(_mean(nulls[it["key"]]))
    r.spec["s_null"] = _mean([_mean(v) for v in groups.values()])
    r.spec["s_null_per_item"] = {k: _mean(v) for k, v in nulls.items()}
    r.spec["aggregation"] = "per seed: mean over effect groups of the mean clipped s of their items; then mean over seeds"
    return r


@reward("within_human_range-v1", scope="population", threshold=0.8)
def within_human_range(ev, effects="default", kinds=("effect", "target")):
    """Share of scored items with d <= m = 1.96 sqrt(se_h(N_h)^2 + se_h(n_a)^2), n_a = the planned agent n (§8.2;
    human noise only, so a smaller or excluded agent run cannot pass more easily). Uninformative items (when a
    baseline exists) are not scored; an agent side that cannot be computed counts as outside (0). Expected share
    for a fresh human sample: 0.95."""
    items, rep = select(ev, effects, kinds)

    def one(it, si):
        t, why = noise_terms(ev, it, si, baseline_needed=False)
        if t is None:
            return None, why, None
        if t.get("agent_failed"):
            return 0.0, why, None
        return float(t["status"] == "within_human_range"), None, None
    return _population(ev, items, rep, one, extra={"expected_for_fresh_human_sample": 0.95})


@reward("spread_check-v0", scope="population")
def spread_check_reward(ev, effects="default", kinds=("effect", "target")):
    """DIAGNOSTIC, not a score (review rewards-4 M1): per item 1 if every arm's agent SD lies within the human
    tolerance of the printed SD (ln SD, se = 1/sqrt(2(n-1)) at the human and the planned agent n, 1.96), else 0.
    It assumes normal data and exact printed SDs, so honest skewed (money) or ceiling (Likert) data fail it often;
    it never changes human_noise_score or within_human_range. Items without a printed SD are not computable."""
    items, rep = select(ev, effects, kinds)

    def one(it, si):
        if it["scoring"] != "full":
            return None, "scoring %s" % it["scoring"], None
        if not it["human"].get("arm_sd"):
            return None, "no printed human SD", None
        a = _seed_side(it, si)
        if a is None or not a.get("arm_sd"):
            return None, "no agent SD (%s)" % _agent_reason(a, it), None
        chk = spread_check(it, a, item_factor(ev, it))
        if not chk:
            return None, "no comparable arm (rows per participant > 1, n < 3, or zero SD)", None
        return float(all(x["ok"] for x in chk)), None, {"seed": ev.seeds[si], "arms": chk}
    r = _population(ev, items, rep, one)
    r.spec["diagnostic"] = ("not a score: tolerance assumes normal data and exact printed SDs; see DESIGN §8.7 "
                            "(deferred: kurtosis- and rounding-aware tolerance)")
    return r


@reward("validity-v0", scope="session", threshold=1.0)
def validity(ev):
    """Per session 1 if it completed and no whole-session exclusion (the paper's declared comprehension /
    attention / screening rules) removed it, else 0; a session whose exclusion is still pending is not computable.
    value = share of valid sessions over all seeds; per_effect is keyed seed:session."""
    per, nc = {}, {}
    for s in ev.sessions["per_seed"]:
        for row in s["rows"]:
            k = "%s:%s" % (s["seed"], row["session"])
            if row["pending"]:   # counted, not dropped: an undecided session is not (yet) valid
                per[k] = 0.0
                nc[k] = "pending exclusion(s) %s: counted as not valid until resolved" % row["pending"]
                continue
            per[k] = float(row["status"] == "completed" and not row["excluded"])
    vals = list(per.values())
    reasons = {}
    for s in ev.sessions["per_seed"]:
        for row in s["rows"]:
            for x in row["excluded"] or ([row["status"]] if row["status"] != "completed" else []):
                reasons[x] = reasons.get(x, 0) + 1
    return Reward(_mean(vals), None, per, nc, {"n_sessions": len(vals), "invalid_by_reason": reasons,
                                               "declared_checks": ev.sessions.get("exclusion_ids", []),
                                               "note": "scoped exclusions (applies_to) do not invalidate a session"})


@reward("loglik-v0", scope="step")
def loglik(ev):
    """Kind B per-answer log-likelihood under the human answer distribution (§8.4). Needs individual human data,
    which this sandbox never reads: always not computable."""
    return Reward(None, None, {}, {"*": "needs individual human data (Kind B, §8.4); not available in this sandbox"},
                  {"kind": "B"})


def combined(ev, config):
    """Declarative reward (§8.7): {"id", "combine": "weighted_mean", "parts": [{"fn", "weight", ...params}],
    "effects": [...], "on_not_computable": "skip"}."""
    parts, tot, wsum, nc, per, meta = [], 0.0, 0.0, {}, {}, {}
    for part in config["parts"]:
        params = {k: v for k, v in part.items() if k not in ("fn", "weight")}
        if config.get("effects") is not None and get(part["fn"]).scope == "population":
            params.setdefault("effects", config["effects"])
        r = score(ev, part["fn"], **params)
        parts.append({"fn": r.spec["id"], "value": r.value, "weight": part.get("weight", 1.0),
                      "official": r.spec.get("official"), "view": r.spec.get("view")})
        for k in ("official", "label", "constants", "protocol_sha16", "code_sha16", "plan", "report_scope",
                  "study", "study_version"):
            if k in r.spec:
                meta[k] = (meta.get(k, True) and r.spec[k]) if k == "official" else r.spec[k]
        nc.update({"%s/%s" % (r.spec["name"], k): v for k, v in r.not_computable.items()})
        per.update({"%s/%s" % (r.spec["name"], k): v for k, v in r.per_effect.items()})
        if r.value is None:
            hard = r.spec.get("status") in ("agent_side_failed", "underpowered_run")
            if hard or config.get("on_not_computable", "skip") != "skip":   # skip only human-side gaps
                return Reward(None, (False if hard else None) if meta.get("official", True) else None, per, nc,
                              dict(meta, id=config.get("id"), parts=parts, status=r.spec.get("status")))
            continue
        tot += part.get("weight", 1.0) * r.value
        wsum += part.get("weight", 1.0)
    return Reward(tot / wsum if wsum else None, None, per, nc, dict(meta, id=config.get("id"), combine="weighted_mean",
                                                                    parts=parts))


DEFAULT = ("significance_match-v1", "direction_match-v2", "effect_gap-v1", "within_human_range-v1",
           "human_noise_score-v1", "spread_check-v0", "validity-v0", "loglik-v0")
