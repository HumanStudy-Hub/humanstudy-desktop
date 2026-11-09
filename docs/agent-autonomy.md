# Agent autonomy: what the agent may do without asking

Owner decision, 2026-11-08: *nothing asks, except actions involving sensitive material*
("让所有东西都不问，除非涉及敏感资料的"). The researcher is not a laborer clicking "allow".
Because almost nothing asks, sensitive material has to be protected by more than the text of a
command: the agent's shell runs in an OS sandbox where the computer offers one, and the command
classifier is the second layer.

## Layer 0: the kernel under its own profile (macOS)

The OpenCode kernel process runs under `sandbox-exec` with a minimal profile (`macosKernelProfile` in
`app/src/main/kernel/agent-sandbox.ts`). The profile takes away only what the kernel never needs:

- reads of participant-data folders, in any letter case and anywhere;
- reads of key folders (`~/.ssh`, `~/.aws`, `~/Library/Keychains`, ...) and of the app's account,
  credential and settings files and relay folder;
- reads of the projects folder (the researcher's projects root from Settings, exported as
  `HUMANSTUDY_PROJECTS_ROOT`, plus the default and earlier default roots), except this project;
- preference writes, LaunchServices (`open`), Apple events and the clipboard.

It also denies writes to what later runs outside it:
- the agent-shell folder (wrapper, profiles, approval tokens, guard);
- the brokers' folder;
- shell start-up files and launch agents.

It may connect only to its own broker socket. Everything else stays as before: the network, the
kernel's own data folder and its other writes. So every OpenCode tool is confined at the root, whatever its path checks miss. That covers read,
list, grep and glob (including any `include` filter), apply_patch, lsp and plugins.

A macOS sandbox is inherited by every child and cannot be nested. The kernel's shell is therefore a
small client (`brokerClient`, system perl). It sends the arguments and folder over a unix socket in
`~/.humanstudy/run/` to the app's shell broker (`shell-broker.ts`). The broker serves exactly three
kinds of request, and refuses anything else:

- **The bash tool** (`-c <command>`, nothing else): the agent-shell wrapper, outside the kernel's
  sandbox, with the kernel's environment minus its secrets.
- **The researcher's `!` command**: OpenCode's login form, but only for a command the app itself has
  just sent (`expectResearcherCommand`, one use). It runs in the researcher's own shell, unconfined,
  as before the kernel was sandboxed.
- **The Terminal view**: the app replaces the terminal's command with the client in terminal mode and a
  one-use ticket. The broker starts the researcher's login shell under a pseudo-terminal of its own
  (`PTY_HELPER`, macOS `/dev/ptmx` ioctls), unconfined, and relays input. The window size is set once
  when the terminal opens; later resizes do not reach the shell.

Every request carries a per-launch secret that only that project's `client.pl` holds. The agent profile
cannot read the kernel folder, and the broker compares the secret in constant time. The folder must be
inside the project. Neither profile may connect to the brokers' folder `~/.humanstudy/run`; the kernel
profile makes one exception, its own socket. Closing a connection (timeout, abort) kills the command.

A participant-data read by an OpenCode tool fails even after the researcher approves it, because the
kernel cannot read the folder. The agent uses a shell command for such a read. Once approved, that
command runs outside both sandboxes.

OpenCode keeps truncated tool output (over 2000 lines or 50 KB) in one folder for all projects
(`<kernel>/data/opencode/tool-output`, kept 7 days). The agent's shell cannot read it. The read tool
reaches only files this project's own calls produced: the app records each `outputPath`. The output of
a command the researcher approved is deleted as soon as that call ends.

Linux keeps the kernel unconfined (bubblewrap nesting under user namespaces was not available to test).
`HUMANSTUDY_KERNEL_SANDBOX_OFF=1` switches the kernel profile off for development.

## Layer 1: the OS sandbox around the agent's shell

`app/src/main/kernel/agent-sandbox.ts`. OpenCode runs every bash command as `<shell> -c <command>`;
the inline config sets `shell` to a generated wrapper (`<userData>/kernel/agent-shell/<project>/zsh`,
named like the real shell so OpenCode's shell handling is unchanged). The wrapper:

1. removes `OPENCODE_SERVER_PASSWORD`, `OPENCODE_CONFIG_CONTENT` (it carries the local transport
   token), `HUMANSTUDY_SERVER_BYPASS`, `HUMANSTUDY_RELAY_DIR`, the kernel's `XDG_*` folders and every
   key-shaped variable (`KEY|TOKEN|SECRET|PASSW|CREDENTIAL|BYPASS|AUTH`) from the environment. The
   model key stays only on the pre-relay path (Linux, Windows), where simulations need it and the run
   confirmation says so;
2. runs a command the researcher approved in the conversation outside the sandbox, once. When the
   researcher approves a bash request the policy had sent to them, the app writes a token into a folder
   the sandbox cannot write. The token holds:
   - the exact command (sha256);
   - the resolved folder of that call (`pwd -P` must match);
   - an expiry of 10 minutes.

   The token is consumed atomically, and removed as soon as that tool call completes, fails or is
   aborted. Commands the policy would have allowed stay confined even when "Ask before changes" shows
   them;
3. runs the app's helpers that confine package code themselves outside the sandbox, because a macOS
   sandbox cannot be nested (`sandbox_apply: Operation not permitted`). This happens only on macOS, and
   only when all of these hold:
   - it is one plain command (`python .opencode/skills/...py args`: no interpreter flags such as `-I`,
     `-E`, `-s` or `-S`, which would drop the guard below; no quotes, `$`, `;`, `&`, `|`, redirection or
     globs), run from the project folder, with the managed runtime's python;
   - every shipped helper script in the project matches the hashes of the app's own copy
     (`trustedHelperHashes()` in pack.ts; refreshPack restores them);
   - it uses only the arguments in `HELPER_FLAGS` (agent-sandbox.ts): relative paths inside the project
     that do not name `.opencode`, `.git`, `.ignore`, `opencode.json` or participant data, and only the
     listed flags.

   `run_confined.py` qualifies only in two forms: with the relay (`HUMANSTUDY_RELAY_REQUIRED=1`; a relay
   run needs the researcher's Run approval), or as exactly
   `--no-model .opencode/skills/export/agent/study_core.py --root . reproduce [--method package|author]`.
   In every other case the helper runs confined, and `sandbox_run.py` refuses with a message telling the
   agent how to run it.

   A helper on this path runs with an in-process guard: `HELPER_GUARD`, loaded as `sitecustomize`
   through `PYTHONPATH`. Its audit hook refuses every open, directory listing and subprocess argument
   that names participant data or a key folder, or that is in the home folder outside the project and
   the managed runtime. This holds whatever path a project file names. Each helper also resolves such
   paths through one rule, `pack/skills/build/project_paths.py`: relative, no `..`, inside the project
   after resolving links, and never participant data or keys. The helpers that use it are
   `check_source_use.py`, `check_results.py`, `check_materials.py`, `check_verbatim.py` and `audit.py`.
   The app's own runs (Readiness) and runs the researcher approved have no guard;
4. runs everything else confined.

### What each helper may do outside the sandbox (audit of `HELPERS`, 2026-11-08)

Package code started by the agent never reads participant data. On the helper path the wrapper sets
`HUMANSTUDY_AGENT_RUN=1` (the plain-command rule leaves the agent no way to unset it), and
`sandbox_run.py` then adds a final rule to its own Seatbelt profile that denies participant-data folders,
over every folder it would otherwise allow. So a helper's output, which passes the child's stdout and
stderr through (`run_confined.py`, `effects.py` error text), cannot carry participant data. The app's
own runs (Readiness, `scientific-readiness.ts`) and commands the researcher approved do not set it,
and read the data as before. Agent-run checks that need the human data say it could not be read; the
authoritative check is the app's Readiness.

| Helper | Runs project code? | Prints project data? | Refused here |
|---|---|---|---|
| `simulate/run_confined.py` | the run script, through sandbox_run and the relay. It has no network except the relay and writes only in a scratch folder. It reads the project, but **not** participant data (below). | what the run script prints | anything but a relay run or `--no-model study_core.py --root . reproduce` |
| `export/agent/study_core.py` (through run_confined `--no-model`) | package analysis code, confined as above | `reproduce` prints the recomputed results; started by the agent it runs without participant data, so it reports the data as unreadable | every subcommand but `reproduce` (`human-data`, `run --cli`, ...) |
| `build/check_readiness.py`, `check_package.py`, `check_validity.py`, `check_replies.py`, `recorded_answers.py`, `audit.py`, `effects.py`, `prompt_context.py`, `export/agent_package.py` | package code, only through sandbox_run (a copy of the package, no network, no home folder) | check results. The helper process itself reads `human-data/` only for its checks (counts, hashes, field names); the package code it starts cannot read it when the agent started the helper. | the in-process child modes: `recorded_answers.py --child`, `check_validity.py --capture/--probe`, `audit.py --probe/--n/--workdir`, `check_replies.py --smoke-child`, `check_package.py`/`agent_package.py --smoke-test`. Any other flag not listed is refused too. |

Helpers that do not run project code only call `pdftotext`/`pdftoppm`: `check_program.py`,
`check_quotes.py`, `check_results.py`, `check_verbatim.py`, `sources.py`, `qsf_flow.py`,
`check_materials.py`, `estimate_run.py`, `paper_tables.py`, `check_source_use.py`, `docx_text.py`,
`program_io.py` and `capabilities.py`. `docx_text.py` prints the text of the file it is given, so it
runs confined like any other command. The other `HELPERS` scripts:

- `fetch_source.py` fetches public URLs into `sources/`.
- `simkit.py` and `package_files/replies.py` are libraries used inside confined runs.
- The agent's build steps do not run `mcp_server.py` or `community.py`.

What a command the app approves by itself cannot do, by platform:

**macOS (`sandbox-exec`).** The network stays open, because public source search needs it. A folder's
existence (`stat`) stays visible. Otherwise, such a command cannot:

- read file contents in, list, or write a folder named `human-data`, `human_data`, `quarantine(d)`,
  `withheld` or `participant-data`/`_data`. This holds in any letter case and anywhere, including other
  projects and `~/.humanstudy/human-data`;
- read or write key folders: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/Library/Keychains`, `~/.config/gh`,
  `~/.claude`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials` and similar;
- read or write the app's `account.json`, `credentials.json`, `settings.json` and `run-relays`, or the
  relay folder;
- read anything in the home folder except the project, the managed runtime, `~/.gitconfig` and
  `~/.config/git`. That covers shell history, other projects, and other apps' tokens and data. It also
  means a python or node installed under the home folder (pyenv, nvm) cannot run;
- read or write the kernel's own folder (other projects' conversations, its config, the wrapper and
  approval tokens), tool output included;
- write any app's preferences (`defaults write`, CFPreferences: cfprefsd would write them on its
  behalf, for example a Terminal start command), or read the clipboard;
- connect to the app's shell broker;
- write anywhere outside the project and the temp folders;
- write the managed runtime (a planted `.pth` file would run in the helpers that start outside);
  `pip install --target` into the project still works;
- write the project's `.opencode/` or `opencode.json(c)`;
- write any `.git`. So there are no commits, and `.git` cannot be replaced by a `gitdir:` file;
- write any `.ignore`/`.rgignore`;
- create symbolic links at all, so `python -m venv`, `npm install` and unpacking archives or wheels that
  contain links fail;
- hard-link a file it may not write;
- see other processes (`ps`), whose environment holds keys, or talk to the keychain service;
- start anything outside the sandbox through LaunchServices (`open`, app bundles: `(deny lsopen)`) or
  run `osascript`/`osacompile`/`automator`/`shortcuts` (Apple events are also denied; a copied
  `osascript` fails its library check, and an Apple event to another app would still need the
  researcher's Automation consent for HumanStudy);
- query Spotlight (`mdfind`), which would reveal what other folders contain.

**Linux with bubblewrap.** This is not tested on a Linux machine; the generated script is only checked
for syntax.

- The root is read-only. The project and temp folders are writable.
- `.opencode/`, `opencode.json`, `.git` and `.ignore` are read-only when they exist.
- Participant-data folders **inside the project** (found per command, in any case), the key folders and
  the app files are hidden behind empty mounts.
- Commands run in their own process namespace.
- Not covered: participant data outside the project is not hidden, and symbolic links can be created.
- The app's helpers run inside the sandbox, so any participant data they need asks.

**Linux without bubblewrap, Windows.** There is no sandbox, so only an allowlist runs without asking:

- `ls`, `cat`/`head`/`tail`/`wc`/`file`/`sort`/`uniq`/`cut`/`echo`/`pwd`, `grep`, `find` without
  `-exec`/`-delete`, `pdftotext`/`pdfinfo`/`hs-pdf`, `git status/diff/log/show`, and the read-only
  helpers above;
- every argument must be relative, inside the project, and not participant data or a key file;
- `{a,b}` is expanded and checked;
- no recursive grep (`-r`, `-R`, `--recursive`, `-d recurse`), because grep ignores `.ignore`;
- no variables, substitutions or redirections (except to `/dev/null`).

Everything else asks, including every helper that runs package code.

Git: the kernel's environment (and the wrapper) sets `GIT_CONFIG_COUNT`, so every git the kernel starts
runs with `core.fsmonitor=false` and `core.hooksPath=/dev/null`. A project's `.git/config` therefore
cannot make OpenCode's own `git status` run code. The researcher's own terminal (the Terminal view) and
`!` commands run their login shell as the researcher, through the broker, not in either profile. Their
own git is not covered.

OpenCode's own tools (read, list, edit, write, grep, glob, lsp) run in the kernel process, not in the
shell, so the OS sandbox does not cover them. Instead, every one of their requests comes to the app.
`PERMISSION_CONFIG` is `"*": "ask"`, with only `webfetch`, `websearch`, `task` and `todowrite` allowed
directly. The app resolves symlinks first: the real path, or the nearest existing parent for a new
file. It then takes the stricter verdict of the written path and the real path.

For grep and glob, the app keeps a block in the project's `.ignore` that names the participant-data
folders in any case. ripgrep honours it, also with `--glob` and from parent folders, and a nested
`.gitignore` cannot re-include them. So a search over the project never returns participant data.
A search whose path or pattern points at participant data asks. If the block is missing, a
project-wide search asks.

ripgrep lets a matching `--glob` override `.ignore`, and OpenCode passes grep's `include` and glob's
`pattern` as `--glob`. On macOS the kernel profile denies these reads anyway. The policy also lists the
participant-data folders under the search root, and asks when the filter could match one of them.

The match over-approximates: every `[...]` class counts as any one character, an unbalanced `[` counts
as matching, `{a,b}` is expanded, and `**` is honoured. So `*`, `**`, `**/*`, `{*}`, `?*`, `[!]]*` or
`sub/**` ask, and `*.csv`, `**/*.py` or `src/**` do not. Outside the project, only this project's own
tool-output files are searched without asking, because temp folders can hold study copies.

apply_patch asks once for several files, with their names joined by ", " in `filepath`. The app checks
every `files[].filePath` and `movePath` and every pattern, and never the joined string.

The bash request carries only the command. The app takes the tool call's `workdir` from its input (the
`message.part.updated` event with the same call id) and judges relative paths from there.

The `.ignore` block also hides participant data from the researcher's own `rg` and from editor searches
that honour `.ignore` (VS Code does).

`HUMANSTUDY_AGENT_SANDBOX_OFF=1` switches the sandbox off for development; the classifier then uses the
allowlist.

## Layer 2: the command classifier

OpenCode sends the app a `permission.asked` for every request (inline config `PERMISSION_CONFIG` in
`app/src/main/kernel/opencode.ts`: every request of every tool). The app answers each one with
`classifyPermission` in `app/src/main/kernel/permission-policy.ts`:

| Verdict | What the app does | Examples |
|---|---|---|
| allow | answers `once` itself (never `always`, so switching Auto off takes effect at once) | edits and commands inside the project, including `sources/private/` and `sources/researcher/` (the researcher's own materials the build needs); temp dirs; this project's own tool-output files; the managed runtime; `webfetch`, `curl https://… -o sources/open/…`; subagents |
| ask | shows the permission card in the conversation, with the reason | participant data in any spelling the text shows (`cd human-data && cat a.csv`, `cat h*/a.csv`, `HUMAN-DATA/`, `D=human-data; cat $D/a.csv`, `find -path "*human*"`, `cd sources && cat ../human-data/x`, `$(...)` inner commands); paths outside the project, including `~`, `$HOME`, `${HOME}`; key files; `printenv`, `env`/`env -0`, `set`, `export`/`declare -p`, `ps eww`/`ps -E`, `$…KEY`/`TOKEN`/`$OPENCODE_*`, `os.environ[...]`/`getenv`; `git push` in every spelling (`git -C . push`, `git -c k=v push`), `git config alias.*`/`remote.*`/`credential.*`/`core.sshCommand`/`core.hooksPath`, `git remote add`; `npm --registry x publish`, `gh release`/`api`; `ssh`/`scp`/`rsync host:`/`nc`/`socat`; uploads (`curl -T/-F @/-d @/--json @/-K`, `wget --post-file`); `sudo`; edits (also through a symlink) of `opencode.json`, `.opencode/**`, `.git/**`, `.ignore`; reads, lists, lsp, grep and glob into participant data (symlinks resolved); without an OS sandbox, everything outside the allowlist; OpenCode's `doom_loop` prompt after 3 automatic answers in one turn |
| deny | rejects with a message (OpenCode continues the turn and tells the model why) | the app's `account.json`, `credentials.json`, `settings.json`, `run-relays/`, the kernel's `auth.json` and `config/`, the agent-shell folder; `security find-*-password` (keychain) |

Compound commands take the most restrictive verdict of their parts. With an OS sandbox, a path the
text cannot resolve (`$X/y`, `$(pwd)/b`) and a bare `*` glob are left to the sandbox; without one
they ask. Settings → "Ask before changes" (`permission: 'ask'`) still sends every non-read-only
request to the researcher; deny verdicts apply in both modes.

## Subagents

Child sessions of the OpenCode `task` tool are routed to the conversation that started them
(`rootOf` in `opencode.ts`): their permission requests go through the same policy and, when they
ask, appear as the parent's permission card labelled with the subagent's name; their questions
appear as the parent's questions; their tool steps are emitted as `subagent` events, which the Study
view's build progress lists (name, state, latest step) and which count for the paper build's phase
and program check. The list is cleared when another conversation or project opens. A subagent
waiting on the researcher keeps the parent's build waiting and triggers the background notification
like the parent would. Subagents use the same shell, so the same OS sandbox.

## Not changed

The package-code sandbox (`pack/skills/build/sandbox_run.py`, `run_confined.py`) and the per-run
model relay are separate layers and unchanged: simulation and package code still runs confined,
without keys or network (on macOS).

## Known limits

What is protected, exactly:

- the folder names above, in any letter case;
- the listed key folders and app files;
- the agent's own configuration and git.

On macOS this holds at the OS level against OpenCode's own tools (the kernel profile) and against any
command the app approves by itself (the agent profile). On the other platforms it rests on the policy:
path checks after symlinks are resolved, and the allowlist.

What is not protected:

- Sensitive content under ordinary names. The network stays open, so an allowed command or `webfetch`
  can send out anything readable in the project. That includes `sources/private/`, which the owner rule
  lets the agent read.
- macOS helpers started by the agent run outside the sandbox. Their in-process guard is a Python
  audit hook, not a kernel rule: native code that a helper loads could open files without an `open`
  event. Only the app's shipped, hash-checked helpers get this path.
- A path named only by `$HUMANSTUDY_HUMAN_DATA` that is not under a participant-data folder name.
- Linux: the kernel is not confined, so OpenCode's own tools rest on the policy. Under bubblewrap the
  agent shell does not hide participant data in other projects or the home folder, and symbolic links
  are allowed.
- macOS: Spotlight daemons and other system services act on their own; a copied `osascript` binary
  failed its library check when tested, and an Apple event would still need the researcher's Automation
  consent.
- Without any OS sandbox (Windows, Linux without bubblewrap): everything outside the allowlist asks,
  but the protection for an allowed command still rests on reading its text.
- The researcher's terminal, their `!` commands, and any command the researcher approves. These run
  unconfined by design.
- The kernel process can still read its own data folder. That folder holds other projects' snapshot
  repositories and `opencode.db` with every project's conversations. It cannot be split per project
  without moving session storage. OpenCode's tools reach it only through the policy, which asks for a
  path outside the project.
