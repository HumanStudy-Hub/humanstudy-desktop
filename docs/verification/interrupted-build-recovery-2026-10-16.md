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
