# Project folder format

One folder per study project, by default `~/Documents/HumanStudy Projects/<project>/`. The app
shows the whole folder as the **Program** explorer and `program.json` as the **Study** document.

```text
<project>/
  paper.pdf                 the source paper (read-only for the agent)
  sources/                  open materials, supplements, large instruments (never participant data:
                            that goes in human-data/)
    open/                   materials downloaded under an open license (url, version, link to the paper)
    private/                public materials without an open license: this project only, never exported. In a
                            published study, a file the researcher drops into the chat lands here (their copy
                            of a source whose wording the app fills in)
    SOURCE.json             every source file's path, SHA-256, size and license ("unknown" unless
                            stated); written by build/sources.py
    researcher/             materials the researcher supplied (instructions, stimuli); recorded as
                            `researcher-supplied`, read by the package at run time, never exported
  program.json              Human Program v2 (canonical design; schema/human-program.schema.json)
  effects.json              hypotheses -> computable effects: outcome, contrast, predicted direction,
                            the paper's reported numbers (each quoted) and how each is computed from
                            sessions (schema/effects.schema.json; checked by build/effects.py);
                            with program.json it forms one typed graph (schema/graph-types.json)
  capabilities.json         what the study can do (read, run, human data, author code, reproduction),
                            each with its reason; written by build/capabilities.py
  protocol.json             the runnable study (protocol route, v0.8): arms, stages, flow, exclusions, units and
                            analysis, run by the bundled engine (.opencode/hsenv); every served text cites
                            its source. Written by the build, checked by `python -m hsenv.checks`
  study.json                identity of the project beside protocol.json: id, title, paper, which protocol (and
                            variant) is current. Not the package's study.json
  sourcetext/               the text of each source the protocol quotes, for the verbatim check: <name>.txt (text
                            layer), <name>#second[-k].txt and <name>#third[-k].txt (blind readings of images).
                            Never overwritten; a new reading gets the next free name
  review/                   checks-<date>.json (hsenv.checks reports), fidelity-review-<n>.md, resolutions-<n>.md:
                            the review trail of protocol.json. Never participant data
  runs/<stamp>/             one engine run of protocol.json: run settings, sessions.jsonl, effects/evaluation,
                            report.md; each record carries the protocol's version hash
  variants/<name>/          researcher variants of the study (protocol.json + a note of what differs); a variant
                            runs only when chosen and never replaces protocol.json silently
  package/<paper-slug>/     runnable replay package (older route, kept read-only for the community library):
                            study.json (refers to program.json), source/paper_metadata.json, materials/, task/,
                            evaluation/
  artifacts/                agent outputs; every file appears in the app
    failures.json           where the template does not fit this paper, and the fallback used
    *.html                  self-contained interactive views (visualize; kit inlined by
                            .opencode/artifact-kit/inline.py)
    *.md, *.py, *.png       analysis reports with their code and figures (analyze)
    simulations/<stamp>/    run.py, sessions.jsonl, evaluation.json, report.md (simulate, package route);
                            plan.json, run.py, run.json, records.jsonl, operator.jsonl, effects.json,
                            results.html, summary.json (simulate, protocol route: skills/run)
    preview.html            the participant view of protocol.json, screen by screen per arm (skills/preview)
  exports/                  files for leaving the app: *.docx, *.pdf, *.zip (export)
  AGENTS.md, schema/        the pack, installed by the app (do not edit)
  .opencode/skills/         the pack's skills, installed by the app
  .opencode/hsenv/          the protocol engine (engine, expr, checks, effects_core; VERSION holds the SHA-256 of
                            each file), installed by the app and kept at the shipped version
  .humanstudy/              app state; the agent does not edit it. original-text.json: for a published study, how
                            much of its held-back wording the app filled in on this computer and what each source
                            still needs (counts and titles only, never the wording)
```

Published studies: a protocol.json published through HumanStudy Hub may carry a top-level `distribution` block
(hsenv 0.8.1, DESIGN §3.6): participant-facing text from a source that may not be redistributed is a placeholder of
the same length (U+2591 per character), and `distribution.held` lists each one with its source, a locator and the
SHA-256 of the exact text. The app restores it on the researcher's computer (pack/runtime/lib/hs_original_text.py
via `hsenv.rehydrate`): link sources are downloaded from their URL, the rest come from files in `sources/private/`,
`paper.pdf` or `sources/`, and each item is accepted only when its text hashes to the recorded value. Downloads
and the restored protocol stay in app storage (`<userData>/original-text/<sha256 of protocol.json>/`), never in
the project. Such a study previews with "[text not available]" in place of missing wording and runs only when
every item is restored; the run plays the restored copy and keeps no screens in its records.

Runnable forms: the app checks both forms itself, from its own copy of the checkers, never the project's, and
keeps the two results apart. `package/<slug>/` runs when it passes the package contract and the build checks.
`protocol.json` is checked by the engine: refs; random-answer sessions that reach every stage and compute every
effect; keyed answers; verbatim texts against `sourcetext/`; coding cases. A passing protocol.json never makes a
package runnable. A run approval names its route: a protocol run plays protocol.json with the engine
(skills/run), a package run executes package/. New studies take the protocol route; the
package route is kept so community studies built before v0.8 still run.

Rules:

- `program.json` is the single source of study facts. Artifacts, the package and exports are
  derived from it and from `paper.pdf`/`sources/`; they never introduce facts of their own.
- The package refers to `program.json` (`study.json.programRef`) and never copies it; the evidence
  and the missing information are read from `program.json`. Older packages with a program copy,
  `source/evidence.json` and `audit/missing_information.json` still work.
- Runs and reproductions return one result block per effect (`effects`), the same shape for human
  and AI-participant sessions: raw cells (n, mean, sd or counts), the test and the metric. Converting
  between effect-size metrics is left to later tools.
- Tools refuse work that `capabilities.json` says the study cannot do, with the reason.
- Citations use the physical page of `paper.pdf` (starting at 1) or a path under `sources/`.
- Paths inside the project are relative. Artifacts load nothing from the network.
- The researcher may edit any file by hand in the app (Study fields become `researcher` origin).
  Re-read a file before changing it; never overwrite an edit you have not seen.
- Proposed changes to accepted files are written beside the target (for example
  `program.proposed.json`, `artifacts/<name>.proposed.html`) until the researcher accepts them;
  see `skills/refine`.
