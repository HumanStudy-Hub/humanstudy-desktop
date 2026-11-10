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

## Original wording (published studies)

A study published through HumanStudy Hub may arrive without some of its participant-facing wording: text whose
source may not be redistributed (a journal's questionnaire, a publisher's PDF) is held back, and protocol.json
holds a placeholder (a run of `░`) of the same length where it goes, under a top-level `distribution` block. The
app fills it in on the researcher's own computer, without you:

- it downloads each source that has a public link from the publisher;
- it tries every file the researcher dropped into the chat (for such a study they land in `sources/private/`,
  which stays in this project and is never exported) and `paper.pdf`;
- it checks every screen's wording against the exact text the study was built with, so a wrong file can only leave
  a screen empty, never put other words on it.

The restored copy stays in the app's own storage, never in the project. You never see it, and you never write or
edit the wording yourself: never type, paste or reconstruct held text into protocol.json, `sourcetext/` or any
file, and never remove the `distribution` block.

What the app found is in `.humanstudy/original-text.json` (read it; never edit it): `complete`, `screensMissing`,
and per source its `title`, `format`, `screens` still empty and `need`. Tell the researcher in plain words, in
their language, never with the words "rehydrate", "projection", "placeholder", "hash" or "sha256":

| need | say |
|---|---|
| `file` | "Drop in your copy of <title> (<format>) to fill in N screens. It stays on your computer." |
| `download` | "HumanStudy Hub tried to fetch <title> from the publisher on your computer, but the download did not work (a paywall or a dead link). Drop in your copy of <title> (<format>) to fill in N screens." |
| `wrong-file` | "Your copy of <title> does not match the version the study was built from. Drop in that version." |
| `changed-online` | "The copy of <title> online has changed since the study was built. Drop in your copy of the version the study used." |
| `pdf-reader` | "This computer cannot read PDF files yet: update or reinstall HumanStudy Hub, then open the study again." |
| `app-version` | "This study was published for a newer HumanStudy Hub: update the app." |
| `reading` | "Some wording is printed inside a picture and cannot be filled in automatically yet." |

The first line to say is: "The study's original wording comes from the paper; HumanStudy Hub fetches it from the
publisher on your computer." After the researcher drops a file into the chat, wait a few seconds and read
`.humanstudy/original-text.json` again; say how many screens are now filled in and what is still needed.

Until `complete` is true the study opens as a preview (`skills/preview` shows "[text not available]" where wording
is missing) but cannot run: the Simulation tab says why, and the app refuses to start a run whose screens would
show "[text not available]". Never try to run it some other way. Once it is complete, a run's records keep the
answers but not the screens, so the restored wording does not end up in the project.

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
