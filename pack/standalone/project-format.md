# Project folder

One folder per paper. `program.json` is the single source of study facts; everything else is
derived from it and from the paper.

```text
<project>/
  paper.pdf                 the source paper (read-only)
  sources/                  open materials, supplements, large instruments, datasets (optional)
  program.json              Human Program v2 ($HS/schema/human-program.schema.json)
  package/<paper-slug>/     runnable replay package, the eight-file contract in build.md section 3
  artifacts/                reports, figures and simulation results you write
  exports/                  files for sharing, e.g. the agent skill from agent_package.py
  .humanstudy/tmp/          scratch files and program batches
```

- `study.json.program` inside the package is an exact copy of `program.json`.
- Citations use the physical page of `paper.pdf` (starting at 1) or a path under `sources/`.
- Paths inside the project are relative. Artifacts load nothing from the network.
- The researcher may edit any file by hand; fields they change get origin `researcher`. Re-read a
  file before changing it and never overwrite an edit you have not seen. Save program changes
  with `program_io.py`, which keeps confirmed researcher edits and reports conflicts.
