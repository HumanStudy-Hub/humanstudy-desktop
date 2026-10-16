# 0.6.2 safe quit and update recovery

Changes:
- Normal quit and update restart share a serialized save barrier. New agent turns are blocked
  while closing. Active turns require an explicit Stop and quit/restart choice (Keep working
  is the default); cancelling a Windows last-window quit reopens a window.
- Pending conversation writes are awaited before disposal and again afterwards. Disk failures
  remain visible, prevent exit, and can be retried without shortening the conversation.
- Update checks observe the separate automatic-download promise. Transient connection failures
  retry after 15, 45 and 120 seconds, then leave a manual retry available. Concurrent checks,
  duplicate retries and re-downloading an already-ready version are prevented.
- Missing update files and HTTP failures are errors, never “already current”. Integrity failures
  do not trigger automatic retries. Mac restart waits for native verification/staging before
  stopping the agent; a native preparation error or timeout leaves the conversation running.

Validation:
- All existing src/**/*.test.mjs scripts passed, including kernel, persistence, telemetry and
  source/PDF/streaming regressions; node and renderer TypeScript checks and production build pass.
- Added recovery/shutdown tests cover rejected download promises, bounded retry exhaustion,
  manual recovery, checksum/metadata failures, concurrent checks, delayed saves, cancellation,
  save failure/retry and native staging success/error/timeout cleanup.
- Real filesystem regression: a blocked .humanstudy directory makes flush reject; restoring
  access and retrying preserves the full 170KB final reply including its final sentence.
- Actual built Electron main/preload handlers, hidden window, mock kernel, temporary userData
  and projects, no external network: quit during a turn asks and can be cancelled; a real
  filesystem obstruction blocks quit with an error; after restoring the folder the app exits
  only after the complete in-memory conversation matches the on-disk JSON. Final build result:
  /private/tmp/hs-062-native-quit.log, repeatable fixture app/scripts/verify-shutdown.cjs.

No owner-installed application or project was replaced in these tests. Intel and Windows real
hardware acceptance remains open. The original multi-day CPU incident remains historically
unproven; this patch addresses shutdown/update reliability, not a new CPU-root-cause claim.
