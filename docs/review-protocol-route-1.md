# Review: claude/protocol-route (693f0fa, 41a8f95 vs origin/main), review 1

Verdict: **not mergeable as is.** Two must-fix items, then it is close. The fail-closed parsing, the cache stamp and
the confinement wiring are sound. Tests show no new failures.

## Must-fix

**M1. Private study data in the vendored engine (public repo).**
- `pack/runtime/hsenv/hsenv/checks.py:747-753` `LEGACY_UNCERTAIN_READINGS` holds sha256 pins plus study ids and
  file labels: arechar2018online, huber2023manydesigns GFL12_*, manylabs2, vlasceanu2024climate.
- `checks.py:758-768` `LEGACY_CITE_SOURCES` lists study ids and their private sourcetext file names:
  burtonchellew2022pgg, chandrashekar2021blindspot (docx_/qsf_ names), huber2023manydesigns (24 team/file codes),
  pennycook2020covid.
- `checks.py:955` (docstring) mentions "review of Huber RDP12".
- `engine.py:3` and `checks.py:3` (docstrings) give `studies/hall2024gettier` as the usage example.

This is study-specific data, which the owner ruled may not go public.

Fix: in the vendored copy, empty both dicts (`{}`) and replace the study names in the docstrings with
`studies/<id>`. The legacy exemptions only matter for the converter's own studies, never for a user project. The
best place to make this change is upstream, by moving the pins into a private sidecar file that checks.py loads if
it exists. Then `scripts/sync_hsenv.sh` keeps copying byte for byte. Until then, add a guard to sync_hsenv.sh that
fails if `LEGACY_*` is non-empty or if a `[a-z]+20\d\d[a-z]+` id appears.

The fixture (`app/src/main/fixtures/protocol-mini`, "fixture-mini") is made up. The tests contain no study ids.

**M2. A protocol PASS unlocks a run of an unchecked package.**
- `app/src/main/package-readiness.ts:181-186`: `projectPackageReadiness` returns ready when protocol.json passes,
  whatever state package/ is in.
- `package-readiness.ts:236-241`: the program approval that the Simulation tab sends is then accepted.

But no protocol runner exists yet (doc "Not done 1"). The agent therefore runs `package/<slug>` code that never
passed the static contract or `check_readiness.py`, behind a relay sized from program.json. This defeats the
package gate. Example: a project whose package fails the checks, plus any protocol.json that passes, can now run.

`assertRunnableProtocol` (`:248`) has the same gap. It accepts a protocol approval and starts the relay
(`index.ts:699-713`), but the agent can only execute the package.

Fix: until the engine runner lands, a program approval must require `packageRouteReadiness`. A protocol approval
should be refused, or accepted only after the runner exists, and the approval must carry the route so the agent
runs the matching form.

## Should-fix

- **S1. No memory or CPU bound on the expression language.** `expr.py:15` allows `Mult` and `Pow` on any value.
  Tested: a unit field `len([0]*(4*10**8))` in the fixture took 3.2 GB RSS and 42 s for 2 sessions, and still
  reported `"PASS": true`. With `10**10` it would exhaust memory on the user's machine. `10**10**9` pins a core
  until the 10-minute timeout (`protocol-readiness.ts:16`).

  Separately, `engine.py:57-64` (`asset_ref`) does `read_bytes()` on any local `src`, including absolute paths and
  `../`. `"/dev/zero"` grows without bound. Other paths outside the project are read and hashed; only the hash
  escapes.

  Fix: set `RLIMIT_AS` and `RLIMIT_CPU` in RUNNER via the `resource` module on POSIX. Optionally reject `src`
  values outside the project root in the gate.

  Code escape: none found. Attribute nodes, `_`-prefixed names, f-strings, lambdas and non-Name calls are
  rejected, and `__builtins__` is `{}`. Probed with `().__class__`, `__import__`, `getattr`, `type`, `str.join`,
  comprehension over dunders and `key=print`; all blocked. `money()` coerces `places` with `int()`, so no format
  injection. stdout can only carry the `json.dumps` report, so a protocol cannot forge `PASS`.
- **S2. Stale engine.** The VERSION hashes match the vendored files, and engine/expr/effects_core/`__init__` match
  the source. But upstream `checks.py` has since changed (sha 56c4978f…; adds the `floor` policy and more). Re-sync
  after M1.
- **S3. Local path in VERSION.** `pack/runtime/hsenv/VERSION:2` publishes the absolute local path
  `/Users/assassin808/...` (`sync_hsenv.sh:19`). Record a relative or descriptive source instead.
- **S4. Cache key ignores the Python interpreter.** The checker version key (`index.ts`) is the app version plus
  the engine hash. A runtime reinstall with a different Python keeps cached results. Minor.
- **S5. Readiness latency.** With protocol.json present, the protocol check runs first on every uncached readiness
  call, with a 10-minute timeout. The doc says it takes "seconds". Consider a shorter timeout (2-3 min) plus the
  rlimits from S1.

## Verified OK

- **Confinement.** The engine is written fresh from the bundled copy into a mkdtemp folder each run. Python runs
  with `-I -B -X utf8` from an empty HOME/TMP, with the env limited to PATH/HOME/TMP/LANG (no keys). The timeout
  and maxBuffer are set and the folders are removed afterwards. Source-text symlinks that leave the project are
  skipped. `--fetch-images` is never passed, so there is no network.
- **Fail closed.** No python, no engine, a non-1 exit, a kill or timeout, or no report all give `ENGINE_FAILED`,
  which is never cached. A report must say `PASS: true`, and a PASS with a blocking finding is rejected. A
  traceback becomes a blocking `protocol` problem. A Python version below 3.11 exits with a message but no
  traceback, which gives `ENGINE_FAILED`. A protocol.json that is a symlink falls back to the package route.
- **Cache stamp.** Each stamp row records size, mtime, ctime, ino, mode and the link target of protocol.json,
  study.json, sourcetext/, sources/, assets/ and local `src` files. The check reruns if the stamp moves during it.
  Editing protocol.json cannot leave a stale PASS. The renderer's `readinessStamp` covers the same files.
- **Approval limits.** A protocol approval re-hashes protocol.json before and after validation and builds the
  limits from the de-duplicated arm ids. `runLimits` caps the result at 100 groups, 60 per condition and 16M
  tokens, so the plan cannot inflate the relay beyond the program route's ceiling (see M2 for what then runs).

## Tests

Full offline desktop suite, as CI runs it (`node --test --test-concurrency=2`, keys unset), on the branch and on
an origin/main worktree. `npm run typecheck` on the branch is clean.

| | tests | pass | fail | skip |
|---|---|---|---|---|
| branch | 256 | 249 | 4 | 3 |
| origin/main | 243 | 238 | 2 | 3 |

- `runtime.test.mjs` fails on both (pre-existing). Here it hung on the network; I killed it after about 9 minutes.
- `build-progress.test.mjs` fails on both (pre-existing). Its assertions pass, then the Electron child does not exit
  within 30 s.
- `sim-run-state.test.mjs` failed on the branch run only. Run alone, it also fails on origin/main with the same
  Electron exit timeout after its assertions pass, so it is pre-existing and environmental.
- `pack.test.mjs` "installPack puts the artifact kit…" fails on the branch only, because of an untracked
  `pack/artifact-kit/__pycache__` left in this worktree (the test compares against `readdirSync`). This is
  environmental, not the diff.

**New failures from the diff: none.** All v0.8 tests pass, including the real-engine fixture test (python3.12).
