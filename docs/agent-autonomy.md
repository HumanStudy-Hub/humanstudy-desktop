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
3. runs the app's helpers that confine package code themselves (`run_confined.py`,
   `check_readiness.py`, `check_package.py`, `check_replies.py`, `check_validity.py`, `audit.py`,
   `effects.py`, `recorded_answers.py`, `prompt_context.py`, `agent_package.py`) outside the sandbox,
   because a macOS sandbox cannot be nested (`sandbox_apply: Operation not permitted`). Only as one
   plain command (`python .opencode/skills/...py args`: no quotes, `$`, `;`, `&`, `|`, redirection or
   globs), from the project folder, with the managed runtime's python, and only while every shipped
   helper script in the project matches the hashes of the app's own copy (`trustedHelperHashes()` in
   pack.ts; refreshPack restores them). Otherwise the helper runs confined and `sandbox_run.py` refuses
   with a message telling the agent how to run it;
4. runs everything else confined.

| Platform | What a command the app approved by itself cannot do |
|---|---|
| macOS (`sandbox-exec`) | read file contents in, list, or write a folder named `human-data`, `quarantine(d)`, `withheld`, `participant-data`/`_data`, in any letter case, anywhere (other projects, `~/.humanstudy/human-data` too); read or write `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/Library/Keychains`, `~/.config/gh`, `~/.claude`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials` and similar, the app's `account.json`/`credentials.json`/`settings.json`/`run-relays`, the relay folder, the kernel's own folder (other projects' conversations, its config, the wrapper and approval tokens) except OpenCode's tool-output files; write anywhere outside the project and the temp folders, or in the project's `.opencode/`, `opencode.json(c)`, `.git/hooks`, `.git/config` (these run code later, outside the sandbox); see other processes (`ps`, their environment holds keys) or talk to the keychain service. The network stays open: public source search needs it. A folder's existence (`stat`) stays visible. |
| Linux with bubblewrap | the same file rules where bubblewrap can express them: read-only root, writable project and temp folders, `.opencode/`/`opencode.json`/`.git/hooks`/`.git/config` read-only, participant-data folders **inside the project** (found per command, any case) and the key folders and app files hidden behind empty mounts, own process namespace. Participant data outside the project (other projects) is not hidden. Not tested on a Linux machine in this round; the generated script is checked for syntax only. |
| Linux without bubblewrap, Windows | no sandbox. The classifier (`osSandbox: false`) also asks before any command that runs code from a file or inline (`python x.py`, `python -c`, heredocs, `bash x.sh`, `./x`, `node`, `pip install`, `npm run`, ...), except the app's helpers under `.opencode/skills/` and `.opencode/artifact-kit/`, before shell writes into the agent's configuration, and before paths built from shell variables or bare `*` globs. Reads of participant data ask as on macOS. This protection depends on reading the command text and is weaker: a helper or command that is allowed can still be steered by its arguments. |

Not covered by the OS sandbox: OpenCode's own tools (read, edit, write, grep, glob, webfetch) run
in the kernel process, not in the shell, so for them the classifier is the only layer (reads of
participant-data folders ask; `grep`/`glob` tool searches without a path do not). A path named by
`$HUMANSTUDY_HUMAN_DATA` outside a participant-data folder name is not recognised. On macOS the
managed runtime is read-only for the agent's shell (otherwise a planted `.pth` file would run in
the helpers that start outside the sandbox); `pip install --target` into the project still works.
`HUMANSTUDY_AGENT_SANDBOX_OFF=1` switches the sandbox off for development (the classifier then
runs in its no-sandbox mode). The researcher's own terminal (the Terminal view) runs their login
shell, not the wrapper.

## Layer 2: the command classifier

OpenCode sends the app a `permission.asked` for every edit, every shell command, every path outside
the project and every read of a participant-data folder (inline config `PERMISSION_CONFIG` in
`app/src/main/kernel/opencode.ts`; the read rules list each name in its usual spellings and as
`?`-wildcards, because OpenCode's wildcard match is case-sensitive). The app answers each one with
`classifyPermission` in `app/src/main/kernel/permission-policy.ts`:

| Verdict | What the app does | Examples |
|---|---|---|
| allow | answers `once` itself (never `always`, so switching Auto off takes effect at once) | edits and commands inside the project, including `sources/private/` and `sources/researcher/` (the researcher's own materials the build needs); temp dirs; OpenCode's tool-output files; the managed runtime; `webfetch`, `curl https://… -o sources/open/…`; subagents |
| ask | shows the permission card in the conversation, with the reason | participant data in any spelling the text shows (`cd human-data && cat a.csv`, `cat h*/a.csv`, `HUMAN-DATA/`, `D=human-data; cat $D/a.csv`, `find -path "*human*"`, `cd sources && cat ../human-data/x`, `$(...)` inner commands); paths outside the project, including `~`, `$HOME`, `${HOME}`; key files; `printenv`, `env`/`env -0`, `set`, `export`/`declare -p`, `ps eww`/`ps -E`, `$…KEY`/`TOKEN`/`$OPENCODE_*`, `os.environ[...]`/`getenv`; `git push` in every spelling (`git -C . push`, `git -c k=v push`), `git config alias.*`/`remote.*`/`credential.*`/`core.sshCommand`/`core.hooksPath`, `git remote add`; `npm --registry x publish`, `gh release`/`api`; `ssh`/`scp`/`rsync host:`/`nc`/`socat`; uploads (`curl -T/-F @/-d @/--json @/-K`, `wget --post-file`); `sudo`; edits of `opencode.json`, `.opencode/**`, `.git/hooks`, `.git/config`; OpenCode's `doom_loop` prompt after 3 automatic answers in one turn |
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

- The classifier reads command text; on platforms without an OS sandbox, it is the only protection
  for shell commands, and it holds against a cooperative model, not a determined prompt-injected
  one (an allowed helper can still be steered by its arguments, and OpenCode's own tools are not
  sandboxed anywhere).
- On macOS the OS sandbox protects the folder names above, key folders and the app's files. It does
  not know other sensitive content stored under ordinary names, and the network stays open, so
  anything readable in the project can be sent out by an allowed command.
- The confining helpers start outside the sandbox and can read participant data on the app's
  behalf; what they print is what the agent sees.
- `grep`/`glob` tool searches without a path are allowed; a content search inside a participant-data
  folder through those tools is not asked.
