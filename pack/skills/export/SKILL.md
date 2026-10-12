---
name: export
description: Export the study protocol, analyses or replay package as .docx, .pdf or .zip into exports/. Use when the researcher asks to download, share, send, print or archive the study.
---

# Export: files into exports/

Exports are derived from `program.json` and existing artifacts; they add no facts.

## Formats

- **Protocol (.docx / .pdf)**: a methods-style document generated from the program. Per study:
  participants, design, conditions, materials, procedure in `next` order ("Depending on
  condition:" for branches, "Repeated:" for repeats), variables, analyses, reported results.
  Every sentence comes from a program field and ends with its citation (`p. N`). Verbatim
  instruments are reproduced exactly. Close with an "Open issues" section listing every issue
  (severity, item, reason, suggested action). Build .docx with python-docx or pandoc; build .pdf
  from the same HTML/markdown source (e.g. pandoc, or headless Chrome on a self-contained HTML).
- **Analysis (.pdf / .docx)**: convert an `artifacts/*.md` report with its figures.
- **Package (.zip)**: zip `artifacts/package/<paper-slug>/` plus `program.json`. Exclude
  `.humanstudy/`, caches and `__pycache__`.

## Rules

- Name files `exports/<project>-<what>-<YYYY-MM-DD>.<ext>`; never overwrite an existing export,
  add a suffix instead.
- Keep `missing` items visibly marked in the export; never drop or fill them.
- Fully offline. After writing, verify the file opens (e.g. `unzip -l`, `pdfinfo`, read back the
  docx) and reply with the path and size.
