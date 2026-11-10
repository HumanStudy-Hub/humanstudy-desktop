// The web edition's server around the real main process (mock kernel): auth, IPC, events, uploads,
// project files. Build first:  npx electron-vite build && node scripts/build-web.mjs && node --test web/web.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const app = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = mkdtempSync(join(tmpdir(), 'hs-web-'))
const PORT = 5400 + Math.floor(Math.random() * 500)
const B = `http://127.0.0.1:${PORT}`
const TOKEN = 'test-token-0123456789'
const auth = { Authorization: `Bearer ${TOKEN}` }
let server

const ipc = async (channel, ...args) => {
  const r = await fetch(`${B}/ipc/${channel}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ args }) })
  return r.json()
}

before(async () => {
  server = spawn(process.execPath, [join(app, 'out', 'web', 'server.cjs')], {
    env: { ...process.env, HOME: home, HS_USER_DATA: join(home, 'userData'), HS_WEB_TOKEN: TOKEN, PORT: String(PORT), HUMANSTUDY_KERNEL: 'mock', HS_APP_VERSION: '0.0.0-test' },
    stdio: 'ignore',
  })
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${B}/healthz`)).ok) return } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('server did not start')
})
after(() => server?.kill())

test('everything but the health check needs the token', async () => {
  assert.equal((await fetch(`${B}/`)).status, 401)
  assert.equal((await fetch(`${B}/ipc/projects:list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401)
  // Not JSON, or another site's page: refused before anything else.
  assert.equal((await fetch(`${B}/ipc/projects:list`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: '{}' })).status, 403)
  assert.equal((await fetch(`${B}/ipc/projects:list`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', Origin: 'https://evil.vercel.run' }, body: '{}' })).status, 403)
  assert.equal((await fetch(`${B}/`, { headers: { cookie: 'hs_web=%E0' } })).status, 401)
  const first = await fetch(`${B}/?t=${TOKEN}`, { redirect: 'manual' })
  assert.equal(first.status, 302)
  assert.match(first.headers.get('set-cookie') ?? '', /hs_web=.*HttpOnly/)
  const page = await fetch(`${B}/`, { headers: { cookie: `hs_web=${TOKEN}` } })
  assert.equal(page.status, 200)
  assert.match(await page.text(), /web-config\.js[\s\S]*web-preload\.js[\s\S]*type="module"/)
})

test('IPC reaches the desktop main process; errors keep their message', async () => {
  const info = await ipc('app:info')
  assert.equal(info.ok, true)
  assert.equal(info.value.version, '0.0.0-test')
  assert.deepEqual((await ipc('projects:list')).value, [])
  const bad = await ipc('project:readText', '/etc/passwd')
  assert.equal(bad.ok, false)
  assert.match(bad.error.message, /outside the opened projects/)
})

test('an uploaded paper becomes a project whose files are served at /hsfile/', async () => {
  const id = crypto.randomUUID()
  const pdf = Buffer.from('%PDF-1.4\n% test\n')
  const up = await (await fetch(`${B}/upload/${id}/paper.pdf`, { method: 'POST', headers: auth, body: pdf })).json()
  assert.equal(up.ok, true)
  const dir = (await ipc('projects:create', { name: 'Upload check', pdfPath: up.path })).value
  const snap = (await ipc('project:read', dir)).value
  assert.match(snap.pdf.url, /^hsfile:\/\/local\//)
  const served = await fetch(`${B}/hsfile/${snap.pdf.url.slice('hsfile://local/'.length)}`, { headers: auth })
  assert.equal(served.status, 200)
  assert.equal(served.headers.get('content-type'), 'application/pdf')
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), pdf)
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff')
  assert.match(served.headers.get('content-security-policy') ?? '', /sandbox/)
  const outside = await fetch(`${B}/hsfile/${encodeURIComponent('/etc/passwd')}`, { headers: auth })
  assert.equal(outside.status, 403)
})

test('the shipped example opens as a protocol project with sources and a current view, without building', async () => {
  const created = await ipc('projects:create', { name: 'Protocol walkthrough', sample: true })
  assert.equal(created.ok, true, JSON.stringify(created))
  const snap = (await ipc('project:read', created.value)).value
  assert.equal(snap.program, null)
  assert.equal(snap.build, undefined)
  const text = (await ipc('project:readText', `${created.value}/protocol.json`)).value
  const p = JSON.parse(text)
  assert.equal(p.id, 'mazzarella2018politeness')
  assert.equal(p.schema_version, '1')
  assert.equal(p.arms.length, 2)
  assert.ok(snap.pdf)
  const preview = (await ipc('project:readText', `${created.value}/artifacts/preview.html`)).value
  assert.match(preview, /hs-protocol/)
  assert.match(preview, /hs.openSource/)
  const projects = (await ipc('projects:list')).value
  assert.equal(projects.find(p => p.dir === created.value).hasProgram, true)
})

// One pending read per stream: a read abandoned by a timeout would swallow the next chunk.
function lines(stream) {
  const reader = stream.getReader()
  let pending = null
  let buffer = ''
  return async function readUntil(pattern, ms = 5000) {
    const until = Date.now() + ms
    while (Date.now() < until && !pattern.test(buffer)) {
      pending ??= reader.read()
      const r = await Promise.race([pending, new Promise((res) => setTimeout(() => res(null), 250))])
      if (!r) continue
      pending = null
      if (r.done) break
      buffer += new TextDecoder().decode(r.value)
    }
    return buffer
  }
}

test('events stream to the browser and resume after a dropped connection', async () => {
  const dir = (await ipc('projects:create', { name: 'Event check', sample: true })).value
  const ctl = new AbortController()
  const res = await fetch(`${B}/events`, { headers: auth, signal: ctl.signal })
  const readUntil = lines(res.body)
  await readUntil(/retry:/)
  await ipc('project:read', dir) // starts watching the folder
  await ipc('project:writeText', `${dir}/notes.md`, 'hello')
  const text = await readUntil(/project:changed/)
  ctl.abort()
  assert.match(text, /"c":"project:changed"/)
  const id = Math.max(...[...text.matchAll(/id: (\d+)/g)].map((m) => Number(m[1])))
  // Reconnecting with the id before the last one replays the missed event.
  const ctl2 = new AbortController()
  const again = await fetch(`${B}/events`, { headers: { ...auth, 'Last-Event-ID': String(id - 1) }, signal: ctl2.signal })
  const replay = await lines(again.body)(new RegExp(`id: ${id}\\n`))
  ctl2.abort()
  assert.match(replay, new RegExp(`id: ${id}\\n`))
})

test('the launcher can sign the app in (seed), and only with the token', async () => {
  const denied = await fetch(`${B}/__seed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(denied.status, 401)
  const session = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3_600_000, email: 'test@example.org' }
  const ok = await fetch(`${B}/__seed`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ session }) })
  assert.equal(ok.status, 200)
  const status = (await ipc('account:status')).value
  assert.equal(status.signedIn, true)
  assert.equal(status.email, 'test@example.org')
})
