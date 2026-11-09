---
name: run
description: Run the study's protocol.json with AI participants (answers = f(state), f = the app's model) and compare the result with the paper's printed numbers. Use only after a "[Simulation scope approved]" message whose JSON has "route": "protocol"; for "route": "package" (or no route) use the simulate skill.
---

# run: AI participants take part in protocol.json

The study owns the *state* (exactly what a participant had on screen, what they saw before, their own answers)
and the *step* (what happens after an answer); the engine (`.opencode/hsenv`) plays both. The participant, f, is
the app's model: one fresh call per page, the page shown by the default renderer (`render.py`, text only:
pictures appear as an id and their verified text lines), JSON answers. `run.json` records f, the model and the
protocol's SHA-256, so every result names what produced it.

`run_study.py`, `fspec.py` and `render.py` are vendored from the sandbox and never edited here.
`app_run.py` (launcher) and `protocol_report.py` (results page) are the app's.

## Approval

Only a `[Simulation scope approved]` message from the Simulation tab with `"route": "protocol"` approves a run.
Check `protocolHash` against the exact bytes of `protocol.json`
(`hashlib.sha256(Path('protocol.json').read_bytes()).hexdigest()`). If it differs, do not run even a trial: say
so in two plain sentences and ask the researcher to press Run simulation again. Run only `plan.perCondition` AI
participants per arm. Model access, sandbox and limits are the simulate skill's "Model access" section: always
launch through `run_confined.py`, never import the run in an unconfined process, never handle a key.

The app enforces the rest itself:
- The relay's token budget is `plan.tokenBudget`. The app measured it from protocol.json (one call per page,
  prompts that grow with every page, every group member) and the researcher approved that figure. Do not try to
  stretch it.
- On macOS the run capability is bound to this approval's route, protocol.json version and run id. `run.py`
  refuses to run under any other approval, or after protocol.json changed.
- A model call that fails (a refusal, the token budget) ends that participant as incomplete. A run that does not
  reach every planned participant ends `failed`, with a results page and summary labelled PARTIAL. Report it as
  partial; never present it as the planned comparison.
- A stopped run (STOP, or progress `stopped`) starts again only under a new Run simulation approval given after
  the stop. Never delete STOP yourself.

## Procedure

```bash
python .opencode/skills/run/app_run.py new artifacts/simulations/<YYYY-MM-DD-HHMM> --per-arm <plan.perCondition> --protocol-hash <protocolHash>
python .opencode/skills/simulate/run_confined.py artifacts/simulations/<run>/run.py --trial     # one participant per arm
python .opencode/skills/simulate/simkit.py start artifacts/simulations/<run>                    # the full run, detached
```

1. **Trial**: read the printed status. Every arm's participant should complete; `trial/records.jsonl` shows each
   page and the model's raw reply (`note.reply`). A reply that does not parse, or a page the model cannot pass,
   is a finding for the researcher: report it; never change protocol.json or the renderer to steer answers.
2. **Full run**: check `progress.json` every 20–60 seconds (`sleep 30; cat artifacts/simulations/<run>/progress.json`)
   until its stage is `done`, `failed` or `stopped`. `failed` with "Partial run" means some participants did not
   finish: report the partial page as partial. A run that failed for another reason resumes when started again
   (logged answers are replayed, no model call is repeated). `stopped` means the researcher pressed Stop: do not
   restart.
3. When it is `done`, run.py has written `results.html` (human vs AI per effect, an offline report, not a
   leaderboard; checked by the artifact kit) and `summary.json`. If either is missing, run
   `python .opencode/skills/run/protocol_report.py artifacts/simulations/<run>`.
4. Reply with the completion rate (`run.json` `participants`), the direction comparison from `summary.json`, the
   number of model calls, and that the result is in the Simulation tab. Say plainly that AI participants are not
   people and that agreement with the paper does not show human validity.
