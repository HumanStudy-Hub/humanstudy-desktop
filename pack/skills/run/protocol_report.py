#!/usr/bin/env python3
"""The results page of a protocol run: human vs AI per effect, labelled an offline report. App-owned.

    python .opencode/skills/run/protocol_report.py artifacts/simulations/<stamp>

Reads the run folder (run.json, effects.json, rewards.json when hsenv.rewards scored the run) and the project's
protocol.json (its SHA-256 must be the one the run recorded). The human side is the paper's printed numbers in
protocol.json (analysis effects `reported`); the AI side is effects.json, computed on the AI participants by the
engine. Writes results.html (the artifact kit inlined, protocol embedded, checked offline) and summary.json (the
Simulation tab's paragraph). It compares directions and sizes; it is not a leaderboard and not human data.
"""
from __future__ import annotations

import hashlib
import html
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPORT_SCOPE = "offline_report — not a leaderboard"


def _num(v) -> str:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return "—"
    return f"{v:.3f}".rstrip("0").rstrip(".") if isinstance(v, float) else str(v)


UNSIGNED = {"phi", "cramers_v"}   # no direction to compare


def human_side(e: dict, metric: str | None = None) -> tuple[float | None, str, str | None]:
    """(the paper's value, how it was read, its metric) from the effect's printed numbers: printed cells give a
    risk or mean difference (treatment minus reference); else a printed estimate in the AI side's metric; else
    the printed value with its stated metric (None when it states none)."""
    rep = e.get("reported") or {}
    cells = rep.get("cells") or {}
    t, r = (e.get("contrast") or {}).get("treatment"), (e.get("contrast") or {}).get("reference")
    ct, cr = (cells.get(t) or {}) if t else {}, (cells.get(r) or {}) if r else {}
    if all(isinstance(c.get(k), (int, float)) for c in (ct, cr) for k in ("k", "n")) and ct["n"] and cr["n"]:
        return ct["k"] / ct["n"] - cr["k"] / cr["n"], f"{t} {ct['k']}/{ct['n']} vs {r} {cr['k']}/{cr['n']}", "risk_difference"
    if all(isinstance(c.get("mean"), (int, float)) for c in (ct, cr)):
        return ct["mean"] - cr["mean"], f"{t} mean {_num(ct['mean'])} vs {r} mean {_num(cr['mean'])}", "mean_difference"
    for est in rep.get("estimates") or []:
        if isinstance(est, dict) and est.get("metric") == metric and isinstance(est.get("value"), (int, float)):
            return float(est["value"]), f"printed {metric}", metric
    if isinstance(rep.get("value"), (int, float)):
        m = rep.get("metric") if isinstance(rep.get("metric"), str) else None
        return float(rep["value"]), f"printed {m or 'value (metric not stated)'}", m
    return None, "the paper prints no comparable number", None


def ai_side(block: dict | None) -> tuple[float | None, str]:
    if not block or block.get("status") != "computed" or not isinstance(block.get("value"), (int, float)):
        return None, (block or {}).get("reason") or (block or {}).get("status") or "not computed"
    cells = block.get("cells") or {}
    parts = []
    for name, c in cells.items():
        if "k" in c and "n" in c:
            parts.append(f"{name} {c['k']}/{c['n']}")
        elif "mean" in c:
            parts.append(f"{name} mean {_num(c['mean'])} (n {c.get('n', '?')})")
    return float(block["value"]), " vs ".join(parts) or f"n {block.get('n', '?')}"


def rows(protocol: dict, effects: dict) -> list[dict]:
    an = protocol.get("analysis") or {}
    defs = list(an.get("effects") or []) + list(an.get("effects_means") or [])
    pooled = effects.get("pooled")
    if not pooled:
        seeds = effects.get("per_seed") or {}
        pooled = seeds[sorted(seeds)[0]] if len(seeds) == 1 else []
    blocks = {b.get("effectId"): b for b in pooled or []}
    out = []
    for e in defs:
        block = blocks.get(e.get("id")) or {}
        a, awhy = ai_side(block)
        h, hwhy, hmetric = human_side(e, block.get("metric"))
        directional = e.get("direction_claimed") is not False and not e.get("suspect") and not e.get("direction_unresolved")
        # Like with like only (review 2, S8): an odds ratio or a d is never read by sign against a difference.
        comparable = hmetric is not None and hmetric == block.get("metric") and hmetric not in UNSIGNED
        same = None if h is None or a is None or not directional or not comparable or h == 0 else (a > 0) == (h > 0) and a != 0
        why = None if same is not None else ("different metric" if h is not None and a is not None and not comparable else None)
        out.append({"effect": e.get("id"), "metric": block.get("metric") or (e.get("compute") or {}).get("op"),
                    "human_metric": hmetric, "human": h, "human_from": hwhy, "ai": a, "ai_from": awhy,
                    "same_direction": same, "not_compared": why,
                    "page": ((e.get("reported") or {}).get("cite") or {}).get("page")})
    return out


def outcome(table: list[dict]) -> str:
    judged = [r["same_direction"] for r in table if r["same_direction"] is not None]
    if not judged:
        return "unknown"
    return "replicated" if all(judged) else "partly" if any(judged) else "not_replicated"


def paragraph(table: list[dict], run: dict, partial: bool = False) -> str:
    p = run.get("participants") or {}
    judged = [r for r in table if r["same_direction"] is not None]
    same = sum(1 for r in judged if r["same_direction"])
    s = (f"{p.get('completed', 0)} of {p.get('records', 0)} AI participants finished the study "
         f"({run.get('calls', 0)} model calls). ")
    if judged:
        s += f"In {same} of {len(judged)} comparisons the AI participants differed in the same direction as the paper's participants. "
    else:
        s += "No effect could be compared in direction with the paper. "
    s += ("This is a simulation with AI participants, not human data, and an offline comparison with the paper's "
          "printed numbers, not a leaderboard.")
    if partial:
        app = run.get("app") or {}
        s = (f"PARTIAL RUN: only {app.get('valid', p.get('completed', 0))} of {app.get('planned', '?')} planned AI "
             f"participants finished without a failed model call, so these numbers are not the planned comparison. ") + s
    return s


def page(protocol: dict, run: dict, table: list[dict], rewards: dict | None, partial: bool = False) -> str:
    title = (protocol.get("meta") or {}).get("title") or protocol.get("id") or "Protocol run"
    trs = []
    for r in table:
        mark = (("not compared (%s)" % r["not_compared"] if r["not_compared"] else "not compared")
                if r["same_direction"] is None else "same direction" if r["same_direction"]
                else "no difference" if r["ai"] == 0 else "opposite direction")
        page_ = f' data-page="{r["page"]}"' if isinstance(r["page"], int) else ""
        trs.append(
            f'<tr><td data-program-id="{html.escape(str(r["effect"]))}"{page_}><b>{html.escape(str(r["effect"]))}</b>'
            f'<br><span class="hs-sub">{html.escape(str(r["metric"] or ""))}</span></td>'
            f'<td>{_num(r["human"])}<br><span class="hs-sub">{html.escape(r["human_from"])}</span></td>'
            f'<td>{_num(r["ai"])}<br><span class="hs-sub">{html.escape(r["ai_from"])}</span></td>'
            f'<td>{mark}</td></tr>')
    rew = ""
    if rewards:
        items = "".join(f"<li>{html.escape(str(k))}: {html.escape(json.dumps(v, default=str)[:200])}</li>"
                        for k, v in rewards.items())
        rew = f'<div class="hs-card"><h2 class="hs-h2">Rewards</h2><ul>{items}</ul></div>'
    p = run.get("participants") or {}
    f = run.get("f") or {}
    manifest = [("Protocol", f'{protocol.get("id")} (SHA-256 {str(run.get("protocol_sha256", ""))[:16]}…)'),
                ("Model", str(f.get("model") or "")), ("Renderer", "default (skills/run render.render_state)"),
                ("AI participants per arm", json.dumps(run.get("n_per_arm"))), ("Seeds", json.dumps(run.get("seeds"))),
                ("Completed", f'{p.get("completed", 0)} of {p.get("records", 0)}'), ("Model calls", str(run.get("calls", 0))),
                ("Images shown to the model", str(f.get("images") or "")), ("Finished", str(run.get("finishedAt", "")))]
    man = "".join(f"<tr><td>{html.escape(k)}</td><td>{html.escape(v)}</td></tr>" for k, v in manifest)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="hs-artifact" content="protocol-report">
<title>{html.escape(title)} — AI participants vs the paper</title>
<link rel="stylesheet" href="hs-kit.css">
<script src="hs-kit.js"></script>
</head>
<body>
<div class="hs-page">
<div class="hs-banner">Simulation — not human data · {html.escape(REPORT_SCOPE)}{' · PARTIAL RUN — not the planned n' if partial else ''}</div>
<h1>{html.escape(title)}</h1>
<p class="hs-sub">{html.escape(paragraph(table, run, partial))}</p>
<div class="hs-card">
<table>
<thead><tr><th>Effect</th><th>People (paper, printed)</th><th>AI participants (this run)</th><th>Direction</th></tr></thead>
<tbody>
{chr(10).join(trs) or '<tr><td colspan="4">The protocol defines no effects to compare.</td></tr>'}
</tbody>
</table>
<p class="hs-sub">Values are treatment minus reference (a difference in proportions or means, as the protocol computes
it). The people column is the paper's printed numbers; the AI column is computed by the engine from this run.</p>
</div>
{rew}
<div class="hs-card"><h2 class="hs-h2">What ran</h2><table>{man}</table></div>
</div>
</body>
</html>
"""


def build(run_dir: Path, project: Path, partial: bool | None = None) -> dict:
    """partial: None reads run.json (status "partial" from app_run.py)."""
    run_dir, project = Path(run_dir), Path(project)
    run = json.loads((run_dir / "run.json").read_text(encoding="utf-8"))
    raw = (project / "protocol.json").read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    if run.get("protocol_sha256") != sha:
        raise SystemExit("protocol.json is not the protocol this run used; no report was written")
    protocol = json.loads(raw.decode("utf-8"))
    effects = json.loads((run_dir / "effects.json").read_text(encoding="utf-8"))
    rewards = json.loads((run_dir / "rewards.json").read_text(encoding="utf-8")) if (run_dir / "rewards.json").is_file() else None
    table = rows(protocol, effects)
    if partial is None:
        partial = run.get("status") == "partial"
    kit = project / ".opencode" / "artifact-kit"
    sys.path.insert(0, str(kit))
    import inline as kit_inline
    out = kit_inline.inline(page(protocol, run, table, rewards, partial), None, (protocol, sha))
    problems, _ = kit_inline.check(out, None, protocol)
    if problems:
        raise SystemExit("results page failed the artifact checks: " + "; ".join(problems))
    (run_dir / "results.html").write_text(out, encoding="utf-8")
    summary = {"outcome": "not_ready" if partial else outcome(table), "paragraph": paragraph(table, run, partial),
               "partial": partial, "model": (run.get("f") or {}).get("model"),
               "perCondition": max((run.get("n_per_arm") or {0: 0}).values()), "calls": run.get("calls", 0),
               "route": "protocol", "scope": REPORT_SCOPE}
    (run_dir / "summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return summary


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__.split("\n\n")[1])
    run_dir = Path(sys.argv[1]).resolve()
    print(json.dumps(build(run_dir, run_dir.parents[2]), ensure_ascii=False))
