# Paper2Agent exploration and HumanStudy pipeline findings

Published: 2026-10-22. These reports document local exploratory runs, not a product
leaderboard or a controlled scientific benchmark.

## Start here

| Material | What it establishes | Important limitation |
| --- | --- | --- |
| [Framing paper: existing HumanStudy artifact vs reviewed Paper2Skill](framing-1981.md) | Concrete source-reading, OCR, evidence-linking and review-process findings | HumanStudy was an existing artifact with unknown generation provenance; Paper2Skill received additional Codex/coordinator and independent review. This is not a matched-model comparison. |
| [False-consensus paper: fresh matched-Haiku runs](false-consensus-1977.md) | Both workflows made partial progress; early stopping, request-size failures and incomplete acceptance need attention | Neither delivered a complete verified asset within the allowance. Same model route and reported output allowance do not mean equal total compute/cost. |
| [Sanitized case metadata](evidence/cases.json) | Input hashes, pinned upstream revision and controls | Identifies the exact local inputs; does not redistribute them. |
| [Matched-run aggregate results](evidence/matched-run-summary.json) | Reported usage, stops, partial coverage and observed errors | Counts are not a semantic accuracy score. Provider cost metadata was unavailable. |
| [Request-size probe results](evidence/request-size-probes.json) | Gateway/hosting failures were reproduced without model generation | Synthetic requests deliberately used an invalid model. Original failing conversation wire bodies were not captured. |

The reports retain their original local-evidence inventories for traceability.
Paths under `cases/` refer to maintainer-held experiment files, not files missing
from this published directory. Raw chat histories, model credentials, account
state, execution databases, original PDFs, page images and full extracted reading
packages are not uploaded here. New runs should obtain authorized source copies,
record hashes, and keep fresh output separate from the original observations.

## Findings to carry forward

1. **Separate structure, source fidelity and completion.** A JSON schema PASS did
   not establish that all studies, materials or experimental steps were extracted.
   A model becoming idle did not establish task completion either.
2. **Make source review actionable.** Paper2Skill's source snapshots, page plans,
   discrepancy handling, hash-bound review decisions and independent verification
   are worth studying. Review flags and mechanical checks are not themselves
   proof of accurate transcription.
3. **Preserve the reading layer.** Complete text plus faithful figures, tables,
   equations and source locations can support the Human Program without forcing
   every paragraph into a rigid experimental schema.
4. **Recover with checkpoints and a changed plan.** Preserve complete research
   content, save coherent units, inspect actual files and continue from concrete
   unfinished work. Do not hide missing output with ordinary continuation loops.
5. **Keep the product simple.** Improve the common agent pipeline and provenance;
   do not add a second user-facing workflow, a taxonomy project or more controls
   merely to expose implementation details.

## Request-size and budget correction

The approximately 32k reported output stop was caused by the test harness's
explicit cumulative 30k allowance, checked after completed-message usage events.
It is **not** evidence of a Haiku or OpenCode product output cap.

Separate production probes reproduced an application body-size rejection at
4,100,000 bytes and a hosting ingress rejection at 4,700,000 bytes, without asking
any model to generate. OpenCode 1.19.0 has automatic compaction, but its generic
413 classification does not distinguish these byte-size failures from token
context overflow.

Draft [Desktop PR #12](https://github.com/HumanStudy-Hub/humanstudy-desktop/pull/12)
adds shared-kernel request adaptation. Its real-OpenCode offline test successfully
read 23 page images and wrote a fixture checkpoint, retaining approximately
7.66 MB of native history while forwarding at most 3.6 MB per request. This is
transport validation, **not** a successful post-fix Haiku paper conversion. The PR
is not merged or released at publication time.

## Pipeline entry points

- [Desktop repository](https://github.com/HumanStudy-Hub/humanstudy-desktop): the
  common kernel, research pack, schema and validators.
- [Headless OpenCode asset skill, draft PR #11](https://github.com/HumanStudy-Hub/humanstudy-desktop/pull/11):
  Codex supervises the actual desktop OpenCode kernel without opening the app.
  This is a pending branch, not an assumed production feature.
- [Batch source collection and initial import, Bench issue #28](https://github.com/HumanStudy-Hub/HumanStudy-Bench/issues/28):
  a separate collaborator assignment. Initial imports may retain missing items;
  this research should improve the pipeline without silently imposing a complete
  scientific-reproduction gate on every bulk import.

Use your own authorized model access or explicitly issued project access.
Personal Codex login does not automatically authorize OpenCode model calls.

## Upstream scope and attribution

[Paper2Agent](https://github.com/jmiao24/Paper2Agent) is the upstream project and
workflow reference. The tested revision was
`8c2d059165ef8cdcb70dbea76655b9c2b55b38e6`:

- [Paper2Skill workflow](https://github.com/jmiao24/Paper2Agent/blob/8c2d059165ef8cdcb70dbea76655b9c2b55b38e6/skills/paper2agent/paper2skill/SKILL.md)
- [Source-review contract](https://github.com/jmiao24/Paper2Agent/blob/8c2d059165ef8cdcb70dbea76655b9c2b55b38e6/skills/paper2agent/paper2skill/references/review-plan.md)
- [Paper2MCP workflow](https://github.com/jmiao24/Paper2Agent/blob/8c2d059165ef8cdcb70dbea76655b9c2b55b38e6/skills/paper2agent/paper2mcp/SKILL.md)

Only the paper-only Paper2Skill route was executed. Paper2MCP, research-code
execution, simulation and numerical reproduction were not tested. Upstream
workflow mechanisms remain credited to Paper2Agent's contributors; any future
reuse must retain its applicable license and attribution.

The research sources are Tversky and Kahneman (1981), *The Framing of Decisions
and the Psychology of Choice*, and Ross, Greene and House (1977), *The False
Consensus Effect: An Egocentric Bias in Social Perception and Attribution
Processes*. HumanStudy's conversion/review work does not replace original
research authorship or any upstream material/data credits.
