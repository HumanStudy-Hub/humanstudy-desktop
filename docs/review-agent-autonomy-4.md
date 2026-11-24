# Review 4: agent autonomy (claude/agent-autonomy @ 41326ed)

Verdict: **not yet**.

Every round-1 to round-3 bypass I re-ran is closed. Four new problems reach sensitive material
without a prompt, and each was reproduced.

How I tested:
- esbuild bundles of `permission-policy.ts` and `agent-sandbox.ts`.
- A scratch project with the pack in `.opencode/`, trusted hashes taken from pack.ts `HELPERS`, and the
  wrapper from `prepareAgentShell`.
- The real `sandbox-exec`, the managed runtime's python, and `HUMANSTUDY_RELAY_REQUIRED=1`.
- For grep/glob: the kernel's own ripgrep (`kernel/cache/opencode/bin/rg`) with the exact arguments
  OpenCode 1.19.0 passes. I read them from the binary: grep is `--no-config --json --hidden --no-messages
  --glob=<include> …`; glob is `--files --glob=<pattern>`. Neither tool passes `--follow`.

## Must-fix

1. **A character class that starts with `]` gets past the grep/glob filter rule.**
   - Where: `permission-policy.ts:262` (`globHitsSensitive`) and `:301` (`ripgrepGlobRegex`). Both copy the
     class body into a JS regex without escaping. In JS, `[^]` and `[]` are complete classes, so `[!]]*`
     turns into `[^]` followed by a literal `]`.
   - Reproduced with the kernel's rg. Each of these is allowed for both grep `include` and glob `pattern`,
     and returns the `TOPSECRET` row of `human-data/a.csv` (or lists the file, for glob): `[!]]*`, `[^]]*`,
     `[!]a]*`, `[!]-]*`, `[]-z]*`, `**/[!]]*` and `{[!]]*,zz}`.
   - Fix: do not try to copy globset's semantics. Over-approximate instead: turn every `[...]` into "any
     one character" (`[^/]`), in both functions. A class can only narrow a match, so this stays safe.
     Treat an unbalanced `[` as reaching.
2. **The unsandboxed helpers read any file a project JSON names, including folders the sandbox denies,
   and print its text.**
   - Where: `pack/skills/build/check_source_use.py:613-616` (`source_pages`). It uses `root / source.filename`
     from `program.json` with no containment check. `check_claims` then prints 90-character snippets
     (around line 764).
   - Reproduced through the real wrapper. `program.json` had `"source":{"filename":"../../r4/k2/secret.txt"}`,
     a file in the kernel folder, which the sandbox denies: `cat` of it gives `Operation not permitted`.
     `artifacts/failures.json` held guessed words, and there was no `paper.pdf`. Then
     `python3 .opencode/skills/build/check_package.py package/s1 --no-validity` (helper path) printed
     `warn claims: … ../../r4/k2/secret.txt p. 1 (… "host internal hostname basti…`.
   - The same works for `~/.ssh/config` (`../`×n), other projects, and `human-data/*`.
   - `check_readiness.py` passes it on through `package_warnings`.
   - Related channels, from a helper audit subagent. It reproduced these directly; I did not re-run them
     through the wrapper:
     - `check_verbatim.Sources.pages` (around line 192) and `audit.Sources.pages` (around line 146) accept
       evidence paths inside `human-data/`. `audit.py . --only X1 --no-run` then lists which guessed
       verbatim strings occur in `human-data/raw.csv`. That is a substring oracle on participant data.
     - `check_materials.norm_rel` (`:286`) keeps `..`, so `private_index` reads
       `sources/SOURCE.json` `{"path":"../outside/secret.txt","private":true}`. Readiness then confirms
       guessed lines ("copies the private material …").
     - `check_results.py` (around line 1462) opens `root / source.filename` for PDFs and prints table rows.
   - Fix: one shared resolver for every path that comes from project JSON. It should reject absolute paths
     and `..`, require `realpath` inside the project, and reject participant-data and key-folder segments.
     Use it in check_source_use, check_results, check_materials (`norm_rel`/`project_rel`/`private_paths`),
     check_verbatim, audit and fetch_source. As a backstop, have the wrapper start the helper under a
     relaxed Seatbelt profile that denies only participant data, key folders and home reads (no
     nesting is needed, because sandbox_run starts its own child). That closes the whole class of bugs.
3. **Allowed commands read anything in the home folder outside the short key-folder list.**
   - Where: `agent-sandbox.ts:156`. It denies reads only for participant data, `HOME_SECRETS`, the kernel
     folder and the app files. The classifier allows paths it cannot see.
   - Reproduced, all allowed with no prompt and run in the sandbox:
     - `python3 -c "…open(os.path.expanduser('~/.zsh_history'))…"` read 46,139 bytes. Shell history
       routinely holds `export …_API_KEY=`.
     - A `glob` of `~/humanstudy/*/sources/private/*` and of `~/Library/Application Support/*` (248
       entries) worked.
   - That covers other projects' `sources/private`, `program.json` and packages, other apps' data and
     tokens (`~/.codex`, `~/.config/*`, `~/.cache/huggingface/token`, `~/.cargo/credentials`,
     `~/.pgpass`, …). The network is open, so this content can then be sent out with an allowed `curl`.
   - Under the stated threat model (keys and other projects' data ask), this is a hole. The doc does not
     list it among the "not protected" items.
   - Fix: `(deny file-read-data (subpath HOME))`, then allow the project, the managed runtime,
     tool-output, the temp folders and anything else that is needed (pip/mpl caches already live under
     TMPDIR). Rules later in the profile win. Keep the participant and secret denies last.
4. **`defaults write` escapes the write sandbox through cfprefsd.**
   - Where: `agent-sandbox.ts:140-167`. There is no `user-preference-write` rule. The text rule
     (`permission-policy.ts:182`) is easy to get around: `d=defaults; $d write …`, `"defaults" write`,
     `defaults -currentHost write` and a python `ctypes` call to `CFPreferencesSetAppValue` are all
     allowed.
   - Reproduced: from inside the sandbox, `python3 cf.py` (ctypes) and `defaults write com.hs.test k v`
     both persisted to `~/Library/Preferences/com.hs.test.plist`. I deleted the test domain afterwards.
   - Impact: any app's preferences can be written. Examples are Terminal or iTerm profile start commands,
     which run unconfined the next time the researcher opens a window, and LaunchServices handler
     preferences. I did not test against a real app's domain.
   - Fix: add `(deny user-preference-write)`. I verified that it makes both routes fail
     (`Could not write domain`), and python still runs.

## Should-fix

- **Without an OS sandbox (Windows, Linux without bubblewrap), the allowlist reads participant data.**
  - Where: `permission-policy.ts:374-378`. Both of these are allowed in strict mode:
    - `grep -r TOPSECRET .` (also `-R`, `--recursive`, `-d recurse`). grep ignores `.ignore`.
    - `cat {human,x}-data/a.csv`. Brace expansion is not treated as a glob, and the segment is not a
      sensitive name.
  - Fix: in strict mode, ask on recursive grep (or allow it only with `--exclude-dir` for every
    participant name), and treat `{` as a glob, with braces expanded before `globHitsSensitive`.
- **An approval token is tied only to the command text** (`agent-sandbox.ts:254-260`,
  `opencode.ts` reply → `approveCommandOnce`).
  - If the approved call never reaches the wrapper, the token stays valid for 10 minutes. That happens
    with a nonexistent `workdir` (spawn fails), an abort, or OpenCode failing before the spawn.
  - A later identical command that the policy allows (different `workdir`, or from a subagent) then
    consumes it and runs **unsandboxed**. Example: approve `cat */a.csv` "in /nonexistent", then the plain
    `cat */a.csv` in the project reads `human-data`.
  - I reasoned this from the code and the binary; I did not run it end to end in OpenCode.
  - Fix: store the resolved cwd in the token and compare it with `pwd -P`. Also delete the call's token
    when its tool part completes or errors.
- **run_confined's subcommand check can be fooled** (`agent-sandbox.ts:212`). The first non-flag argument
  is taken as the subcommand, so `--root reproduce overview` passes and runs `overview`. Reproduced; it
  stays confined. Fix: require exactly `--root . reproduce` (or `reproduce` right after the script).
- **`pbpaste` is allowed and works in the sandbox.** The clipboard often holds passwords and keys. This is
  low, but the doc should name it, or `com.apple.pasteboard.1` mach-lookup could be denied.
- **Docs.** `agent-autonomy.md` should say that the sandbox does not cover reads under home (until item 3
  is fixed), name preferences (item 4) and say that the helpers read paths named in project files (item 2).

## Why the kernel is not sandboxed: judgement

The costs listed are real. Nested sandboxes are impossible on macOS. Approved reads would need a broker.
The kernel's storage holds every conversation. So I accept not sandboxing the kernel for now.

But the substitute design depends on re-implementing ripgrep's globset in a regex. This is the second
round in a row where that emulation was wrong (round 3: wildcards and braces; round 4: classes). Path
checks should over-approximate rather than emulate. A cheaper backstop is still worth doing: start the
kernel under a minimal profile that only denies `file-read-data` of the participant-data regex. That
needs no broker for ordinary work. An approved participant-data read could fall back to the agent's
shell, where approval tokens already lift the sandbox. Every OpenCode tool would then be covered at the
root for the one material the owner cares about most.

## Rounds 1-3, re-run: closed

- **Through the wrapper:**
  - `open` and app bundles fail (`deny lsopen`, exec denied).
  - `ln -s` fails. Writes to `.ignore`, `.opencode/`, `~/Library/LaunchAgents/` and `.git` fail.
  - `ps` is denied.
  - `cat` and `grep -r` into `human-data` are denied.
  - `launchctl bootstrap/load/submit` via python `subprocess` fail (`5: Input/output error`) or do not
    register, and no file appeared.
  - `at` and `crontab` are exec-denied.
  - `nohup` children stay in the sandbox (inherited).
- **Package code (round 3 #4):** an agent-written `human/human_sessions.py` under
  `run_confined --no-model … reproduce` gets `Operation not permitted` on `human-data/a.csv` and on
  `human-data/../human-data/a.csv`. The participant deny is in effect.
- **`=` arguments:** `--json=/tmp/…` and `--root=..` take the confined path. The helper refuses package
  code there.
- **apply_patch (real shape, from the binary: `files[].filePath/movePath` absolute, `patterns` relative to
  the worktree):** each of these asks: a move into `.opencode/`, into `OpenCode.JSON`, a move out of
  `human-data`, `.Ignore`, `sub/.git/config`, `src/../.opencode/x` and LaunchAgents.
- **workdir:** `human-data`, `sub` + `../human-data` and `~` ask. `.opencode/plugin` + a write is left to
  the sandbox, which denies it.
- **grep/glob filters:** `*`, `**`, `*/**`, `{*}`, `{,*}`, `*{,}`, `{a,{b,*}}`, `?*`, `[a-z]*`, `[!x]*`, `/**`
  and `sub/**` ask (each one leaks with rg). `*.csv`, `**/a.csv`, `**/*.csv`, `*/*`, `./**`, `*/`, `**/` and
  `!…` are allowed, and none of them leaks with rg. A file-level glob cannot whitelist the ignored
  directory.
- **Search roots:** `..` asks, and temp asks. Symbolic links are moot: neither tool passes `--follow`, and
  the agent cannot create links on macOS.

## Regressions (real runs through the wrapper)

- `check_readiness.py . s1` returns JSON.
- `run_confined --no-model study_core.py --root . reproduce` gives a correct refusal or result.
- `agent_package.py --output exports/o` passes, including its self-test.
- `effects.py .` runs.
- `pip install --target .humanstudy/pylib six` works.
- `curl https` works.
- No regressions found.

## Tests

- `npm run typecheck`: passes.
- Kernel `*.test.mjs` (all except `native-live` and the live transport test): 55/55. The real
  `sandbox-exec` test was not skipped.
- `src/main/*.test.mjs`: 116 of 119 pass, 2 skipped, 1 fails.
  - The failure is the python unit-test runner under the system python 3.9. Four `test_check_readiness`
    cases fail with "the jsonschema package is unavailable in the research runtime".
  - This comes from the environment, not the branch: with the managed runtime python,
    `test_check_readiness` passes 25/25.
