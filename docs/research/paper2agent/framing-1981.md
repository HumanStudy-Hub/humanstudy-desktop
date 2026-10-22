# HumanStudy Hub and Paper2Agent: first source-conversion comparison

> Publication note: this is a report of a local experiment, not a model ranking. See the [research index](README.md) for controls, published evidence, and follow-up status. Paths under `cases/` below identify retained local evidence; those source files and private execution records are not part of this public report bundle.

Date: 2026-10-22 (America/Vancouver).

## Outcome

A real Paper2Skill conversion was completed using the exact PDF associated with an existing local HumanStudy project. The reviewed delivery passed Paper2Agent's strict verification with status **`reviewed_with_limitations`**. The existing HumanStudy `program.json` passed our current structural checker but retains source-readable OCR errors and incomplete experimental materials.

The most useful lesson is a missing distinction between **structural validity**, **source fidelity**, and **experimental completeness**. These should not share a single success label.

This is an artifact/workflow comparison, not a controlled model or product benchmark. The existing HumanStudy extraction has unknown model/prompt provenance and was not regenerated. Paper2Skill received an additional source-image review and a fresh independent verifier. Its raw automatic output also contained the same important OCR errors. Do not attribute the reviewed improvement to a better automatic extractor.

## What was actually run

- Paper: Tversky and Kahneman, *The Framing of Decisions and the Psychology of Choice* (1981).
- Source: the local project's original five-page `paper.pdf`, copied without modification. It contains printed pages 453–457 and ends mid-sentence. The continuation and reference list are not present in the supplied file.
- HumanStudy baseline: the existing saved `program.json`, copied without modification. It contains 4 study groupings, 17 nodes, 4 steps, 8 issues and 35 evidence entries.
- Paper2Agent: upstream commit `8c2d059165ef8cdcb70dbea76655b9c2b55b38e6`, checked out under `vendor/Paper2Agent/`. No upstream converter code was changed.
- Mode: **Paper2Skill**, the official paper-only route. No upstream research repository was supplied, so Paper2MCP and scientific code execution were not tested.
- Conversion: official `paper_bundle.py prepare`, `extract`, draft build, source-page review, independent verification, reviewed build and `verify --strict`.
- Runtime: the upstream script's pinned Python dependencies through `uv`. No paid external model API call or owner credential was needed; Codex and its verifier performed the review.
- Hashes and baseline provenance are in `cases/tversky-kahneman-1981/comparison-manifest.json`.

The Paper2Skill conversion used only the source PDF, not the HumanStudy program as input. The independent verifier read the baseline only after reviewing all source pages and generated crops. The coordinator also inspected the baseline, so this is not a blinded experiment.

## Concrete findings

| Check | Existing HumanStudy program | Raw Paper2Skill draft | Reviewed Paper2Skill delivery |
| --- | --- | --- | --- |
| Problem 1 and 2 sample sizes | Keeps 1521 and 1551, flagged for checking | Same damaged OCR values | Corrected to 152 and 155 from source images |
| Problem 1 option B response | Says 128%, probably 28%, flagged for checking | Extracts 128% | Corrected to 28% |
| Problem 6 option D probability | Retains 8%, flagged for checking | Same 8% OCR error | Corrected to 80% |
| Problem 7 option F probability | Unresolved garbling | Garbled `P. 2Wh` | Corrected to F, 20% |
| Full Problem 1 wording | Flagged reconstruction omits the two-proposed-programs and exact-estimate sentences | Full source passage, but OCR errors remain | Full source wording retained and checked |
| Problems 3–10 materials | Results are summarized, but comparable complete material/action nodes are absent | Full source passages available | All supplied problem passages reviewed against source |
| Problem 6 decision timing | Not represented in the saved steps/material nodes | Contains choice-before-game instruction | Retained and verified |
| Figures 1 and 2 | No source-figure representation in this program snapshot | Figure 1 omitted; Figure 2 crop covers only its x-axis label | Both complete figures restored and independently checked |
| Math-heavy paragraphs | Not represented as complete source content in this program snapshot | Embedded text confuses symbols and variables | Three source-image crops retained; not claimed as verified searchable math |
| Original source completeness | Venue lists pp. 453–458 without an explicit supplied-file limitation | Initial source inventory alone does not resolve it | Explicitly records missing continuation/reference page |
| Research-specific structure | Study, condition, participant, step and evidence IDs; actionable unresolved issues | Continuous paper reading package | Continuous paper reading package, not a Human Program |

The HumanStudy program responsibly marks several uncertain readings as `check` or `missing`; those are not all unqualified false claims. However, source-readable uncertainty should be resolved by inspecting the source instead of remaining in a nominally completed asset. The material node's title “as printed” also conflicts with its explicitly nonverbatim reconstructed content.

All 35 baseline evidence excerpts are **3–9 whitespace-delimited words** long (median 6), and all have `verification: unverified`. Some are useful locators, but the program checker does not establish that their context supports the linked claim. The independent review found a specific mismatch: `design-s3`'s different-group claim points to `e-each-group`, whose quote concerns the one-in-ten payment procedure. The correct different-group statement exists immediately before it in the source. These are separate claims and need appropriate supporting passages.

These findings concern the saved program snapshot. They do not establish that all current HumanStudy runs behave this way, or audit every artifact in the original project.

## Verification evidence and limits

- HumanStudy: actual `check_program.py` result **PASS**, retained in `humanstudy-baseline/check-program.txt`. This is a structural/reference/issue check, not source or coverage certification.
- Raw Paper2Skill: draft built; strict verification exited **2**, status **`unreviewed`**, with `mechanical_ok: true`. This demonstrates that the official workflow does not call an unaudited extraction reviewed. It does not demonstrate automatic semantic error detection.
- Reviewed Paper2Skill: strict verification exited **0**, status **`reviewed_with_limitations`**, `mechanical_ok: true`, all five pages reviewed, no mechanical issues, 5/5 asset transformations matched, 0 stale adjudications.
- There are **15 fingerprint-bound adjudications**: line/numeric checks from both parsers disagree with visually corrected text because both read the same faulty embedded OCR layer. Each decision records source-specific reasons. They are not 15 waived unknown errors and not an accuracy score. Original snapshots and frozen extraction evidence were not edited.
- A fresh verifier inspected all five original page PNGs, all five generated image crops, and the assembled text. It found further symbol and continuity defects; the final delivery includes the accepted repairs. See the separate independent review.
- Package-only retrieval was checked for Problems 6 versus 7 and the two Problem 10 price/version groups. The checked material is retrievable from the delivery without consulting the HumanStudy baseline.
- No Windows portability test, MCP-server test, fresh HumanStudy extraction, simulator execution, numerical reproduction, or full-paper completeness claim was made.

## Important capabilities worth borrowing

### Source review as a real stage

Paper2Skill explicitly separates source snapshots, page plans, visible page review, conversion, discrepancy handling and final verification. Its review queue includes missing lines, numeric discrepancies, cross-page continuity and unreviewed items. Hash-bound review reuse avoids silently applying decisions to changed PDFs. These are concrete mechanisms beyond asking an agent to cite evidence.

### Faithful multi-format preservation

The documented workflow handles figures, equations and workbooks as first-class source assets. Workbook conversion retains raw values, hidden sheets/rows, formula caches and limitations rather than guessing displayed values. This case exercised PDF images, not workbook export; workbook strengths here are based on the upstream contract, not this run.

### Independent verification with an actionable repair cycle

The verifier compares the actual delivered material with visible originals, rather than trusting the producing agent's success statement. In this case it found useful symbol and paragraph-continuity repairs even after coordinator review. The extra review effort must be counted as part of the result.

### Delivery verification and source-code binding

Paper2MCP requires tools to bind to existing research implementations, reference executions before wrapping, tests with changed inputs, and fresh-location installation and real tool calls. This is a stronger documented delivery gate than our package checker alone, which checks files, JSON/bindings and an adapter smoke test. The MCP route was not executed in this paper-only comparison, so no runtime-performance claim is supported.

## Suggested HumanStudy priorities

1. **Separate completion labels.** A program may be structurally valid while source review or experimental coverage remains incomplete. Preserve the actual state instead of allowing one PASS to imply all three.
2. **Add targeted source verification.** Prioritize N, probabilities, units, response percentages, original instrument wording and evidence-to-claim support. Retain complete supporting passages and the source location. Require source-image review where the embedded text layer is suspicious.
3. **Add an extraction coverage report.** Enumerate the empirical tasks found, then show which have materials, condition mappings, action paths and measures. Missing information is allowed; an accidentally unextracted section should be distinguishable from an unreported fact.
4. **Keep a source-reading layer alongside the Human Program.** Complete searchable text plus faithful image/table fallbacks would support agent questions and review without overloading the structured schema or interface. Paper2Skill can be evaluated as an optional input layer, not a replacement for the Human Program.
5. **Then strengthen replay delivery tests.** When a runnable package is actually requested, test it outside the generation workspace with explicit provenance and limits. Tool smoke tests and scientific replication remain distinct.

No product code was changed, no data was published, and no PR was merged for this experiment.

## Local deliverables

- Reviewed reading package: `cases/tversky-kahneman-1981/paper2skill-delivery/`.
- Readable article: `cases/tversky-kahneman-1981/paper2skill-delivery/references/paper.md`.
- Strict verification: `cases/tversky-kahneman-1981/paper2skill-review/verification.json` and `delivery-verify.log`.
- Independent source review: `cases/tversky-kahneman-1981/independent-review.md`.
- Explicit review decisions: `cases/tversky-kahneman-1981/review-decisions.json`.
- Raw pre-review output and checks: `paper2skill-raw/`, `raw-review-snapshot/`, `raw-verification.json` and `raw-verify.log` inside the case directory.
- Source and unchanged program snapshots are retained locally; no original project files were modified.

Upstream references:

- [Paper2Skill workflow](https://github.com/jmiao24/Paper2Agent/blob/8c2d059165ef8cdcb70dbea76655b9c2b55b38e6/skills/paper2agent/paper2skill/SKILL.md)
- [Source review and verification contract](https://github.com/jmiao24/Paper2Agent/blob/8c2d059165ef8cdcb70dbea76655b9c2b55b38e6/skills/paper2agent/paper2skill/references/review-plan.md)
- [Paper2MCP workflow](https://github.com/jmiao24/Paper2Agent/blob/8c2d059165ef8cdcb70dbea76655b9c2b55b38e6/skills/paper2agent/paper2mcp/SKILL.md)
