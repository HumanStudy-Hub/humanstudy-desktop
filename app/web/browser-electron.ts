// The `electron` module for the web build of the preload (src/preload/index.ts, unchanged): the same
// window.humanstudy, with ipcRenderer over HTTP to web/server.cjs and events over server-sent events.
type Handler = (event: unknown, ...args: unknown[]) => void
export type IpcRendererEvent = { sender: unknown }

declare global {
  interface Window {
    __HS_WEB__?: { uploads: string; sep: string }
  }
}

const config = window.__HS_WEB__ ?? { uploads: '/uploads', sep: '/' }

// ---- values: bytes are tagged, project file URLs become same-origin paths ------------------------
const HSFILE = 'hsfile://local/'
function decode(v: unknown): unknown {
  if (typeof v === 'string') return v.startsWith(HSFILE) ? '/hsfile/' + v.slice(HSFILE.length) : v
  if (Array.isArray(v)) return v.map(decode)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.__hs_u8 === 'string') return Uint8Array.from(atob(o.__hs_u8), (c) => c.charCodeAt(0))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o)) out[k] = decode(o[k])
    return out
  }
  return v
}
function encode(v: unknown): unknown {
  if (v instanceof Uint8Array) {
    let s = ''
    for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode(...v.subarray(i, i + 0x8000))
    return { __hs_u8: btoa(s) }
  }
  if (Array.isArray(v)) return v.map(encode)
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (x !== undefined && typeof x !== 'function') out[k] = encode(x)
    return out
  }
  return v
}

// ---- uploads: a picked or dropped file gets its sandbox path at once; calls wait for the upload ------
const uploads = new Set<Promise<unknown>>()
function upload(file: File): string {
  const id = crypto.randomUUID()
  const name = file.name.replace(/[/\\]/g, '_') || 'file'
  const path = [config.uploads, id, name].join(config.sep)
  const p = fetch(`/upload/${id}/${encodeURIComponent(name)}`, { method: 'POST', body: file, credentials: 'same-origin' })
    .then((r) => { if (!r.ok) throw new Error(`Upload of ${name} failed (${r.status}).`) })
  uploads.add(p)
  void p.finally(() => uploads.delete(p)).catch(() => undefined)
  return path
}
function pick(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.style.display = 'none'
    let done = false
    const finish = (v: string | null) => { if (done) return; done = true; input.remove(); resolve(v) }
    input.addEventListener('change', () => { const f = input.files?.[0]; finish(f ? upload(f) : null) })
    input.addEventListener('cancel', () => finish(null))
    document.body.appendChild(input)
    input.click()
  })
}

// ---- downloads: a save dialog in the sandbox writes a file; the browser then downloads it -----------
function download(path: unknown): void {
  if (typeof path !== 'string' || !path) return
  const a = document.createElement('a')
  a.href = '/download/' + encodeURIComponent(path)
  a.download = path.split(/[/\\]/).pop() || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
const SAVES = new Set(['project:saveCopy', 'kernel:export', 'telemetry:saveExport'])

async function call(channel: string, args: unknown[]): Promise<unknown> {
  if (uploads.size) await Promise.all([...uploads])
  let res: Response
  try {
    res = await fetch('/ipc/' + encodeURIComponent(channel), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: encode(args) }),
      credentials: 'same-origin',
    })
  } catch {
    throw new Error(`Error invoking remote method '${channel}': Error: The connection to HumanStudy Hub was lost. Check your network and try again.`)
  }
  if (res.status === 401) {
    connection.ended()
    throw new Error(`Error invoking remote method '${channel}': Error: This session has ended. Open HumanStudy Hub again.`)
  }
  const out = (await res.json().catch(() => null)) as { ok: boolean; value?: unknown; error?: { name?: string; message: string } } | null
  if (!out) throw new Error(`Error invoking remote method '${channel}': Error: HumanStudy Hub did not answer (${res.status}).`)
  if (!out.ok) throw new Error(`Error invoking remote method '${channel}': ${out.error?.name || 'Error'}: ${out.error?.message ?? 'failed'}`)
  return decode(out.value)
}

// ---- events -------------------------------------------------------------------------------------
const handlers = new Map<string, Set<Handler>>()
const connection = {
  source: null as EventSource | null,
  ended() { this.source?.close(); this.source = null; window.dispatchEvent(new CustomEvent('hs-web:ended')) },
}
function connect(): void {
  if (connection.source) return
  const es = new EventSource('/events', { withCredentials: true })
  connection.source = es
  es.onmessage = (m) => {
    let msg: { c: string; p: unknown }
    try { msg = JSON.parse(m.data) } catch { return }
    if (msg.c === 'web:openExternal') { window.open(String(msg.p), '_blank', 'noopener'); return }
    const payload = decode(msg.p)
    for (const h of handlers.get(msg.c) ?? []) {
      try { h({ sender: null }, payload) } catch (e) { console.error(e) }
    }
  }
  // The replay buffer could not cover the gap: everything is re-read on focus (the app does this).
  es.addEventListener('reset', () => window.dispatchEvent(new Event('focus')))
  es.onerror = () => {
    // EventSource reconnects by itself and resumes from the last event id.
    window.dispatchEvent(new CustomEvent('hs-web:offline'))
  }
  es.onopen = () => window.dispatchEvent(new CustomEvent('hs-web:online'))
}
connect()

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === 'projects:pickPdf') return pick('application/pdf,.pdf')
    // Folder pickers have no web equivalent: projects live in the sandbox's projects folder.
    if (channel === 'project:open' || channel === 'settings:pickProjectsRoot') return Promise.resolve(null)
    if (channel === 'project:reveal') return Promise.resolve(undefined)
    const p = call(channel, args)
    if (SAVES.has(channel)) void p.then(download, () => undefined)
    return p
  },
  send(channel: string, ...args: unknown[]): void {
    void fetch('/send/' + encodeURIComponent(channel), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ args: encode(args) }),
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => undefined)
  },
  on(channel: string, h: Handler) {
    if (!handlers.has(channel)) handlers.set(channel, new Set())
    handlers.get(channel)!.add(h)
    return ipcRenderer
  },
  removeListener(channel: string, h: Handler) {
    handlers.get(channel)?.delete(h)
    return ipcRenderer
  },
}

export const webUtils = { getPathForFile: (file: File): string => upload(file) }

export const contextBridge = {
  exposeInMainWorld(key: string, api: unknown): void {
    ;(window as unknown as Record<string, unknown>)[key] = api
  },
}
