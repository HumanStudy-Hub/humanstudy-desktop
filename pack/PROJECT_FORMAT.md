# Project folder format

One folder per study project, by default `~/HumanStudy/<project>/`.

```text
<project>/
  paper.pdf                 the source paper (read-only for the agent)
  sources/                  open materials, supplements, large instruments, datasets
  program.json              Human Program v2 (canonical design; schema/human-program.schema.json)
  artifacts/                agent outputs shown in the artifact panel
    *.html                  self-contained views (visualize)
    *.png                   figures (analyze)
    *.md                    analysis reports, change summaries
  exports/                  files for leaving the app: *.docx, *.pdf, *.zip (export)
  .humanstudy/
    session.json            app/kernel session state; the agent does not edit it
```

Rules:

- `program.json` is the single source of study facts. Artifacts and exports are derived from it
  and from `paper.pdf`/`sources/`; they never introduce facts of their own.
- Citations use the physical page of `paper.pdf` (starting at 1) or a path under `sources/`.
- Paths inside the project are relative. Artifacts load nothing from the network.
- Replayable study packages (built by `skills/build`) go under `artifacts/package/<paper-slug>/`
  and are zipped into `exports/` on request.
- Proposed changes are written beside the target (for example `program.proposed.json`,
  `artifacts/<name>.proposed.html`) until the researcher accepts them; see `skills/refine`.
