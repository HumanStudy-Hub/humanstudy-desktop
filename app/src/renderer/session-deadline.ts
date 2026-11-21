// The cloud workspace's provider deadline, as the page sees it. The server sends the time remaining when
// the page loads (web-config.js), so the countdown runs on this page's clock without comparing clocks.
export const WARN_MS = 10 * 60_000
export const FINAL_MS = 2 * 60_000

/** When this page's session ends, in this page's Date.now() terms, or null outside a deadlined workspace. */
export function sessionDeadline(deadlineIn: unknown, now = Date.now()): number | null {
  return typeof deadlineIn === 'number' && Number.isFinite(deadlineIn) && deadlineIn >= 0 ? now + deadlineIn : null
}

/** Nothing until 10 minutes are left; then the whole minutes left; in the last 2 minutes, the final notice. */
export function deadlineNotice(msLeft: number): { minutes: number; final: boolean } | null {
  if (!Number.isFinite(msLeft) || msLeft > WARN_MS) return null
  return { minutes: Math.max(1, Math.ceil(msLeft / 60_000)), final: msLeft <= FINAL_MS }
}
