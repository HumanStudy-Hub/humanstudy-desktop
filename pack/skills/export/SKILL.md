---
name: export
description: Export the study protocol, analyses or replay package as .docx, .pdf or .zip into exports/, or as an agent skill (optionally with an MCP server) for other AI agents. Use when the researcher asks to download, share, send, print or archive the study, or to use it in Claude Code, Codex, OpenCode or another agent.
---

# Export: files into exports/

## Protocol projects (default)

For a protocol project, export from the paired scholarly program.json (if present), protocol.json, study.json, its source references and requested derived artifacts. Preserve all studies, missing items, evidence and the precise replay scope. The legacy agent_package.py/community.py/study_core.py instructions below are not protocol exporters: never call them for a protocol or fabricate a program.json to satisfy them. A local requested report may quote permitted materials with citations. A shareable bundle must obey source licences, exclude chats, account/config files, keys, private/researcher source files and restored original wording, and preserve distribution restrictions. Do not call a local file bundle an MCP server or a runnable agent skill unless that interface is actually implemented and tested. Never publish as part of an export.


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
  `.humanstudy/`, caches, `__pycache__`, `sources/researcher/` and `sources/private/`.
- **Community contribution (.zip)**: run `python .opencode/skills/export/community.py --output exports/community-<date>.zip`.
  The legacy community ZIP contains the program, package, shareable finished artifacts and
  redistributable source files. Keep the exact original paper ID and fork baseline. Preserve the
  paper's author credit. The Hub credits reconstruction contributors from their submission profile.
  PDFs require explicit selection and a recorded redistribution license. A source's recorded digest,
  when present, must match its bytes. Private and researcher materials, annotations, raw runs,
  chat, credentials and local state stay local. The export blocks known copies of private material
  in program/package files and omits artifacts with known copies.
  Before submitting, review the exact public file list and the local-only omission list returned by
  the exporter. Ask the researcher to inspect any content that may include personal or unpublished
  information. Upload only via the Hub contribution flow after their approval. A local ZIP is a
  draft for review and does not certify a study, anonymous data or redistribution rights. A protocol
  project needs a separate verified public projection before it can enter a protocol publishing flow.

- **Agent skill (folder)**: for using the study in another AI agent (Claude Code, Codex,
  OpenCode, anything that reads skills). Run
  `python .opencode/skills/export/agent_package.py --output exports/<project>-agent-<date>`.
  It writes one skill folder: SKILL.md, one readable reference per study with pages, open issues,
  `references/accuracy.md` (every quote compared with its cited page), `program.json`, the replay
  package and `scripts/study_core.py`, then verifies hashes, the scripts and the package smoke test
  before the folder appears. Add `--mcp` only when the researcher's client cannot run commands or
  read files (it adds an MCP server over the same folder). It prints `PASS`; on `FAIL` fix the cause
  and run it again. The paper and `sources/` stay out unless the researcher confirms the right to
  share them (`--include-paper`, `--include-sources`); `sources/researcher/` and `sources/private/` never go in. Reply with the folder path, the install line
  from its `README.md` for the agent the researcher named, and the quote-check line it printed.
  Readable without a package; runnable only when `study.json.readiness.status` is `ready`.

## Rules

- Name files `exports/<project>-<what>-<YYYY-MM-DD>.<ext>`; never overwrite an existing export,
  add a suffix instead.
- Keep `missing` items visibly marked in the export; never drop or fill them.
- Fully offline. After writing, verify the file opens (e.g. `unzip -l`, `pdfinfo`, read back the
  docx) and reply with the path and size.
