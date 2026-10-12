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

Use the runtime's `humanstudy_llm` module; it is importable from the bundled `python`, and needs no
key handling and no package install:

```python
from humanstudy_llm import llm, chat, llm_many
reply = llm(prompt, temperature=1.0)                       # str; prompt may carry system=...
reply = chat([{"role": "system", "content": s}, {"role": "user", "content": u}], seed=7)
replies = llm_many(prompts)                                # parallel, order kept
```

It calls the HumanStudy Hub hosted models of the signed-in account (model from
`HUMANSTUDY_SIM_MODEL`, default the model selected in the app), retries 429/5xx with backoff, caps
concurrent calls (`HUMANSTUDY_LLM_CONCURRENCY`, default 8) and appends token usage (no prompt text)
to `.humanstudy/tmp/llm-usage.jsonl`. It raises `LLMError` when a call fails for good; count such
failures in the report instead of retrying forever. Never print, write or pass on any key or
environment variable; do not call the endpoint any other way. Use the bare `python` /
`python3` on PATH (the managed runtime with numpy, scipy, pandas, statsmodels, matplotlib).

## Procedure

1. Create `artifacts/simulations/<YYYY-MM-DD-HHMM>/` and write `run.py` there. It imports the
   adapter and evaluation by path, builds `llm(prompt) -> str` from `humanstudy_llm.llm` with a
   fixed temperature (state it) and a per-prompt cache in `cache.json`, runs `run_sessions(llm, seed, n, arms)`,
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
ready, with the key numbers), and the number of model calls (from `.humanstudy/tmp/llm-usage.jsonl`). Reply in the researcher's language.
