# v0.8: the protocol route

One protocol across all platforms. A study's runnable form is now `protocol.json`, run by the Python engine
`hsenv`. The older `package/<slug>/` route stays, read-only, so community studies built before v0.8 still run.

## What changed

**Vendored engine.** `pack/runtime/hsenv/hsenv/{__init__,engine,expr,checks,effects_core}.py` are exact copies of
the sandbox engine. `pack/runtime/hsenv/VERSION` records a source label (no local paths), the date and the SHA-256
of each file. Refresh them with `scripts/sync_hsenv.sh <path to hsenv/hsenv> [label]` and never edit them by hand.
The script refuses an engine that carries study-specific data (non-empty `LEGACY_*` tables or study ids). The copy
vendored here still has such data (review 1, M1); it is being removed upstream, and a re-sync will replace it. `pack.ts` installs the engine into `<project>/.opencode/runtime/hsenv/` and keeps it at the
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
- A package approval (route absent, as the Simulation tab sends it, or `"package"`) needs the package route
  (`check_readiness` included) whatever protocol.json says.
- A protocol approval (`{"route": "protocol", "protocolHash": sha256(protocol.json bytes), "plan": {...}}`) is
  refused with "Protocol runs are not available yet" by both `assertRunnablePackage` and `approvedRunLimits`, so
  the relay never starts for it. A flag (`enableProtocolRuns`) is off by default. Once the runner exists and
  switches it on, the approval needs the protocol route, the hash is checked before and after validation, and
  the relay is capped by the arms of the hashed protocol.json.
- An unknown route, or a package approval carrying a protocol hash, is refused.

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
- `main/pack.test.mjs`: the vendored files match VERSION and are installed and restored.
- `paper-build` and `ux` tests: the new regexes.

## Not done (next)

1. **Simulate through the engine.** A runner that plays `protocol.json` sessions with AI participants
   (engine `Env` → model, behind the macOS relay), writes `runs/<stamp>/` (`sessions.jsonl`, `progress.json`, effects
   via `effects_core`), and uses the protocol approval above; it turns `enableProtocolRuns` on in `index.ts`. The Simulation tab still builds only program approvals
   (Workbench), and it needs `program.json`. A protocol-only project cannot start a run from the UI yet. The main
   process already accepts one.
2. **Preview artifact.** A participant view of `protocol.json` screen by screen per arm, with derived and missing
   text marked (the sandbox's `preview/`). It would be generated from the engine, not hand-written, and shown as an
   artifact card.
3. **MCP export.** Expose `protocol.json` + engine through the agent-package MCP server (`skills/export/agent`), so
   other platforms run the same protocol.
4. **Build skill.** Teach `skills/build` to write `protocol.json` and `sourcetext/` and run `hsenv.checks`. The
   paper-build certificate is still `program.json`-based, so a protocol-only build does not count as complete.
5. **Images.** The gate does not pass `--fetch-images` (no network in the gate). A protocol that serves remote images
   is not image-checked by the app; the converter's own 1,000-session gate must have done it.
6. **Two `effects_core.py` copies.** One is in `skills/export/agent/` (Bench copy rule) and one in the engine. They
   can drift; decide which one is canonical.
