"""Score a study with the §8.7 rewards from simulated sessions (no model calls).

    python -m hsenv.score studies/<id> [--sessions N | --max-sessions N] [--seeds 3] [--policy random|keyed]
                          [--rewards significance_match,...] [--out file.json]
    python -m hsenv.score --rescore evaldata.json [--rewards ...]

Offline report, not a leaderboard. Agent n defaults to the human analysed n per arm (evaldata.analysed_n: the
structured arms[].n_analysed, else n_paper labelled n_paper_unverified; §8.2); only that n is `official`. --sessions N / --max-sessions N run
other n (quick runs) and are labelled non_official (values, no pass/fail). The baseline is the State-only `floor`
policy (checks.play policy "floor": random answers from the State, no protocol internals) at the same planned n,
seed 0, topped up like agent sessions.
"""
import argparse
import json
import sys

from . import rewards as R
from .engine import Protocol
from .evaldata import EvalData, agent_n, baseline_run, simulate

BASELINE_SEED = 0


def build(study, sessions=None, seeds=3, policy="keyed", first_seed=1, cap=None):
    p = Protocol.load(study)
    n, missing = agent_n(p, sessions, cap)
    if missing:
        raise SystemExit("arms %s print no human n; pass --sessions N or --max-sessions N" % missing)
    runs = [simulate(p, policy, n, first_seed + i) for i in range(seeds)]
    base = baseline_run(p, n, BASELINE_SEED)
    prov = {"policy": policy, "agent_n_per_arm": n, "agent_n_source": "--sessions" if sessions else ("min(human analysed n, --max-sessions)" if cap else "human analysed n per arm (evaldata.analysed_n)"),
            "baseline_seed": BASELINE_SEED, "baseline_n_per_arm": base.get("n_per_arm"), "seeds": [first_seed + i for i in range(seeds)],
            "agent_sessions_run_per_arm": [r["n_per_arm"] for r in runs],
            "top_up": "sessions added per arm until valid sessions reach 90% of the agent n (max 10x)"}
    return EvalData.build(p, runs, baseline=base, provenance=prov)


def summarize(ev, ids):
    out = {}
    for rid in ids:
        r = R.score(ev, rid)
        reasons = {}
        for why in r.not_computable.values():
            key = why.split(":")[0][:60]
            reasons[key] = reasons.get(key, 0) + 1
        out[r.spec["id"]] = {"value": r.value, "passed": r.passed, "n_scored": r.spec.get("n_scored"),
                             "sd_across_seeds": r.spec.get("sd_across_seeds"), "s_null": r.spec.get("s_null"),
                             "not_computable": len(r.not_computable), "reasons": reasons, "reward": r.to_dict(),
                             "agent_failed": r.spec.get("n_agent_side_failed"), "status": r.spec.get("status"),
                             "view": r.spec.get("view")}
    return out


def plan_header(ev):
    """The labels a reader must see (review rewards-6 M1): official or not, and on what n basis."""
    plan = ev.d.get("plan") or {}
    basis = plan.get("human_n_basis") or {}
    unv = plan.get("n_unverified_arms") or []
    if not plan.get("official"):
        sub = plan.get("subset_of_arms") or []
        return "NON_OFFICIAL: planned n differs from the human analysed n%s; values only, no pass/fail" % (
            " and arms %s were not run" % ", ".join(sub) if sub else "")
    if unv:
        return "official n = n_paper_unverified (%s): no structured n_analysed, so any verdict is on an UNVERIFIED n" % (
            ", ".join(unv))
    return "official n = structured n_analysed (%s)" % ", ".join(sorted(set(basis.values())))


def text_report(ev, res):
    out = []
    out.append("%s  policy=%s seeds=%s n/arm=%s" % (ev.d["study"], ev.d["policy"], ev.seeds,
                                                   ev.d["provenance"].get("agent_n_per_arm")))
    out.append("  [%s]  %s" % (R.REPORT_SCOPE, plan_header(ev)))
    out.append("  protocol %s  code %s  constants %s" % (
        ev.d["provenance"].get("protocol_sha16"), ev.d["provenance"].get("code_sha16"),
        " ".join("%s=%s" % kv for kv in R.CONST.items())))
    for rid, x in res.items():
        spec = x["reward"]["spec"]
        v = "n/c" if x["value"] is None else "%.3f" % x["value"]
        extra = "" if x["s_null"] is None else "  s_null=%.3f" % x["s_null"]
        sd = "" if x["sd_across_seeds"] is None else " ±%.3f" % x["sd_across_seeds"]
        passed = x["passed"]
        if passed is not None and spec.get("verdict_on_unverified_n"):
            passed = "%s(UNVERIFIED n)" % passed
        flags = []
        if x.get("view"):
            flags.append("view: %s" % x["view"])
        if spec.get("itt_unchecked"):
            flags.append("ITT_UNCHECKED (human exclusion rate unknown)")
        elif spec.get("itt_not_applicable"):
            flags.append("itt not applicable (no whole-session exclusion)")
        out.append("  %-24s %8s%s  passed=%s  scored=%s  not_computable=%d  agent_failed=%s%s%s" % (
            rid, v, sd, passed, x["n_scored"], x["not_computable"], x["agent_failed"], extra,
            "  (%s)" % "; ".join(flags) if flags else ""))
        for why, k in sorted(x["reasons"].items(), key=lambda kv: -kv[1]):
            out.append("      %3d  %s" % (k, why))
    return out


def main(argv=None):
    if sys.version_info < (3, 11):   # coding rules use Python 3.11+ regex
        sys.exit("hsenv.score needs Python 3.11+ (found %s)" % sys.version.split()[0])
    ap = argparse.ArgumentParser()
    ap.add_argument("study", nargs="?")
    ap.add_argument("--sessions", type=int, default=None, help="agent sessions per arm (default: human n per arm)")
    ap.add_argument("--max-sessions", type=int, default=None, help="cap per arm: min(human n, N) (quick runs)")
    ap.add_argument("--seeds", type=int, default=3)
    ap.add_argument("--first-seed", type=int, default=1)
    ap.add_argument("--policy", choices=("random", "keyed"), default="keyed")
    ap.add_argument("--rewards", default=",".join(R.DEFAULT))
    ap.add_argument("--rescore", help="an EvalData JSON written by --out")
    ap.add_argument("--out", help="write {evaldata, rewards} JSON here")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args(argv)
    ids = [x.strip() for x in a.rewards.split(",") if x.strip()]
    if a.rescore:
        d = json.load(open(a.rescore))
        ev = EvalData.from_dict(d.get("evaldata", d))
    elif a.study:
        ev = build(a.study, a.sessions, a.seeds, a.policy, a.first_seed, a.max_sessions)
    else:
        ap.error("a study or --rescore is needed")
    res = summarize(ev, ids)
    if not a.quiet:
        print("\n".join(text_report(ev, res)))
    if a.out:
        with open(a.out, "w") as f:
            json.dump({"evaldata": ev.to_dict(), "rewards": {k: v["reward"] for k, v in res.items()}}, f,
                      default=str)
    return 0


if __name__ == "__main__":
    sys.exit(main())
