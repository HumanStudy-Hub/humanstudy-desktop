// Messages from artifact iframes to the app. Artifacts run sandboxed (allow-scripts, no same-origin,
// no network), so the only thing they can do is post one of two requests, validated here:
//   {type:'hs.openSource', page?, quote?, programId?, file?}  open the cited source at a page
//   {type:'hs.ask', text}                                     prefill the chat with a question
// Viewers call `listenToArtifact(frame)`; the app (or Workbench) subscribes with onOpenSource/onAsk.

export interface OpenSourceRequest { page?: number; quote?: string; programId?: string; file?: string }
export interface AskRequest { text: string }
export type BridgeMessage = ({ type: 'hs.openSource' } & OpenSourceRequest) | ({ type: 'hs.ask' } & AskRequest)

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}(\/[A-Za-z0-9][A-Za-z0-9._:-]{0,99})?$/
const MAX_QUOTE = 2000
const MAX_ASK = 4000

/** A project-relative source path: no absolute paths, no "..", no URL schemes. */
function safeFile(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v || v.length > 300) return undefined
  if (v.startsWith('/') || v.startsWith('\\') || /^[a-z]+:/i.test(v) || v.split(/[\\/]/).includes('..')) return undefined
  return v
}

/** Returns the message in canonical shape, or null when it is not a valid bridge request. */
export function parseBridgeMessage(data: unknown): BridgeMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (d.type === 'hs.ask') {
    if (typeof d.text !== 'string') return null
    const text = d.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, MAX_ASK)
    return text ? { type: 'hs.ask', text } : null
  }
  if (d.type === 'hs.openSource') {
    const out: BridgeMessage = { type: 'hs.openSource' }
    if (d.page !== undefined && d.page !== null) {
      const page = typeof d.page === 'string' ? Number(d.page) : d.page
      if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 100000) return null
      out.page = page
    }
    if (d.quote !== undefined && d.quote !== null) {
      if (typeof d.quote !== 'string') return null
      if (d.quote.trim()) out.quote = d.quote.slice(0, MAX_QUOTE)
    }
    if (d.programId !== undefined && d.programId !== null) {
      if (typeof d.programId !== 'string' || !ID.test(d.programId)) return null
      out.programId = d.programId
    }
    if (d.file !== undefined && d.file !== null) {
      const file = safeFile(d.file)
      if (!file) return null
      out.file = file
    }
    return out.page !== undefined || out.programId !== undefined ? out : null
  }
  return null
}

/** Accepts a MessageEvent only from the given frame's window, with an opaque (sandboxed) or file origin. */
export function acceptFrom(event: { source: unknown; origin: string; data: unknown }, frame: { contentWindow: unknown } | null): BridgeMessage | null {
  if (!frame || !frame.contentWindow || event.source !== frame.contentWindow) return null
  if (event.origin !== 'null' && !event.origin.startsWith('hsfile:')) return null
  return parseBridgeMessage(event.data)
}

type Listener<T> = (v: T) => void
const openListeners = new Set<Listener<OpenSourceRequest>>()
const askListeners = new Set<Listener<AskRequest>>()

/** Subscribe to "open this source" requests from artifacts. Returns an unsubscribe function. */
export function onOpenSource(cb: Listener<OpenSourceRequest>): () => void {
  openListeners.add(cb)
  return () => openListeners.delete(cb)
}
/** Subscribe to "ask the agent" requests from artifacts. Returns an unsubscribe function. */
export function onAsk(cb: Listener<AskRequest>): () => void {
  askListeners.add(cb)
  return () => askListeners.delete(cb)
}

let lastAsk = 0
export function dispatchBridge(msg: BridgeMessage, now = Date.now()): void {
  if (msg.type === 'hs.ask') {
    // A view cannot flood the composer: at most one prefill per 500 ms.
    if (now - lastAsk < 500) return
    lastAsk = now
    askListeners.forEach((cb) => cb({ text: msg.text }))
    return
  }
  const { type: _t, ...req } = msg
  openListeners.forEach((cb) => cb(req))
}

/** Listen to one artifact frame; returns a cleanup for useEffect. */
export function listenToArtifact(getFrame: () => HTMLIFrameElement | null): () => void {
  const handler = (event: MessageEvent) => {
    const msg = acceptFrom(event, getFrame())
    if (msg) dispatchBridge(msg)
  }
  window.addEventListener('message', handler)
  return () => window.removeEventListener('message', handler)
}

/** Content-Security-Policy for artifact documents: inline code only, no network at all. */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: hsfile:; font-src data:; media-src data: blob: hsfile:; connect-src 'none'; base-uri 'none'; form-action 'none'"

/** For HTML shown from a string (old versions, unsaved edits): put the no-network policy first in <head>. */
export function withArtifactCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => m + meta)
  return meta + html
}
