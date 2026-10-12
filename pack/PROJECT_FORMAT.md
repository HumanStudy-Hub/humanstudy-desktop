# Project folder format

One folder per study project, by default `~/Documents/HumanStudy Projects/<project>/`. The app
shows the whole folder as the **Program** explorer and `program.json` as the **Study** document.

```text
<project>/
  paper.pdf                 the source paper (read-only for the agent)
  sources/                  open materials, supplements, large instruments, datasets
  program.json              Human Program v2 (canonical design; schema/human-program.schema.json)
  package/<paper-slug>/     runnable replay package, the HumanStudy-Bench eight-file contract (build)
  artifacts/                agent outputs; every file appears in the app
    *.html                  self-contained views (visualize)
    *.md, *.py, *.png       analysis reports with their code and figures (analyze)
    simulations/<stamp>/    run.py, sessions.jsonl, evaluation.json, report.md (simulate)
  exports/                  files for leaving the app: *.docx, *.pdf, *.zip (export)
  AGENTS.md, schema/        the pack, installed by the app (do not edit)
  .opencode/skills/         the pack's skills, installed by the app
  .humanstudy/              app state; the agent does not edit it
```

Rules:

- `program.json` is the single source of study facts. Artifacts, the package and exports are
  derived from it and from `paper.pdf`/`sources/`; they never introduce facts of their own.
- `study.json.program` inside the package is an exact copy of `program.json`.
- Citations use the physical page of `paper.pdf` (starting at 1) or a path under `sources/`.
- Paths inside the project are relative. Artifacts load nothing from the network.
- The researcher may edit any file by hand in the app (Study fields become `researcher` origin).
  Re-read a file before changing it; never overwrite an edit you have not seen.
- Proposed changes to accepted files are written beside the target (for example
  `program.proposed.json`, `artifacts/<name>.proposed.html`) until the researcher accepts them;
  see `skills/refine`.
