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
`app_run.py` (the run), `launch.py` (how the app starts it), `protocol_report.py` (results page) and `budget.py`
(the model budget) are the app's. The app runs its own shipped copy of all of them.

## Approval

Only a `[Simulation scope approved]` message from the Simulation tab with `"route": "protocol"` approves a run, and
the app starts that run itself (see Procedure). If protocol.json changed after the approval, the app refuses to
start and says so; ask the researcher to press Run simulation again. Never handle a key.

The app enforces the rest itself:
- The relay's token budget is `plan.tokenBudget`. The app measured it from protocol.json (one call per page,
  prompts that grow with every page, every group member) and the researcher approved that figure. Do not try to
  stretch it.
- On macOS the run capability is bound to this approval's route, protocol.json version and run id, and the run
  is confined by the system sandbox; it refuses to run under any other approval, or after protocol.json changed.
- A model call that fails (a refusal, the token budget) ends that participant as incomplete. A run that does not
  reach every planned participant ends `failed`, with a results page and summary labelled PARTIAL. Report it as
  partial; never present it as the planned comparison.
- A stopped run (STOP, or progress `stopped`) starts again only under a new Run simulation approval given after
  the stop. Never delete STOP yourself.

## Procedure

The app starts the run itself when the researcher presses Run simulation, from its own copy of this code (not
the project's `.opencode` copy, and not a script you write). It creates `artifacts/simulations/<YYYY-MM-DD-HHMM>/`
with a `plan.json` that says `"startedBy": "app"`. Do not start, restart or copy a protocol run yourself; never
write a run.py for it.

1. Find the newest folder under `artifacts/simulations/` whose `plan.json` says `"route": "protocol"`. Check its
   `progress.json` every 20–60 seconds (`sleep 30; cat artifacts/simulations/<run>/progress.json`) until the stage
   is `done`, `failed` or `stopped`. `run.log` holds the run's output.
2. `done`: the app has written `results.html` (human vs AI per effect and the engine's scores, an offline report,
   not a leaderboard) and `summary.json`.
   `failed` with "Partial run": some participants did not finish; report the page as partial.
   `failed` otherwise: read `run.log` and tell the researcher in plain words; a new Run simulation starts a new run.
   `stopped`: the researcher pressed Stop; report what finished (run.json `app`, partial.jsonl). Do not restart.
3. Reply with the completion rate (`run.json` `participants`), the headline from `summary.json` (the engine's
   verdict on an official n, else "Finished" with values only), the number of model calls, and that the result is
   in the Simulation tab. Say plainly that AI participants are not people and that agreement with the paper does
   not show human validity.
