# Review 7: agent autonomy (branch claude/agent-autonomy, up to 8c72cbc)

This is an independent adversarial review, and the final check. No tracked files were changed.

The tests ran for real on macOS:
- the kernel binary hs-v1.19.0, under the generated kernel profile, with a mock model that makes real tool calls;
- the real shell broker and agent profile;
- real `sandbox-exec` runs against the generated profiles (bundled from HEAD).

The test fixtures (`~/.hs-r7-*`, `~/.hs-r7e-*`, `/Users/Shared/hs-r7`) have been removed.

**Verdict: not yet. One must-fix remains (item 1), and it is narrow.** Both round-6 must-fixes are closed.

## Round-6 must-fixes: closed

- **Undo/Redo works.**
  - `native-live.test.mjs` with `HUMANSTUDY_KERNEL_BIN=…/hs-v1.19.0/opencode` passes (1/1).
  - In my own end-to-end run (project with an empty `.git`), the agent's `write` turned `draft.txt` from
    ORIGINAL into CHANGED. Undo brought back ORIGINAL, and Redo brought back CHANGED.
- **The empty-`.git` ambiguity is closed (real kernel).**
  - Setup: project A was `git init`ed with no commit. `tool_fakeB` was planted in `<kernel>/data/opencode/tool-output`.
  - Result: `read` of that file gives `ASKED: another project's conversations, snapshots or tool output`
    (round 6: `once auto`). Rejected, it returns nothing.

## Must-fix

1. **The agent shell reads other projects without asking when they are outside the home folder.**
   - **Where.** The agent profile (`macosAgentProfile`, `agent-sandbox.ts:139`) denies reads only of the
     home folder (except the project). It gets no projects root or project list (`agent-sandbox.ts:387`).
     The kernel profile denies only `HUMANSTUDY_PROJECTS_ROOT`.
   - **Trigger.** The projects folder can be anywhere: Settings → General accepts any folder, such as an
     external drive or `/Users/Shared`. A project can also be opened from anywhere with Open.
   - **Real run.** The real kernel and broker; project A in a root under home; project B at `/Users/Shared/hs-r7/B`.
     - The bash call `python3 -c "print(open('/Users/'+'Shared/hs-r7/B/sources/private/s.txt').read())"`
       gave `PERM bash once auto`. **PRIVATE-SOURCE was returned.**
     - The same holds for `protocol/`.
     - `human-data/` is still covered: the policy asks, and the profile's regex blocks it.
   - **Seatbelt runs with A's root set to `/Users/Shared/hs-r7`.**
     - The agent profile READ every other project's `sources/private` there.
     - The kernel profile denied them.
   - **Projects under the home folder are safe.** The agent shell gets `Operation not permitted`.
   - **Proposed rule.**
     - Keep a persisted list of known projects in main: the projects root, every created project, and every
       folder picked with Open. Today `allowedRoots` lives only in memory, and recent projects only in the
       renderer.
     - Pass that list to **both** profiles. Emit `(deny file-read-data (subpath <root>) (subpath <each known
       project>))`, followed by `(allow file-read-data (subpath <this project>))`. Use real paths.
     - Seatbelt matching is case-insensitive here. A root spelled `HS-R7-ROOT` still denied `hs-r7-root`,
       so the deny matches every spelling on a case-insensitive disk.
     - Skip any entry that equals home or `/`, or that contains this project.
     - In the policy, classify those paths as a new `other-project` class. Make it deny, or ask with that
       reason, rather than "outside the project folder".
     - Add a test with a root outside home and a second project there.

## Item 2 (projects-root deny list): other answers

- **Default root and chosen root.** Other projects in `~/HumanStudy Hub` (one real project was checked:
  exit status only) and in a test root are denied to the kernel's tools by the kernel profile. This holds
  for `sources/private`, `protocol` and `human-data`. The agent shell is denied there too, because these
  folders are under home.
- **Dropping `~/HumanStudy` is fine.** On a case-insensitive disk that path names `~/humanstudy` (the
  workspace), and settings already discards the retired roots.
- **Projects opened with Open, outside the root but under home:**
  - the kernel's `read` asks with the reason "outside the project folder";
  - the agent shell is denied, including when the path is hidden in code (`EPERM`);
  - so this case is within the threat model, but it would be better under the item 1 rule.

## Rounds 1–6 re-checked

- Covered by suites that pass:
  - permission-policy (16), which includes the empty-`.git` case;
  - kernel-sandbox (real binary, 1);
  - agent-sandbox (4), subagent (11), connection (19);
  - native-api, auto, dedup, recovery, question, completion, request-transport.
- Re-checked by hand on HEAD's kernel profile:
  - B's `client.pl` cannot be read, and B's `profile.sb` cannot be written. Both give
    `Operation not permitted`.
  - A's own `profile.sb` cannot be written. A's own folder is readable.
  - Another project's `human-data` is denied in every case.

## Regressions and tests

- `npm run typecheck`: passes.
- All kernel `*.test.mjs` pass, including native-live with the real binary.
- `src/main/*.test.mjs`: all pass except `runtime.test.mjs` #14 (12 of 13 pass). This is the same
  environment failure as in rounds 4–6: the runtime python has no pytest.
- pack: `test_project_paths`, `test_audit`, `test_agent_package` and `test_check_readiness` give 56 passed
  and 13 skipped. These cover build, simulate and export.
- pack: `test_sandbox_run` and `test_relay_sandbox` give 19 passed.
- Terminal: native-live's ticketed PTY passes, and kernel-sandbox's resize test passes.

## Threat model

- Once item 1 is fixed, the remaining risks are within the stated model:
  - every cross-project path through the kernel's tools asks, or is denied by the OS;
  - participant data is denied by the OS everywhere.
- Item 1 is outside it today. A prompt-injected agent can read another project's private sources and
  protocols with no ask, whenever projects live outside the home folder.
