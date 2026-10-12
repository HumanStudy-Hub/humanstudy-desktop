/** "12.4k", "830", "1.2M" */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 1 : 1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}

export function money(n: number): string {
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
}

/** "just now", "5 min ago", "yesterday", "3 Mar" */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, (now - t) / 1000)
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  if (s < 2 * 86400) return 'yesterday'
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} days ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
