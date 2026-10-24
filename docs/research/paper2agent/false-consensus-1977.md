# False Consensus Effect: matched Haiku source-conversion trial

> Publication note: this is a report of a local experiment, not a model ranking. See the [research index](README.md) for controls, published evidence, and follow-up status. Paths under `cases/` below identify retained local evidence; those source files and private execution records are not part of this public report bundle.

Date: 2026-10-22, America/Vancouver.

## Conclusion

Both fresh workflows used the **same configured model route, `humanstudy/anthropic/claude-haiku-5.5`**, through the same HumanStudy OpenCode kernel and authorized desktop account. Codex did not transcribe, repair or supply scientific answers to either producer.

**Neither workflow delivered a complete, verified conversion within this bounded trial. There is no supported whole-paper quality winner.** The result identifies early stopping, request-size failures and incomplete-output acceptance as immediate engineering issues.

The previous framing-paper comparison used Codex review on one side and an existing HumanStudy result on the other. This second trial corrects the producer-model mismatch, but it is still a one-paper workflow experiment, not a controlled scientific benchmark or an equal-compute/cost comparison.

## Inputs and controls

- Paper: Lee Ross, David Greene and Pamela House, *The False Consensus Effect: An Egocentric Bias in Social Perception and Attribution Processes* (1977).
- Identical original 23-page PDF, copied byte-for-byte from the other existing local HumanStudy project. SHA-256 and unchanged historical-program hash are in `cases/false-consensus-1977/case.json`.
- Two fresh, isolated projects and sessions; no historical HumanStudy extraction was supplied to either worker.
- Same actual desktop `OpencodeKernel`, HumanStudy OpenCode 1.19.0, provider/model selection, managed Python runtime, optional PDF image/parser dependencies and project approval behavior.
- HumanStudy arm: desktop research pack from `codex/opencode-asset-skill`, commit `5d70737`; program-only initial conversion with the normal schema, evidence, issues, checks and artifacts.
- Paper2Skill arm: unmodified upstream workflow/scripts from Paper2Agent commit `8c2d059165ef8cdcb70dbea76655b9c2b55b38e6`. Its research instructions replace the HumanStudy instructions in that project; no Human Program was requested from it.
- Same initial-turn rule and at most two output-repair requests. Repair text identifies absent/incomplete deliverables and directs the worker back to its own task, files and checkers; no source facts or corrected values were supplied.
- Same cumulative 30-minute execution allowance and nominal 30,000 reported output-token allowance per arm. Usage is received after a message completes, so the completed-message overshoot is retained. No scientific file was shortened to fit a display limit.
- Source interpretation and judgments happen after output snapshots. No independent verifier phase was performed, because both initial deliveries remained incomplete.

This tests **Paper2Skill adapted to the same Haiku/OpenCode host**, not the vendor's default Codex/Claude configuration. Paper2MCP, research-code execution and simulation were not tested.

## Recorded results

| Measure | HumanStudy | Paper2Skill |
| --- | --- | --- |
| Model routes in native assistant history | Haiku 5.5 only | Haiku 5.5 only |
| First turn | 320 seconds; stopped idle with a skeleton | 303 seconds; stopped after extraction and a path/permission failure |
| First-turn deliverable | Four study entries, **zero nodes and zero steps**, five evidence records | Extracted review files; no reading package |
| External output-repair requests | 2 | 2 |
| Final reported output tokens | 32,382 | 32,360 |
| Active phase elapsed time | 764 seconds | 864 seconds |
| Completed tool events | 46 | 68 |
| Distinct image files read | 11 | 23 |
| Final substantive coverage | 36 nodes, 9 steps, 31 evidence entries, 6 issues; Study 1 has 23 nodes, Study 2 has 13, Studies 3–4 have none | All 23 page previews read; 12 pages marked reviewed; no completed reading-package delivery |
| Requested artifacts | No HTML views or conversion report | No delivered reading package or conversion report |
| Request-size errors observed | `Request too large` | `Request too large`, `Request Entity Too Large`, then `Request too large` |
| Final producer stop | Output budget reached | Output budget reached |

Elapsed times include tool execution and approval waits inside the active phases. The workflows' scripts and information representations differ intentionally. Reading an image is not proof it was correctly interpreted, and a reviewed flag is not independent verification.

Reported input and reasoning token fields are retained in `results-summary.json`, not converted into a price or summed into a universal compute score. The reported reasoning quantities differ substantially, and provider cost fields are unavailable/zero-valued; that does not establish free usage. Equal output allowance is **not** equal total compute or cost.

## What the checks actually establish

### HumanStudy

The final saved program passes the current `check_program.py`. Its first-turn skeleton also meets structural requirements despite having no substantive nodes or steps. This is a concrete example of **schema PASS not establishing extraction completion**.

After the first repair, the Study 1 batch preserves the four story conditions, original stimulus passages, consensus questions, procedure, hypotheses and table results. A spot check against physical page 5 finds the supermarket Table 1 values correctly represented: the two own-choice groups have n=53 and n=27, consensus pairs 75.6/24.4 and 57.3/42.7, and F=17.7. The second repair adds Study 2, including N=80, the 35-versus-34 item distinction, reversed questionnaire order, the non-independent itemwise tests and missing full questionnaire wording. These are useful partial outputs, not evidence that the whole article is complete.

Studies 3 and 4 remain listed in the root study map and some initial evidence, but have no substantive program nodes. This distinction matters: a study title or source quote is not a complete structured reconstruction. No view/report was delivered before the allowance was reached.

### Paper2Skill

The worker inspected the page previews and edited its review plans and tables. Marked-reviewed pages at the stopping point were 2–11, 14 and 16; reading all page images did not produce complete review flags or a final build. Original converter source files were unchanged.

After freezing the producer state, the evaluator copied its review directory and attempted an official **draft** build on that copy. It failed with:

```text
join_previous requires preceding prose and space/none
```

The problematic continuation is `p0007-b003`, which requests a prose join after preceding content that is not eligible prose. Strict verification therefore cannot succeed: no build record exists in the evaluator copy. This is a defect in the worker's unfinished review plan, not evidence that the upstream converter itself is broken. It is also not a secretly repaired delivery: no evaluator correction was applied to make the package pass.

## Interpretation

1. **The producer-model mismatch is removed.** Native history for both runs confirms the requested Haiku route. Differences here are not a Codex-generated package versus a Haiku-generated package.
2. **First-turn completion failed on both sides.** HumanStudy stopped after announcing its next batch. Paper2Skill stopped after a tool/path failure and later stopped again after reviewing only a small part of the article. Idle is not a successful conversion signal.
3. **Source inspection is possible with Haiku.** Both workers used actual source images and made source-based corrections. The prior Codex-reviewed comparison did not justify calling Haiku intrinsically incapable of this work.
4. **The shared transport is a confound.** Both workflows encountered large-request failures after accumulating source images. These errors cannot fairly be assigned to Paper2Agent's original host or to the model's scientific reasoning. Image-history payload growth is consistent with the observed failures; exact request-level attribution still needs a targeted transport investigation.
5. **The trial was censored by its allowance.** Neither side had a complete final asset, so an overall accuracy percentage or product ranking would be misleading. More output allowance might help, but would not itself fix premature stopping or request-size failures.

## Practical priorities

- Keep schema validity, source fidelity and task completion as separate states.
- Detect a skeleton or missing study content before declaring a build complete. A progress-based supervisor should name the actual unfinished unit instead of issuing an uninformative “continue.”
- Preserve source files and full research content while reducing transport overhead from repeated page images. Do not solve request-size errors by truncating the scientific materials.
- Preserve first-turn, repaired and independently verified outputs separately. A future full-quality comparison should use both complete deliveries and a shared source-fact rubric; the 14 source-grounded questions in this case are not an accuracy score for these unfinished outputs.

No production code, original desktop project, public dataset or deployment was changed. No PR was merged. Desktop credentials were used through process memory for the authorized run and were not included in the report or test prompts.

## Evidence

- Setup and limitations: `cases/false-consensus-1977/case.json`.
- Aggregate metrics: `cases/false-consensus-1977/results-summary.json`.
- Frozen first-turn outputs: `cases/false-consensus-1977/snapshots/initial/`.
- Frozen final outputs and native model histories: `cases/false-consensus-1977/snapshots/final/`.
- Partial Human Program: `cases/false-consensus-1977/snapshots/final/humanstudy-fresh/program.json`.
- HumanStudy check: `cases/false-consensus-1977/snapshots/final/humanstudy-fresh/check-program.txt`.
- Evaluator-only draft-build failure: `cases/false-consensus-1977/evaluator-draft-build.log`.
- Producer source-review plans: `cases/false-consensus-1977/paper2skill-fresh/.humanstudy/paper-review/`.
- Source-grounded evaluation questions, never supplied as producer answers: `cases/false-consensus-1977/evaluation-questions.json`.

[Upstream Paper2Skill workflow](https://github.com/jmiao24/Paper2Agent/blob/8c2d059165ef8cdcb70dbea76655b9c2b55b38e6/skills/paper2agent/paper2skill/SKILL.md)

## Follow-up: production request-size diagnosis

Three controlled requests were sent through the same authorized account to the production desktop endpoint. Every request deliberately used an invalid model identifier, so it did not request a model generation. The payload was synthetic ASCII, not research data.

| UTF-8 request bytes | Response | Layer established by the probe |
| --- | --- | --- |
| 3,900,000 | 400, model unavailable | Application validation reached; expected invalid-model control |
| 4,100,000 | 413, JSON `Request too large` | Application's roughly 4 MB request guard |
| 4,700,000 | 413, `FUNCTION_PAYLOAD_TOO_LARGE` / `Request Entity Too Large` | Vercel's function ingress limit, before application/model processing |

The probe reproduces both observed error wordings without invoking Haiku. This establishes two concrete request-path limits; the original per-request bodies were not captured, so this does not map every historical error to a measured byte count. Results are saved in `payload-boundary-probe.json` inside the case folder.

The pinned OpenCode `hs-v1.19.0` parser classifies any HTTP 413 as `context_overflow` (`packages/opencode/src/provider/error.ts`). It has automatic compaction/media-recovery behavior: read-only inspection of the local run databases found 7 summary messages in the HumanStudy session and 11 in Paper2Skill. These counts are not all independently verified successful recovery cycles. It is incorrect to say OpenCode has no recovery mechanism. Token-oriented recovery does not by itself guarantee that the next serialized HTTP request fits a byte-oriented gateway limit.

Separately, stopping near 32,000 output tokens was the evaluator's explicit cumulative output allowance, with completed-message overshoot. It is not evidence of a fixed Haiku/OpenCode product limit. Production remediation should address serialized request bytes, source-media transport and distinct 413 handling; a larger model output budget alone does not address those failures.

[Vercel function request-body limit](https://vercel.com/docs/functions/limitations#request-body-size)

## Subsequent transport work (not a new conversion result)

Draft [Desktop PR #12](https://github.com/HumanStudy-Hub/humanstudy-desktop/pull/12) adds byte-aware request adaptation in the shared desktop/headless kernel. A real OpenCode 1.19.0 offline-fixture test read 23 paper-page images and saved a fixture checkpoint while retaining 7,659,764 bytes of native history; the largest upstream request was 3,592,024 bytes. Archived image bytes matched the originals. This proves transport behavior only. No complete post-fix Haiku conversion or scientific-quality result is claimed, and the PR is not merged or released as of this report publication.
