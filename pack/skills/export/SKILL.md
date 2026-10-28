---
name: export
description: Export the study protocol, analyses or replay package as .docx, .pdf or .zip into exports/, or as an agent skill (optionally with an MCP server) for other AI agents. Use when the researcher asks to download, share, send, print or archive the study, or to use it in Claude Code, Codex, OpenCode or another agent.
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
- **Community contribution (.zip)**: run `python .opencode/skills/export/community.py --output exports/community-<date>.zip`.
  This includes the complete program, `package/`, research `artifacts/` and `sources/`, records
  the original paper ID and baseline revision, and excludes chat, credentials and local state.
  Never manufacture a new baseline or substitute the current recommendation for the version
  actually forked. PDF redistribution is off by default; `--include-paper` requires the researcher's
  explicit permission and the right to redistribute it. Before export run the build checks.

- **Agent skill (folder)**: for using the study in another AI agent (Claude Code, Codex,
  OpenCode, anything that reads skills). Run
  `python .opencode/skills/export/agent_package.py --output exports/<project>-agent-<date>`.
  It writes one skill folder: SKILL.md, one readable reference per study with pages, open issues,
  `references/accuracy.md` (every quote compared with its cited page), `program.json`, the replay
  package and `scripts/study_core.py`, then verifies hashes, the scripts and the package smoke test
  before the folder appears. Add `--mcp` only when the researcher's client cannot run commands or
  read files (it adds an MCP server over the same folder). It prints `PASS`; on `FAIL` fix the cause
  and run it again. The paper and `sources/` stay out unless the researcher confirms the right to
  share them (`--include-paper`, `--include-sources`). Reply with the folder path, the install line
  from its `README.md` for the agent the researcher named, and the quote-check line it printed.
  Readable without a package; runnable only when `study.json.readiness.status` is `ready`.

## Rules

- Name files `exports/<project>-<what>-<YYYY-MM-DD>.<ext>`; never overwrite an existing export,
  add a suffix instead.
- Keep `missing` items visibly marked in the export; never drop or fill them.
- Fully offline. After writing, verify the file opens (e.g. `unzip -l`, `pdfinfo`, read back the
  docx) and reply with the path and size.
