---
name: simulate
description: Run the study's replay package with a language model playing every original participant, then compare the observed results with the paper's reported results. Use when the researcher asks to simulate, replay, run, pilot or test the study, or asks whether agents reproduce the finding.
---

# Simulate: AI participants take part in the study

A simulation runs the participants of `package/<paper-slug>/` (prompts and reply parsing in
`task/adapter.py`) and scores them with `evaluation/evaluation.py` → `evaluate(sessions)`. If there
is no package yet, run the `build` skill first (section 3). If `study.json.readiness.status` is
`blocked`, stop and tell the researcher which decisions are needed; never fill them in to make the
run possible.
Read `capabilities.json` too: parts listed in `run.excluded` are not run (say so in the report, with
the reason), and a `partial` run is reported as partial, never as the whole paper.
When the package has `human/key.json`, run `study_core.py reproduce` before comparing AI with people:
it says how far the package's analysis recovers the paper from the human data, and whether those
data are the paper's own sample.

The researcher follows the run in the app's **Simulation** tab, which reads the files below while
you work. They do not read code: every sentence you write for them (progress messages, the
summary) is plain language about participants, conditions and results.

## Model access

Use the runtime's `humanstudy_llm` module. It is importable as is from the bundled `python` (never
add a `sys.path` entry for it), and needs no key handling and no package install:

```python
from humanstudy_llm import llm, chat, model_name
reply = llm(prompt, temperature=1.0)                       # str; prompt may carry system=...
reply = chat([{"role": "system", "content": s}, {"role": "user", "content": u}], seed=7)
```

It calls the HumanStudy Hub hosted models of the signed-in account (model from
`HUMANSTUDY_SIM_MODEL`, default the model selected in the app), retries 429/5xx with backoff, caps
concurrent calls (`HUMANSTUDY_LLM_CONCURRENCY`, default 8) and appends token usage (no prompt text)
to `.humanstudy/tmp/llm-usage.jsonl`. It raises `LLMError` when a call fails for good; count such
failures in the report instead of retrying forever. Never print, write or pass on any key or
environment variable; do not call the endpoint any other way.

## Approval

The Simulation tab shows the researcher what will run (study, conditions, AI participants per
condition, model, what cannot be simulated) and its **Run simulation** button sends a message
beginning `[Simulation scope approved]` with JSON: program id, SHA-256 of the complete
`program.json`, the study id, the five section-12 fields, and `plan` (`perCondition`, the condition
ids, the model). That message is the researcher's confirmation; nothing else is.

- Re-read `program.json` and check the hash of the exact file bytes
  (`hashlib.sha256(Path('program.json').read_bytes()).hexdigest()`). If it differs, or a blocking
  issue remains, or there is no approval, do not run even a trial: explain in two plain sentences
  and ask the researcher to press Run simulation again in the Simulation tab.
- Run only the approved study, with `plan.perCondition` AI participants in each condition (if
  absent: the paper's per-condition sample size, capped at 60; state the cap). Approval of one study
  never approves another.
- Open decisions of the study (`decision` issues) are settled with the paper's reported design when
  it states one; otherwise ask with the native `question` tool (a few options in social-science
  language plus a written answer). A dismissed question is not consent. Never change `program.json`
  during a run.
- Clearly distinguish AI simulation from observations of people; neither agreement of results nor a
  runnable adapter demonstrates human validity.

## Procedure

Create `artifacts/simulations/<YYYY-MM-DD-HHMM>/` (the run folder) and work inside it.

1. **run.py** uses `.opencode/skills/simulate/simkit.py`, which runs participants in parallel,
   writes `progress.json` (what the app shows), appends `sessions.jsonl` as each participant
   finishes, resumes after an interruption, and honours the researcher's Stop button:

   ```python
   import sys, json, importlib.util
   from pathlib import Path
   RUN = Path(__file__).resolve().parent
   PROJECT = RUN.parents[2]
   sys.path.insert(0, str(PROJECT / ".opencode/skills/simulate"))
   from simkit import SimRun
   from humanstudy_llm import llm, model_name
   def load(name, path):
       spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec)
       spec.loader.exec_module(m); return m
   PKG = PROJECT / "package/<paper-slug>"
   adapter = load("adapter", PKG / "task/adapter.py"); evaluation = load("evaluation", PKG / "evaluation/evaluation.py")
   TEMPERATURE, SEED = 1.0, 20261015
   run = SimRun(RUN, plan={"<condition-id>": N, ...}, model=model_name(), seed=SEED)

   def one(condition, index, rng):          # one AI participant, one independent model call (or turn sequence)
       prompt = adapter.<build the prompt for condition>       # the adapter's own prompt builder
       reply = llm(prompt, temperature=TEMPERATURE)
       return {"condition": condition, "arm": ..., "reply": reply, "answers": adapter.<parse>(..., reply)}

   if "--trial" in sys.argv:
       print(json.dumps(run.participants(one, trial=1), ensure_ascii=False)[:3000]); sys.exit()
   sessions = run.participants(one)
   run.stage("scoring")
   (RUN / "evaluation.json").write_text(json.dumps(evaluation.evaluate(sessions), indent=2, default=str))
   run.stage("writing")
   ```

   Assignment is balanced: exactly `N` per condition (the plan), in the adapter's own prompt and
   reply format. If the adapter has no separate prompt/parse functions, call
   `adapter.run_sessions(llm, seed, n, arms=[...])` inside `one` for a single participant and arm.
   Never cache replies across participants: two participants with the same prompt must get two
   independent model calls (a cache would make them identical copies).

2. **Trial first**: `python run.py --trial` (one participant per condition; a few seconds). Check that
   every reply parses into the paper's response format. Fix the adapter's prompt or parser if not, and
   record the fix in `report.md`. Never adjust prompts to steer results.

3. **The full run, in the background** (the shell tool stops commands after 2 minutes, and may end
   processes it started; `start` detaches run.py so it keeps running):

   ```bash
   python .opencode/skills/simulate/simkit.py start artifacts/simulations/<run>
   ```

   Then check every 20–60 seconds with a short command (`sleep 30; cat artifacts/simulations/<run>/progress.json`)
   until `progress.json` says `scoring`, `writing`, `failed` or `stopped`. If it failed, read `run.log`,
   fix the cause and start again (finished participants are kept, so no model call is repeated). If it says `stopped`, the researcher
   pressed Stop: do not restart; report what was finished.

4. **report.md**: the model, temperature, seed, AI participants per condition and arms run; number
   of model calls and failed/unreadable replies; the paper's **reported** results (from `result` nodes,
   cited `p. N`) and the **observed** results from `evaluate`, side by side, with effect sizes and
   direction; whether the finding replicated by the paper's own criterion; limitations (parsing
   failures, missing arms, adaptations for AI participants).

5. **results.html** with the `visualize` skill's kit, then `python .opencode/artifact-kit/inline.py
   artifacts/simulations/<run>/results.html` until `PASS`:
   - an `hs-banner` "Simulation — not human data" (`HS.simLabel()`) at the top and the one-sentence
     outcome by the paper's own criterion as the title;
   - `HS.results` (or `HS.forest` for effect sizes) with, per condition, `human` = the paper's reported
     value (`id` of the result node, `page`) and `sim` = the observed value with `values: [...]` (one per
     session, from `sessions.jsonl`) so spread and 95% CI are drawn; never an observed number in `human`;
   - `HS.manifest` with model, temperature, seed, n per condition, arms run, number of calls, unreadable
     replies, date, and the approved `program.json` SHA-256;
   - a short limitations list (`hs-card`), and a link-free reference to `report.md`.

6. **summary.json**, read by the Simulation tab above the chart, in the researcher's language:

   ```json
   {"outcome": "replicated | partly | not_replicated | not_ready",
    "paragraph": "4-6 plain sentences: did the AI participants show the paper's effect (by the paper's own criterion), how big it was compared with the paper (the key numbers side by side), and the main caveats. No code, file names or statistics jargon beyond what the paper itself uses.",
    "model": "<model id>", "perCondition": N, "calls": <model calls>}
   ```

7. Finally `python .opencode/skills/simulate/simkit.py stage artifacts/simulations/<run> done`.
   On any failure you cannot fix: `... stage <run> failed "<one plain sentence: what went wrong>"`.

Reply with the one-sentence outcome (replicated / not replicated / not ready, with the key numbers),
the number of model calls (from `.humanstudy/tmp/llm-usage.jsonl`), and that the result is in the
Simulation tab. Reply in the researcher's language.
