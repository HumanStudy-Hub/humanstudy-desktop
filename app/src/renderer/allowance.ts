import type { Allowance } from '../preload/types'

/** What to say about the hosted allowance, as an i18n key and vars; null hides the line.
 * Settings always shows it; chat only when it has ended or is low (<= 20%). */
export function allowanceMessage(a: Allowance | null, where: 'settings' | 'chat'): { key: string; vars?: Record<string, number> } | null {
  if (!a?.available) return null
  if (a.revoked || a.expired) return { key: 'allowance.ended' }
  if (where === 'settings') return { key: 'settings.allowance', vars: { n: a.percentLeft } }
  return a.percentLeft <= 20 ? { key: 'chat.allowance_low', vars: { n: a.percentLeft } } : null
}
