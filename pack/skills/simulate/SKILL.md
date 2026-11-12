---
name: simulate
description: Run the study's replay package with a language model playing every original participant, then compare the observed results with the paper's reported results. Use when the researcher asks to simulate, replay, run, pilot or test the study, or asks whether agents reproduce the finding.
---

# Simulate: AI participants take part in the study

**Two routes.** An approval whose JSON has `"route": "protocol"` runs `protocol.json` with the engine: follow the
`run` skill (`.opencode/skills/run/SKILL.md`) instead of this page's procedure; the model access rules below
apply to it unchanged. An approval with `"route": "package"`, or with no route, runs `package/<paper-slug>/` as
described here.

A simulation runs the participants of `package/<paper-slug>/` (prompts and reply parsing in
`task/adapter.py`) and scores them with `evaluation/evaluation.py` → `evaluate(sessions)`. If there
is no package yet, run the `build` skill first (section 3). If `study.json.readiness.status` is
`blocked`, stop and tell the researcher which decisions are needed; never fill them in to make the
run possible.
Read `capabilities.json` too: parts listed in `run.excluded` are not run (say so in the report, with
the reason), and a `partial` run is reported as partial, never as the whole paper.
When the package has `human/key.json`, run `study_core.py reproduce` before comparing AI with people
(`python .opencode/skills/simulate/run_confined.py --no-model .opencode/skills/export/agent/study_core.py --root . reproduce`, after `study_core.py --root . human-data` has fetched the files):
it says how far the package's analysis recovers the paper from the human data, and whether those
data are the paper's own sample.

The researcher follows the run in the app's **Simulation** tab, which reads the files below while
you work. They do not read code: every sentence you write for them (progress messages, the
summary) is plain language about participants, conditions and results.

## Model access

Always launch the complete run script through `.opencode/skills/simulate/run_confined.py`,
including trials and `study_core.py run/reproduce` wrappers. Never import package code in an
unconfined process.

On macOS the app sets `HUMANSTUDY_RELAY_REQUIRED=1`: it creates an approved-run local relay whose
per-run capability is not an upstream model key, and `run_confined.py` runs the script inside
macOS sandbox-exec. The relay permits only the approved model, with at most 4,096 output tokens
per call. Its token cap and lifetime follow the approved plan: 40,000 tokens per AI participant
(conditions x `plan.perCondition` in the approval message), at least 200,000 and at most
16,000,000; 0.2 minutes per participant, at least 30 and at most 120 minutes. Only text messages
are supported. Do not retry a token-cap refusal.

Each call reserves, before it runs: its request size in bytes + 256 per message + its output
limit. `humanstudy_llm` (and `study_core.http_llm`) send an output limit of 512 tokens per call
by default, enough for a participant's answer with a short reason. In a run script you write, pass
a larger `max_tokens` only to a call whose reply genuinely needs it (a long essay, a multi-question block), never as a
blanket setting. Package adapters call `llm(prompt)` with no arguments; when a package's
participants must write long replies (`task/task.json` has `"maxOutputTokens"`, or a trial run
logs truncated replies), set `HUMANSTUDY_LLM_MAX_OUTPUT` to that number for the whole run instead,
and count it in the estimate below. Before a real run, estimate one participant: the sum over its calls of (prompt
bytes + 256 x messages + output limit), about 4,000 for a 3 KB prompt, more when a conversation
resends its history. If that exceeds 40,000 (or the run would pass 16,000,000), say so in the run
confirmation, with how many participants fit, instead of letting the cap stop the run halfway.
Real upstream credentials stay in the app process.

Desktop execution of legacy packages requires verified file isolation. On computers without that
isolation, the researcher can review and export the project or run a supported protocol through the
bundled engine. Preserve the legacy package when preparing a protocol.

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
to the usage log: `artifacts/simulations/<run>/llm-usage.jsonl` for a run started through
`run_confined.py` on macOS (the sandbox writes only there), else `.humanstudy/tmp/llm-usage.jsonl`.
Each call sends `max_tokens` 512 unless you pass one (or set
`HUMANSTUDY_LLM_MAX_OUTPUT` for the run, 1 to 4,096). A usage line with `"truncated": true` is a
reply cut off at that limit: count them and report them; if a measure depends on the cut-off
part, rerun those calls with a larger limit (`HUMANSTUDY_LLM_MAX_OUTPUT` for package calls). `study_core.http_llm` instead warns on stderr
and counts them (`llm.truncated`, `llm.calls`). It raises `LLMError` when a call fails for good; count such
failures in the report instead of retrying forever. Never print, write or pass on any key or
environment variable; do not call the endpoint any other way.

## Approval

Before starting any real run or reproduction, check `.humanstudy/community.json` in the project.
If present (including unreadable or malformed provenance), say exactly, when
`HUMANSTUDY_RELAY_REQUIRED` is `1` (macOS):
"This study's code will run on your computer through a limited model relay (up to {tokens} tokens and {minutes} minutes)."
with the plan's limits above filled in (tokens written like 4,800,000), and otherwise (Linux, Windows):
"This study's code will run on your computer with access to your model key."
Without the relay, also say for every run, community or not:
"On this computer, the study's code can read your API key. Only run studies you trust."
Include it in the existing run confirmation, before any package code executes; do not add a
button or dialog. Community revision provenance currently carries no authenticated maintainer
review attestation, so show the notice for every such fork. A local `reviewed` flag is not proof
of review. This applies to `study_core.py run/reproduce`, `simkit.py`, and trial runs too.

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
   A package that asks through `task/replies.py` (the adapter has `from replies import ...`): inside `one`,
   call `adapter.run_sessions(lambda p: llm(p, temperature=TEMPERATURE), rng.randrange(2**31), 1,
   arms=[condition])[0]`, so every screen, keyed check, retry and session `status` is the adapter's own; use
   `build_prompt`/`parse_reply` only for a single-screen study, and read replies only with `parse_reply` (which
   uses `replies.parse`), never with a parser of your own.
   Never cache replies across participants: two participants with the same prompt must get two
   independent model calls (a cache would make them identical copies).

2. **Trial first**: `python .opencode/skills/simulate/run_confined.py artifacts/simulations/<run>/run.py --trial` (one participant per condition; a few seconds). Check that
   every reply parses into the paper's response format. Fix the adapter's prompt or parser if not, and
   record the fix in `report.md`. Never adjust prompts to steer results.

3. **The full run, in the background** (the shell tool stops commands after 2 minutes, and may end
   processes it started; `start` detaches run.py so it keeps running):

   ```bash
   python .opencode/skills/simulate/simkit.py start artifacts/simulations/<run>
   ```

   Then check every 20–60 seconds with a short command (`sleep 30; cat artifacts/simulations/<run>/progress.json`)
   until `progress.json` says `scoring`, `writing`, `failed` or `stopped`. If it failed, read `run.log`,
   fix the cause and start again (finished participants are kept, so no model call is repeated).
   On macOS the run's model access ends when a run finishes, on Stop, or at its time limit; if the
   launcher says it has ended, ask the researcher to press Run simulation again. If it says `stopped`, the researcher
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
the number of model calls (from the usage log above; on macOS the run folder's `llm-usage.jsonl`), and that the result is in the
Simulation tab. Reply in the researcher's language.
