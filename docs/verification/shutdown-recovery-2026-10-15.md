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

## Published acceptance

v0.6.3 published as latest at 2026-10-16T06:26:54Z (2026-10-15 Vancouver):
https://github.com/HumanStudy-Hub/humanstudy-desktop/releases/tag/v0.6.3
PR #5 merged; tag source 634a29e. Release CI run 38860754409 succeeded. Both Mac apps are
notarized and Gatekeeper accepted; packed main AND renderer bytes match the tested build.
All installer SHA-512 values and nine uploaded Mac/update asset SHA-256 digests/sizes verified.
Local installers/manifest: app/dist/v0.6.3/.

Actual arm64 0.6.2→0.6.3 public-channel download, native staging, quit-to-install and reopening
passed. All 34 existing isolated project/source/chat files retained identical SHA-256 hashes.
The reopened app returned version 0.6.3, identical messages/settings and update state=none;
its Gatekeeper assessment passed and it quit normally using the new preparation logic.
No owner-installed app or real project was replaced. Evidence:
/private/tmp/hs-update-e2e-061/{release-063-verification.json,preservation-before-063.json,
preservation-after-063.json,upgrade-063.log,after-063.log}.

Failure injection uses the real built main/preload code with a mock agent/updater; actual
public-channel upgrade uses the signed packaged app. These are distinct tests, not claims of
reproducing a real OS installer failure. Native Restart-button relaunch and Windows/Intel
hardware remain untested; real hosted-model research and long-duration CPU acceptance remain open.
