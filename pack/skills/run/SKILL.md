---
name: run
description: Prepare a requested experiment scope, or run the study's protocol.json with AI participants (answers = f(state), f = the app's model) and compare the result with the paper's printed numbers. Start a run only after a "[Simulation scope approved]" message whose JSON has "route": "protocol"; for "route": "package" (or no route) use the simulate skill.
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

## A request before approval

If the researcher asks to run a named experiment before an approved scope exists, use build's requested-scope
procedure first. Read the complete scholarly program and current protocol, prepare only the requested scope,
and use a specific question/material request if needed. Do not start the run or create a new paid-model script.
If the original cannot run, show the exact gap; a modified-wording proposal needs researcher confirmation
and separate storage. Never silently replace the original protocol to make it runnable.

## Original wording (published studies)

A study published through HumanStudy Hub may arrive without some of its participant-facing wording: text whose
source may not be redistributed (a journal's questionnaire, a publisher's PDF) is held back, and protocol.json
holds a placeholder (a run of `░`) of the same length where it goes, under a top-level `distribution` block. The
app fills it in on the researcher's own computer, without you:

- it downloads each source that has a public link from the publisher;
- it tries every file the researcher dropped into the chat (for such a study they land in `sources/private/`,
  which stays in this project and is never exported) and `paper.pdf`;
- it checks every screen's wording against the exact text the study was built with, so a wrong file can only leave
  a screen empty, never put other words on it;
- when the exact check fails but the study carries a fingerprint of a passage, it finds that passage in the
  researcher's own copy of the PDF (**approximate**: the wording comes from their copy and may contain reading
  errors, for example from a scan);
- what still cannot be filled in, you can fill with the researcher (see "When no file fills a screen" below).

**Never open, read, extract, summarise or quote any file in `sources/private/`**, nor anything in the app's storage
folder `original-text/` (the restored wording): no read tool, no `cat`, `hs-pdf`, `pdftotext`, Python or `grep` on
them. Their text must stay on this computer, and whatever you read goes to the model and into the conversation
record. When the researcher drops a file, an app note tells you it was received for filling in the wording; reply
from `.humanstudy/original-text.json` only.

Never move, copy or rename the researcher's copy of a source out of `sources/private/` (into `paper.pdf`,
`sources/` or anywhere else): only `sources/private/` stays out of exports and research capture. If they mention a
copy that sits elsewhere in the project, ask before moving it into `sources/private/`. The restored copy stays in
the app's own storage, never in the project. You never see it. Never type, paste or reconstruct held text into
protocol.json, `sourcetext/` or any file other than the fills file below, and never edit or remove the
`distribution` block (the app notices a changed one and blocks the run).

What the app found is in `.humanstudy/original-text.json` (read it; never edit it): `complete`, `screensMissing`,
how the restored items were filled in (`exact`, `approx`, `supplied.user`, `supplied.reconstructed`, and `labels`:
held id -> `approx` | `user` | `reconstructed`), `unresolved` (each item nothing filled in: `held` id, `screen`,
`path` in protocol.json, `source`, `title`, `kind`, `length` in characters, `need`), `fillsFile`, `fillsProblems`,
and per source its `title`, `format`, `screens` still empty and `need`. It never holds any wording. Tell the
researcher in plain words, in their language, never with the words "rehydrate", "projection", "placeholder",
"hash" or "sha256":

| need | say |
|---|---|
| `file` | "Drop in your copy of <title> (<format>) to fill in N screens. It stays on your computer." |
| `download` | "HumanStudy Hub tried to fetch <title> from the publisher on your computer, but the download did not work (a paywall or a dead link). Drop in your copy of <title> (<format>) to fill in N screens." |
| `wrong-file` | "Your copy of <title> does not match the version the study was built from. Drop in that version." |
| `changed-online` | "The copy of <title> online has changed since the study was built. Drop in your copy of the version the study used." |
| `pdf-reader` | "This computer cannot read PDF files yet: update or reinstall HumanStudy Hub, then open the study again." |
| `app-version` | "This study was published with a different version of HumanStudy Hub's PDF reader: update the app; if that does not help, ask the study's publisher." |
| `held-changed` | "This study's record of which wording to fill in was changed or removed after it was first opened on this computer, so it cannot run. Put back the study's protocol.json exactly as you received it." (never edit it back yourself from memory) |
| `checks-failed` | "With its original wording filled in, the study did not pass its own checks, so it cannot run. If protocol.json or the files in sourcetext/ were changed on this computer, put back the versions you received; otherwise the published version itself needs fixing." |
| `picture` | "Some screens show pictures from <title>. Drop in a screenshot or scan of each picture (the figure or the page it is on); it stays on your computer." Then fill it as in "When no file fills a screen". |
| `reading` | "Some wording is printed inside a picture and cannot be filled in automatically yet." |

### When no file fills a screen

A screen whose wording no file can fill in (`unresolved` is not empty: printed inside a picture, a scan without a
text layer, a questionnaire the researcher does not have, a passage that cannot be located) need not stop the run.
Offer these steps, in this order, one passage at a time, naming the screen (its stage) and the source `title`:

1. **Ask the researcher for the passage first**: "Please paste (or type) the wording of <screen> from <title>
   here, exactly as printed." Use their words exactly as given. Origin `user`. (A screenshot of a text passage does
   not help: a file dropped into a published study stays private and you never open it. Screenshots are for
   pictures, below.)
2. **Reconstruct only when the paper does not print it** (or the researcher cannot get it), and only after the
   researcher agrees: write the closest wording the paper's description supports, of about the given `length`.
   Origin `reconstructed`. Say plainly that it is a reconstruction, not the original wording.

Write each passage into the fills file `sources/private/original-text-fills.json` (the `fillsFile`; it stays on
this computer, in this project, and is never exported, published or collected). It is the one file in
`sources/private/` you may read and write. One JSON object keyed by held id:

```json
{
  "h7": {"text": "<the wording>", "origin": "user", "note": "pasted by the researcher"},
  "h9": {"text": "<the wording>", "origin": "reconstructed", "note": "the paper describes this item but does not print it"}
}
```

Keep the entries already there; never put wording anywhere else. `origin` is `user` (the researcher gave it) or
`reconstructed` (you wrote it with their agreement), never anything else, and never label a reconstruction `user`.
Wait a few seconds and read `.humanstudy/original-text.json` again: the app applies a fill only to a screen that no
file filled in (the exact wording, then the approximate one, win over a fill), and reports problems with an entry in
`fillsProblems`. A pasted passage that is exactly the published text counts as exact.

Once the study runs, say how its wording was filled in whenever `approx` or `supplied` is not zero, before the run
and with its results: "N passages came from your copy of the paper and may contain reading errors; N you supplied;
N were reconstructed."

A held picture (`kind: picture` in `unresolved`) is filled with a file, never with text: ask the researcher to drop
in a screenshot or scan of that figure or page (PNG, JPEG, GIF or WebP). The app note names where it landed (in
`sources/private/`); do not open it. Then add `"<held id>": {"file": "sources/private/<name>", "origin": "user"}`
to the fills file. It counts as exact when it is the very published picture, otherwise as supplied by the
researcher (`supplied.user`), and say so like any supplied wording.

### Arms marked not runnable

A released protocol may mark an arm `runnable: false` with a `why` (its materials are not printed in the paper).
The rest of the study runs without it. If the researcher wants that arm, you may, with their agreement, reconstruct
the missing materials in the project's protocol.json, label every reconstructed text as reconstructed (say so in
the arm's `why`/notes and to the researcher), and only then mark the arm runnable. Never present a reconstructed
arm as the original.

The first line to say is: "The study's original wording comes from its original materials (the paper,
questionnaire or booklet), and HumanStudy Hub fills it in on your computer." Say "HumanStudy Hub fetches it from the
publisher on your computer" only for a source with a `url` (tier `link`); for the others the researcher supplies
the file. After the researcher drops a file into the chat, wait a few seconds and read
`.humanstudy/original-text.json` again; say how many screens are now filled in and what is still needed.

Until `complete` is true (approximate and supplied wording count) the study opens as a preview (`skills/preview` shows "[text not available]" where wording
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
