// The `electron` module for the web build of the preload (src/preload/index.ts, unchanged): the same
// window.humanstudy, with ipcRenderer over HTTP to web/server.cjs and events over server-sent events.
import { researchUuid } from '../src/shared/research-contract'
import { actionRef } from '../src/shared/research-operations'
import { createResearchOutbox } from './research-outbox'

type Handler = (event: unknown, ...args: unknown[]) => void
export type IpcRendererEvent = { sender: unknown }

declare global {
  interface Window {
    __HS_WEB__?: { uploads: string; sep: string; workspace?: string; visit?: string; scope?: string | null; deadlineIn?: number | null }
  }
}

const config: NonNullable<Window['__HS_WEB__']> = window.__HS_WEB__ ?? { uploads: '/uploads', sep: '/' }
function browserVisit(workspace: string): string {
  const key = 'humanstudy.visit.' + workspace
  const launched = config.visit ?? new URL(window.location.href).searchParams.get('hs_visit')
  try {
    const previous = sessionStorage.getItem(key)
    const visit = researchUuid(launched) ? launched : researchUuid(previous) ? previous : crypto.randomUUID()
    sessionStorage.setItem(key, visit)
    return visit
  } catch { return researchUuid(launched) ? launched : crypto.randomUUID() }
}
const visit = config.workspace ? browserVisit(config.workspace).toLowerCase() : undefined
const outbox = config.workspace && visit ? createResearchOutbox(config.workspace, visit, config.scope ?? null,
  entry => call('telemetry:outboxWrite', [entry], AbortSignal.timeout(10_000)),
  () => call('telemetry:outboxScope', [], AbortSignal.timeout(10_000))) : undefined

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
const uploads = new Map<string, Promise<unknown>>()
const failedUploads = new Map<string, Error>()
const UPLOAD_LIMIT = 200 << 20
function upload(file: File): string {
  const id = crypto.randomUUID()
  const name = file.name.replace(/[/\\]/g, '_') || 'file'
  const path = [config.uploads, id, name].join(config.sep)
  // The server stops reading at 200 MB (server.cjs); say so before sending, instead of a dropped connection.
  const p = (file.size > UPLOAD_LIMIT
    ? Promise.reject(new Error(`${name} is larger than 200 MB, the most the online workspace accepts.`))
    : fetch(`/upload/${id}/${encodeURIComponent(name)}`, { method: 'POST', body: file, credentials: 'same-origin' })
      .then((r) => { if (!r.ok) throw new Error(`Upload of ${name} failed (${r.status}).`) }))
    .catch((e: Error) => { failedUploads.set(path, e); throw e })
  uploads.set(path, p)
  void p.finally(() => uploads.delete(path)).catch(() => undefined)
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
function download(value: unknown): void {
  // Most saves answer with the saved path; a study download answers { ok, savedPath } (or why it failed).
  const path = value && typeof value === 'object' ? (value as { ok?: unknown; savedPath?: unknown }).ok === true ? (value as { savedPath?: unknown }).savedPath : null : value
  if (typeof path !== 'string' || !path) return
  const a = document.createElement('a')
  a.href = '/download/' + encodeURIComponent(path)
  a.download = path.split(/[/\\]/).pop() || 'download'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
const SAVES = new Set(['project:saveCopy', 'kernel:export', 'telemetry:saveExport', 'projects:exportStudy', 'projects:shareStudy'])

class IpcTransportError extends Error {}

async function call(channel: string, args: unknown[], signal?: AbortSignal): Promise<unknown> {
  // A call that names a picked file waits for its upload; a failed upload fails only the calls that use it.
  const paths = new Set<string>()
  const collect = (value: unknown): void => {
    if (typeof value === 'string') paths.add(value)
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  collect(args)
  await Promise.allSettled([...uploads].filter(([path]) => paths.has(path)).map(([, pending]) => pending))
  if (failedUploads.size) {
    for (const [path, error] of failedUploads) if (paths.has(path)) throw new Error(`Error invoking remote method '${channel}': Error: ${error.message}`)
  }
  let res: Response
  try {
    res = await fetch('/ipc/' + encodeURIComponent(channel), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(visit ? { 'X-HS-Visit': visit } : {}) },
      body: JSON.stringify({ args: encode(args) }),
      credentials: 'same-origin',
      signal,
    })
  } catch {
    throw new IpcTransportError(`Error invoking remote method '${channel}': Error: The connection to HumanStudy Hub was lost. Check your network and try again.`)
  }
  if (res.status === 401) {
    connection.ended()
    throw new IpcTransportError(`Error invoking remote method '${channel}': Error: This session has ended. Open HumanStudy Hub again.`)
  }
  const out = (await res.json().catch(() => null)) as { ok: boolean; value?: unknown; error?: { name?: string; message: string } } | null
  if (res.status !== 200 || !out || typeof out.ok !== 'boolean') {
    const message = typeof out?.error?.message === 'string' ? out.error.message : `HumanStudy Hub did not answer (${res.status}).`
    throw new IpcTransportError(`Error invoking remote method '${channel}': Error: ${message}`)
  }
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
let externalNotice: HTMLElement | null = null
function openExternal(value: unknown): void {
  if (typeof value !== 'string' || !/^(https?:|mailto:)/i.test(value)) return
  // SSE arrives after the original click, outside the browser's popup activation window.
  // Keep a real, user-clickable link: even a successful noopener open may return null.
  window.open(value, '_blank', 'noopener')
  externalNotice?.remove()
  externalNotice = document.createElement('div')
  externalNotice.setAttribute('role', 'status')
  externalNotice.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483646;max-width:calc(100vw - 40px);padding:12px 16px;background:var(--bg,#fff);color:var(--fg,#263d46);border:1px solid #a8b5bd;border-radius:8px;font:14px/1.5 system-ui'
  externalNotice.appendChild(document.createTextNode('If the new tab did not open: '))
  const link = document.createElement('a')
  link.href = value
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = 'Open link'
  link.addEventListener('click', () => externalNotice?.remove())
  externalNotice.appendChild(link)
  const close = document.createElement('button')
  close.textContent = 'Dismiss'
  close.style.marginLeft = '12px'
  close.addEventListener('click', () => externalNotice?.remove())
  externalNotice.appendChild(close)
  document.body.appendChild(externalNotice)
}
const connection = {
  source: null as EventSource | null,
  ended() { this.source?.close(); this.source = null; showEnded() },
}
function connect(): void {
  if (connection.source) return
  const es = new EventSource(visit ? '/events?hs_visit=' + visit : '/events', { withCredentials: true })
  connection.source = es
  es.onmessage = (m) => {
    let msg: { c: string; p: unknown }
    try { msg = JSON.parse(m.data) } catch { return }
    if (msg.c === 'web:openExternal') { openExternal(msg.p); return }
    if (msg.c === 'web:researchScope' || msg.c === 'account:changed' || msg.c === 'web:account') void outbox?.refresh()
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
  es.onopen = () => { failures = 0; void outbox?.refresh() }
}
connect()
outbox?.replay()
window.addEventListener('online', () => void outbox?.refresh())
window.addEventListener('focus', () => void outbox?.refresh())

let unsaved = false
window.addEventListener('beforeunload', (e) => { if (unsaved) { e.preventDefault(); e.returnValue = '' } })

export const ipcRenderer = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (channel === 'projects:pickPdf') return pick('application/pdf,.pdf')
    if (channel === 'projects:pickStudy') return pick('.zip,application/zip')
    // Folder pickers have no web equivalent: projects live in the sandbox's projects folder.
    if (channel === 'project:open' || channel === 'settings:pickProjectsRoot') return Promise.resolve(null)
    if (channel === 'project:reveal') return Promise.resolve(undefined)
    if (channel === 'telemetry:track' || channel === 'telemetry:chatSubmission')
      return outbox?.append(channel, args) ?? Promise.resolve(undefined)
    if (channel === 'telemetry:setConsent') {
      const consent = args[0] as { usage?: boolean; content?: boolean } | undefined
      if (!consent?.usage || !consent.content) outbox?.suspend()
    }
    if (channel === 'kernel:send' && outbox && typeof args[1] === 'string') {
      const [sid, value, workspace, action] = args
      const ref = actionRef(action) ?? { id: crypto.randomUUID(), via: 'system',
        target: args[1].startsWith('[Simulation scope approved]') ? 'simulation.run' : 'composer.send' }
      const recordFailure = outbox.deferredAppend('telemetry:chatSubmission', [sid, value, 'failed', ref])
      if (navigator.onLine === false) {
        void recordFailure()
        return Promise.reject(new Error('The connection to HumanStudy Hub was lost. Check your network and try again.'))
      }
      return call(channel, [sid, value, workspace, ref]).catch(error => {
        if (error instanceof IpcTransportError) void recordFailure()
        throw error
      })
    }
    const p = call(channel, args)
    if (channel === 'telemetry:setConsent' || /^account:sign(?:In|Up|Out)$/.test(channel))
      void p.then(() => outbox?.refresh(), () => outbox?.refresh())
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
