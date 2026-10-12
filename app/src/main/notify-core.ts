// When to tell the user an agent turn finished: only while no window of the app is focused.
export interface NotifyInput {
  enabled: boolean
  anyWindowFocused: boolean
  eventType: string
}
export const shouldNotify = (i: NotifyInput): boolean => i.enabled && !i.anyWindowFocused && i.eventType === 'done'
export const notifyTitle = (projectName: string): string => `Agent finished · ${projectName}`
