/** "12.4k", "830", "1.2M" */
export function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 1 : 1).replace(/\.0$/, '')}k`
  return String(Math.round(n))
}

export function money(n: number): string {
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
}

import { getLang, t } from './i18n'

/** "just now", "5 min ago", "yesterday", "3 Mar" (in the app language) */
export function relativeTime(iso: string | number, now = Date.now()): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 45) return t('time.now')
  if (s < 3600) return t('time.min', { n: Math.round(s / 60) })
  if (s < 86400) return t('time.hour', { n: Math.round(s / 3600) })
  if (s < 2 * 86400) return t('time.yesterday')
  if (s < 7 * 86400) return t('time.days', { n: Math.floor(s / 86400) })
  return new Date(ms).toLocaleDateString(getLang(), { day: 'numeric', month: 'short' })
}

/** "45 s", "3 min 12 s" (dur.* keys) */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return t('dur.sec', { sec: s })
  const min = Math.floor(s / 60)
  return s % 60 ? t('dur.min_sec', { min, sec: s % 60 }) : t('dur.min', { min })
}
