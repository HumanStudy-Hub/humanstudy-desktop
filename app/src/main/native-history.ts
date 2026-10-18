import type { ThreadMessage, ThreadPart } from '../preload/types'
/** Render native records without losing tools, questions or other part types. Native IDs stay addressable. */
export function nativeMessages(records: any[], revertAt?: string): ThreadMessage[] {
  const end = revertAt ? records.findIndex((r) => r.info?.id === revertAt) : -1
  return (end < 0 ? records : records.slice(0, end))
    .filter((r) => ['user', 'assistant'].includes(r.info?.role))
    .map((r) => ({
      id: r.info.id,
      nativeId: r.info.id,
      role: r.info.role,
      at: new Date(r.info.time?.created ?? Date.now()).toISOString(),
      parts: (r.parts ?? []).map((p: any): ThreadPart => {
        if (p.type === 'text') return { kind: 'text', text: p.text ?? '' }
        if (p.type === 'reasoning') return { kind: 'reasoning', text: p.text ?? '' }
        if (p.type === 'tool')
          return {
            kind: 'tool',
            tool: p.tool,
            detail: p.state?.title,
            state: p.state?.status,
            input: p.state?.input,
            output: p.state?.output ?? p.state?.error,
          }
        return { kind: 'native', type: p.type ?? 'unknown', data: p }
      }),
    }))
}
