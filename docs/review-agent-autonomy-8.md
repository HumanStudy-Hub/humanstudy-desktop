# Review 8: agent autonomy (branch claude/agent-autonomy, up to 7986523)

This is an independent confirmation review. No tracked files were changed.

The tests ran for real on macOS:
- the kernel binary hs-v1.19.0, under the generated kernel profile;
- the real shell broker, shim and agent profile;
- a known-projects list file.

The fixtures (`~/.hs-r8-*`, `/Users/Shared/hs-r8-*`, `$TMPDIR/hs-r8-open-*`) have been removed.

**Verdict: not yet.**
- The round-7 fix works for every project the app knew **when this project's kernel started**.
- One must-fix remains: the list is read only once, at kernel launch.

## 1. Round-7 fix: verified for projects known at launch

**Setup**
- Project A sits under a root in home.
- B sits in `/Users/Shared`. It was recorded with an upper-case spelling.
- D sits in `$TMPDIR` (`/private/var/folders/...`), as if picked with Open.
- R was renamed to Rnew (forget, then remember).

**Results**

| Check | B | D | Rnew |
|---|---|---|---|
| Agent shell: `cat`, `python3 open()`, `grep -r` on `sources/private` and `protocol` | `Operation not permitted` | `Operation not permitted` | `Operation not permitted` |
| Kernel profile: `cat`, `grep -r`, `find` | denied | denied | denied |
| Policy: read | asks, "another project (...)" | asks, "another project (...)" | asks, "another project (...)" |

- Lower-case spellings of B are denied by the profile and asked about by the policy.
- Project A's own files stay readable.

**The list**
- Entries are stored as real paths, with no duplicates by case.
- The list persists in a file, and a fresh process reads it back the same way after a restart.
- Rename drops the old path. The projects root is added.
- A removed folder keeps its last spelling, which only adds a deny and is harmless.

## Must-fix

1. **A project opened or added after another project's kernel started is readable by that kernel's agent
   shell, with no ask.**
   - **Cause.** Kernels live for the whole app session. `profile.sb` (read by `sandbox-exec` on every
     command) and `kernel.sb` are written once, in `launch()`. `rememberProject()` never rewrites them.
   - **Real run.**
     1. A's kernel was started.
     2. `rememberProject(/Users/Shared/.../E)` was called, the same call Open makes.
     3. The agent shell's `cat E/sources/private/s.txt` returned **PRIV-E**. Under `kernel.sb`, the same
        read also returned PRIV-E.
   - **The policy does pick E up, because it is computed per call:**
     - a plain `cat` asks with "another project";
     - `read` asks;
     - `grep` asks.
   - **But it cannot catch a hidden path.** The obfuscated form
     `python3 -c "open('/Users/'+'Shared/...')"` is classified `allow`.
   - **Realistic trigger.** The researcher works in A, then uses Open on a folder outside home. A's agent
     can now read it until the app restarts.
   - **Fix.**
     - When the list changes, rewrite every live server's `profile.sb` from the new list. This takes effect
       on the next command.
     - Restart or mark stale any kernel whose `kernel.sb` lacks the new entry (`markKernelStale` exists).
       Doing it only when idle is enough, because the kernel's own tools are already asked about by the
       dynamic policy.
     - Add a test that remembers a project after `startSession` and checks the agent shell.

## Should-fix (gaps in completeness, same class)

2. **Changing the projects root forgets the old root.**
   - `settings:pickProjectsRoot` never calls `rememberProject(oldRoot)`, and it does not mark kernels stale.
   - Two kinds of project become readable by the agent shell when they are outside home:
     - projects in the old root that were never created or opened since this build;
     - projects in the new root, for kernels that are already running.
   - **Fix.** Remember the old root on change, and seed the list once with the current root.
3. **No migration.**
   - Projects opened with Open before this build are unknown until they are opened again.
   - The renderer's recent-projects list could seed the list once.
4. **The list is not OS-protected from the kernel.**
   - `kernel.sb` allows writing `<userData>/known-projects.json`. A real run under `kernel.sb` overwrote
     it (`KERNEL-WROTE`); it was then restored.
   - Through the kernel's `write` or `edit` tools, the policy only asks, with the generic reason
     "outside the project folder".
   - The agent shell cannot read or write it (`Operation not permitted`). That part of item (2) holds.
   - **Fix.** Add the file to `secretPaths` (policy deny) and to `kernel.sb`'s `file-write*` deny.

## Rounds 1–7 re-checked (all hold)

- `typecheck` passes.
- Every kernel suite passes with the real binary (none were skipped):
  - permission-policy (17);
  - agent-sandbox (4);
  - kernel-sandbox (1), which covers B's broker, `client.pl`, `profile.sb`, the Terminal ticket and resize,
    researcher `!`, approved-once commands and participant data;
  - native-live (1), which covers Undo/Redo;
  - subagent, connection, auto, dedup, recovery, question, completion, native-api and request-transport.
- `src/main/*.test.mjs`: all pass except `runtime.test.mjs` #14. This is the same environment gap as in
  rounds 4–7: the runtime python has no pytest.
- pack runtime tests pass: 75 passed, 13 skipped. They include project_paths, audit, agent_package,
  check_readiness (build, simulate and export), sandbox_run and relay_sandbox.

## Threat model

- After the must-fix, the cross-project risk is limited to items 2–3. Those are projects the app has never
  seen since upgrade, outside home, and outside the current root.
- That is within the threat model if items 2–3 are written up in the release notes. Fixing them is better.
- The must-fix is outside the threat model. It is the same leak as round 7 (private sources and protocols,
  with no ask), on a common path: Open while another project is live.
