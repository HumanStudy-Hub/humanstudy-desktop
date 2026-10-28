---
name: build
description: Turn the project's paper.pdf (and any authorized open materials) into a schema-valid Human Program v2 program.json and a runnable replay package that agents can execute (the HumanStudy-Bench eight-file contract). Use when a project has a paper but no program, or the researcher asks to (re)build the study or make it runnable.
---

# Build: paper → program.json → runnable package

Follow every rule in `AGENTS.md`. Never invent study facts. The goal is a study that an agent
can actually run as the original participants did, so the researcher can check it and simulate it.

## 1. Read the sources

- Extract text from `paper.pdf` page by page with `hs-pdf pages paper.pdf` (prints one
  `=== page N ===` block per page; add `--from N --to M` for a range, `--layout` for column-aligned
  tables). `pdftotext -layout paper.pdf -` and `pdfinfo` also work (form feed between pages). If
  `hs-pdf` reports pages with no text, the PDF is scanned: OCR is not available, so say which
  pages could not be read instead of guessing. Keep the physical page number of every passage
  you may cite.
- Read `sources/` only if present. Use the network only for URLs the researcher explicitly gave;
  record each URL consulted in `source/paper_metadata.json` → `external_sources`.
- List every empirical study in the paper before modelling any of them.

## 2. Write program.json (the Study document)

**Save in checkpoints, so the researcher sees the study as it is extracted.** Once the study
map is known, write a first batch (top level `schemaVersion: 2`, `id`, `title`, `source`, `intent`,
plus `studies` and the overview/question nodes with their evidence) as JSON with the write tool to
`.humanstudy/tmp/batch-01.json` and apply it:

```bash
python .opencode/skills/build/program_io.py .humanstudy/tmp/batch-01.json
```

Continue with small batches (`batch-02.json`, …), for example one section or one study at a time,
each with the evidence its records cite. `program_io.py` merges records by `id`: a record sent
again updates the fields it contains, and records not in the batch are kept. It writes
`program.json` under a shared save lock and atomically, so a failed batch never damages the saved one. Never write the whole
program in one tool call. An import build is already authorized: do not ask whether to start.

Validate against `schema/human-program.schema.json`. Work in this order:

1. `source`, `studies` (with `dependsOn` where a study consumes another's outputs), `intent`.
2. `evidence`: one record per cited passage, `locator.page` + exact `quote` copied from the
   extracted text. Preserve the complete relevant sentence(s), or the whole paragraph when its
   conditions, qualifications or context are needed to support the claim. A short keyword fragment
   is a locator, not sufficient evidence for a research decision. Do not shorten quotations to save
   tokens. Use several evidence records when a claim depends on separate passages, and attach every
   relevant record to that field/step. Verify each complete quote occurs on its physical PDF page;
   do not mark it verified merely because an opening phrase matches.
3. Nodes: participants, design, `condition` nodes (one per condition), materials, variables,
   analyses, `result` nodes (`result_kind = reported`). Transcribe printed instruments exactly
   as `verbatim` fields; put long instruments in `sources/` and reference them.
4. Steps: per study, with actors, inputs, outputs, `visibleIds` (who sees what earlier
   responses), `conditionIds` on condition-specific branches and materials, and `next` edges
   only where the paper states order.
5. Issues: one per `missing`/`decision` field or step rule, with exact ids, `reason`, `impact`,
   `suggestedAction`. `blocking` only when the missing rule prevents execution. The app derives
   "Is there enough information to reproduce this study?" from these issues, so be complete and
   honest here rather than optimistic.
6. Optional `extensions.presentation` (`open`, `collapsed`).

**Sections the Study document expects** (kind: field ids). State what the paper states; leave the rest out or `missing`.

- 01 Overview: `source` (optional `doi`, `venue`, `version`); `overview`: `year`, `method-type`, `summary`.
- 02 Questions: `background`: `question`, `gap`, `theory`, `concepts`; `hypothesis`: `statement`, `scope`.
- 03 Study map: `studies[]` (`description`, `dependsOn`), `hypothesis.studyIds`.
- 04 Participants: `participants`: `setting`, `roles`, `recruitment`, `eligibility`, `n-recruited`, `n-completed`, `n-analysed`, `characteristics`, `unit-of-analysis` (sampling unit), `compensation`, `attrition`.
- 05 Design: `design`: `type`, `control`, `assignment`, `order`, `blinding`, `manipulation-check`; `condition` nodes.
- 06 Procedure: `procedure`: `task`, `goal`, `actions`, `visible`, `feedback`, `payoff`, `stopping`; `steps`; `material` (verbatim).
- 07 Variables: `variable`: `role` (iv/dv/moderator/mediator/covariate), `type`, `definition`, `scale`, `scoring`, `timing`, `observation-unit` (what one data row is); `record`.
- 08 Analysis: `analysis`: `aim`, `inputs`, `method`, `criterion`, `coding`, `robustness`.
- 09 Results: `result` (`result_kind = reported`): `descriptives`, `effect`, `uncertainty`, `test`, `heterogeneity`, `themes`.
- 10 Findings: `finding`: `answer`, `support`, `mechanism-tested`, `mechanism-proposed`, `contribution`, `design-principles`.
- 11 Validity: `limitation`: `validity`, `scope`, `limitations`, `replications`, `openness`.
- 12 Simulation scope: `simulation`: `steps`, `roles`, `conditions`, `outcomes`, `limits`.

Rules: 09 holds what the paper reports (numbers), 10 holds interpretation; never mix them. 12 is your
assessment, so every field has origin `implementation` and must agree with `readiness` and the
blocking issues. 11 `replications` records only replications the paper itself reports or cites;
do no literature search.

Write for a social science researcher: explain the research question, who participated,
what each group saw and did, what was measured, how comparisons were analysed, and what
the findings mean. Use familiar methodological language, not software implementation terms.
Treat these twelve areas as coverage of available information, not twelve boxes to invent
content for. A study without hypotheses or experimental conditions may still be valid.
Preserve all source-supported details in fields or referenced resources; the interface can
collapse detail and the researcher may ask about it later. Distinguish missing extraction,
facts the paper does not report, and features not applicable to its method.

Scope simulation nodes by `studyIds`. All five fields (`steps`, `roles`, `conditions`,
`outcomes`, `limits`) describe what is possible, what is excluded, and why. Include physical,
economic, longitudinal and contextual limitations when relevant. A missing boundary is an
open question, not implicit permission. This assessment is reviewed in a separate screen
before any simulation runs; building the package does not authorize a simulation.

For each evidence record, keep the exact resource path in `path` (including when `sourceId`
is also present), so the interface opens the cited attachment rather than assuming paper.pdf.

Self-check: schema valid; every node, step and paper-derived field has `evidenceIds`; every
evidence id resolves; every `conditionIds` entry names a condition node of the same study; no
placeholder text; interactive and sequential structure intact; all source-supported content preserved.
Write in complete stages and use referenced resources for long materials; never truncate scientific content.

### Self-check (mandatory)

After every write to `program.json` run `python .opencode/skills/build/check_program.py program.json`
and fix every printed problem until it prints `PASS` (between checkpoints, only problems about
records a later batch will add may remain; the final check must print `PASS`). It lists all problems at once, each with a
fix. Typical slips: a step id placed in an issue's `nodeId` (use `stepId`), a `missing`/`decision`
field or rule with no review issue naming its `nodeId`/`fieldId` (or `stepId`), an id in a list
that does not exist. The app tolerates a few slips by setting them aside, but it warns the
researcher; a clean check is the standard.

Before reporting completion run `python .opencode/skills/build/check_program.py program.json --complete`.
Then run `python .opencode/skills/build/check_quotes.py program.json`: it compares every evidence
quote with the text of its cited page. Fix `other_page` (wrong page number) and `not_found` (wrong or
reconstructed quote) by rereading the page; if the page is a garbled table or scan, set the evidence
`verification` to `unverified` and say so in the report. Never mark a quote `verified` that this check
cannot find.
For every identified empirical study account for participants, design, procedure, variables/records,
analysis and results. For an analysis-only scope account for analysis and results. These are coverage
checks, not a fixed experimental template: information the paper omits is an explicit `missing` field
with its targeted issue, not invented content. Shared nodes may supply shared details, but every
study needs its own scoped content or explicit missing information. A valid checkpoint is not a
completed paper. Recheck after any change; PASS applies only to the checked bytes.

Always use `program_io.py` for agent edits, including refinements; do not bypass its lock/protection
with direct writes to program.json. Confirmed researcher fields are kept when a batch conflicts;
the complete proposal is saved under `.humanstudy/program-conflicts/` with a review issue. Discuss it
with the researcher, who can accept it by editing that field. Never relabel the saved human edit.

Finish and validate the visible program **before** packaging or views. Do not delay the
program until these auxiliary artifacts exist.

## 3. Package: make the study runnable

Unless the researcher only asked for the program, continue and write `package/<paper-slug>/`
with exactly these eight core files (the HumanStudy-Bench contract; additional participant
materials are allowed, no other sidecars):

```text
study.json                     overview; study.json.program is an exact copy of program.json;
                               readiness: {status: ready|blocked, blocking: [...issue ids]}
source/paper_metadata.json     bibliography + external_sources (empty if none authorized)
source/evidence.json           every claim/material → source, page, label, derivation
materials/materials.json       participant-visible material by study and condition, verbatim
task/task.json                 agents, roles, order, visibility, scripted roles + justification,
                               conditions, sampling/assignment/observation units, programBindings
task/adapter.py                offline; --smoke-test; run_sessions(llm, seed, n, arms=None)
evaluation/evaluation.py       evaluate(sessions) -> dict; not_ready when a test cannot run
audit/missing_information.json entries: study, field, reason, impact, suggested_action
```

Rules the runner depends on:

- `task/task.json.programBindings` = `{programId, stepIds, recordNodeIds, analysisNodeIds}`,
  exactly the program's id, every step id in order, every `record`/`variable` node id, every
  `analysis` node id. `audit/missing_information.json` uses the same issue ids as `program.json`.
- `run_sessions(llm, seed, n, arms=None)`: `llm(prompt) -> str` is injected; call it for every
  original human participant (never a script, distribution or fixed answer for a role the paper
  did not script). `n` is the sampling unit stated in `task.json`. `arms=None` runs every arm the
  paper's comparisons need; each session dict carries `condition` and `arm`. The adapter builds
  its own prompts from `materials/materials.json`, parses replies into the response format the
  paper used, and needs nothing from the researcher at run time.
  Keep the prompt for one participant and the reply parser as module-level functions (for example
  `build_prompt(study, condition)` and `parse_reply(study, condition, reply)`), so a simulation can run
  an exact number of AI participants per condition in parallel (`simulate` skill).
- `evaluate(sessions)` derives every metric from `sessions` alone and returns the paper's own
  comparison (test, statistic, effect size) or a structured `not_ready` with what is missing.
- Run `python .opencode/skills/build/check_program.py program.json` (it also runs inside check_package.py), then `python .opencode/skills/build/check_package.py package/<paper-slug>` (eight files,
  JSON validity, bindings, smoke test) and repair until it passes.

## 4. Views: two artifacts, automatically

After the program check prints `PASS` (and the package check, if you built the package), write
two views with the `visualize` skill's kit, without being asked; each must pass
`python .opencode/artifact-kit/inline.py <file>`:

- `artifacts/study-overview.html`: a title naming the paper, a two-sentence takeaway (what was
  studied, who took part, the design), then `HS.overview('#app')` (sample sizes, procedure flow,
  conditions, open questions per study).
- `artifacts/reported-results.html`, only when `09 Results` holds reported numbers (means,
  percentages, proportions, effect sizes): one `HS.results` or `HS.forest` chart per comparison the
  paper reports, using the paper's numbers exactly, each mark with its `id` and `page` (the table
  or text it comes from); spread exactly as reported (SD, SE or CI) or left out so the kit marks it
  "spread not reported". Test statistics without descriptives (only F, t, p) go in the chart's
  `hs-sub` line or a cited stat tile, not invented bars. Skip this file when no numbers are
  reported, and say so in the report.

A view failing its check is fixed, not dropped. Do not add new study facts in a view.

## 5. Report

Reply with: studies found; counts of nodes, steps, conditions, issues (by severity); the
readiness verdict ("can be run as published" / "blocked by: …"); checks run and their result;
and the paths written (including the two views). Reply in the researcher's language.

## Clarifying decisions with the researcher

When missing information or conflicting sources require a researcher decision, use the native
`question` tool with a few clear alternatives and allow a written answer. Ask only the next
necessary question in the currently selected study; do not force the same wizard on every
experiment. Retain the source evidence and label actual user choices `researcher`; never
convert a suggested default or dismissed question into a confirmed study fact.
