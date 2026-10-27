# Building many papers at once

`scripts/batch_build.py` builds a folder of PDFs with the standalone `humanstudy` skill, one fresh
agent session per paper, in parallel. No desktop app is needed.

```bash
python scripts/batch_build.py --pdfs papers/ --work runs/batch-1 --jobs 4 \
    --python "<python with pypdf>"          # e.g. the HumanStudy runtime's bin/python3
```

- Needs the `claude` CLI (default, Sonnet) or `codex` (`--agent codex`, untested) on PATH.
- Optional: Tesseract on PATH, so scanned pages get OCR text (`brew install tesseract`). Without it
  the agent reads page images and marks their quotes `unverified`.
- Each paper gets `<work>/<pdf name>/` with `paper.pdf`, `program.json`, `package/<slug>/` and
  `build.log`. Projects contain the papers' text: keep `<work>` private.
- Rerunning the same command skips papers that already have a passing program, so an interrupted
  batch resumes; `--rebuild` builds them again. `--limit N` tries the first N papers.
- `<work>/results.csv` (and `.json`) has one row per paper: minutes, cost, `programComplete`,
  `package`, `readiness` (ready or blocked), studies, issue counts by severity, quote check counts
  (`quotes_found`, `quotes_found_ocr`, `quotes_check_ocr`, `quotes_not_found`, ...) and
  `unnamedStudies` (experiments the paper names that the program never mentions).

Cost and time on HumanStudy-Bench with Sonnet: median 5.7 minutes and about $1.15 per paper
(`docs/accuracy-bench-2026-10-26.md`).
