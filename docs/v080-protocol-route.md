# v0.8: the protocol route

One protocol across all platforms. A study's runnable form is now `protocol.json`, run by the Python engine
`hsenv`. The older `package/<slug>/` route stays, read-only, so community studies built before v0.8 still run.

## What changed

**Vendored engine.** `pack/runtime/hsenv/hsenv/{__init__,engine,expr,checks,effects_core}.py` are exact copies of
the sandbox engine. `pack/runtime/hsenv/VERSION` records a source label (no local paths), the date and the SHA-256
of each file. Refresh them with `scripts/sync_hsenv.sh <path to hsenv/hsenv> [label]` and never edit them by hand.
The script refuses an engine that carries study-specific data (non-empty `LEGACY_*` tables or study ids). The copy
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
like a package run. Runs resume and STOP works. `records.jsonl` stands in for `sessions.jsonl`.

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

`build_preview.py` is not vendored yet. Upstream line 497 hard-codes an absolute local path to the kit, and the
sync refuses local paths. Its test is skipped until a re-sync. With the upstream files copied in by hand, that test
passes locally.

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
  - the preview build (skipped until vendored).
- `shared/simulation-run.test.mjs`: records.jsonl counts as a run's participant data.
- `paper-build` and `ux` tests: the new regexes.

## Not done (next)

1. **Protocol-only projects in the UI.** The Simulation tab still needs `program.json` (study, scope). A project
   with only protocol.json + study.json cannot open the tab. The main process and skills/run already handle it.
2. **Engine re-sync.** Vendor `evaldata`/`rewards`/`score` with the next engine round (rewards on the results
   page). Re-sync `skills/preview` once its local path is relative.
3. **MCP export.** Expose `protocol.json` + engine through the agent-package MCP server (`skills/export/agent`), so
   other platforms run the same protocol.
4. **Build skill.** Teach `skills/build` to write `protocol.json` and `sourcetext/` and run `hsenv.checks`. The
   paper-build certificate is still `program.json`-based, so a protocol-only build does not count as complete.
5. **Images.** The gate does not pass `--fetch-images` (no network in the gate). A protocol that serves remote images
   is not image-checked by the app; the converter's own 1,000-session gate must have done it.
6. **Two `effects_core.py` copies.** One is in `skills/export/agent/` (Bench copy rule) and one in the engine. They
   can drift; decide which one is canonical.
