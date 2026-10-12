---
name: build
description: Turn the project's paper.pdf (and any authorized open materials) into a schema-valid Human Program v2 program.json and a runnable replay package that agents can execute (the HumanStudy-Bench eight-file contract). Use when a project has a paper but no program, or the researcher asks to (re)build the study or make it runnable.
---

# Build: paper → program.json → runnable package

Follow every rule in `AGENTS.md`. Never invent study facts. The goal is a study that an agent
can actually run as the original participants did, so the researcher can check it and simulate it.

## 1. Read the sources

- Extract text from `paper.pdf` page by page (`pdftotext -layout paper.pdf -`; OCR if scanned).
  Keep the physical page number of every passage you may cite.
- Read `sources/` only if present. Use the network only for URLs the researcher explicitly gave;
  record each URL consulted in `source/paper_metadata.json` → `external_sources`.
- List every empirical study in the paper before modelling any of them.

## 2. Write program.json (the Study document)

Validate against `schema/human-program.schema.json`. Work in this order:

1. `source`, `studies` (with `dependsOn` where a study consumes another's outputs), `intent`.
2. `evidence`: one record per cited passage, `locator.page` + exact `quote` copied from the
   extracted text. Verify each quote occurs on that page.
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

- 01 Overview: `source` (optional `doi`, `venue`, `version`); `overview`: `method-type`, `summary`.
- 02 Questions: `background`: `question`, `gap`, `theory`, `concepts`; `hypothesis`: `statement`, `scope`.
- 03 Study map: `studies[]` (`description`, `dependsOn`), `hypothesis.studyIds`.
- 04 Participants: `participants`: `setting`, `roles`, `recruitment`, `eligibility`, `n-recruited`, `n-completed`, `n-analysed`, `characteristics`, `unit-of-analysis` (sampling unit), `compensation`, `attrition`.
- 05 Design: `design`: `type`, `control`, `assignment`, `order`, `blinding`, `manipulation-check`; `condition` nodes.
- 06 Procedure: `procedure`: `task`, `actions`, `visible`, `feedback`, `payoff`, `stopping`; `steps`; `material` (verbatim).
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

Self-check: schema valid; every node, step and paper-derived field has `evidenceIds`; every
evidence id resolves; every `conditionIds` entry names a condition node of the same study; no
placeholder text; interactive and sequential structure intact; under 500 KB.

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
- `evaluate(sessions)` derives every metric from `sessions` alone and returns the paper's own
  comparison (test, statistic, effect size) or a structured `not_ready` with what is missing.
- Then run `python .opencode/skills/build/check_package.py package/<paper-slug>` (eight files,
  JSON validity, bindings, smoke test) and repair until it passes.

## 4. Report

Reply with: studies found; counts of nodes, steps, conditions, issues (by severity); the
readiness verdict ("can be run as published" / "blocked by: …"); checks run and their result;
and the paths written. Reply in the researcher's language.
