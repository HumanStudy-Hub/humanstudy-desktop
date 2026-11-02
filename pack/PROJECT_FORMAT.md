# Project folder format

One folder per study project, by default `~/Documents/HumanStudy Projects/<project>/`. The app
shows the whole folder as the **Program** explorer and `program.json` as the **Study** document.

```text
<project>/
  paper.pdf                 the source paper (read-only for the agent)
  sources/                  open materials, supplements, large instruments, datasets
  program.json              Human Program v2 (canonical design; schema/human-program.schema.json)
  effects.json              hypotheses -> computable effects: outcome, contrast, predicted direction,
                            the paper's reported numbers (each quoted) and how each is computed from
                            sessions (schema/effects.schema.json; checked by build/effects.py);
                            with program.json it forms one typed graph (schema/graph-types.json)
  capabilities.json         what the study can do (read, run, human data, author code, reproduction),
                            each with its reason; written by build/capabilities.py
  package/<paper-slug>/     runnable replay package (build): study.json (refers to program.json),
                            source/paper_metadata.json, materials/, task/, evaluation/
  artifacts/                agent outputs; every file appears in the app
    failures.json           where the template does not fit this paper, and the fallback used
    *.html                  self-contained interactive views (visualize; kit inlined by
                            .opencode/artifact-kit/inline.py)
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
