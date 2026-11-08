// When to tell the user about the agent: only while no window of the app is focused, when a turn finished
// or when the agent stopped to ask (a question or a permission). A build can wait on a question for as
// long as nobody looks, so "you will be notified" has to cover that too.
export interface NotifyInput {
  enabled: boolean
  anyWindowFocused: boolean
  eventType: string
  /** For question and permission events: already answered (a replay or an update), so nothing to ask. */
  resolved?: boolean
}
export type NotifyKind = 'done' | 'waiting'
export function notifyKind(i: NotifyInput): NotifyKind | null {
  if (!i.enabled || i.anyWindowFocused) return null
  if (i.eventType === 'done') return 'done'
  if ((i.eventType === 'question' || i.eventType === 'permission') && !i.resolved) return 'waiting'
  return null
}
export const shouldNotify = (i: NotifyInput): boolean => notifyKind(i) !== null
export const notifyTitle = (projectName: string, kind: NotifyKind = 'done'): string =>
  kind === 'waiting' ? `Agent needs your answer · ${projectName}` : `Agent finished · ${projectName}`
