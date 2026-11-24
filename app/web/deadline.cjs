// The cloud workspace's provider deadline (HS_DEADLINE_AT, set by the Hub launcher). The server ends the
// visit itself shortly before the provider stops the sandbox, so `session.end` records a timeout without
// any external scheduler. The lead covers the bounded quit (6 s flush inside the 8 s watchdog) plus
// clock and provider slack.
'use strict'

const LEAD_MS = 25_000
// A deadline further away than this is not a provider session limit (the launcher caps sessions at a day).
const MAX_AHEAD_MS = 2 * 86_400_000

/** The deadline as epoch ms, or undefined when it is missing, invalid, already past or implausibly far. */
function parseDeadline(value, now = Date.now()) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined
  const at = Date.parse(value)
  return Number.isFinite(at) && at > now && at - now <= MAX_AHEAD_MS ? at : undefined
}

/** Calls onDue once, `lead` ms before the deadline (at once when that moment has passed). Returns a cancel. */
function armDeadline(deadlineAt, onDue, { now = Date.now(), lead = LEAD_MS, timers = globalThis } = {}) {
  if (!Number.isFinite(deadlineAt)) return () => {}
  const timer = timers.setTimeout(onDue, Math.max(0, deadlineAt - lead - now))
  timer?.unref?.()
  return () => timers.clearTimeout(timer)
}

module.exports = { LEAD_MS, parseDeadline, armDeadline }
