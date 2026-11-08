# Agent autonomy: what the agent may do without asking

Owner decision, 2026-11-08: *nothing asks, except actions involving sensitive material*
("让所有东西都不问，除非涉及敏感资料的"). The researcher is not a laborer clicking "allow".

## Where it is decided

OpenCode sends the app a `permission.asked` for every edit, every shell command, every path outside
the project and every read of a sensitive folder (inline config `PERMISSION_CONFIG` in
`app/src/main/kernel/opencode.ts`). The app answers each one with
`classifyPermission` in `app/src/main/kernel/permission-policy.ts`:

| Verdict | What the app does | Examples |
|---|---|---|
| allow | answers `once` itself (never `always`, so switching Auto off takes effect at once) | edits and commands inside the project; temp dirs; OpenCode's tool-output files; the managed runtime; `webfetch`, `curl https://… -o sources/open/…`; subagents |
| ask | shows the permission card in the conversation, with the reason | `human-data/`, `sources/private/`, `sources/researcher/`, `quarantine`/`withheld`/`participant-data` folders; paths outside the project; `.env`, `~/.ssh`, `~/.aws` and other key files; `printenv`/`env`, `$…KEY`/`TOKEN`, `os.environ[...]`; `git push`, `gh release`, `npm publish`, `ssh`/`scp`, uploads (`curl -F/-T/-d @file`), `sudo`, `rm -rf /` or `~` |
| deny | rejects with a message (OpenCode continues the turn and tells the model why) | the app's `account.json`, `credentials.json`, `settings.json`, `run-relays/`, the kernel's `auth.json`; `security find-*-password` (keychain) |

Compound commands take the most restrictive verdict of their parts. Matching is done in TypeScript
rather than in OpenCode's last-match-wins wildcard rules, because a command line needs quote-aware
parsing (paths after `=`, `~`, `..`, inline `python -c` code) that a glob list cannot express.

Settings → "Ask before changes" (`permission: 'ask'`) still sends every non-read-only request to the
researcher; deny verdicts apply in both modes.

## Subagents

Child sessions of the OpenCode `task` tool used to be dropped. They are now routed to the
conversation that started them (`rootOf` in `opencode.ts`): their permission requests go through the
same policy and, when they ask, appear as the parent's permission card labelled with the subagent's
name; their questions appear as the parent's questions; their tool steps are emitted as `subagent`
events, which the Study view's build progress lists (name, state, latest step) and which count for
the paper build's phase and program check. A subagent waiting on the researcher keeps the parent's
build waiting and triggers the background notification like the parent would.

## Not changed

The package-code sandbox (`pack/skills/build/sandbox_run.py`, `run_confined.py`) and the per-run
model relay are separate layers and unchanged: simulation and package code still runs confined,
without keys or network.

## Known limits

- The command classifier is a heuristic over the command text. It does not see what a script file
  does when run (`python3 x.py` is allowed inside the project); the sandbox, the relay's key
  stripping and OpenCode's own `external_directory` check are the other layers.
- `grep`/`glob` tool searches are allowed; a content search inside a sensitive folder is not asked.
- OpenCode's `doom_loop` prompt (same call three times) is answered automatically.
