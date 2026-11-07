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
// Only `url` fields carry project file URLs (ProjectFile, ProjectEntry, the paper); file text is never touched.
function decode(v: unknown, key = ''): unknown {
  if (typeof v === 'string') return key === 'url' && v.startsWith(HSFILE) ? '/hsfile/' + v.slice(HSFILE.length) : v
  if (Array.isArray(v)) return v.map((x) => decode(x))
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.__hs_u8 === 'string') return Uint8Array.from(atob(o.__hs_u8), (c) => c.charCodeAt(0))
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(o)) out[k] = decode(o[k], k)
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
const failedUploads = new Map<string, Error>()
function upload(file: File): string {
  const id = crypto.randomUUID()
  const name = file.name.replace(/[/\\]/g, '_') || 'file'
  const path = [config.uploads, id, name].join(config.sep)
  const p = fetch(`/upload/${id}/${encodeURIComponent(name)}`, { method: 'POST', body: file, credentials: 'same-origin' })
    .then((r) => { if (!r.ok) throw new Error(`Upload of ${name} failed (${r.status}).`) })
    .catch((e: Error) => { failedUploads.set(path, e); throw e })
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
  // A call that names a picked file waits for its upload; a failed upload fails only the calls that use it.
  if (uploads.size) await Promise.allSettled([...uploads])
  if (failedUploads.size) {
    const named = JSON.stringify(args)
    for (const [path, error] of failedUploads) if (named.includes(JSON.stringify(path).slice(1, -1))) throw new Error(`Error invoking remote method '${channel}': Error: ${error.message}`)
  }
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

// ---- the online session ended (stopped after its time limit, or replaced): say so, keep nothing hidden --
const TRY_URL = 'https://humanstudy-hub.com/try'
let notice: HTMLElement | null = null
function showEnded(): void {
  if (notice) return
  notice = document.createElement('div')
  notice.setAttribute('role', 'alert')
  notice.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483647;max-width:min(560px,calc(100vw - 32px));padding:14px 18px;border-radius:10px;background:#132019;color:#e5ede2;font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px #0004'
  const zh = (navigator.language || '').toLowerCase().startsWith('zh')
  notice.textContent = zh ? '在线会话已结束，你的项目和对话都已保存。' : 'This online session has ended. Your projects and conversations are saved.'
  const a = document.createElement('a')
  a.href = TRY_URL
  a.textContent = zh ? ' 重新打开' : ' Reopen'
  a.style.cssText = 'color:#a9c4b4;font-weight:600;margin-left:6px'
  notice.appendChild(a)
  document.body.appendChild(notice)
}
let failures = 0
async function checkAlive(): Promise<void> {
  try {
    const r = await fetch('/healthz', { cache: 'no-store', credentials: 'same-origin' })
    if (r.ok) { failures = 0; return }
  } catch { /* unreachable */ }
  if (++failures >= 3) showEnded()
}

// ---- events -------------------------------------------------------------------------------------
const handlers = new Map<string, Set<Handler>>()
const connection = {
  source: null as EventSource | null,
  ended() { this.source?.close(); this.source = null; showEnded() },
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
  // EventSource reconnects by itself and resumes from the last event id; a server that stays gone means
  // the sandbox stopped.
  es.onerror = () => { void checkAlive() }
  es.onopen = () => { failures = 0 }
}
connect()

let unsaved = false
window.addEventListener('beforeunload', (e) => { if (unsaved) { e.preventDefault(); e.returnValue = '' } })

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
    // Unsaved edits: the browser asks before the tab closes (the desktop asks before the window closes).
    if (channel === 'app:unsaved') unsaved = Boolean(args[0])
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
