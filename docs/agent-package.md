# Agent skill: a study for any AI agent

Issue [#14](https://github.com/HumanStudy-Hub/humanstudy-desktop/issues/14). Research reports: PR #13.

## What it is

Paper2Agent turns a paper into a skill an agent can read. HumanStudy already has the asset that
matters for social science: `program.json` (what each participant saw and did, cited to the page)
and a replay package that runs participants and the paper's own analysis. The export packs both
into one skill folder:

```text
exports/<project>-agent-<date>/
  README.md                 install lines for Claude Code, Codex, OpenCode
  MANIFEST.json             SHA-256 of every file, program and paper hashes, readiness, quote check
  <name>/                   the skill
    SKILL.md
    references/             study-<id>.md (one per study), paper.md, open-issues.md,
                            sources.md, accuracy.md
    program.json, package/<slug>/
    scripts/study_core.py   read, search, run and score (standard library, Python 3.8+)
    scripts/mcp_server.py   only with --mcp
```

One folder, nothing duplicated. A skill is enough for any agent that can run commands and read
files (Claude Code, Codex, OpenCode). `--mcp` adds a stdio MCP server over the same folder for clients
that cannot. References are rendered from program fields with their pages; verbatim fields stay
quoted with their check flag; missing fields read "Not stated in the paper".

## Running AI participants

Each AI participant must answer in its own fresh context. A model answering many prompts in one
conversation knows the hypothesis, so its answers are not independent participants (seen in an
early pilot: one context answered every gain-frame prompt the same way).

- `run --cli "claude -p --model haiku"` or `--cli "codex exec --skip-git-repo-check -s read-only -"`:
  one new process per participant, prompt on stdin, in an empty folder so it cannot read the
  study. Uses the CLI's own login; no key in the export.
- `run --model <id>`: OpenAI-compatible API with a key from the environment.
- `plan` / `replay`: list every prompt, collect answers elsewhere, score them in the same order.
  Refused when a prompt depends on an earlier answer.

All three go through the package's own `run_sessions` and `evaluate`, and a `blocked` study can be
read but not run.

## Accuracy

Two different questions:

1. **Does the export match the program?** Verified before the folder appears: manifest hashes,
   SKILL.md frontmatter and links, every study renders, every cited evidence id exists, the scripts
   run from outside the folder, a real MCP session (with `--mcp`), the package smoke test on a copy.
2. **Does the program match the paper?** `build/check_quotes.py` compares every evidence quote with
   the text layer of its cited page: found / close / other page / not found / unchecked (scanned
   pages). It runs in `build` and again at export, into `references/accuracy.md`. The model's own
   "verified" mark is not treated as evidence. On the two test papers: 35/35 and 43/45 found; the
   two misses were table rows whose text layer is garbled, which is exactly what needs a human look.

Not yet checked mechanically: completeness (every study, condition and step present) and
summarised fields. Next: compare programs built from Bench's 12 curated studies with their ground
truth, field by field, for an accuracy rate.

## Accepted on 2026-10-25 (private papers, content not published)

- False consensus 1977 (blocked package): Claude Code answered method questions with pages.
- Framing 1981 (ready package): Claude Code ran a pilot over MCP; `--cli "claude -p --model haiku"`
  ran 4 participants as 4 separate processes and scored them with the paper's evaluator.

## Not in scope

- Research-code tools (Paper2MCP): social-science papers rarely ship code; the replay package is the
  executable part.
- Paper redistribution by default (`--include-paper`, `--include-sources` need the right to share).
- A second workflow in the app: the researcher asks the agent and the `export` skill runs one command.
