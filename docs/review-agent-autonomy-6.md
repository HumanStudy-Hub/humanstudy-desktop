# Review 6: agent autonomy (branch claude/agent-autonomy, up to 14767db)

Independent adversarial review. No tracked files changed. Real macOS runs:
- the HumanStudy kernel binary hs-v1.19.0 under `macosKernelProfile`, with a mock OpenAI-compatible model
  driving real tool calls (read, glob, grep, bash), in projects under the home folder;
- real `sandbox-exec` with generated agent and kernel profiles;
- real brokers.

Test homes (`~/.hs-r6-*`, `~/.hs-r6w-*`) and scratch copies were removed or kept in the session scratchpad.

**Verdict: not yet.** There are 2 must-fix items. One is a functional regression (Undo/Redo is broken). The
other is a cross-project read that needs no ask, under a narrow condition.

## Must-fix

1. **Regression: Undo/Redo of agent edits no longer restores files.**
   - Where: `opencode.ts:727`. Since d3aab38 (review 2), the kernel env sets
     `GIT_CONFIG_COUNT/KEY_n/VALUE_n` (`core.fsmonitor=false`, `core.hooksPath=/dev/null`).
   - Real run: `native-live.test.mjs` with `HUMANSTUDY_KERNEL_BIN=…/hs-v1.19.0/opencode`.
     - On origin/main it passes.
     - On HEAD it fails at line 37: after `undo`, `draft.txt` still reads `CHANGED DRAFT…`. It fails with
       `HUMANSTUDY_KERNEL_SANDBOX_OFF=1` too, and with `HUMANSTUDY_AGENT_SANDBOX_OFF=1`.
   - Bisected in a scratch copy:
     - with those env vars removed, the whole test passes (undo/redo, shell, ticketed PTY);
     - with only one pair (either `core.hooksPath` or `core.fsmonitor`), it still fails.
     - So any `GIT_CONFIG_COUNT` in the kernel env breaks OpenCode's snapshot revert.
   - Earlier rounds missed it because this test throws unless `HUMANSTUDY_KERNEL_BIN` is set (it is not
     part of the default suite).
   - Fix: drop these vars from the kernel env. The agent-shell wrapper already sets them for agent
     commands (`wrapperHead`). If the kernel's own `git status` must not run a project's fsmonitor, find
     another way and re-run native-live. Also add native-live to the routine real-kernel runs.
2. **Another project's truncated tool output is readable with no ask when the project has an empty
   `.git`.**
   - Where: `permission-policy.ts:558-571` (`relativeVerdict`).
   - Background:
     - OpenCode never sends an `external_directory` request for its tool-output folder (built-in
       exemption), so the `read` request is the only gate.
     - That request carries only a worktree-relative pattern, without `metadata.filepath`.
     - OpenCode's worktree is "/" when the repository has no commit. The policy takes the nearest `.git` as
       the root instead.
   - The failure: the policy resolves `Users/…/kernel/data/opencode/tool-output/tool_X` as `<project>/Users/…`,
     which does not exist. The text-only fallback then counts it as "project", so it allows.
   - Real run (project A was `git init`ed with no commit; file planted as another project's output):
     `read <kernel>/data/opencode/tool-output/tool_fakeB` gave `PERM read once auto` and
     `PARTICIPANT-ROW-FROM-B` came back.
   - The same run without `.git` gives `ASKED outside the project folder`. That is correct.
   - Exposure:
     - every project's non-approved truncated outputs (other projects' data, kept 7 days);
     - not participant data from approved bash calls (those are deleted, see below);
     - not approved grep/read of participant data (the kernel profile returns EPERM, so they never reach
       the output folder).
   - The trigger needs a researcher-made empty repository. The agent cannot create `.git` (the profile
     denies it, and the policy asks).
   - Fix: classify both readings, `join(root, p)` and `join('/', p)`, and take the worst. Alternatively,
     treat any relative pattern that resolves into `<kernelHome>/data` as outside unless it is in
     `toolOutputs`. Add a test with `git init` and no commit.

## Should-fix

3. **The kernel profile still lets kernel code rewrite *other* projects' agent-shell folders.**
   - Where: `agent-sandbox.ts:224`. It denies writes to its own `agentShellDir` only. It also allows reading
     all of `kernelHome`.
   - Real run: under project A's generated kernel profile,
     - `profile.sb` of project B was overwritten with `(allow default)`. `inner.sh` reads that file on
       every command, so B's agent shell would run unconfined.
     - A token was planted in B's `approved/`.
     - B's broker secret was read from its `client.pl`.
     - A's own `profile.sb` is denied. That part is correct.
   - Not reachable through agent tools: the policy denies any `agent-shell` path (`reject auto`, tested).
     Formatters and LSP stay off.
   - This is the same class as review 5 item 5, which the fix meant to close.
   - Fix: deny `file-write*` on the whole `<kernelHome>/agent-shell`. Deny `file-read-data` on it too,
     except the own folder.
4. **Other projects' snapshots and `opencode.db`.**
   - Through tools these stay at "ask": glob and grep in `data/` ask, and `read opencode.db` asks. The
     reason shown is "outside the project folder".
   - That is within the threat model, but it invites approval of what is really other projects'
     conversations.
   - Suggest deny, or a reason that says "other projects' conversations". Also see item 2: the
     `toolOutputs` allowance depends on correct path resolution.
5. **Terminal (minor usability).**
   - Window size is sent once (`shell-broker.ts:168`, `PTY_HELPER` `TIOCSWINSZ`) and there is no resize
     path, so full-screen programs keep the starting size.
   - Otherwise the terminal works: the login shell, the researcher's data, and one-use tickets were
     verified in both the real-kernel test and native-live.

## Re-checked and holding (round 6 changes)

- **Broker secret.**
  - Stored only in `<kernel>/agent-shell/<hash>/client.pl` (0600).
  - Not in the env, not in argv (only the socket path, plus a ticket for the terminal), and not in logs or
    tool output.
  - The agent profile cannot read it (`cat …/client.pl` is rejected by the policy, and the profile denies
    `kernelHome`).
  - The kernel can read other projects' secrets (item 3) but cannot connect to their sockets: the profile
    allows only its own `path-literal`.
  - The agent profile denies the whole `run/` folder: `connect: Operation not permitted`.
  - Wrong secret → `not authorised`. A `cwd` outside the project → refused. A form other than `-c` → refused.
- **Terminal tickets.**
  - Random, 18 bytes, a 60 s TTL, and taken on first use (replay → `ticket is not valid`).
  - They exist only in the kernel's PTY args, which the agent cannot reach (no server password; the
    profile denies process-info).
  - Forging one needs both the secret and the socket.
- **Researcher `!`.**
  - Accepted only in OpenCode's 5-argument login form, matching a command the app has just registered.
  - A forged `/session/:id/shell` call → `not allowed`.
  - Its output is not truncated to a file.
- **Approved long output.**
  - Real run: an approved `cat human-data/big.csv` (4000 rows) produced a `tool_…` file, which was gone
    once the call ended.
  - Race: the filename is unknown to the agent, `glob`/`ls` of the folder asks or is denied, and `read` of
    a file not in `toolOutputs` asks (except under item 2).
- **Interpreter flags.** `hs_trusted` needs the second word to be a listed entry, so `-I/-E/-s/-S`, `-X`
  and `-W` all fall back to the sandbox. Arguments after the script cannot reach the interpreter.
- **Rounds 1–5:** all covered by suites that pass, including the real-binary kernel test (not skipped):
  - the cross-project broker;
  - the guard flags;
  - tool-output from a non-own project without `.git` (asks);
  - the kernel profile;
  - the agent profile;
  - helpers, symlinks, `.git`, `.ignore`, apply_patch, search filters.
- **Package code:** `sandbox_run.py` keeps `(deny network*)` (no broker sockets) and keeps the home folder
  unreadable.

## Tests

- `npm run typecheck`: passes.
- Kernel `*.test.mjs`: all pass:
  - agent-sandbox 4;
  - kernel-sandbox 1 (real binary);
  - policy 15;
  - subagent 11;
  - connection 18;
  - the others 1 each.
- **native-live with the real binary: fails on HEAD (item 1)** and passes on origin/main.
- `src/main/*.test.mjs`: all pass except `runtime.test.mjs` #14. That is the same environment failure as
  in rounds 4 and 5: the runtime python has no pytest.
- pack: `test_project_paths`, `test_audit` (21), `test_agent_package` (22) and `test_check_readiness`
  (12, 13 skipped) all pass. These cover build and export.

## Threat model

- Once items 1 and 2 are fixed, the remaining risks are within the stated model:
  - item 3 needs code execution inside the kernel process, which no tool path gives;
  - item 4 still asks.
