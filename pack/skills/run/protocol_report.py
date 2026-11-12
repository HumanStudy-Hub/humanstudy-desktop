#!/usr/bin/env python3
"""The results page of a protocol run: human vs AI per effect, labelled an offline report. App-owned.

    python .opencode/skills/run/protocol_report.py artifacts/simulations/<stamp>

Reads the run folder (run.json with the engine's scores from hsenv.score, effects.json) and the project's
protocol.json (its SHA-256 must be the one the run recorded). The human side is the paper's printed numbers in
protocol.json (analysis effects `reported`); the AI side is effects.json, computed on the AI participants by the
engine. Writes results.html (the artifact kit inlined, protocol embedded, checked offline) and summary.json (the
Simulation tab's paragraph). It compares directions and sizes; it is not a leaderboard and not human data.
"""
from __future__ import annotations

import hashlib
import html
import json
import os
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


def citations(value):
    """The protocol schema permits a cite, a list, or a named map. Keep every reference."""
    if isinstance(value, list):
        return [cite for child in value for cite in citations(child)]
    if isinstance(value, dict):
        if "source" in value or "page" in value:
            return [value]
        return [cite for child in value.values() for cite in citations(child)]
    return []


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
                    "cites": citations((e.get("reported") or {}).get("cite")),
                    "page": None})
    return out


def official(run: dict) -> bool:
    """hsenv.score's rule: pass/fail only when the AI n equals the human analysed n in every arm."""
    return ((run.get("evaluation") or {}).get("plan") or {}).get("official") is True


def unverified_n(run: dict) -> list:
    """Arms whose human n is the printed n_paper with no structured n_analysed: an official verdict is then a
    verdict on an unverified human n (hsenv.score labels it so)."""
    return list(((run.get("evaluation") or {}).get("plan") or {}).get("n_unverified_arms") or [])


def direction_reward(run: dict) -> dict | None:
    rewards = (run.get("evaluation") or {}).get("rewards")
    if not isinstance(rewards, dict):
        return None
    return next((v for k, v in sorted(rewards.items()) if k.startswith("direction_match") and isinstance(v, dict)), None)


def outcome(table: list[dict], run: dict | None = None, partial: bool = False) -> str:
    """The Simulation tab's headline, following hsenv.score (review 3, M1): a partial run is not_ready; a
    non_official run has values only, so a neutral "unknown" (Finished); an official run takes the verdict of the
    engine's direction reward, worded in the tab as direction agreement (agree / disagree), never as "showed the
    effect". The sign table on the page is a reading aid and never sets the headline."""
    if partial:
        return "not_ready"
    run = run or {}
    # A direction verdict only on the strict official comparison (official plan, verified human n, complete run);
    # otherwise the neutral "Finished": the headline never says more than the text (UX re-check).
    if not official(run) or unverified_n(run):
        return "unknown"
    # The headline follows the same per-comparison direction count as the paragraph (UX round 3):
    #   every comparison in the paper's direction, engine check passed  -> same
    #   every comparison in the paper's direction, engine check failed  -> same_ns (failed on significance only)
    #   some in the paper's direction, some not                         -> mixed (k of n)
    #   none in the paper's direction                                   -> differs
    judged = [r["same_direction"] for r in table if r["same_direction"] is not None]
    if not judged:
        return "unknown"
    same = sum(1 for x in judged if x)
    if same == len(judged):
        passed = (direction_reward(run) or {}).get("passed")
        return "same" if passed else "same_ns"
    return "differs" if same == 0 else "mixed"


# Plain words for the page, in the app's language (review: researchers read this first; code strings stay under
# "Technical details").
TEXT = {
    "en": {
        "banner": "Simulation with AI participants — not data from people. A comparison with the paper's printed numbers, not a leaderboard.",
        "partial_banner": "Partial run: not the planned number of participants.",
        "finished": "{done} of {planned} AI participants finished the study.",
        "partial": "Only part of the planned run finished, so this is not the planned comparison.",
        "why_calls": "Why: {failedCalls} model calls failed.", "why_cap": "Why: the run used up its approved model limit.",
        "why_unfinished": "Why: some participants did not finish.", "run_again": "Next: press Run simulation to run it again.",
        "directions": "In {same} of {compared} comparisons the AI participants differed in the same direction as the people in the paper.",
        "no_directions": "No result could be compared in direction with the paper.",
        "official": "Official comparison: the sample size matches the paper's analysed sample in every condition.",
        "unofficial": "Unofficial comparison: values only, no pass or fail.",
        "unverified": "The paper's sample size is taken as printed and has not been checked yet.",
        "caveat": "AI participants are not people: this is a simulation and a comparison with the paper's printed numbers, not a ranking.",
        "col_what": "What was compared", "col_people": "People in the paper", "col_ai": "AI participants in this run",
        "col_dir": "Direction", "none": "The study defines no results to compare.",
        "same": "same direction", "opposite": "opposite direction", "nodiff": "no difference",
        "not_compared": "not compared", "different": "not compared (measured differently)",
        "note": "Each value is the difference between the two conditions compared (a difference in proportions or in means). The people column is the paper's printed numbers; the AI column comes from this run.",
        "prop": "difference in proportions", "mean": "difference in means", "diff": "difference",
        "vs": "vs", "mean_word": "mean", "no_number": "the paper prints no comparable number", "not_computed": "not computed",
        "tech": "Technical details", "what_ran": "What ran", "scores": "Scores",
        "how_many": "exactly the approved number per condition: participants the study excludes are scored by its rules and not replaced, so the run stays within its approved model use",
        "baseline": "the random baseline the scores compare against was played without a model and is kept inside this run folder",
    },
    "zh": {
        "banner": "AI 参与者的模拟实验——不是真人数据。这是与论文印出数字的比较，不是排行榜。",
        "partial_banner": "部分运行：参与者人数没有达到计划。",
        "finished": "{planned} 名 AI 参与者中有 {done} 名完成了研究。",
        "partial": "只完成了计划中的一部分，所以这不是计划中的比较。",
        "why_calls": "原因：{failedCalls} 次模型调用失败。", "why_cap": "原因：运行用完了批准的模型用量。",
        "why_unfinished": "原因：有参与者没有完成。", "run_again": "下一步：点击“运行模拟”重新运行。",
        "directions": "在 {compared} 项比较中，有 {same} 项 AI 参与者的差异方向与论文中的人类参与者相同。",
        "no_directions": "没有可以与论文比较方向的结果。",
        "official": "正式比较：每个条件的样本量都与论文分析的样本量一致。",
        "unofficial": "非正式比较：只给出数值，不判定通过与否。",
        "unverified": "样本量按论文印出的数字，尚未核对。",
        "caveat": "AI 参与者不是真人：这是模拟实验，以及与论文印出数字的比较，不是排名。",
        "col_what": "比较的内容", "col_people": "论文中的人类参与者", "col_ai": "本次运行的 AI 参与者",
        "col_dir": "方向", "none": "这项研究没有定义可比较的结果。",
        "same": "方向相同", "opposite": "方向相反", "nodiff": "没有差异",
        "not_compared": "未比较", "different": "未比较（测量方式不同）",
        "note": "每个数值都是两个条件之间的差（比例之差或均值之差）。人类一栏是论文印出的数字；AI 一栏来自本次运行。",
        "prop": "比例之差", "mean": "均值之差", "diff": "差值",
        "vs": "对", "mean_word": "均值", "no_number": "论文没有印出可比较的数字", "not_computed": "未能计算",
        "tech": "技术细节", "what_ran": "运行内容", "scores": "评分",
        "how_many": "每个条件正好是批准的人数：研究排除的参与者按研究规则计分、不补人，因此运行不会超出批准的模型用量",
        "baseline": "评分对照的随机基线不用模型生成，保存在本次运行文件夹内",
    },
}


def lang_of(lang) -> str:
    return "zh" if str(lang or "").lower().startswith("zh") else "en"


def facts(table: list[dict], run: dict, partial: bool) -> dict:
    """The structured summary the Simulation tab turns into words in the app's language."""
    p = run.get("participants") or {}
    app = run.get("app") or {}
    judged = [r for r in table if r["same_direction"] is not None]
    unverified = bool(unverified_n(run))
    return {"done": int(app.get("valid", p.get("completed", 0)) or 0), "planned": int(app.get("planned", p.get("records", 0)) or 0),
            "same": sum(1 for r in judged if r["same_direction"]), "compared": len(judged),
            # "official" only when the engine's plan is official, the paper's n is verified and the run is complete
            "official": bool(official(run) and not unverified and not partial), "unverified": unverified, "partial": bool(partial),
            "failedCalls": int(app.get("failed_calls") or 0), "tokenCap": bool(app.get("token_cap")),
            "engineDirection": (direction_reward(run) or {}).get("passed")}


def paragraph(table: list[dict], run: dict, partial: bool = False, lang: str = "en") -> str:
    T, f = TEXT[lang_of(lang)], facts(table, run, partial)
    why = (T["why_cap"] if f["tokenCap"] else T["why_calls"] if f["failedCalls"] else T["why_unfinished"]).format(**f)
    parts = [T["finished"].format(**f), T["partial"] if partial else "", why if partial else "", T["run_again"] if partial else "",
             T["directions"].format(**f) if f["compared"] else T["no_directions"],
             "" if partial else T["official"] if f["official"] else T["unofficial"],
             T["unverified"] if f["unverified"] else "", T["caveat"]]
    return ("" if lang_of(lang) == "zh" else " ").join(x for x in parts if x)


def _esc(v) -> str:
    return html.escape(str(v))


TECH = {
    "en": {"scores": "Scores", "none": "the engine did not score this run",
           "official": "official comparison (official plan, verified human n, complete run)",
           "unofficial": "unofficial comparison: values only, no pass or fail",
           "unverified": "human n unverified in %s (printed n, no analysed n)", "basis": "human n basis: ",
           "reward": "Reward", "value": "Value", "items": "Items", "labels": "Labels", "nc": "not computable",
           "no_verdict_partial": "no verdict (partial run)", "no_verdict": "no verdict", "passed": "passed",
           "not_passed": "not passed", "scored": "{a} scored, {b} not computable", "text": "The engine's text report",
           "unofficial_flag": "unofficial", "official_flag": "official", "itt_unchecked": "intention-to-treat not checked",
           "itt_na": "intention-to-treat not applicable", "view": "view: ", "code": "engine code",
           "reason": "engine reason", "scope": "offline report, not a leaderboard"},
    "zh": {"scores": "评分", "none": "引擎没有为本次运行评分",
           "official": "正式比较（正式计划、样本量已核对、运行完整）",
           "unofficial": "非正式比较：只给出数值，不判定通过与否",
           "unverified": "以下条件的人类样本量未核对：%s（论文印出的数字，没有分析样本量）", "basis": "人类样本量来源：",
           "reward": "评分项", "value": "数值", "items": "项目", "labels": "标注", "nc": "无法计算",
           "no_verdict_partial": "不判定（部分运行）", "no_verdict": "不判定", "passed": "通过",
           "not_passed": "未通过", "scored": "已计分 {a} 项，{b} 项无法计算", "text": "引擎的文字报告",
           "unofficial_flag": "非正式", "official_flag": "正式", "itt_unchecked": "未检查意向治疗分析",
           "itt_na": "不适用意向治疗分析", "view": "视角：", "code": "引擎代码",
           "reason": "引擎说明", "scope": "离线报告，不是排行榜"},
}


REWARD_NAMES = {
    "en": {"significance_match": "Significance agreement", "direction_match": "Direction agreement",
           "effect_gap": "Size of the difference", "within_human_range": "Within the human range",
           "human_noise_score": "Closeness given human variation", "spread_check": "Spread of answers",
           "validity": "Valid answers", "loglik": "Fit to individual human answers"},
    "zh": {"significance_match": "显著性一致", "direction_match": "方向一致", "effect_gap": "差异大小",
           "within_human_range": "在人类范围内", "human_noise_score": "考虑人类波动的接近程度",
           "spread_check": "回答的离散程度", "validity": "有效回答", "loglik": "与个体人类回答的拟合"},
}
STATUS = {"en": {"scored": "scored", "not_computable": "not computable", "agent_side_failed": "not computable on the AI side"},
          "zh": {"scored": "已计分", "not_computable": "无法计算", "agent_side_failed": "AI 一侧无法计算"}}


def scores_card(run: dict, rewards: dict | None, partial: bool = False, lang: str = "en") -> str:
    """The engine's scores (hsenv.score.summarize, as run_study writes them in run.json evaluation.rewards): each
    reward's value and verdict with its labels (offline_report, official or not, a verdict on an unverified human
    n, the intention-to-treat flags, the view) and why items were not computable. Nothing is recomputed here."""
    X = TECH[lang_of(lang)]
    ev = (run.get("evaluation") or {})
    summary = ev.get("rewards")
    if not isinstance(summary, dict):
        why = summary if isinstance(summary, str) else X["none"]
        return f'<div class="hs-card"><h2 class="hs-h2">{X["scores"]}</h2><p class="hs-sub">{_esc(why)}</p></div>'
    plan = ev.get("plan") or {}
    basis = plan.get("human_n_basis") or {}
    # "official" only on the strict definition: official plan, verified human n, complete run (UX re-check).
    strict = bool(plan.get("official")) and not plan.get("n_unverified_arms") and not partial
    head = [X["official"] if strict else X["unofficial"]]
    if plan.get("n_unverified_arms"):
        head.append(X["unverified"] % ", ".join(map(str, plan["n_unverified_arms"])))
    basis_line = (f'<p><code class="hs-code">{_esc(X["code"])}: {_esc(X["basis"] + ", ".join(f"{k} {v}" for k, v in sorted(basis.items())))}</code></p>'
                  if basis else "")
    trs = []
    for rid, r in summary.items():
        if not isinstance(r, dict):
            continue
        value = X["nc"] if r.get("value") is None else _num(r.get("value"))
        verdict = (X["no_verdict_partial"] if partial else X["no_verdict"] if r.get("passed") is None or not strict
                   else X["passed"] if r.get("passed") else X["not_passed"])
        flags = [x for x in (
            X["scope"], X["official_flag"] if strict else X["unofficial_flag"],
            X["itt_unchecked"] if r.get("itt_unchecked") else None,
            X["itt_na"] if r.get("itt_not_applicable") else None,
            ) if x]
        reasons = r.get("reasons") or {}
        nc = r.get("not_computable") or 0
        why = "; ".join(f"{k} ({n})" for k, n in reasons.items()) if reasons else ""
        L = lang_of(lang)
        base = rid.rsplit("-", 1)[0]
        name = REWARD_NAMES[L].get(base, base.replace("_", " "))
        status = STATUS[L].get(str(r.get("status") or ""), str(r.get("status") or ""))
        trs.append(f'<tr><td><b>{_esc(name)}</b><br><span class="hs-sub">{_esc(status)}</span>'
                   f'<br><code class="hs-code">{_esc(X["code"])}: {_esc(rid)}</code></td>'
                   f'<td>{value}<br><span class="hs-sub">{verdict}</span></td>'
                   f'<td>{_esc(X["scored"].format(a=r.get("n_scored") if r.get("n_scored") is not None else "—", b=nc))}'
                   f'{"<br><code class=hs-code>" + _esc(X["reason"]) + ": " + _esc(why) + "</code>" if why else ""}</td>'
                   f'<td><span class="hs-sub">{_esc(" · ".join(flags))}</span></td></tr>')
    text = ev.get("text_report")
    pre = (f'<details><summary class="hs-sub">{X["text"]}</summary><pre>{_esc(chr(10).join(map(str, text)))}</pre></details>'
           if isinstance(text, list) and text and strict else "")   # its lines carry passed=…: only on a strict official run
    return (f'<div class="hs-card"><h2 class="hs-h2">{X["scores"]} — {_esc(X["scope"])}</h2>'
            f'<p class="hs-sub">{_esc("; ".join(head))}</p>{basis_line}'
            f'<table class="hs-results"><thead><tr><th>{X["reward"]}</th><th>{X["value"]}</th><th>{X["items"]}</th><th>{X["labels"]}</th></tr></thead><tbody>'
            + "".join(trs) + f'</tbody></table>{pre}</div>')


def _plain_metric(metric, T) -> str:
    return {"risk_difference": T["prop"], "proportion_difference": T["prop"], "mean_difference": T["mean"]}.get(str(metric), T["diff"])


def _plain_from(text: str, T) -> str:
    return text.replace(" vs ", " %s " % T["vs"]).replace(" mean ", " %s " % T["mean_word"]) \
        .replace("the paper prints no comparable number", T["no_number"]).replace("not computed", T["not_computed"])


def page(protocol: dict, run: dict, table: list[dict], rewards: dict | None, partial: bool = False, lang: str = "en") -> str:
    L = lang_of(lang)
    T = TEXT[L]
    title = (protocol.get("meta") or {}).get("title") or protocol.get("id") or "Protocol run"
    labels = {e.get("id"): e.get("label") or e.get("title") or e.get("description")
              for e in list((protocol.get("analysis") or {}).get("effects") or []) + list((protocol.get("analysis") or {}).get("effects_means") or [])
              if isinstance(e, dict)}
    trs = []
    for r in table:
        mark = ((T["different"] if r["not_compared"] else T["not_compared"]) if r["same_direction"] is None
                else T["same"] if r["same_direction"] else T["nodiff"] if r["ai"] == 0 else T["opposite"])
        page_ = f' data-page="{r["page"]}"' if isinstance(r["page"], int) else ""
        refs = []
        for cite in r.get("cites", []):
            pg = cite.get("page")
            if not isinstance(pg, int) or pg < 1:
                continue
            source = ((protocol.get("meta") or {}).get("sources") or {}).get(cite.get("source"))
            file = source.get("file") if isinstance(source, dict) else None
            file_attr = f' data-file="{html.escape(file, quote=True)}"' if isinstance(file, str) else ""
            refs.append(f'<button type="button" data-page="{pg}"{file_attr}>p. {pg}</button>')
        references = " ".join(refs)
        name = labels.get(r["effect"]) or str(r["effect"]).replace("_", " ")
        trs.append(
            f'<tr><td data-program-id="{html.escape(str(r["effect"]))}"{page_}><b>{html.escape(str(name))}</b>'
            f'<br><span class="hs-sub">{html.escape(_plain_metric(r["metric"], T))}</span></td>'
            f'<td>{_num(r["human"])}<br><span class="hs-sub">{html.escape(_plain_from(r["human_from"], T))}</span> {references}</td>'
            f'<td>{_num(r["ai"])}<br><span class="hs-sub">{html.escape(_plain_from(r["ai_from"], T))}</span></td>'
            f'<td>{mark}</td></tr>')
    rew = scores_card(run, rewards, partial, L)
    p = run.get("participants") or {}
    f = run.get("f") or {}
    M = {"Protocol": "研究方案", "Model": "模型", "Renderer": "页面呈现", "AI participants per arm": "每个条件的 AI 参与者",
         "Seeds": "随机种子", "Completed": "完成", "Model calls": "模型调用", "Images shown to the model": "是否给模型看图片",
         "Finished": "结束时间", "How many ran": "运行人数", "Baseline": "基线"} if L == "zh" else {}
    manifest = [("Protocol", f'{protocol.get("id")} (SHA-256 {str(run.get("protocol_sha256", ""))[:16]}…)'),
                ("Model", str(f.get("model") or "")), ("Renderer", ("默认" if L == "zh" else "default") + " (render.render_state)"),
                ("AI participants per arm", json.dumps(run.get("n_per_arm"))), ("Seeds", json.dumps(run.get("seeds"))),
                ("Completed", (f'{p.get("records", 0)} 名中 {p.get("completed", 0)} 名' if L == "zh" else f'{p.get("completed", 0)} of {p.get("records", 0)}')),
                ("Model calls", str(run.get("calls", 0))),
                ("Images shown to the model", ("不展示：只给文字，图片以编号和其中核实过的文字出现" if L == "zh" else "not shown: text only; images appear as ids with their verified text lines")
                 if str(f.get("images") or "").startswith("NOT shown") else str(f.get("images") or "")), ("Finished", str(run.get("finishedAt", ""))),
                ("How many ran", T["how_many"]), ("Baseline", T["baseline"] + " (.baseline-cache)")]
    man = "".join(f"<tr><td>{html.escape(M.get(k, k))}</td><td>{html.escape(v)}</td></tr>" for k, v in manifest)
    return f"""<!doctype html>
<html lang="{'zh-CN' if L == 'zh' else 'en'}">
<head>
<meta charset="utf-8">
<meta name="hs-artifact" content="protocol-report">
<title>{html.escape(title)}</title>
<link rel="stylesheet" href="hs-kit.css">
<script src="hs-kit.js"></script>
<style>
.hs-results {{ width: 100%; border-collapse: collapse; table-layout: fixed; }}
.hs-results th, .hs-results td {{ text-align: left; vertical-align: top; padding: 6px 10px 6px 0; overflow-wrap: anywhere; }}
.hs-results thead th {{ border-bottom: 1px solid var(--hs-line, #cdd7c6); }}
details.hs-card > summary {{ cursor: pointer; }}
.hs-what td:first-child {{ width: 32%; color: var(--hs-muted, #5e6e60); }}
details pre {{ white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }}
.hs-code {{ font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; color: var(--hs-muted, #5e6e60); }}
</style>
</head>
<body>
<div class="hs-page">
<div class="hs-banner">{html.escape(T["banner"])}{(' ' + html.escape(T["partial_banner"])) if partial else ''}</div>
<h1>{html.escape(title)}</h1>
<p class="hs-sub">{html.escape(paragraph(table, run, partial, L))}</p>
<div class="hs-card">
<table class="hs-results">
<thead><tr><th>{T["col_what"]}</th><th>{T["col_people"]}</th><th>{T["col_ai"]}</th><th>{T["col_dir"]}</th></tr></thead>
<tbody>
{chr(10).join(trs) or '<tr><td colspan="4">%s</td></tr>' % html.escape(T["none"])}
</tbody>
</table>
<p class="hs-sub">{html.escape(T["note"])}</p>
</div>
<details class="hs-card"><summary>{html.escape(T["tech"])}</summary>
{rew}
<div class="hs-card"><h2 class="hs-h2">{html.escape(T["what_ran"])}</h2><table class="hs-results hs-what">{man}</table></div>
</details>
</div>
</body>
</html>
"""


def build(run_dir: Path, project: Path, partial: bool | None = None, lang: str | None = None) -> dict:
    """partial: None reads run.json (status "partial" from app_run.py). lang: the app's language (en, zh-CN);
    None reads HUMANSTUDY_LANG."""
    lang = lang_of(lang if lang is not None else os.environ.get("HUMANSTUDY_LANG"))
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
    # The kit beside this code first: the app's trusted copy when the app started the run (<code>/artifact-kit),
    # the project's installed kit otherwise (.opencode/artifact-kit, also beside .opencode/skills/run).
    kit = next((k for k in (HERE.parent.parent / "artifact-kit", project / ".opencode" / "artifact-kit") if (k / "inline.py").is_file()),
               project / ".opencode" / "artifact-kit")
    sys.path.insert(0, str(kit))
    import inline as kit_inline
    out = kit_inline.inline(page(protocol, run, table, rewards, partial, lang), None, (protocol, sha))
    problems, _ = kit_inline.check(out, None, protocol)
    if problems:
        raise SystemExit("results page failed the artifact checks: " + "; ".join(problems))
    (run_dir / "results.html").write_text(out, encoding="utf-8")
    f = facts(table, run, partial)
    summary = {"outcome": outcome(table, run, partial), "official": f["official"], "facts": f,
               "paragraph": paragraph(table, run, partial, "en"), "paragraph_zh": paragraph(table, run, partial, "zh"),
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
