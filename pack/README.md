# HumanStudy pack

The social-science layer of HumanStudy Desktop: a researcher-agent contract plus skills that any
AGENTS.md-aware agent harness (opencode or another kernel) can load in a project folder. It
contains no app code and depends on no particular kernel.

```text
pack/
  AGENTS.md                         researcher-agent contract and scientific rules
  PROJECT_FORMAT.md                 project folder layout
  schema/human-program.schema.json  Human Program v2 JSON Schema
  skills/<name>/SKILL.md            build, simulate, visualize, analyze, export, refine
  skills/build/check_package.py     offline package check (mirrors Bench validate_package.py)
  runtime/                          research runtime: requirements.lock (hash-pinned wheels), lib/ (pdftotext /
                                    pdfinfo / hs-pdf shims, humanstudy_llm), tests/; installed by the desktop app
```

## Loading it

A kernel loads the pack into a project in one of two ways:

1. **Copy**: copy `AGENTS.md`, `skills/` and `schema/` into the project folder (opencode reads
   `AGENTS.md` from the working directory; place skills where the kernel discovers them, e.g.
   `.opencode/skills/` for opencode or `.claude/skills/` for Claude Code).
2. **Reference**: leave the pack in place and point the kernel's instruction/skill paths at it
   (e.g. opencode `instructions` in `opencode.json`), or write a one-line project `AGENTS.md`
   that refers to the pack's `AGENTS.md`.

Skill files use standard frontmatter (`name`, `description`), so kernels that list skills by
description can surface them without extra configuration. Skills refer to the schema as
`schema/human-program.schema.json`, relative to the pack or project root.

## Provenance

The contract is distilled from the HumanStudy-Bench agent package builder
(`agent_pipeline/CLAUDE.md`, the Human Program v2 prompt in `agent_pipeline/build_prompt.py`,
the eight-file package contract with `programBindings` checked by
`agent_pipeline/validate_package.py`, and the harness interface `run_sessions`/`evaluate` used by
`playground/run_package.py`) and the humanstudy-hub-web Human Program design notes. A package
built in the app is therefore the same artefact the website's GitHub Actions pipeline produces. The schema is copied from
`humanstudy-hub-web/lib/studio/human-program.schema.json`; keep the two in sync.

## License

Open source under the MIT License, the same license as HumanStudy-Bench.
