// Size limits for what the agent transcript carries. Pure, so the kernel, threads and the research
// data tests share one implementation.

/** Single values (strings) above this many characters are cut and marked. */
export const VALUE_MAX = 20_000

export function truncateString(s: string, max = VALUE_MAX): string {
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} of ${s.length} characters]` : s
}

/** Walks JSON-like data and truncates every string above `max`. Depth and breadth are bounded. */
export function truncateValue(v: unknown, max = VALUE_MAX, depth = 0): unknown {
  if (typeof v === 'string') return truncateString(v, max)
  if (v === null || typeof v !== 'object') return v
  if (depth >= 8) return '[nested too deep]'
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => truncateValue(x, max, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 200)) out[k] = truncateValue(val, max, depth + 1)
  return out
}
