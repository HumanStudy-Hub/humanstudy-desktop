# Review 9: agent autonomy (branch claude/agent-autonomy, up to c489562)

This is an independent confirmation review. No tracked files were changed.

The tests ran for real on macOS:
- the kernel binary hs-v1.19.0, under the generated kernel profile;
- the real shell broker, shim and agent profile;
- a known-projects list file.

The fixtures (`~/.hs-r9-*`, `/Users/Shared/hs-r9-*`, `$TMPDIR/hs-r9-*`) have been removed.

**Verdict: ready.**
- The round-8 must-fix is closed. Every check in the 93-check probe below passed.
- The remaining risk is within the threat model: a project outside the projects folder that this build has never
  seen, and that no agent session has used. The release note in `docs/agent-autonomy.md` covers it.

## 1. A project that becomes known while A's kernel runs

**Setup.** A's kernel was started first. Then, through `rememberProject`/`forgetProject` and
`refreshKnownProjects()` (the same calls `knowProject` makes in `index.ts`), four projects became known:
- E was opened from `/Users/Shared`.
- F was created in home, outside the projects folder.
- R in `/Users/Shared` was renamed to Rnew.
- The projects folder was changed to `/Users/Shared/.../Root2`, and the root's project G was checked.

Before E became known, the agent shell could read it. That is expected, because E was never opened.

**Agent shell, from the next command, with no kernel restart.** Each of these was run against E, F, Rnew and G:
- `cat`;
- obfuscated `python3 open('/'+'Users'+...)`;
- `grep -r`;
- `find -exec cat`;
- `ls -R`;
- `cp` into A, then `cat`;
- a symlink in A, then `cat lnk/...`;
- `perl open`;
- a write into the project.

Every read failed with `Operation not permitted`, and no write went through. A's own files stay readable.

**Policy (`k.policyContext(A)`, built fresh on every call).** These all **ask** with "another project", for E, F,
Rnew and G:
- `read`, including a project-relative `../..` path;
- `grep` and `glob` with `path`;
- `list`;
- `external_directory`;
- `edit` in the `apply_patch` shape, with several relative patterns, `../`-relative or absolute;
- `write`;
- `lsp`;
- `bash cat`.

Paths that go through a symlink inside A (`lnk` → E) also ask: `read`, relative `read`, `grep`, `glob` and
`list`. They resolve to the real path.

`webfetch` with a `file://` URL is allowed by the policy, but it cannot reach a file. The kernel itself rejects it
("URL must start with http:// or https://", checked in the hs-v1.19.0 binary).

**Running kernel.** It keeps the `kernel.sb` it started with. This is the fixer's choice and it holds, because:
- every tool of the kernel's that takes a path reaches the policy, and the policy asks;
- the kernel's own HTTP `/file/content` route did not return E's file. That route is the app's only, and it is
  password-protected;
- the agent shell cannot get the password. It is not in the shell's environment, and
  `ps -E`/`ps eww` on the kernel pid does not show it.

`kernel.sb` is rewritten with E, F, Rnew and Root2 for the next start.

**Result: nothing reaches the new project without an ask.**

## 2. Seeding and the list file

**Seeding**
- The list keeps the old projects folder when the folder changes (`~R/projects` and `Root2` are both listed).
  Rename drops the old path and adds the new one.
- Seeding was checked against the real `opencode.db`. Read-only, the query `select distinct directory from session`
  returns 5 folders, and all 5 have `.humanstudy/`. So all 5 would be seeded.
- The unit test seeds only once, and only takes HumanStudy folders.

**The list file is protected**
- The agent shell cannot `cat`, overwrite, `mv`, or plant `known-projects.json.tmp`.
- Under `kernel.sb`, writing the file, `rm`, `mv`, writing the `.tmp` and `rm -rf` of the parent folder are all
  denied. The file survives.
- Policy: `read`, `edit` and `write` on the file are **deny**.
- The userData folder itself: `list` and `bash rm -rf` **ask** with "outside the project folder".

## 3. Rounds 1–8 re-checked

- `typecheck` passes.
- These suites pass with the real binary (`HUMANSTUDY_KERNEL_BIN` set, none skipped): kernel-sandbox,
  permission-policy, agent-sandbox (23 tests in all), and native-live (Undo/Redo).
- These suites pass: auto, completion, connection, dedup, kernel, native-api, question, recovery,
  request-transport (and its live variant), subagent.
- Without `HUMANSTUDY_KERNEL_BIN`, native-live fails at once with "Set HUMANSTUDY_KERNEL_BIN". That is the
  environment, not the branch.

- `src/main/*.test.mjs`: every file reports `fail 0`. This covers paper-build, package-readiness and runtime.
- pack runtime tests (system `python3 -m pytest tests`): 524 passed, 31 skipped, 2 failed.
  - They include sandbox_run, relay_sandbox, project_paths, check_readiness (build, simulate and export),
    agent_package and audit.
  - The 2 failures are `test_effects` (wilcoxon) and `test_effects_scope`. Both are an `ImportError` from the
    environment: `rpds` in `~/Library/Python/3.9` is an x86_64 build on arm64.
  - The branch changes no effects or schema code. In `pack/runtime` it only adds `test_project_paths.py`.
- The researcher Terminal ticket, researcher `!`, approved-once commands, Undo/Redo and the participant-data
  denials are covered by kernel-sandbox and native-live, as in rounds 4–8.

## Notes (no action needed for release)

- Every `project:read` calls `knowProject`, which rewrites every live profile. That is cheap but repeated work.
- The kernel's `/file/content` route is app-only. If it ever becomes agent-reachable, the stale `kernel.sb` would
  matter. Keep the server password out of the agent shell, as it is now.
- Never-opened projects outside the projects folder (no session in `opencode.db`) are covered only by the release
  note. This was accepted in round 8.
