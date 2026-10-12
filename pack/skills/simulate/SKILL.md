---
name: simulate
description: Run the study's replay package with a language model playing every original participant, then compare the observed results with the paper's reported results. Use when the researcher asks to simulate, replay, run, pilot or test the study, or asks whether agents reproduce the finding.
---

# Simulate: agents as participants

A simulation runs `package/<paper-slug>/task/adapter.py` → `run_sessions(llm, seed, n, arms)`
and scores it with `evaluation/evaluation.py` → `evaluate(sessions)`. If there is no package yet,
run the `build` skill first. If `study.json.readiness.status` is `blocked`, stop and tell the
researcher which decisions are needed; never fill them in to make the run possible.

## Model access

The participant model is called through an OpenAI-compatible endpoint. Use, in this order:

1. `HUMANSTUDY_HOSTED_BASEURL` + `HUMANSTUDY_DESKTOP_KEY` (models hosted by HumanStudy Hub; model
   id from `HUMANSTUDY_MODEL`, e.g. `anthropic/claude-sonnet-5.5`). When `HUMANSTUDY_SERVER_BYPASS`
   is set, send it as header `x-vercel-protection-bypass`.
2. `OPENROUTER_API_KEY` with base URL `https://openrouter.ai/api/v1`.

Never print or write any key. Use the `openai` Python package (`pip install openai` if absent).

## Procedure

1. Create `artifacts/simulations/<YYYY-MM-DD-HHMM>/` and write `run.py` there. It imports the
   adapter and evaluation by path, builds `llm(prompt) -> str` with retries, a fixed temperature
   (state it) and a per-prompt cache in `cache.json`, runs `run_sessions(llm, seed, n, arms)`,
   appends every session to `sessions.jsonl` as it completes, then writes `evaluation.json`.
2. **Smoke first**: run with `n=2` (or the smallest unit the design allows) and check that the
   replies parse into the paper's response format. Fix the adapter's prompt or parser if they
   do not; record the fix in `report.md`. Then run the requested `n` (default: the paper's own
   per-condition sample size, capped at 60 per condition unless the researcher asks for more;
   state the cap).
3. Write `report.md`: the model, temperature, seed, n per condition and arms run; how many calls
   were made; the paper's **reported** results (from `result` nodes, cited `p. N`), the
   **observed** results from `evaluate`, side by side, with effect sizes and direction; whether
   the finding replicated by the paper's own criterion; and limitations (parsing failures,
   missing arms, LLM-replay adaptations). Save a figure (`matplotlib`, labelled axes, n per
   group) as `results.png`.
4. Never present an observed number as reported, and never adjust prompts to steer results.

Reply with the path of `report.md`, the one-sentence outcome (replicated / not replicated / not
ready, with the key numbers), and the number of model calls. Reply in the researcher's language.
