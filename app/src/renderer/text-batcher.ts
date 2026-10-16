import type { KernelEvent } from '../preload/types'

/** Bound UI rendering frequency, not transcript size. Main-process persistence stays immediate. */
export function createTextBatcher(deliver: (event: KernelEvent) => void, delay = 100) {
  let sessionId: string | undefined
  let pieces: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { clearTimeout(timer); timer = undefined; pieces = []; sessionId = undefined }
  const flush = () => {
    if (!pieces.length || !sessionId) return
    const event: KernelEvent = { sessionId, type: 'text', text: pieces.join('') }
    cancel()
    deliver(event)
  }
  return {
    flush, cancel,
    push(event: KernelEvent) {
      // Tool calls, questions, errors and completion must retain exact ordering and remain immediate.
      if (event.type !== 'text') { flush(); deliver(event); return }
      if (sessionId && sessionId !== event.sessionId) flush()
      sessionId = event.sessionId
      pieces.push(event.text ?? '')
      if (timer === undefined) timer = setTimeout(flush, delay)
    },
  }
}
