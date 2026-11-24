not yet

Review 3 of `claude/protocol-route` at HEAD `cdcfc9e` (worktree hsd-protocol-route; range `693f0fa~1..HEAD`, 8 commits). I read docs/v080-protocol-route.md, reviews 1 and 2, SPEC.md, and the full branch diff. The main files were index.ts (relay start and Stop), model-relay.ts, run-stop.ts, run-approval.ts, package-readiness.ts, protocol-readiness.ts, run-limits.ts, protocol-program.ts, Workbench.tsx, SimulationPanel.tsx, app_run.py, budget.py, protocol_report.py, run_confined.py, simkit.py, run_study.py (run, evaluate, stop), the vendored score.py, the private-config loader in checks.py, and sync_hsenv.sh. I grepped every commit's added lines and every commit message against the 42 upstream study folder names, their author prefixes, and local home paths. I ran the offline app suite, the typecheck, the build, and pack/runtime/tests. Close: the safety path is sound and the hygiene of HEAD is clean. Two must-fix items remain: the Simulation tab's headline verdict ignores the reward layer, and the budget undercounts non-ASCII text.

## Review 2 findings vs code

- **M1 (private data in the vendored engine): fixed in HEAD, still in history.** The net diff has no study folder name, no id of the `name+year+word` shape and no home path. Pins load from a sidecar (`checks.py:881-909`). `HSENV_PRIVATE_CONFIG=''` is set in the gate (`protocol-readiness.ts:153`) and the relay run (`run_confined.py:73`). Commit `693f0fa` still adds 10 study ids, the team/file codes and `source: /Users/<owner>/…/sandbox/hsenv/hsenv` in VERSION. Squash it away (see Before push). One residue in HEAD is a should-fix (S1).
- **M3 (budget sized for packages; cap-out still "done"): fixed, with one gap.**
  - The budget is measured confined from the app's copy (`budget.py`). `protocolRunLimits` counts group size. The main process recomputes the figure and refuses any other.
  - `retries` is 0. `app_run.outcome` marks a run `partial`. Progress goes to `failed`, the page is labelled PARTIAL, and summary.json says `not_ready`. Tested by `pack.test.mjs` "a failed model call makes the run partial".
  - Gap: the measurement undercounts non-ASCII text (M2).
- **S6 (binding): fixed.** The descriptor carries `route`, `runId`, `approvedAt` and `protocolSha256`, read by the app (`index.ts:723-725`, refused if it differs from the approval). run_confined passes them on. app_run refuses a package capability or another protocol hash. simkit refuses a protocol capability. Caveat: the check runs in the project's editable `.opencode` copy, and the relay itself does not enforce the route (S3). The token cap is still the real bound.
- **S7 (resume after STOP): fixed.**
  - A Stop through `project:writeText` closes every relay of the project (`index.ts:500-501`, `run-stop.ts`). `close()` aborts requests in flight and unlinks the descriptor.
  - `app_run.check_not_stopped` refuses unless a later approval with a new runId comes in. It records `resumedAfterStop`. With no relay binding, a stopped run is never resumed.
  - Remaining race: S2.
- **S8 (like metrics): fixed.** `protocol_report.rows` compares only when the human metric equals the block metric. Unsigned metrics are not compared; anything else shows "not compared (different metric)".
- **S9 (score not vendored): fixed.** evaldata, rewards, score, schema_check, serve and the v1 schemas are vendored. `run_study.evaluate` calls `S.summarize`. `scores_card` prints the values, verdicts, labels, reasons and text_report without recomputing them. But see M1: the tab's headline does not use them.
- **S10 (no Python tests): fixed.** pack.test.mjs covers app_run (complete, partial, binding, stop mid-run), protocol_report and inline protocol mode, all on the made-up fixture.
- **Minor (protocol-only project cannot run): fixed** by `shared/protocol-program.ts`. The stand-in only reaches SimulationPanel and `approveSimulation`, which reads protocol.json bytes for the hash. Nothing writes it.
- **Minor (`engine.asset_ref` reads absolute or `../` src): not re-checked as changed.** It is upstream code and local only. Still open upstream.

## Must-fix

**M1. The Simulation tab's verdict contradicts the reward layer.** `pack/skills/run/protocol_report.py:251` sets `summary.outcome = outcome(table)`. `outcome()` (line 92) is the sign-only direction table.
- The tab shows it as the headline and the run badge (`SimulationPanel.tsx:350,433`). For example: "The simulated participants showed the paper's effect".
- `hsenv.score` says a non_official run (AI n ≠ human analysed n, which is the usual case since per-arm is capped at 60) has values only and no pass/fail. On an official run its verdict can also disagree with the signs.
- The page itself is labelled correctly. The tab, which researchers read first, is not.
- Fix, for the protocol route:
  - `outcome = "unknown"` (headline "Finished") unless `run.json evaluation.plan.official` is true;
  - when it is official, derive the headline from the rewards' `passed`, or keep sign agreement but name it as direction agreement, not "showed the effect";
  - put "offline report · non_official" in `paragraph()`.

**M2. The measured budget undercounts non-ASCII text by about 2x. Runs of non-English protocols cap out and end partial after the money is spent.**
- `budget.py:45` counts `len(text.encode("utf-8"))`.
- The relay charges the HTTP body bytes (`model-relay.ts:89`). `humanstudy_llm.chat` builds that body with `json.dumps(body)` (`humanstudy_llm.py:177`, `ensure_ascii` left on), so every non-ASCII character is sent as `\uXXXX`. Measured: CJK 144 → 297 bytes, German 44 → 61. Newlines and quotes are escaped as well.
- The 1.5 margin does not cover the CJK ratio (about 2.06 on text). The app ships a Chinese UI.
- Fix (one line): count `len(json.dumps({"model": "x", "messages": [{"role": "system", "content": system}, {"role": "user", "content": text}], "max_tokens": 512}).encode())` instead of the raw UTF-8 lengths. Alternatively, send `ensure_ascii=False` in humanstudy_llm, but that changes the package route too. Add a test with a non-ASCII fixture page.

## Should-fix

- **S1. Study residue in HEAD.** `pack/runtime/hsenv/hsenv/checks.py:1056` has a comment that names a study's author prefix and its supplementary-material label (`(<author> S2b)`). The guard misses it because it matches whole folder names only. Scrub it upstream and re-sync. Optionally, make the guard refuse author prefixes (folder name up to the year) followed by a material label.
- **S2. No single-runner lock per run folder.**
  - After Stop, the old process keeps going for up to about 45 s: `humanstudy_llm` retries connection errors 6× with backoff. A quick re-approval resumes the same folder, and `check_not_stopped` deletes STOP (`app_run.py:141`). The old process then no longer sees STOP and keeps writing failed participants into the same operator.jsonl/records.jsonl.
  - Two `simkit.py start` calls under one relay do the same.
  - No spend escapes: the old relay is closed and the cap holds. The run is then marked partial, so it fails safe, but the data is mixed.
  - Fix: `app_run.main_run` refuses while `progress.json` says `runner: "alive"` with a heartbeat younger than 2×15 s and a live pid. Or take an `fcntl` lock file in the run folder.
- **S3. The binding and the scores run from the project's editable `.opencode` copy.** run.py imports `app_run` and the engine from `<project>/.opencode/`, and `refreshPack` restores them only when the project opens.
  - The descriptor cannot be forged, but the code that checks it and computes the scores can be edited by the agent.
  - The doc's "the agent cannot change it" is true of the descriptor only.
  - Fix: call `refreshPack(projectDir)` (or just the app-owned files) in `kernel:send` before starting the relay, and reword the doc.
- **S4. `HSENV_PRIVATE_CONFIG=''` is not set on every desktop path.** It is missing from `run_unconfined` (`run_confined.py:20-23`, used on Linux and Windows), from `simkit._start` without a relay, and from agent-run `make_preview.py` / `hsenv.checks`. There the engine falls back to `<project>/.opencode/coordinator/engine-private.json`, a file the project controls. It only adds exemptions, so the impact is low, but the doc says desktop runs never read it. Fix: `os.environ["HSENV_PRIVATE_CONFIG"] = ""` at the top of app_run.py and make_preview.py, before any hsenv import, or set it in run_unconfined and in `_start`'s env.
- **S5. Stop matches projects by `resolve()`, not `realpath`** (`run-stop.ts:14`). The relay's project can come from `k.directory(id)` (`index.ts:705`) and the Stop root from `openProjects`. A symlinked projects folder makes them differ, and Stop then leaves the relay open. That is safe anyway, because app_run refuses the stopped run, but the immediate cut-off is lost. Compare `realpath`s.
- **S6. A partial run briefly shows "done".** `run_study` writes stage `done` (`run_study.py:818`) before app_run rewrites `failed` (`app_run.py` after `protocol_report.build`). If `protocol_report.build` raises, progress stays `done` while run.json says partial. Have app_run pass `quiet` and stage control to run_study, or write `failed` before building the page.
- **S7. A partial run still shows reward verdicts** ("passed") in the scores card. Show "no verdict (partial run)" when `partial`.
- **S8. Smaller items.**
  - `app_run.outcome` detects the cap with `"402" in text` (`app_run.py:162`), which matches any number containing 402. Match `HTTP 402`.
  - SPEC.md "Project folder format" does not list protocol.json, sourcetext/, runs/ or variants/.
  - The two `effects_core.py` copies differ by 162 diff lines (doc "Not done" 5). This is a CLAUDE.md cross-repo copy rule, so decide which is canonical before the export work.

## Checked and correct

- **Hygiene (HEAD).**
  - Fixture, tests, docs, PROJECT_FORMAT.md, inline.py, skills and the vendored engine have no upstream study folder name, no `name+year+word` id and no home path (S1 aside). The 64-hex strings are file hashes in VERSION/VENDORED.
  - No commit message names a study.
  - sync_hsenv.sh refuses upstream folder names (case-insensitive), id shapes, literal LEGACY_* tables and home paths, and refuses without a studies folder.
- **Stop.**
  - Writing `artifacts/simulations/<run>/STOP` through the app closes every relay of the project. Closing aborts in-flight upstream fetches, unlinks the descriptor and frees the project for a new approval.
  - `app_run.stopped` writes partial.jsonl and run.json `app`, ends with stage `stopped` and draws no comparison or page.
  - A stopped run resumes only under a later approval with a fresh runId, and never without a relay binding.
  - Detached run processes after quit can no longer reach a model.
- **Double start.** `relayProjects` refuses a second approval while a relay is live. A send failure closes the relay just started.
- **Budget enforcement.** The reservation is synchronous and never refunded. The plan's `tokenBudget` must equal the main process's recomputation from the cached, stamped measurement. There is a hard ceiling (`fits`). The budget is measured confined: `-I -B`, empty home, no keys, `HSENV_PRIVATE_CONFIG=''`, CPU, memory and wall bounds.
- **Keys and logs.** The run gets only the relay token. The usage log has counts only. The relay returns only completion text and usage.
- **Sandbox and permissions.** The OS sandbox and permission policy are not weakened: run_confined is unchanged apart from the env additions, and the package route stays as before.
- **Readiness.** `ready` is still the package route alone, and `protocol` is reported beside it. A program approval uses `packageRouteReadiness`. A protocol approval checks the hash before and after validation. `approvalRoute` refuses unknown routes and a package approval carrying a protocol hash.
- **Protocol-only stand-in.** View-only and never written. The approval hash is of protocol.json bytes.
- **Results page numbers.**
  - `scores_card` prints `run.json evaluation.rewards`, built in run_study straight from `hsenv.score.summarize`, with formatting only.
  - Labels: report_scope (offline_report), official/non_official, "verdict on an unverified human n", the ITT flags, the view, the not-computable counts with reasons, the human n basis, and the engine's text report.
  - The banner reads "Simulation — not human data · offline_report — not a leaderboard".
- **Tests (keys unset; Python 3.13 at /usr/local/bin/python3).**
  - App suite, as CI lists it, minus live/native-live/runtime: 264 tests, 262 pass, 0 fail, 2 skips (web-contract env and T11).
  - `npm run typecheck`: clean. `electron-vite build`: OK.
  - `pack/runtime/tests`: 556 tests, 2 errors, both `No module named 'jsonschema'` (environmental, as in review 2).

## Before push

1. **Squash the branch into one commit.** `693f0fa` contains study ids, file/team codes and a home path in VERSION. `41a8f95`, `a16f784`, `6b44416`, `ae13233` and `da8d6dd` still carry that engine copy in their trees. After squashing, check with `git log -p origin/main..HEAD | grep -iE '<the upstream folder names>|/Users/'`: no hits.
2. **Do not commit `docs/review-protocol-route-1.md` or `-2.md`.** They name studies, 4 and 6 lines respectively. This file (`-3.md`) names none, but keep it out too unless the owner wants review notes public.
3. Fix M1 and M2. Fix S1 upstream, then re-sync with `scripts/sync_hsenv.sh` (VERSION hashes will change).
4. Check that no remote branch already holds `693f0fa`: `git branch -r --contains 693f0fa` must be empty, as it was in review 2.
