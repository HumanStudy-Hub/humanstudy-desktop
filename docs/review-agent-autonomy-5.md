# Review 5: agent autonomy (branch claude/agent-autonomy, up to f4d84c7)

Independent adversarial review. No tracked files changed. Real macOS runs: the HumanStudy kernel
binary hs-v1.19.0 under `macosKernelProfile`, with a mock OpenAI-compatible model driving real tool
calls, and real `sandbox-exec` agent profiles with real brokers (`startShellBroker`). All test homes
were removed afterwards.

**Verdict: not yet.** There are 3 must-fix items: a cross-project hole in the broker, a cross-project
hole in tool-output, and a bypass of the helper guard. There is also a functional regression in the
researcher's terminal.

## Must-fix

1. **Any project's broker accepts commands from another project's agent.**
   - Where: `agent-sandbox.ts:174` denies connecting to the project's *own* socket literal only.
     `shell-broker.ts` has no authentication: any peer that reaches the socket is served.
   - Real run: a confined command in project A (agent profile A, no prompt) used perl to connect to
     `~/.humanstudy/run/<hash B>.sock`. It sent `{"args":["-c","cat private.txt; pwd"],"cwd":"<B>"}`
     and got back `OTHER-PROJECT-CONTENT`. In the same profile, `cat <B>/private.txt` directly gives
     `Operation not permitted`.
   - What the agent in A gets through B's broker:
     - B's agent profile: read and write all of project B, so it can plant code that B's researcher
       runs later;
     - B's helper-unconfined path;
     - any pending approval token in B.
   - The kernel profile does not restrict these sockets either.
   - Fix:
     - deny `network-outbound` to the whole `~/.humanstudy/run` folder (subpath or regex) in the agent
       profile;
     - in the kernel profile, allow only the kernel's own socket;
     - authenticate the client: a per-launch secret embedded in `client.pl` (the agent profile cannot
       read the kernel dir), checked by the broker.
   - Hard-linking the socket into the project is denied (tested), so path aliasing is closed.
2. **The shared tool-output folder leaks between projects.**
   - Where: `agent-sandbox.ts:172` (agent profile read allow) and `permission-policy.ts:94` (allowed
     root, no ask).
   - OpenCode's truncation store is global: `<kernel>/data/opencode/tool-output/tool_*`, kept 7 days,
     for every output over 2000 lines or 50 KB.
   - The risk: a command the researcher approved in project B (`cat human-data/big.csv`) leaves the
     full participant data there.
   - Real run: under project A's agent profile, `ls tool-output; cat tool-output/*` printed
     `1,PARTICIPANT-ROW-FROM-PROJECT-B`.
   - Within one project, the same file also outlives the one-use approval.
   - Fix: give each project its own data folder (per-project `XDG_DATA_HOME`), or scope the allow to
     files the kernel lists for this session. Also delete truncation files written by approved
     commands.
3. **`python -I` switches off the helper guard.**
   - Where: `hs_trusted` (`agent-sandbox.ts:297`) accepts `-I` (and skips it).
   - `-I` makes Python ignore `PYTHONPATH`, so `sitecustomize` (the guard) never loads. Yet the helper
     still runs outside the sandbox.
   - Real run with the managed runtime python 3.12: the guard blocks `~/.zshrc` without flags and with
     `-s`. It reads it with `-I` and with `-E`.
   - What remains in place:
     - the `project_paths.py` resolver in its 5 helpers;
     - `HUMANSTUDY_AGENT_RUN` for package code.
   - What is lost: everything else the guard covered. That is the helper process's own reads of
     participant data or home files named by project files.
   - Fix: refuse `-I`/`-E` on this path, or load the guard in a way the flags cannot drop (for example
     `python -I -c 'import guard; runpy…'` written by the wrapper).

## Should-fix

4. **Regression: the researcher's Terminal view is now confined by the kernel profile.**
   - The terminal is the `terminalCreate` route, `/pty` spawned by the kernel. Spawned by the kernel,
     it inherits the kernel's sandbox.
   - Real run: `cat human-data/a.csv` and `ls ~/.ssh` give `Operation not permitted`. So git over ssh,
     the researcher's own data and other projects all fail there.
   - Docs `agent-autonomy.md:178` and `:278` say the terminal runs unconfined. Either route the PTY
     through the app (as the broker does) or document the change.
5. **The kernel profile leaves kernel files and the home folder open to code running in the kernel.**
   - It denies no writes: not the `agent-shell/` folder (`inner.sh`, `approved/`, `profile.sb`,
     `trusted.sha256`, `guard/`), and not `~/Library/LaunchAgents` or the shell rc files.
   - It allows reading all of `kernelHome` (`agent-sandbox.ts:215`), which includes:
     - other projects' snapshot repos (`data/opencode/snapshot/<B>`);
     - `opencode.db`, which holds every project's conversations.
   - Not exploitable today, because formatters and LSPs are off in the fork. The log says "all
     formatters/LSPs are disabled", and a planted `node_modules/.bin/prettier` with prettier in
     package.json did **not** run. But code running in the kernel could rewrite `inner.sh` and get
     unconfined execution through the broker.
   - Fix: deny writes to `agent-shell/` and to home-folder dotfiles in the kernel profile.
   - Reads of other projects' snapshot repos reach the policy only as "outside project → ask", which
     invites the researcher to approve.
6. **The broker does not check what it is asked to run.** The `cwd` is any existing folder and the
   `args` are arbitrary. This is harmless only while issue 1 is closed. Checking `args[0]==='-c'` with
   length 2 and that `cwd` is under the project would bound it.

## Checked and holding

- **Formatter and LSP:** disabled; the planted prettier did not run.
- **Snapshots under the kernel profile:** work (git repo, edit tracked) and contain no participant
  data (grep of the kernel data: none).
- **Broker:**
  - its own socket is unreachable from the agent profile (`Operation not permitted`);
  - hard links to it are denied;
  - no env passes from the client, and the wrapper strips secrets;
  - closing the connection kills the process group;
  - one JSON line, so nothing can be smuggled after it;
  - approval tokens are hash- and `pwd -P`-bound, single-use and removed when the call ends.
- **Rounds 1–4:** covered by the suites below, all pass, including the real-binary kernel test
  (not skipped).
- **Guard:** `subprocess` `cwd=` is not checked by the hook, but no shipped helper passes a
  project-named `cwd`. `ctypes`/`posix_spawn` appear only in `sandbox_run.py`/`program_lock.py`
  (shipped, hash-checked).

## Tests

- `npm run typecheck`: passes.
- Kernel `*.test.mjs`: all pass (agent-sandbox 4, kernel-sandbox 1 real, policy 15, subagent 11,
  connection 18, …).
- `src/main/*.test.mjs`: 116 of 119 pass, 2 skipped, 1 fails. The failure is the same environment
  failure as in round 4: `No module named pytest` in the runtime python.
- `test_project_paths`: OK.
