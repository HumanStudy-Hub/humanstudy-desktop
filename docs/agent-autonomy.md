# Agent autonomy: what the agent may do without asking

Owner decision, 2026-11-08: *nothing asks, except actions involving sensitive material*
("让所有东西都不问，除非涉及敏感资料的"). The researcher is not a laborer clicking "allow".
Because almost nothing asks, sensitive material has to be protected by more than the text of a
command: the agent's shell runs in an OS sandbox where the computer offers one, and the command
classifier is the second layer.

## Layer 1: the OS sandbox around the agent's shell

`app/src/main/kernel/agent-sandbox.ts`. OpenCode runs every bash command as `<shell> -c <command>`;
the inline config sets `shell` to a generated wrapper (`<userData>/kernel/agent-shell/<project>/zsh`,
named like the real shell so OpenCode's shell handling is unchanged). The wrapper:

1. removes `OPENCODE_SERVER_PASSWORD`, `OPENCODE_CONFIG_CONTENT` (it carries the local transport
   token), `HUMANSTUDY_SERVER_BYPASS`, `HUMANSTUDY_RELAY_DIR`, the kernel's `XDG_*` folders and every
   key-shaped variable (`KEY|TOKEN|SECRET|PASSW|CREDENTIAL|BYPASS|AUTH`) from the environment. The
   model key stays only on the pre-relay path (Linux, Windows), where simulations need it and the run
   confirmation says so;
2. runs a command the researcher approved in the conversation outside the sandbox, once: on an
   approval of a bash request the policy had sent to the researcher, the app writes a token for that
   exact command (sha256, valid 10 minutes, consumed atomically) into a folder the sandbox cannot write.
   Commands the policy would have allowed stay confined even when "Ask before changes" shows them;
3. runs the app's helpers that confine package code themselves outside the sandbox, because a macOS
   sandbox cannot be nested (`sandbox_apply: Operation not permitted`). This happens only on macOS, and
   only when all of these hold:
   - it is one plain command (`python .opencode/skills/...py args`: no quotes, `$`, `;`, `&`, `|`,
     redirection or globs), run from the project folder, with the managed runtime's python;
   - every shipped helper script in the project matches the hashes of the app's own copy
     (`trustedHelperHashes()` in pack.ts; refreshPack restores them);
   - it uses only the arguments in `HELPER_FLAGS` (agent-sandbox.ts): relative paths inside the project
     that do not name `.opencode`, `.git`, `.ignore`, `opencode.json` or participant data, and only the
     listed flags.

   `run_confined.py` qualifies only in two forms: with the relay (`HUMANSTUDY_RELAY_REQUIRED=1`; a relay
   run needs the researcher's Run approval), or as
   `--no-model .opencode/skills/export/agent/study_core.py --root . reproduce`. In every other case the
   helper runs confined, and `sandbox_run.py` refuses with a message telling the agent how to run it;
4. runs everything else confined.

### What each helper may do outside the sandbox (audit of `HELPERS`, 2026-11-08)

| Helper | Runs project code? | Prints project data? | Refused here |
|---|---|---|---|
| `simulate/run_confined.py` | the run script, through sandbox_run and the relay. It has no network except the relay and writes only in a scratch folder. It can read the project, including `human-data/`. | what the run script prints | anything but a relay run or `--no-model study_core.py --root . reproduce` |
| `export/agent/study_core.py` (through run_confined `--no-model`) | package analysis code, confined as above | `reproduce` prints the recomputed results. Agent-written package code could also print rows. | every subcommand but `reproduce` (`human-data`, `run --cli`, ...) |
| `build/check_readiness.py`, `check_package.py`, `check_validity.py`, `check_replies.py`, `recorded_answers.py`, `audit.py`, `effects.py`, `prompt_context.py`, `export/agent_package.py` | package code, only through sandbox_run (a copy of the package, no network, no home folder) | check results. `check_readiness`, `effects` and `audit` read `human-data/` for their checks. | the in-process child modes: `recorded_answers.py --child`, `check_validity.py --capture/--probe`, `audit.py --probe/--n/--workdir`, `check_replies.py --smoke-child`, `check_package.py`/`agent_package.py --smoke-test`. Any other flag not listed is refused too. |

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
- read or write the kernel's own folder (other projects' conversations, its config, the wrapper and
  approval tokens), except OpenCode's tool-output files;
- write anywhere outside the project and the temp folders;
- write the managed runtime (a planted `.pth` file would run in the helpers that start outside);
  `pip install --target` into the project still works;
- write the project's `.opencode/` or `opencode.json(c)`;
- write any `.git`. So there are no commits, and `.git` cannot be replaced by a `gitdir:` file;
- write any `.ignore`/`.rgignore`;
- create symbolic links at all, so `python -m venv` fails;
- hard-link a file it may not write;
- see other processes (`ps`), whose environment holds keys, or talk to the keychain service.

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
- no variables, substitutions or redirections (except to `/dev/null`).

Everything else asks, including every helper that runs package code.

Git: the kernel's environment (and the wrapper) sets `GIT_CONFIG_COUNT`, so every git the kernel starts
runs with `core.fsmonitor=false` and `core.hooksPath=/dev/null`. A project's `.git/config` therefore
cannot make OpenCode's own `git status` run code. The researcher's own terminal (the Terminal view) runs
their login shell, not the wrapper, and their own git is not covered.

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

`HUMANSTUDY_AGENT_SANDBOX_OFF=1` switches the sandbox off for development; the classifier then uses the
allowlist.

## Layer 2: the command classifier

OpenCode sends the app a `permission.asked` for every request (inline config `PERMISSION_CONFIG` in
`app/src/main/kernel/opencode.ts`: every request of every tool). The app answers each one with
`classifyPermission` in `app/src/main/kernel/permission-policy.ts`:

| Verdict | What the app does | Examples |
|---|---|---|
| allow | answers `once` itself (never `always`, so switching Auto off takes effect at once) | edits and commands inside the project, including `sources/private/` and `sources/researcher/` (the researcher's own materials the build needs); temp dirs; OpenCode's tool-output files; the managed runtime; `webfetch`, `curl https://… -o sources/open/…`; subagents |
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

On macOS this holds against any command the app approves by itself. On every platform it holds
against OpenCode's own tools, through path checks after symlinks are resolved.

What is not protected:

- Sensitive content under ordinary names. The network stays open, so an allowed command or `webfetch`
  can send out anything readable in the project. That includes `sources/private/`, which the owner rule
  lets the agent read.
- What the helpers that start outside the sandbox read. They read participant data on the app's behalf,
  and the agent-written package code they run (confined, no network) can print what it reads; that
  output reaches the agent.
- A path named only by `$HUMANSTUDY_HUMAN_DATA` that is not under a participant-data folder name.
- On Linux with bubblewrap: participant data in other projects, and symbolic links.
- Without any OS sandbox (Windows, Linux without bubblewrap): everything outside the allowlist asks,
  but the protection for an allowed command still rests on reading its text.
- The researcher's terminal, and any command the researcher approves. These run unconfined by design.
