---
name: build
description: Turn the project's paper.pdf (and any authorized open materials) into a schema-valid Human Program v2 program.json and, on request, a runnable replay package. Use when a project has a paper but no program, or the researcher asks to (re)build the study.
---

# Build: paper to program.json and package

Follow every rule in `AGENTS.md`. Never invent study facts.

## 1. Read the sources

- Extract text from `paper.pdf` page by page (`pdftotext -layout`, OCR if scanned). Keep the
  physical page number for every passage you may cite.
- Read `sources/` only if present. Use the network only for URLs the researcher explicitly gave;
  record each URL consulted.
- List every empirical study in the paper before modelling any of them.

## 2. Write program.json

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
   `suggestedAction`. `blocking` only when the missing rule prevents execution.
6. Optional `extensions.presentation` (`open`, `collapsed`).

Self-check before finishing: schema valid; every node, step and paper-derived field has
`evidenceIds`; every evidence id resolves; every `conditionIds` entry names a condition node of
the same study; no placeholder text; interactive and sequential structure intact; under 500 KB.

## 3. Package (when asked to make the study runnable)

Write `artifacts/package/<paper-slug>/` with exactly these core files:

```text
study.json                     overview; study.json.program holds the canonical program
source/paper_metadata.json     bibliography + external_sources (empty if none authorized)
source/evidence.json           every claim/material -> source, page, label, derivation
materials/materials.json       participant-visible material by study and condition
task/task.json                 agents, roles, order, visibility, scripted roles + justification,
                               conditions, sampling/assignment/observation units
task/adapter.py                offline; --smoke-test; run_sessions(llm, seed, n, arms=None)
evaluation/evaluation.py       evaluate(sessions) -> dict; not_ready when a test cannot run
audit/missing_information.json entries: study, field, reason, impact, suggested_action
```

`run_sessions` uses the injected `llm(prompt) -> str` for every original human participant,
runs all arms the paper's comparisons need when `arms` is None, and tags each session with its
condition and arm. Run `python task/adapter.py --smoke-test`, parse every JSON file, and repair
failures. Record any structure you could not preserve in `audit/missing_information.json`.

Report: studies found, counts of nodes/steps/issues, blocking issues, and checks run.
