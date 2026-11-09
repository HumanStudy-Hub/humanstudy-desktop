# v0.8: the protocol route

One protocol across all platforms. A study's runnable form is now `protocol.json`, run by the Python engine
`hsenv`. The older `package/<slug>/` route stays, read-only, so community studies built before v0.8 still run.

## What changed

**Vendored engine.** `pack/runtime/hsenv/hsenv/{__init__,engine,expr,checks,effects_core}.py` are exact copies of
the sandbox engine. `pack/runtime/hsenv/VERSION` records a source label (no local paths), the date and the SHA-256
of each file. Refresh them with `scripts/sync_hsenv.sh <path to hsenv/hsenv> [label]` and never edit them by hand.
The script refuses study-specific data (protocols are private): non-empty `LEGACY_*` tables, ids shaped like
author2024topic, the name of any folder in the upstream `studies/` (read at sync time, case-insensitive; no folder,
no sync) and local home paths. The copy
vendored here still has such data (review 1, M1); it is being removed upstream, and a re-sync will replace it. `pack.ts` installs the engine into `<project>/.opencode/hsenv/` and keeps it at the
shipped version on refresh, like the other app-owned helpers. The engine is stdlib-only; `checks.py` needs Python
3.11+, and the app bundles CPython 3.12. `rewards.py`, `score.py` and `evaldata.py` are not vendored yet, because
nothing in the app calls them.

**Project format.** `pack/PROJECT_FORMAT.md` documents `protocol.json`, `study.json` (the project's identity
beside the protocol, not the package's study.json), `sourcetext/`, `review/`, `runs/<stamp>/` and
`variants/<name>/` next to `package/`. It also states that the two forms are checked separately and that a passing protocol.json never makes a
package runnable.
`previous-pack-hashes.json` lists the v0.7.2 hash, so untouched copies in existing projects are upgraded.

**Readiness** (`main/package-readiness.ts`, `main/protocol-readiness.ts`). There are two separate results, never
merged (review 1, M2):
- `ready` is the package route alone, unchanged: the static contract plus `check_readiness.py`. That is the only
  form the agent can run today, so a passing protocol.json never makes a project ready.
- `protocol` (`{ ready, problems }`) is reported beside it when protocol.json exists. It passes when
  `hsenv.checks <project> --sessions 50` passes, with every `sourcetext/*.txt` passed as `--source-text`. Problems
  are listed one line per blocking finding (refs, fuzz, effects, keyed, verbatim, coding, limits).

The protocol checks are confined the same way as `check_readiness`. The engine is written fresh from the app's
bundled copy into a temp folder for each run, never taken from the project's editable copy. Python runs with
`-I -B -X utf8` from an empty home, with only PATH/HOME/TMP set and no keys. Source-text links that lead out of the
project are skipped. The engine runs under bounds, because a protocol's expressions are data an agent wrote:
- 120 s of CPU (`RLIMIT_CPU`);
- 2 GB of memory (`RLIMIT_AS`/`RLIMIT_DATA` where the OS enforces them, and an RSS watch that kills the process
  on macOS, which does not);
- 3 minutes of wall clock.

Stopping at a bound is a blocking `limits` problem and is cached.

The check fails closed:
- with no runtime or no engine configured, the project is not ready;
- without a JSON report that says `"PASS": true`, the project is not ready;
- a report that says PASS but lists a blocking finding is not ready either;
- an engine traceback becomes a `protocol` problem.

Results are cached by input stamp: the metadata, ctime and inode of `protocol.json`, `study.json`, `sourcetext/`,
`sources/`, `assets/` and every local `src` the protocol serves. Runtime problems are never cached, and an edit
made during a check makes it run again. The renderer's `readinessStamp` now covers the same files, so the
Simulation tab rechecks when they change.

**Run approval.** An approval names its route.
- A package approval (`"route": "package"`, or no route as in older approvals) needs the package route
  (`check_readiness` included) whatever protocol.json says.
- A protocol approval (`{"route": "protocol", "protocolHash": sha256(protocol.json bytes), "plan": {...}}`) needs
  the protocol route, never the package. The hash is checked before and after validation, and the relay is capped
  by the runnable arms of the hashed protocol.json (`approvedRunLimits`). Tokens and time are the same per
  participant as for packages.
- An unknown route, or a package approval carrying a protocol hash, is refused.

**Protocol runs** (`skills/run`). `run_study.py`, `fspec.py` and `render.py` are vendored from the sandbox
(`scripts/sync_hsenv.sh run <sandbox/skills>`, manifest `VENDORED`). They are installed in `.opencode/skills/run/`
with the engine in `.opencode/hsenv/`, the sandbox's own layout, so run_study finds the engine unchanged.
The app adds two files of its own:
- `app_run.py`. `new` writes `plan.json` and a fixed `run.py` into `artifacts/simulations/<stamp>/`, after
  checking the approved `protocolHash`. The agent starts run.py through `run_confined.py` (sandbox and relay on
  macOS) and `simkit.py start`.
- `protocol_report.py`. It writes `results.html` (people vs AI per effect, labelled
  `offline_report — not a leaderboard`, kit inlined, protocol embedded, checked offline) and `summary.json`.

f is `make_chat_f` over the app's model client (`humanstudy_llm.chat`, so keys stay in the relay), with the
default renderer: one fresh call per page, JSON answers, text only. `run.json` records the model, the renderer and
the protocol's SHA-256. `progress.json` follows the simkit conventions, so the Simulation tab shows a protocol run
like a package run. `records.jsonl` stands in for `sessions.jsonl`.

**Budget (review 2, M3).** The package allowance (40,000 tokens per participant) does not fit a protocol: there is
one call per page, and each prompt carries every earlier page and answer.
- When protocol.json passes its checks, the app measures the run's budget with `skills/run/budget.py`. It runs
  confined, from the app's own copy, like the checks. It plays three random+gates participants per arm through
  run_study and counts what the default renderer would send: bytes + 256 per message + 512 output per call. It
  keeps the largest member per arm, adds a 1.5x margin and records group sizes.
  - The fixture needs about 4,700 tokens per participant, a 33-page survey about 180,000, and a 4-person game
    about 2,000,000 per member.
- `protocolRunLimits` (shared) turns the budget into the relay's cap: per arm × group size × tokens per member,
  plus a one-per-arm trial. It is capped by the hard ceiling of 16,000,000. Minutes come from the calls.
- The Simulation tab shows the figure ("Model budget") and sends it as `plan.tokenBudget`. The main process
  recomputes it and refuses any other number, or a plan over the ceiling.
- The run uses `retries` 0 (humanstudy_llm already retries 429/5xx), so a call that still fails ends that
  participant as incomplete.
- `app_run` marks the run `partial` unless every planned participant finished without a failed call. Progress
  becomes `failed` with "Partial run: k of n …". The page carries "PARTIAL RUN — not the planned n" and
  summary.json says `not_ready`.

**Binding and stop (S6, S7).** The relay descriptor the app writes carries the approval's `route`, the SHA-256 of
protocol.json as the app read it at approval, a fresh `runId` and `approvedAt`. run_confined.py hands them to the
run:
- `app_run` refuses a package-route capability or another protocol version;
- simkit refuses a protocol-route capability;
- a stopped run (STOP or progress `stopped`) restarts only under an approval given after the stop, recorded in
  `plan.json.resumedAfterStop`. STOP is never deleted otherwise.

On Linux and Windows there is no relay. There, only plan.json's hash and STOP are checked: a stopped run is never
resumed.

**Like with like (S8).** The results page compares directions only when the paper's metric is the engine's metric:
cells give a risk or mean difference, then an estimate in the same metric, then a printed value with its stated
metric. Unsigned metrics (phi, Cramér's V) are not compared by direction. Anything else shows
"not compared (different metric)".

When `hsenv.evaldata`/`rewards`/`score` are vendored (the next engine re-sync), run_study also writes
`rewards.json`, and the page lists it.

The Simulation tab prefers the protocol route when protocol.json passes. It sends a protocol approval, shows the
arms as the conditions and caps the confirmation by them. When protocol.json does not pass, it lists the protocol's
problems.

**Preview** (`skills/preview`). `make_preview.py` (the app's) runs the vendored `build_preview.py`, embeds the
protocol's identity and checks the page with the kit. The output is `artifacts/preview.html`, an artifact card.

`inline.py` has a protocol mode, used for a page with `<meta name="hs-artifact" content="participant-preview|protocol-report">`
or with `--protocol`:
- it embeds `<script id="hs-protocol">` (id, SHA-256, arms, stages and effect ids; never screen text) instead of
  the program;
- `data-program-id` must be a protocol ref;
- a participant preview keeps its own styles and script, so the kit is not injected;
- the offline rules are unchanged.

`build_preview.py` finishes the page through the same step on both paths, the sandbox CLI and `make_preview.py`:
`finish()` embeds the protocol block and runs the kit's protocol-mode check. It finds the kit via
`HS_ARTIFACT_KIT` or a sibling `artifact-kit/`, and falls back to the kit's offline check with an older kit.

**Build progress / results.** `buildPhase` maps writes to `protocol.json`, runs of `build_protocol.py` and runs of
`hsenv.checks` to the "Make it runnable" phase. `checkResult` reads the top-level `"PASS": true|false` line of an
`hsenv.checks` report and gives no verdict on a crash or on a grep of the checker. `results.ts` shows
`protocol.json`, `runs/` and `variants/` as simulation cards. `sourcetext/` and `review/` appear as reports.

**Tests.**
- `main/protocol-readiness.test.mjs` (new): report parsing, fail-closed cases, source-text confinement, and the
  real bundled engine on a synthetic fixture (`main/fixtures/protocol-mini/`, not a real study, because protocols
  stay private). The engine passes a sound protocol and blocks an unreached stage and a broken flow.
- `shared/package-readiness.test.mjs`: the either-route rule, refusal of approvals, the cache, fail-closed
  behaviour, and the renderer stamp.
- `main/run-approval.test.mjs`: protocol caps.
- `main/pack.test.mjs`:
  - the vendored files match VERSION/VENDORED and are installed and restored;
  - a protocol run with a stub f end to end in an installed project (trial, full run, records, effects, results
    page passing the kit checks, summary, no arm in records);
  - inline.py's protocol mode;
  - the preview build of the fixture, checked in protocol mode.
- `shared/simulation-run.test.mjs`: records.jsonl counts as a run's participant data.
- `paper-build` and `ux` tests: the new regexes.

## Not done (next)

1. **Protocol-only projects in the UI.** The Simulation tab still needs `program.json` (study, scope). A project
   with only protocol.json + study.json cannot open the tab. The main process and skills/run already handle it.
2. **Engine re-sync.** Vendor `evaldata`/`rewards`/`score` with the next engine round (rewards on the results
   page).
3. **MCP export.** Expose `protocol.json` + engine through the agent-package MCP server (`skills/export/agent`), so
   other platforms run the same protocol.
4. **Build skill.** Teach `skills/build` to write `protocol.json` and `sourcetext/` and run `hsenv.checks`. The
   paper-build certificate is still `program.json`-based, so a protocol-only build does not count as complete.
5. **Images.** The gate does not pass `--fetch-images` (no network in the gate). A protocol that serves remote images
   is not image-checked by the app; the converter's own 1,000-session gate must have done it.
6. **Two `effects_core.py` copies.** One is in `skills/export/agent/` (Bench copy rule) and one in the engine. They
   can drift; decide which one is canonical.
