# Interrupted build recovery · 2026-10-16

The observed paper build failed first on a binary PDF request, then on two model generation
limits (one spent 31,132 tokens reasoning and emitted only 868 output tokens; another emitted
an incomplete write call). This patch addresses the generation/tool-call failures. The separate
PDF transport and first-build orchestration work is not part of this patch.

## Behavior

- On an active model output limit, wait for native idle and submit a checkpoint-aware adjusted
  prompt in the same session, with lower reasoning effort on the hosted provider.
- Also recognize OpenCode's synthetic `invalid` tool. A native follow-up that merely promises
  to write does not clear the failure; a successful real tool does. If native stops without a
  repair, submit the adjusted recovery prompt.
- Preserve source detail and quotations; split writes rather than shortening the study. Check
  files first because malformed calls may not have executed. Do not rerun completed simulations,
  uploads or submissions. This instruction is not a transactional guarantee for external tools.
- At most two automatic adjustments per user request; an adjustment without visible text or a
  successful real tool action does not qualify for another adjustment. Invalid tools and token
  usage alone do not count as progress. Report failure with saved work preserved when exhausted.
- User Stop, a newer request, rejected permissions, and rejected questions cancel recovery.
  Unanswered questions and permissions pause it. Authentication and arbitrary API errors remain
  explicit failures, rather than triggering blind retries.
- Usage and completion metadata are deduplicated separately so late finish metadata is not lost.

## Verification

`app/src/main/kernel/recovery.test.mjs` covers length limits, malformed tools, native repairs,
native promise-only stops, duplicate idle, late finish metadata, native continuation before
recovery dispatch, bounded/no-progress attempts, failed dispatch, cancellation, researcher
questions, permissions and unrelated API errors.

Run with `HUMANSTUDY_KERNEL_BIN` set to the installed v1.19.0 executable to test against the real
OpenCode server and a localhost OpenAI-compatible fixture (no account or hosted model quota).
Both live scenarios passed: reasoning-only length -> adjusted low-effort request -> output;
malformed JSON -> native promise-only stop -> automatic recovery -> real write tool -> complete
UTF-8 checkpoint saved. The latter performs four model-fixture calls with one app adjustment.

Kernel, questions, permission auto-mode, completion, and nine dropped-connection regression
cases pass, as do node and renderer TypeScript checks. A live-model build is not part of this
deterministic verification. A normal `stop` without a preceding length/invalid-tool failure is
not treated as proof that an arbitrary research task is unfinished.

## Published acceptance

v0.6.4 published as latest at 2026-10-17T06:57:45Z (October 16, Vancouver):
https://github.com/HumanStudy-Hub/humanstudy-desktop/releases/tag/v0.6.4
PR #6 merged; source tag 0a4994d50f7caa27e6ce42983e3a2644866304d2. Release workflow
39011466577 succeeded. Both Mac applications pass Gatekeeper as Notarized Developer ID;
packaged main/preload/renderer bytes equal the clean tested source build. All four installer
SHA-512 values, nine GitHub Mac asset SHA-256 digests/sizes and five Windows preview/update
asset presences were verified. The public latest-mac.yml byte-matches the local verified file.
Installers/manifests are in app/dist/v0.6.4/ (ignored build outputs).

An isolated signed arm64 0.6.3 app discovered and downloaded the public 0.6.4 update, received
native Squirrel.Mac update-downloaded, installed on normal quit, then reopened and reported
0.6.4 via actual preload IPC with update state=none. Gatekeeper accepted the upgraded app.
All 35 pre-existing project/source/chat/settings files retained identical SHA-256 hashes,
including after reopening. The owner-installed application remains 0.6.3 and was not replaced.
Evidence: /private/tmp/hs-update-e2e-061/{upgrade-064.log,after-064.log,
preservation-before-064.json,preservation-after-064.json,public-latest-mac-064.yml}.

The first checks immediately after publication returned 0.6.3; a later normal check discovered
0.6.4 after the public endpoint propagated. No update feed, signature or integrity bypass was
used. Native Restart-button automatic relaunch, real Windows/Intel hardware installation, and
a hosted-model paper build remain separate acceptance items.
