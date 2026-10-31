# Project folder

One folder per paper. `program.json` is the single source of study facts; everything else is
derived from it and from the paper.

```text
<project>/
  paper.pdf                 the source paper (read-only)
  sources/                  open materials, supplements, large instruments, datasets (optional)
  program.json              Human Program v2 ($HS/schema/human-program.schema.json)
  effects.json              hypotheses -> computable effects, each reported number quoted
                            (schema/effects.schema.json; scripts/build/effects.py;
                            graph vocabulary schema/graph-types.json)
  capabilities.json         what the study can do, each with its reason (scripts/build/capabilities.py)
  package/<paper-slug>/     runnable replay package, build.md section 3 (study.json refers to program.json)
  artifacts/                reports, figures and simulation results you write
    failures.json           where the template does not fit this paper, and the fallback used
  exports/                  files for sharing, e.g. the agent skill from agent_package.py
  .humanstudy/tmp/          scratch files and program batches
```

- The package refers to `program.json` (`study.json.programRef`) and never copies it; evidence and
  missing information are read from `program.json`.
- Citations use the physical page of `paper.pdf` (starting at 1) or a path under `sources/`.
- Paths inside the project are relative. Artifacts load nothing from the network.
- The researcher may edit any file by hand; fields they change get origin `researcher`. Re-read a
  file before changing it and never overwrite an edit you have not seen. Save program changes
  with `program_io.py`, which keeps confirmed researcher edits and reports conflicts.
