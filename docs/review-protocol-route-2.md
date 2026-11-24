# Review: claude/protocol-route (up to ae13233 vs origin/main), review 2

Verdict: **not mergeable as is.** M2 from round 1 is closed and the runner is sound: answers = f(state), no keys
anywhere, STOP works, and the preview and results pages pass the kit. Two must-fix items remain. The first is the
private data still in the vendored engine (M1). The second is a relay budget that a real protocol run will
exhaust, and the run then still reports "done".

Not pushed: no remote branch contains 693f0fa, so nothing has leaked yet.

## Must-fix

**M1 (round 1, still open). Private study data in the vendored engine.** I know the re-sync is pending, but
these lines must not reach the public repo:
- `pack/runtime/hsenv/hsenv/checks.py:747-753`: `LEGACY_UNCERTAIN_READINGS` holds arechar2018online,
  huber2023manydesigns GFL12, manylabs2 and vlasceanu2024climate.
- `checks.py:758-768`: `LEGACY_CITE_SOURCES` holds burtonchellew2022pgg, chandrashekar2021blindspot (docx_/qsf_
  names), huber2023manydesigns (team/file codes) and pennycook2020covid.
- `checks.py:955`: "review of Huber RDP12".
- `checks.py:3` and `engine.py:3`: `studies/hall2024gettier`.

I grepped every id in `new-studies-1027/sandbox/hsenv/studies/*` against the diff. Only these lines match. Fixture,
tests, skills, inline.py and docs are clean (the fixture is made up).

`scripts/sync_hsenv.sh:27-31` would refuse this file today, which is good. It still misses ids without the
`name+year+word` shape (`manylabs2`, `Huber RDP12`, `GFL12`). Have the guard also take the upstream `studies/`
folder and refuse any of its directory names, case-insensitively.

Aside, not from this diff: `pack/runtime/tests/test_analysis_run.py` on origin/main already names about 12 study
ids in comments (e.g. lines 131-419).

**M3. A protocol run's relay budget is sized for the package route. When it runs out, the run still ends "done"
with a results page.**
- `app/src/shared/run-limits.ts:8`: `TOKENS_PER_PARTICIPANT = 40_000` is sized for about 5 calls. The protocol
  runner makes one call per page, and each prompt carries every earlier page and answer (`render.py`
  `seen`/`answered`), so the prompt grows with every page.
  - At the relay's reservation (`model-relay.ts:88`: bytes + 256 per message + output), a 30-40-page survey needs
    several hundred thousand tokens per participant. Refusal retries (`max_refusals` 20 × `retries` 2) add more.
  - Group arms make it worse: `runLimits` counts arms × per-arm and ignores `group_size`.
- When the cap is reached, every call fails. Each participant becomes `incomplete` with "f failed". Yet
  `run_study.py:560` sets `status: "done"`, and `app_run.py:104` writes results.html/summary.json from the
  remaining completed sessions.
  - Tested with a fake model: 0 of 10 completed still gave `done`, results.html and `outcome: "unknown"`. A
    partial cap-out would show a real-looking comparison.
- The estimate in the Simulation tab also uses the package plan (`SimulationPanel.tsx` `estimateRun`).
- Fix:
  1. Size protocol limits from the protocol. hsenv.checks already plays sessions, so it can report pages per
     session and prompt bytes. Count group members.
  2. In `app_run.main_run`, end the run as `failed` (no results page) when f failures from relay refusals (402,
     or "token cap") occur, or when completion falls below a threshold.

## Should-fix

- **S6. The approved hash is checked only by the agent's own argument.**
  - `app_run.py:65,89` compares protocol.json with `--protocol-hash`, which the agent types in.
  - The main process checks the hash at approval (`run-approval.ts:19-25`, `package-readiness.ts` `assertRunnableProtocol`).
  - After that, the relay is not bound to the hash or the route. An agent that edits protocol.json and passes the
    new hash, or that runs package/ code under a protocol approval, still gets model access.
  - Fix: put `route` and `protocolHash` (plus per-arm) in the relay descriptor that the app writes. Have
    `app_run`/`run_confined.py` read them from there, not from argv.
- **S7. Resuming after STOP.** `run_study.py:520` deletes STOP on a resumed run. The relay stays alive until it
  expires, so if the agent restarts a stopped run, it continues. SKILL.md asks the agent not to restart, but
  nothing enforces it.
  - Tested: the stop took effect after the pages in flight (24 calls with STOP at call 20), then a re-run
    finished all 120 calls.
  - Fix: `app_run.main_run` refuses when `progress.json` says `stopped` or STOP exists, unless a new approval
    comes in. Better, the app closes the run relay when the Stop button writes STOP.
- **S8. The direction comparison can mix metrics.** `protocol_report.py:41,71`: a "printed value" (an OR, d, r,
  …) is compared by sign with whatever the engine computed (risk_difference, phi/cramers_v ≥ 0, …). For an odds
  ratio the null is 1, not 0. Fix: compare only when the reported metric equals the block's `metric`; otherwise
  show "not compared (different metric)".
- **S9. "via hsenv.score" is not what ships.** The vendored engine has no evaldata/rewards/score, so
  `run.json.evaluation.evaldata` is always "skipped: hsenv.evaldata not importable", and no rewards or
  `not_computable` block from score appears. The page is clearly labelled (banner "Simulation — not human data ·
  offline_report — not a leaderboard", same text in summary.json). The AI-side `not_ready` reasons are shown
  (e.g. "needs at least 2 values in each arm"). Either vendor score/evaldata/rewards in the pending re-sync, or
  drop the claim from the docs.
- **S10. No tests for the new Python.** Nothing runs `app_run.py`, `protocol_report.py` or `make_preview.py`;
  `pack.test.mjs` only checks that they are installed. Add one fixture test with a fake `complete` (as below)
  that checks: status, results.html passes `inline.check`, no key-like strings, STOP.
- Minor:
  - A protocol approval needs a program.json (`Workbench.tsx` approveSimulation), so a protocol-only project
    cannot run.
  - `engine.asset_ref` still reads any absolute or `../` `src` (round 1 S1). The preview embeds such an image if
    it is an image file. Local only.

## Verified OK

- **Round 1.**
  - M2 closed: `ready` is the package route alone, and the protocol result is reported separately.
  - A program approval uses `packageRouteReadiness`. A protocol approval needs `protocolRouteReadiness` plus the
    hash before and after validation.
  - `approvalRoute` refuses a package approval that carries a protocolHash, and any unknown route.
  - S1: CPU, AS and DATA rlimits plus a 250 ms RSS watch on macOS; `ENGINE_LIMIT` blocks.
  - S3: VERSION has no local path. S5: the timeout is 3 min.
- **Keys.** The confined run gets only the relay capability (`run_confined.py:69-76`).
  - `fspec.in_process_source` records only hashes of closure values.
  - Fake-model end-to-end run: no key string in run.json, records.jsonl, steps.jsonl, operator.jsonl, effects.json,
    results.html or summary.json. I also set a fake `sk-or-…` env var in the process, and it appeared nowhere.
- **answers = f(state).**
  - `make_chat_f` sends system plus `render_state(state)` only. The prompts captured from the run contain only page
    text: no arm, no condition, no participant id.
  - `ctx.history` and assets are unused when `images=False`. `operator_access` is False for llm f.
  - operator.jsonl is written only by the runner and never passed to f.
  - In records.jsonl, `opaque_id` is a hash and no arm appears.
- **Artifacts.**
  - The preview from `make_preview.py` and the results.html both print `PASS … protocol embedded` under
    `inline.py`.
  - No http(s), src= or href= references besides the SVG xmlns. (The `chart.umd.min.js` match is a code comment.)
  - Remote images are omitted with their URL kept as data, never as `src`. CSP is `default-src 'none'`.
  - `slim_protocol` embeds ids only, never screen text.

## Tests (python3.12, Node, keys unset)

- `npm run typecheck`: clean. `npm run build`: OK (it left an ignored `app/out/`).
- App suite, minus runtime / build-progress / sim-run-state (known env failures): 232 tests, 230 pass, 1 fail,
  1 skip. The failure is `native-live.test.mjs`, which needs `HUMANSTUDY_KERNEL_BIN`, so it is environmental.
- `pack/runtime/tests`: 556 tests, 2 errors, both `No module named 'jsonschema'`, so environmental.
- `scripts/tests`: 15 tests, 1 failure (prepare_conversion needs jsonschema), environmental.
- **New failures from the diff: none.**
