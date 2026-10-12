// DOM session replay (rrweb). Runs only while the account has consented to usage events AND
// conversation content; the main process re-checks consent for every chunk it receives, stores it
// under userData/replay and uploads it to Supabase Storage (see main/replay-core.ts).
//
// What is recorded: DOM mutations, mouse moves and clicks, scrolls, inputs, text selections and
// viewport changes in this window (Home and project workspaces alike). Not recorded: password
// inputs and the invitation-code input (`input[name=code]`, `[data-private]`) are masked, and
// <canvas> (the PDF pages) is blocked.
import { record } from 'rrweb'
import type { eventWithTime } from '@rrweb/types'

export const CHUNK_MS = 10_000
export const CHUNK_BYTES = 500 * 1024
const POLL_MS = 5_000
const PRIVATE = 'input[type=password], input[name=code], [data-private]'

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

let stop: (() => void) | null = null
let timer: ReturnType<typeof setInterval> | undefined

function start(sessionId: string): () => void {
  let buf: eventWithTime[] = []
  let size = 0
  let startedAt = Date.now()
  let seq = 0
  let flushing: Promise<void> = Promise.resolve()

  const flush = (): Promise<void> => {
    if (!buf.length) return flushing
    const events = buf
    const chunkStart = startedAt
    const chunkSeq = seq++
    buf = []
    size = 0
    startedAt = Date.now()
    flushing = flushing.then(async () => {
      try {
        const bytes = await gzip(JSON.stringify(events))
        await window.humanstudy.telemetry?.replayChunk({ sessionId, seq: chunkSeq, startedAt: chunkStart, endedAt: Date.now(), bytes })
      } catch {
        /* research data must never break the app */
      }
    })
    return flushing
  }

  const stopRecording = record({
    emit(event) {
      if (!buf.length) startedAt = event.timestamp
      buf.push(event)
      size += JSON.stringify(event).length
      if (size >= CHUNK_BYTES) void flush()
    },
    maskInputOptions: { password: true },
    maskInputFn: (text, el) => (el?.matches?.(PRIVATE) ? '*'.repeat(text.length) : text),
    maskTextSelector: PRIVATE,
    blockSelector: 'canvas',
    recordCanvas: false,
    collectFonts: false,
    inlineStylesheet: true,
    sampling: { mousemove: true, scroll: 150, input: 'all' },
    // A fresh full snapshot every 10 minutes, so a replay can start from any chunk after it.
    checkoutEveryNms: 10 * 60_000,
  })
  const interval = setInterval(() => void flush(), CHUNK_MS)
  const hidden = (): void => {
    if (document.visibilityState === 'hidden') void flush()
  }
  document.addEventListener('visibilitychange', hidden)
  window.addEventListener('pagehide', hidden)
  return () => {
    stopRecording?.()
    clearInterval(interval)
    document.removeEventListener('visibilitychange', hidden)
    window.removeEventListener('pagehide', hidden)
    void flush()
  }
}

/** Follows the consent: starts recording when content consent turns on, stops (and sends nothing more) when it turns off. */
export function startReplay(): void {
  if (timer || typeof window === 'undefined' || !window.humanstudy?.telemetry || typeof CompressionStream === 'undefined') return
  const check = async (): Promise<void> => {
    try {
      const t = window.humanstudy.telemetry
      const st = await t.status()
      const on = st.usage && st.content
      if (on && !stop) stop = start(await t.sessionId())
      else if (!on && stop) {
        stop()
        stop = null
      }
    } catch {
      /* ignore */
    }
  }
  void check()
  timer = setInterval(() => void check(), POLL_MS)
}
