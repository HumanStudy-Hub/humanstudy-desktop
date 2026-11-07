// HumanStudy Hub on the web: the desktop main process, unchanged, behind one HTTP port.
//
//   GET  /                     the desktop renderer (out/renderer) + web-preload.js (the desktop preload,
//                              built against browser-electron.ts)
//   POST /ipc/<channel>        ipcRenderer.invoke  -> the main process's ipcMain.handle(channel)
//   POST /send/<channel>       ipcRenderer.send    -> ipcMain.on(channel)
//   GET  /events               webContents.send    -> server-sent events, resumable with Last-Event-ID
//   GET  /hsfile/<path>        the app's hsfile:// protocol (project files, limited to opened projects)
//   POST /upload/<id>/<name>   a file the browser picked or dropped (webUtils.getPathForFile)
//   GET  /download/<path>      a file a save dialog wrote (save a copy, export)
//
// Environment: HS_WEB_TOKEN (required unless HS_WEB_INSECURE=1), PORT, HS_USER_DATA, HS_APP_ROOT,
// HS_RENDERER_DIR, HS_MAIN, HS_APP_VERSION. Everything else is the desktop app's own environment.
'use strict'
const Module = require('node:module')
const http = require('node:http')
const { createReadStream, createWriteStream, mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs')
const { join, resolve, sep, basename } = require('node:path')
const { timingSafeEqual } = require('node:crypto')
const { Readable } = require('node:stream')
const { pipeline } = require('node:stream/promises')

const HERE = __dirname
const SHIM = join(HERE, 'electron-shim.cjs')
const UPDATER = join(HERE, 'electron-updater-shim.cjs')
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return SHIM
  if (request === 'electron-updater') return UPDATER
  return resolveFilename.call(this, request, ...rest)
}
const electron = require(SHIM)
const { bus, invoke, emitSend, protocols, contentType, paths } = electron.__web

const PORT = Number(process.env.PORT || 3000)
const TOKEN = process.env.HS_WEB_TOKEN || ''
if (!TOKEN && process.env.HS_WEB_INSECURE !== '1') throw new Error('HS_WEB_TOKEN is required (or HS_WEB_INSECURE=1 for local tests)')
const RENDERER = process.env.HS_RENDERER_DIR || join(HERE, 'renderer')
const UPLOADS = join(paths.userData, 'uploads')
mkdirSync(UPLOADS, { recursive: true })

// ---- events: a replay buffer so a dropped connection resumes where it left off -------------------
const RING = 5000
const ring = []
let seq = 0
const clients = new Set()
bus.on('send', (channel, payload) => {
  let data
  try { data = JSON.stringify({ c: channel, p: encode(payload) }) } catch (e) { console.error('event not serialisable', channel, e); return }
  const ev = { id: ++seq, data }
  ring.push(ev)
  if (ring.length > RING) ring.shift()
  for (const res of clients) write(res, ev)
})
const write = (res, ev) => res.write(`id: ${ev.id}\ndata: ${ev.data}\n\n`)

// Values cross as JSON; bytes (Buffer/Uint8Array) are tagged so the browser can rebuild them.
function encode(v) {
  if (v === undefined) return null
  if (v instanceof Uint8Array) return { __hs_u8: Buffer.from(v).toString('base64') }
  if (Array.isArray(v)) return v.map(encode)
  if (v instanceof Date) return v.toISOString()
  if (v && typeof v === 'object') {
    if (typeof v.toJSON === 'function') return v.toJSON()
    const o = {}
    for (const [k, x] of Object.entries(v)) if (x !== undefined && typeof x !== 'function') o[k] = encode(x)
    return o
  }
  return v
}
function decode(v) {
  if (Array.isArray(v)) return v.map(decode)
  if (v && typeof v === 'object') {
    if (typeof v.__hs_u8 === 'string') return Buffer.from(v.__hs_u8, 'base64')
    const o = {}
    for (const [k, x] of Object.entries(v)) o[k] = decode(x)
    return o
  }
  return v
}

// ---- auth: one secret per sandbox, handed to the browser once and kept in a cookie ----------------
const COOKIE = 'hs_web'
function same(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}
function authorised(req) {
  if (!TOKEN) return true
  const m = /(?:^|;\s*)hs_web=([^;]+)/.exec(req.headers.cookie || '')
  if (m && same(decodeURIComponent(m[1]), TOKEN)) return true
  const h = req.headers.authorization
  return Boolean(h && h.startsWith('Bearer ') && same(h.slice(7), TOKEN))
}

// ---- static renderer ---------------------------------------------------------------------------
let indexHtml = null
function renderIndex() {
  if (indexHtml) return indexHtml
  let html = readFileSync(join(RENDERER, 'index.html'), 'utf8')
  // Project files are same-origin here (/hsfile/), not on a separate hsfile: origin. Frames stay sandboxed.
  html = html.replace(/frame-src ([^;"]*)/, "frame-src 'self' $1")
  html = html.replace(/<script type="module"/, '<script src="./web-config.js"></script>\n    <script src="./web-preload.js"></script>\n    <script type="module"')
  return (indexHtml = html)
}
function sendFile(res, file, extra = {}) {
  let st
  try { st = statSync(file) } catch { return notFound(res) }
  if (!st.isFile()) return notFound(res)
  res.writeHead(200, { 'Content-Type': contentType(file), 'Content-Length': st.size, ...extra })
  createReadStream(file).pipe(res)
}
const notFound = (res) => { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found') }
const json = (res, status, body) => {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(s)
}
async function body(req, limit) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) throw Object.assign(new Error('request is too large'), { status: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}
const inside = (root, p) => { const r = resolve(root) + sep; return resolve(p).startsWith(r) }

const ready = { main: false }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local')
  const path = url.pathname
  try {
    if (path === '/healthz') return json(res, 200, { ok: true, ready: ready.main })
    // First visit: /?t=<token> sets the cookie and drops the token from the address bar.
    const t = url.searchParams.get('t')
    if (TOKEN && t && same(t, TOKEN)) {
      url.searchParams.delete('t')
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`,
        Location: url.pathname + (url.search || ''),
      })
      return res.end()
    }
    if (!authorised(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('This session has ended. Open HumanStudy Hub again from humanstudy-hub.com.') }

    // The launcher (humanstudy-hub.com) signs the app in as the website's user: a session of its own and,
    // when the user has hosted access, a desktop key. Same file and encryption as the desktop's account.ts.
    if (req.method === 'POST' && path === '/__seed') {
      const h = req.headers.authorization || ''
      if (!TOKEN || !h.startsWith('Bearer ') || !same(h.slice(7), TOKEN)) return json(res, 401, { ok: false })
      const seed = JSON.parse((await body(req, 64 << 10)).toString('utf8') || '{}')
      const file = join(paths.userData, 'account.json')
      let store = {}
      try { store = JSON.parse(readFileSync(file, 'utf8')) } catch { /* first run */ }
      const seal = (v) => electron.safeStorage.encryptString(JSON.stringify(v)).toString('base64')
      if (seed.session) store.session = seal(seed.session)
      if (seed.desktopKey) store.desktopKey = seal(seed.desktopKey)
      writeFileSync(file, JSON.stringify(store, null, 2), { mode: 0o600 })
      bus.emit('send', 'web:account', {})
      return json(res, 200, { ok: true })
    }
    if (req.method === 'POST' && path.startsWith('/ipc/')) {
      const channel = decodeURIComponent(path.slice(5))
      const { args } = JSON.parse((await body(req, 16 << 20)).toString('utf8') || '{}')
      try {
        const value = await invoke(channel, decode(Array.isArray(args) ? args : []))
        return json(res, 200, { ok: true, value: encode(value) })
      } catch (e) {
        return json(res, 200, { ok: false, error: { name: e?.name || 'Error', message: e?.message ?? String(e) } })
      }
    }
    if (req.method === 'POST' && path.startsWith('/send/')) {
      const { args } = JSON.parse((await body(req, 1 << 20)).toString('utf8') || '{}')
      emitSend(decodeURIComponent(path.slice(6)), decode(Array.isArray(args) ? args : []))
      return json(res, 200, { ok: true })
    }
    if (path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
      res.write('retry: 1000\n\n')
      // A reconnect names the last event it saw (EventSource sends Last-Event-ID); replay what came after.
      const raw = req.headers['last-event-id'] ?? url.searchParams.get('since')
      const last = Number(raw)
      if (raw != null && Number.isFinite(last) && last >= 0) {
        // Gap larger than the buffer: tell the page to re-read everything.
        if (ring.length && ring[0].id > last + 1) res.write(`event: reset\ndata: {}\n\n`)
        for (const ev of ring) if (ev.id > last) write(res, ev)
      }
      clients.add(res)
      const beat = setInterval(() => res.write(': beat\n\n'), 15000)
      req.on('close', () => { clearInterval(beat); clients.delete(res) })
      return
    }
    if (path.startsWith('/hsfile/')) {
      const handler = protocols.get('hsfile')
      if (!handler) return notFound(res)
      const r = await handler(new Request('hsfile://local/' + path.slice(8) + url.search))
      const headers = Object.fromEntries(r.headers)
      if (/^text\/html/i.test(headers['content-type'] || '')) headers['content-security-policy'] = `${headers['content-security-policy'] || ''}; sandbox allow-scripts`
      headers['cache-control'] = 'no-store'
      res.writeHead(r.status, headers)
      if (!r.body) return res.end()
      return pipeline(Readable.fromWeb(r.body), res).catch(() => res.destroy())
    }
    if (req.method === 'POST' && path.startsWith('/upload/')) {
      const [, , id, ...rest] = path.split('/')
      const name = basename(decodeURIComponent(rest.join('/')))
      if (!/^[0-9a-f-]{36}$/.test(id) || !name || name.startsWith('.')) return json(res, 400, { ok: false })
      const dir = join(UPLOADS, id)
      mkdirSync(dir, { recursive: true })
      const target = join(dir, name)
      let n = 0
      const LIMIT = 200 << 20
      req.on('data', (c) => { n += c.length; if (n > LIMIT) req.destroy(new Error('file is larger than 200 MB')) })
      await pipeline(req, createWriteStream(target))
      return json(res, 200, { ok: true, path: target })
    }
    if (path.startsWith('/download/')) {
      const file = resolve(decodeURIComponent(path.slice(10)))
      if (!inside(paths.downloads, file)) return notFound(res)
      return sendFile(res, file, { 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(file))}`, 'Cache-Control': 'no-store' })
    }
    if (path === '/web-config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' })
      return res.end(`window.__HS_WEB__=${JSON.stringify({ uploads: UPLOADS, sep })};`)
    }
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(renderIndex())
    }
    const file = resolve(RENDERER, '.' + decodeURIComponent(path))
    if (!inside(RENDERER, file)) return notFound(res)
    return sendFile(res, file, { 'Cache-Control': /\/assets\//.test(path) ? 'public, max-age=31536000, immutable' : 'no-store' })
  } catch (e) {
    console.error('request failed', req.method, path, e)
    if (!res.headersSent) json(res, e?.status || 500, { ok: false, error: { message: String(e?.message || e) } })
    else res.destroy()
  }
})
server.requestTimeout = 0 // uploads and event streams are long
server.headersTimeout = 60_000

process.on('unhandledRejection', (e) => console.error('unhandled rejection', e))
process.on('SIGTERM', () => electron.app.quit())

require(process.env.HS_MAIN || join(HERE, 'main', 'index.js'))
ready.main = true
server.listen(PORT, '0.0.0.0', () => console.log(`humanstudy web: listening on ${PORT}`))
