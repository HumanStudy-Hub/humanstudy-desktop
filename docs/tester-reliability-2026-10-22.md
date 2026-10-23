# Tester reliability follow-up — 2026-10-22

Branch: `codex/tester-reliability-fixes`, based on combined tester PR #26 at
`815242a1f32b09187cf6353ad5ee55291eb87298`. This is independent of the collection implementation.
Canonical cross-project tracker: https://github.com/HumanStudy-Hub/humanstudy-desktop/issues/30.
No merge, version bump, release tag, installer publication or shared-database change in this follow-up.

## Changes and regression criteria

### T03: Build completion

- A schema-valid first checkpoint is not a completed paper. Every identified empirical study needs
  content or explicitly missing fields with targeted review issues for participants, design,
  procedure, variables/records, analysis and results. Analysis-only scopes require analysis/results.
  A newly identified study cannot be certified by shared paper-level nodes alone.
- This is minimum extraction coverage, not proof of scientific fidelity or complete study discovery.
  Hypotheses/conditions are not mandatory; missing source information is allowed and never invented.
- The app independently validates the actual file and coverage; a tool's generic PASS cannot certify
  omitted studies or invalid references. A SHA-256 certificate binds validation to exact bytes.
- Shell writes, restart/reopen and later edits invalidate stale certificates. Valid human saves are
  independently rechecked immediately, so normal editing does not falsely leave the build stuck.
- Agent final check: `python .opencode/skills/build/check_program.py program.json --complete`.
  Python/app coverage use identical versioned policy files and are checked for behavioral agreement.

### T04: Researcher edits and concurrent saves

- Confirmed researcher fields and step rules are preserved by the shipped batch helper, including
  value-only patches and replacement of enclosing structures. Unrelated model additions still save.
- Conflicting proposals are stored in full under `.humanstudy/program-conflicts/`; a targeted review
  issue links the proposal. Accept a proposal by editing the field in the app; no silent override flag.
- App save and Python batch read/merge/replace use the same cross-process lock. App compare-and-save
  runs after acquiring that lock, not before. Writes use unique temporary files, sync and atomic rename.
- Dead process locks recover; live locks time out with a retryable message and are never stolen.
  Windows owner probing uses non-terminating process queries, and rename sharing failures are retried.
- Tests force both unsafe orderings with real Python processes: app-first keeps the human field plus
  model additions; helper-first rejects a stale app save without overwriting its newer checkpoint.
- This coordinates the app and shipped helper. Arbitrary external editors/scripts do not acquire
  this lock; the agent instructions require the helper, but this is not an OS filesystem sandbox.

### T05: Simulation readiness

- Unread/unvalidated files fail closed. Large resources are read in full by the background API rather
  than passed into the renderer or silently accepted above 4 MiB. Regression includes eight invalid
  large files and a valid 5 MiB evidence file, which is retained in full and can pass.
- Package program must match the current canonical program and contain the selected study. Task
  bindings must cover the canonical steps, records and analyses, matching the package contract.
- Unknown project, malformed approval, nonexistent selected study and outdated program hash reject
  before sending simulation approval to the agent. Program hash is checked again after package checks.
- React clears stale readiness on project/study/program/package change, and delegates validation to
  the main process. Existing run/build progress, Stop and retry UI regressions use the new API.
- These static checks do not execute adapters or establish scientific reproducibility. The agent's
  full package check and smoke test remain necessary before real participant runs.

## Upgrade and acceptance limits

Existing projects receive the app-owned writer, lock, checker and coverage policy. Untouched default
build instructions are upgraded; customized researcher instructions are preserved. Upgrade regression
covers this so a newer app does not accidentally keep the unsafe old helper.

Automated tests include actual Electron/React component harnesses, local HTTP fixtures and real Python
writers. They are not an installed-app walkthrough, a hosted-model paper build or a Windows test.
These acceptance items remain open in the canonical tracker. No fixes have reached installed users
until the owner approves merging, packaging and release.

## Verification results

- Desktop offline regression: **154/154 passed**, bounded concurrency 2, with local-network fixtures.
  Includes Electron build/run-state UI, helper upgrade, completion hash/coverage, large-resource
  validation and cross-process app/Python save tests. Excludes the two live provider suites.
- Managed Python 3.12 runtime: **17/17 passed**; final-build checker passes the complete fixture.
- Main/preload and renderer TypeScript: passed. Electron production build: passed.
- `git diff --check`: passed.
- Local logs: `/private/tmp/hsh-tester-full-regression.log`,
  `/private/tmp/hsh-tester-python-regression.log`, `/private/tmp/hsh-tester-build.log`.
