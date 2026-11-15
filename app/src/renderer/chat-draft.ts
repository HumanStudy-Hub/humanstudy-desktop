/** Append an explicitly requested suggestion without replacing an unsent draft. */
export function appendChatDraft(current: string, suggestion: string): string {
  if (/^[!/]/.test(current.trim())) return current
  if (!current.trim()) return suggestion
  if (current === suggestion || current.endsWith('\n\n' + suggestion)) return current
  return current + '\n\n' + suggestion
}
