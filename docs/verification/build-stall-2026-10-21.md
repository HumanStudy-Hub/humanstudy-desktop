# Long build / stalled progress investigation

User report: Simulation tab shows “Building the runnable study” for 109 minutes;
chat repeatedly says no program/package was written. Screenshot alone does not
establish continuous model execution, the friends' installed version, or the cause
of their failed extraction.

## Reproduced and fixed

1. Pending build/run state was stored per project without a conversation/turn identity.
   Quick completion could leave a build flag behind because its cleanup waited for
   five seconds while the timer stopped at idle. Later unrelated chat could revive it.
   A real React/Electron test seeded the 109-minute pending state and failed against
   the old implementation. Requests now bind to the actual thread and user turn;
   completion, Stop, changed conversation, failed dispatch and missing run output
   cannot revive the old timer. Active requests survive tab remounts. Missing output
   is explained instead of being displayed as ongoing generation.
2. State recovery previously depended on an event connection disconnecting. A healthy
   but silent connection could leave the UI waiting after a missed completion.
   A quiet active turn is now checked through read-only native snapshots, at most once
   per minute after one minute without visible progress. Completed messages, actual
   tool results, permissions and questions are reconciled without replaying a task.
3. A request accepted over HTTP but repeatedly reported idle by native could remain
   busy without any completed assistant response. Two quiet native-idle observations
   separated by at least 30 seconds now end this state with an explicit error while
   preserving messages/files. With normal polling this is about two minutes, not an
   unconditional two-minute deadline on running work.
4. A late native busy notification after Stop could revive the renderer's busy state
   even though the kernel no longer considered the turn active. Ignore these inactive
   status events. New native commands reset their activity timestamps.

## Long legitimate jobs and permissions

A native job still reported busy is NOT automatically killed, retried or declared
successful. After five minutes without visible progress it shows a clear warning and
the existing Stop control remains available. New visible progress clears the warning.
Unanswered questions/permissions are excluded from the inactivity checks. The observer
does not answer questions, grant permissions, replay uploads, or rerun simulations.
Quiet probes avoid replacing unfinished text parts so subsequent live deltas remain
visible and complete. This behavior has a specific regression test.

No new buttons, model defaults, simulation approvals, schema rules or source truncation
were introduced. No owner/friend project or installed app was modified or restarted.

## Verification

- 69 desktop/shared/renderer regression checks passed, with Node's
  `--experimental-default-type=module` for existing generated ESM fixture files.
  The first broader invocation used Node 20 without that flag and incorrectly
  included the native-only entry without its binary environment variable; those
  were harness invocation failures, followed by the correctly configured passing runs.
- 26 kernel checks passed with the installed HumanStudy OpenCode 1.19.0 binary,
  isolated project/home directories and localhost model/MCP fixtures.
- The native recovery test was strengthened after that run: a malformed JSON tool call
  must be automatically repaired, actually write the entire 50,792-byte sample
  `program.json` byte-for-byte, and pass the shipped `check_program.py` against the
  bundled schema. That strengthened test passed separately.
- Real React/Electron accelerated-clock tests cover the 109-minute legacy state,
  quick completion, unrelated chat, tab remount, changed thread, Stop, dispatch that
  never starts, successful package appearance, and absent simulation output.
- Both TypeScript configurations and the production build passed.
- No hosted model quota was consumed. These tests establish native protocol/state
  behavior, not real-model scientific extraction quality or a 109-minute wall-clock soak.

Evidence logs (temporary, not committed):

- `/private/tmp/humanstudy-build-stall-regression-final.log`
- `/private/tmp/humanstudy-build-stall-kernel-accepted.log`
- `/private/tmp/humanstudy-build-stall-program-acceptance.log`
- `/private/tmp/humanstudy-build-stall-production-final.log`

## Remaining diagnosis / follow-up

- Need the friend's app version and expanded tool/error details to identify why their
  particular extraction did not save `program.json`. No claim that their hosted
  provider or paper-specific failure was reproduced.
- A real model may still stop after promising to act, without a protocol error. This
  patch makes missing output visible; it does not automatically resend arbitrary
  free-form research requests until they produce files. A validated build completion
  contract remains distinct from the agent saying it has finished.
- Existing recovery instructions mention `program_io.py` only “when available”; it is
  not shipped in the build skill. A checkpoint helper could make smaller writes more
  reliable, but was not invented or silently installed during these tests.
- Existing program schema/documentation retain a 500 KB serialized-size limit. This
  can conflict with preserving extensive source material; any follow-up should support
  referenced resources or revise the storage/render contract, never silently truncate.
- No new installer/release was published by this test task. PR contains the tested fixes.
