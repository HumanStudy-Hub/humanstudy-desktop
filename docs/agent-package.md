# Agent package: a study as a skill and an MCP server

Issue [#14](https://github.com/HumanStudy-Hub/humanstudy-desktop/issues/14). Research reports: PR #13.

## What it is

Paper2Agent delivers a paper as `skill/` (an agent-readable paper) plus `mcp/` (tested tools that
bind to the paper's code). HumanStudy already has the asset Paper2Agent lacks for social science:
`program.json` (what each participant saw and did, cited to the page) and a replay package that
runs participants and the paper's own analysis. The agent package uses the same delivery layout
for that asset:

```text
exports/<project>-agent-<date>/
  README.md                 install lines for Claude Code, Codex, OpenCode
  MANIFEST.json             SHA-256 of every file, program and paper hashes, readiness
  skill/<name>/             SKILL.md, references/study-<id>.md (one per study), paper.md,
                            open-issues.md, sources.md, program.json, package/, scripts/study_core.py
  mcp/<name>-mcp/           server.py (stdio MCP, standard library only), study_core.py,
                            program.json, package/
```

One program, two access formats. Neither adds facts: references are rendered from program fields
with their pages; verbatim fields stay quoted; missing fields read "Not stated in the paper".

## How another agent runs the study

MCP tools: `study_overview`, `list_conditions`, `read_study`, `read_paper_context`, `get_item`,
`search_study`, `list_open_issues`, `participant_prompt`, `parse_reply`, `plan_participants`,
`score_replies`, `score_sessions`.

`plan_participants` runs the package's own `run_sessions` with a recording model, so the agent
receives every prompt in order. It answers each in a fresh context (its own model or subagents),
then `score_replies` replays those answers through `run_sessions` with the same seed and runs
`evaluate`. If a prompt depends on an earlier answer (multi-turn studies), replay refuses and the
study must use `study_core.py run --model ...` with an API key from the environment. The export
itself never holds a key. A study whose readiness is `blocked` can be read but not run.

## Verification before the folder appears

Built in a staging folder, then: every file matches the manifest; SKILL.md frontmatter and links;
program loads and every study renders in both copies; every cited evidence id exists; real MCP
session (initialize, tools/list, three tool calls); the package's `--smoke-test` in both copies.
Only then is the folder moved into place. Existing exports are never overwritten.

Accepted on 2026-10-25 with real projects (kept private): false consensus 1977 (blocked package,
read via Claude Code over MCP, answers matched program.json) and framing 1981 (ready package:
Claude Code planned 3 participants per condition, answered them and scored them over MCP).

## What it deliberately does not do

- No research-code MCP tools (Paper2MCP): social-science papers rarely ship code; the replay
  package is the executable part, and every tool binds to it.
- No paper redistribution by default (`--include-paper`, `--include-sources` need the right to share).
- No second workflow in the app: the researcher asks the agent ("use this in Claude Code") and the
  `export` skill runs one command.

## Next

- Paper2Skill's source review ideas inside `build`: source snapshots with hashes (now recorded in
  `sources.md`), page-range review by a separate verifier, review decisions reused only for the same
  source bytes.
- Multi-turn studies: a turn-by-turn MCP session (`start_session` / `answer`) instead of plan/replay.
- Community: publish agent packages next to programs so any agent can load a reviewed study.
