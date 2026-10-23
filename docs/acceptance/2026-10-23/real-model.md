# Real hosted Haiku full-paper builds (2026-10-23)

Machine-readable evidence: [real-model.json](real-model.json). Tracker: issue #30 (T16, feeding T14).

## Setup

- **Code.** Branch `claude/acceptance-0.6.7`, based on `claude/research-t10-causality` at `8ddfb74`. This base combines #32, #33 and T10.
- **Worker.** The headless worker `app/scripts/opencode-assets.mjs` runs the desktop's own OpencodeKernel, request transport, pack, completion certificate and research collector, compiled from this checkout.
  - Kernel: `opencode-humanstudy 1.19.0`.
  - Managed runtime: `py3.12.15-20261009-30d68f4541`.
- **Model.** `humanstudy/anthropic/claude-haiku-5.5`, the default hosted route.
- **Account.** The owner's own desktop account, used under the owner's authorization.
  - Credentials stayed in process memory. A local launcher read them through the app's `account-core` and OS `safeStorage`, and passed the research profile through a private FIFO. Nothing secret was printed or written.
  - The worker got a placeholder refresh token, so it could not rotate the desktop session.
- **Request.** The desktop `build.prompt`, verbatim. This is what the app sends automatically after a paper import. There was no other instruction.
- **Stop rule.** Stop at the first `complete` certificate, meaning the desktop `programCertificate` on the exact program bytes. Otherwise allow at most 2 desktop-style Retries.
- **Limits.**
  - No output-token cap.
  - 45 min wall clock per case.
  - 10 min with no progress.
  - $5 spend guard.
- **Supervision.** Permissions outside Auto's own project heuristic and any questions were rejected, not approved.
- **Harness substitution.** `/api/desktop/identity` returns 404 in production because the web collection endpoint is not deployed (T13). The harness answered that single call from the desktop key's own signed claim. The hosted proxy still verified the key on every model call.

## Results

| | False consensus (1977) | Tversky & Kahneman (1981) | False consensus, rerun on fixed code |
| --- | --- | --- | --- |
| PDF | 23 scanned pages | 5 scanned pages | same as column 1 |
| Build started automatically | yes, 1 request | yes, 1 request | yes, 1 request |
| Certificate | **complete**, 0 problems | **complete**, 0 problems | **complete**, 0 problems |
| `check_program.py --complete` (rerun independently) | PASS | PASS | PASS |
| Retries used | 0 | 0 | 0 |
| Wall time | 676 s | 968 s | 890 s |
| Output / reasoning tokens | 69,549 / 71,448 | 51,340 / 132,419 | 61,163 / 117,183 |
| Reported input tokens | 146,523 | 243,665 | 222,388 |
| Estimated cost (upper bound) | $0.43 | $0.58 | $0.56 |
| Model requests / HTTP 413 | 38 / 0 | 48 / 0 | 52 / 0 |
| Largest request body | 1.19 MB | 3.18 MB | 1.16 MB |
| Stable image budget cut | not needed | **engaged**: 33 "Preparing source context", 5 archived media | not needed |
| Automatic recovery | none | none | 1 (output limit, attempt 1/2) |
| Studies identified | 4 empirical + 1 cross-study analysis scope | 4 scopes grouping Problems 1–10 | 4 empirical + 1 analysis scope |
| Nodes / steps / evidence / issues | 43 / 15 / 57 / 24 | 40 / **0** / 84 / 22 | 47 / 20 / 45 / 15 |
| Fields explicitly missing (`null` / missing) | 23 | 16 | 12 |
| Evidence quotes found in PDF text (normalized) | 57/57, page 57/57 | 83/84, page 83/84 | 43/45 |
| Research rows delivered (rejected / pending) | 319 (0 / 0) | 345 (0 / 0) | 350 (0 / 0) |
| Content objects referenced = visible | 25 = 25 | 12 = 12 | 28 = 28 |

Notes on the table:

- **Studies identified.** The false-consensus paper has 4 studies. All 4 were identified in both runs. The extra analysis-only scope is the covariance analysis reported in the Discussion across Studies 1, 3 and 4. The Tversky & Kahneman paper numbers problems, not studies, so grouping them into 4 scopes is the model's judgement.
- **Estimated cost.** The hosted route reported `cost=0` for every message. That does not mean the usage was free. The estimate uses Haiku 5.5's long-prompt rates as an upper bound: $0.50 per million input tokens and $2.50 per million output and reasoning tokens. Total for the three runs: **$1.56**.
- **Reported input tokens.** The reported input tokens are far below the request volume, which was 34–76 MB of JSON per run. The usage field appears to exclude cached prompt tokens.
- **Rows delivered.** Every row has an `action_id`. On the owner's account, the run wrote one `headless` agreement record (version 3), as the collector does on first use.

## Source fidelity spot checks (5 per run, seeded random sample)

Every quote was compared with the PDF text layer after whitespace and punctuation normalization, and its cited page was checked against the physical page.

**False consensus, run 1:** 5/5 exact, and the cited page is correct for all 57 quotes. The sampled quotes are:

- p. 7, the trait-rating effect for the Supermarket and Term Paper stories.
- p. 18, the correlation range.
- p. 5, the "cooperativeness" scale anchor.
- p. 5, the Table 1 title.
- p. 11, "104 Stanford undergraduates" in Study 3.

**Tversky & Kahneman:** 5/5 present in the text layer.

- The p. 2 option C quote preserves an OCR error, "113 percent]" for a printed "[13 percent]". The agent opened a **review issue** saying the text layer and the page image disagree, instead of silently correcting the quote.
- One quote outside the sample is reconstructed rather than verbatim: "Yes [88 percent] No [12 percent]". The source order is "No … Yes …". The agent marked it `verification: "verified"`.

**False consensus rerun:** 4/5 sampled quotes are exact. The fifth (p. 14) is a table row assembled from columns. Two table-row quotes (Tables 4 and 5) are below 0.8 similarity. Their numbers are on the cited pages, except "119.8", which the text layer reads as "119.X". It is consistent with the printed difference of −4.4. Both are marked `unverified`.

## Bugs found and fixed (with tests)

1. **Duplicate tool starts.** Every tool call wrote **two `tool.start` rows**: 102 starts against 51 ends. OpenCode reports a call as `pending` with `{}` before `running` with its input. The start is now recorded once the input is known. Fixed in `42e5944` and verified in the live rerun: 60 starts / 60 ends.
2. **Auto approvals reported twice.** Each Auto approval was reported twice, once by the automatic reply and again by OpenCode's `permission.replied`. The second copy lacked `automatic`, so half of all `permission.decision` rows looked like researcher decisions: 80 rows for 40 permissions. Question answers and rejections had the same double report.
   - The kernel now reports each resolution once (`42e5944`, `kernel/dedup.test.mjs`).
   - Verified in the rerun: 44 decisions, made of 43 automatic approvals and 1 supervisor rejection.
3. **Recovery rows repeated.** **One recovery attempt produced 69 `agent.recovery` rows**, because later statuses keep saying `recovering`. Now there is one row per attempt (`4200039`).
4. **Headless versioned program.json only at launch and turn end.** A one-turn build therefore delivered 1 `program.version` although `program_io.py` saved several checkpoints. Versions are now captured after each finished tool call and linked to that call (`4200039`).

Fixes 3 and 4 were found in the single allowed rerun. They are covered by tests built from the observed event sequence. Each test fails on the old code. They were not re-verified with another paid run.

**Regression.** 203 offline desktop tests: 202 pass, 1 skipped (the web-contract comparison, as before). Managed Python pack tests: 17/17. Both TypeScript configs and `git diff --check` pass.

## Not established

- The real-model build ran in the headless worker, not inside the installed app's UI. The installed walkthrough used a mock kernel; see [installed-mac.md](installed-mac.md).
- No Windows test (T15).
- No real-model interrupted, multi-turn or restart build.
- A `complete` certificate means minimum coverage. It is not scientific validation.
  - The Tversky program has 0 procedure steps and no views.
  - Agent-written `verification` flags are self-reports.
