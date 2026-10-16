# 0.6.3 reversible quit / installer failures

0.6.2 could retain an open window with an unusable session after a second-save failure; an
installer failure could also leave its closing flag set and update scheduling stopped.

Preparation now stops active turns using abort, preserving kernel/session bindings. It saves
before and after stopping. Failed saves unblock the same conversation. Kernel process exit
hooks remain armed until the actual application exit; preparation no longer disposes them.

Update launch is serialized through a coordinator that rolls back prepared shutdown on thrown
errors, asynchronous updater errors, and no exit within 15 seconds. Errors during a pending
save wait for the barrier to complete before unblocking new turns. Update checks/retries are
stopped only at will-quit. Queued prompts do not auto-dispatch in response to shutdown completion.

Validation:
- All src/**/*.test.mjs regression scripts, both TypeScript projects and production build pass.
- Unit tests cover second-save failure, reset/retry, sync/async installer failure, no-exit timeout,
  concurrent install requests, and an error arriving while the save barrier is still pending.
- app/scripts/verify-shutdown-recovery.cjs runs the actual built Electron main/preload handlers
  with temporary data, a mock agent and injected updater failures. It blocks the filesystem
  specifically between the two saves, restores it, then successfully sends to the SAME session ID.
  It repeats this after thrown installer errors, asynchronous errors, and a silent installer
  timeout. The final in-memory conversation must exactly match persisted JSON on exit.
- app/scripts/verify-shutdown.cjs still verifies busy-quit cancellation, first-save failure,
  successful retry and complete long-conversation persistence.
- app/scripts/verify-kernel-exit.mjs exercises a real Electron exit with the actual OpencodeKernel
  exit hook and an owned dummy helper process, confirming the helper no longer exists afterwards.
  It makes no model/server calls and cleans up its own dummy helper on failed-test paths.

Raw logs: /private/tmp/hs-063-{regression,recovery,quit,kernel-exit,build}.log.
No owner-installed application, real account or real project is used by these fixtures.
Windows/Intel hardware and a native Restart-button relaunch remain separate acceptance items.
