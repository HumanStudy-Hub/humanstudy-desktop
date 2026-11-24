# Review 3: agent autonomy (claude/agent-autonomy @ d3aab38)

Verdict: **not yet**. Every bypass from rounds 1 and 2 is closed. I re-ran each one through the real
generated wrapper on this Mac (sandbox-exec), or through `classifyPermission` for the tool requests.
Four new ways around the protection reach participant data, or the agent's configuration, without a
prompt. Each one below was reproduced, except where noted.

Probe: esbuild bundles of agent-sandbox.ts and permission-policy.ts, a project in my scratchpad
(`p3/study`) with the pack copied to `.opencode/`, trusted hashes taken from pack.ts `HELPERS`, the
wrapper from `prepareAgentShell`, and `HUMANSTUDY_RELAY_REQUIRED=1` as the app sets it.

## Must-fix

1. **`open` (LaunchServices) escapes the OS sandbox completely.**
   - Where: `agent-sandbox.ts:141-160`. The profile has no `lsopen` rule. `classifyCommand` allows `open`.
   - Reproduced: `mkdir -p Probe.app/Contents/MacOS && … && open -g -j Probe.app`. This needs only an
     Info.plist and a shell script, with no quarantine flag. launchd starts the app outside the sandbox.
     The app read `human-data/a.csv` and wrote `.opencode/pwn-open`. A file in `.opencode/` is a plugin,
     and a plugin runs in the kernel with the keys.
   - Fix: add `(deny lsopen)` to the profile. Verified: `open` then fails with -54 and nothing runs.
     Also consider denying mach-lookup of `com.apple.coreservices.launchservicesd`. `launchctl submit`
     through python already fails in the sandbox.
2. **The grep tool's `include` overrides `.ignore`.**
   - OpenCode passes `include` to ripgrep as `--glob=<include>` (confirmed in the kernel binary,
     hs-v1.19.0). A ripgrep whitelist glob always overrides ignore files.
   - Reproduced with real `rg --no-config --json --hidden`: `--glob=*`, `**`, `**/*`, `{*}` and `?*`
     each return the `TOPSECRET` row from `human-data/a.csv`.
   - `classifyPermission` allows all five (`permission-policy.ts:496`). `globHitsSensitive(…, false)`
     treats wildcard-only segments as harmless, and `{…}` is not parsed.
   - This needs no attacker. A cooperative model may write `include: "*"` on its own.
   - Fix: for grep/glob, ask on any `include`/`pattern` that is not provably free of participant-data
     names (strict mode, braces expanded), or drop wildcard-only includes. The glob tool's `**/*` lists
     participant file names (names only). Fix that the same way.
3. **apply_patch with several files bypasses every write rule.**
   - OpenCode's apply_patch asks `edit` with `metadata.filepath = patterns.join(", ")`.
   - Where: `requestPaths` (`permission-policy.ts:452-459`) takes that joined string as one relative path.
   - Result: `"src/x.py, .opencode/plugin/p.ts"` is allowed. So are `"src/x.py, human-data/a.csv"`
     (deleting or moving participant data), `"…, opencode.json"` and `"…, .ignore"`. Only the
     single-file form asks.
   - Fix: classify every entry of `perm.patterns` and of `metadata.files[].filePath/movePath`, never the
     joined `filepath`. Not run live, because no GPT-family model was in the loop. The request shape is
     taken from the binary.
4. **Package code reads participant data and prints it through an allowed helper.**
   - Reproduced with three agent-written files: `package/x/task/adapter.py`, `human/key.json` with
     `{"files": []}` (an empty list gives status "ok") and `human/human_sessions.py`. Then:
     `python3 .opencode/skills/simulate/run_confined.py --no-model .opencode/skills/export/agent/study_core.py --root . reproduce`.
     The classifier allows it, the wrapper starts it outside the sandbox, and the output contains
     `LEAK: pid,secret_answer / 1,TOPSECRET`.
   - Why: `run_confined.py:111-113` prints the child's whole stdout and stderr.
   - The same channel exists in two more places:
     - `effects.py:132` returns 300 characters of the child's stderr.
     - `effects.py:138,179` returns the `aiError` text, up to 400 characters.
   - `docs/agent-autonomy.md` lists this under known limits. Under the owner's rule (participant data
     asks, and the agent may be prompt-injected), it is a silent read followed by an allowed `curl`.
   - Fix, either one:
     - Return only the structured result: numbers and fixed labels. Never return raw child output once
       participant data was opened.
     - Or ask before the helper modes that open `human-data/` to package code. That means
       `--no-model … reproduce`, and effects/readiness/audit when a human loader exists.

## Should-fix

- **The `=` form skips the argument checks** (`agent-sandbox.ts:214`). `/*|*..*` is tested on the whole
  word, so `--json=/abs/path` passes.
  - Reproduced: `check_validity.py . --json=<kernel>/pwn.json` wrote into a folder the sandbox denies.
    `agent_package.py --root=<other project> --output=… --include-sources` exported another project.
  - In the app, the classifier asks or denies for paths outside the project. It still allows temp and
    `dirname(HUMANSTUDY_RUNTIME_BIN)`, so an unsandboxed write into the managed runtime gets through.
    The sandbox protects that folder on purpose.
  - Fix: check `${hs_a#*=}` like a positional argument.
- **Bash `workdir` is invisible to the policy.** OpenCode's bash permission metadata is only `{command}`.
  - Without an OS sandbox (Windows, Linux without bubblewrap), `{command:"cat a.csv", workdir:"human-data"}`
    passes `strictAllowed`.
  - Fix: read the tool call's input (by callID) and use it as `base`, or ask when a workdir is given.
- **grep/glob with a path in a temp folder** (`/private/var/folders`, `/tmp`) is allowed, and the
  `.ignore` check covers only the project.
  - `audit.py --keep` (an allowed flag) leaves a full study copy, including `human-data/`, in system temp.
  - The copied `.ignore` still shields it from a plain search, but not from item 2.
- **Docs.**
  - `AGENTS.md:47`: `check_readiness.py .` is a usage error, because main needs `PROJECT SLUG`.
  - `HELPER_FLAGS` lists `--no-validity` for check_readiness, which it does not accept.
  - The docs and AGENTS do not mention `open`, apply_patch, or `include` on searches.
- **Low.** `mdfind -onlyin <project> <word>` can serve as an oracle for a term's presence in Spotlight-indexed
  projects (mds is not sandboxed). `qlmanage` already fails inside the sandbox.

## Rounds 1-2, re-run: all closed

These now ask, or are blocked by the sandbox:
- `${HOME}` paths;
- the human-data spellings: `cd`, globs, `$D`, upper case, `find -exec`, `/.vol/<dev>/<ino>`;
- `git -C/-c push`, git aliases, `npm --registry publish`, `rsync host:`;
- `ps eww`, `env -0`, `declare -p`, `export`, `$OPENCODE_*`, `tar | nc`;
- the python write-then-run script.

The sandbox also blocks:
- **Helper child modes:** `recorded_answers --child`, `check_validity --capture/--probe`,
  `audit --probe/--pro`, `check_replies --smoke-child`, `run_confined --no-model x.py`. They run confined,
  and the adapter's read of `human-data` and its write to `.opencode` both fail.
- **Links and moves:** `ln -s` to `.opencode`, `.git/hooks` or `human-data`. Hard links (`ln`) into
  `human-data`, `.opencode`, `opencode.json`, `.git/config`, `.ignore` or `/etc` also fail. Only
  `ln program.json pj` works. `mv`/`cp` out of `human-data/` fails, as does `mv human-data`.
- **Writes to `.ignore`, `.opencode` and `.git`:** `echo >`, `rm` and `mv .ignore` fail. `.git` cannot be
  replaced with a `gitdir:` file.
- **Tool requests that ask:**
  - The edit tool on `.ignore`, `.IGNORE`, `sub/.ignore`, `.rgignore`, `opencode.json` and `.opencode/plugin`.
  - The read tool on `qUARANTINE`.
  - grep with `path` set to human-data in any spelling, including `sources/../human-data`.

Doom loop: a per-turn counter keyed by the parent session, reset on send. The 4th automatic answer asks. OK.

## Regressions (real runs)

- `python -m venv` fails: ensurepip aborts, because symlinks are denied. This is documented, and nothing
  in the pack uses venv. Low impact.
- Agent `git init`/commit fails (`.git` is not writable). No skill commits. Low impact.
- `pip install --target .humanstudy/pylib six` works.
- `check_readiness.py . x` runs outside the sandbox and returns its JSON.
- `agent_package.py --output exports/o --mcp` passes, including its nested self-test.
- `--include-sources` works.
- `npm install` and any archive or wheel that contains symlinks will fail. This is not used by the
  skills, and it should be noted in the docs.
- The `.ignore` block also hides participant data from the researcher's own rg and VS Code search (UX).

## Tests

- `npm run typecheck` passes.
- permission-policy, agent-sandbox (the real macOS sandbox-exec test was not skipped), subagent and
  account tests: 28/28.
- All kernel `*.test.mjs` except `native-live` and `runtime`: 54/54.
