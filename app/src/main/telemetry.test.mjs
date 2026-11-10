// Research data (telemetry-core.ts) test against a stubbed fetch and in-memory storage:
//   node src/main/telemetry.test.mjs
// Covers consent gating, the payload sanitizer, batching, retry/backoff, the queue cap, the
// 30-day age drop, persistence, withdrawal and "Delete my data".
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'telemetry-test-'))
await build({
  entryPoints: [join(here, 'telemetry-core.ts'), join(here, 'replay-core.ts'), join(here, 'research-content.ts'), join(here, 'research-agent.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: out,
  logLevel: 'error',
})
const { storeResearchContent } = await import(pathToFileURL(join(out, 'research-content.js')).href)
const core = await import(pathToFileURL(join(out, 'telemetry-core.js')).href)
const replayMod = await import(pathToFileURL(join(out, 'replay-core.js')).href)
const agentMod = await import(pathToFileURL(join(out, 'research-agent.js')).href)
rmSync(out, { recursive: true, force: true })
const { createReplay, DISK_CAP } = replayMod
const { programDiff } = core
const { createTelemetry, sanitizeEvent, CONSENT_VERSION, FLUSH_AT, QUEUE_CAP, MAX_BATCH, FLUSH_INTERVAL_MS } = core

const SB = 'https://sb.test'
const EMAIL = 'Researcher@Example.org'
const USER_ID = '11111111-2222-3333-4444-555555555555'
const DAY = 86_400_000
let clock = Date.parse('2026-10-01T12:00:00Z')

function memoryStorage() {
  const s = { state: null, queue: '', recent: [] }
  return {
    s,
    readState: () => (s.state ? JSON.parse(s.state) : null),
    writeState: (v) => (s.state = JSON.stringify(v)),
    readQueue: () => s.queue,
    appendQueue: (lines) => (s.queue += lines),
    writeQueue: (c) => (s.queue = c),
    readRecent: () => JSON.parse(JSON.stringify(s.recent)),
    writeRecent: (r) => (s.recent = JSON.parse(JSON.stringify(r))),
  }
}

/** A fetch stub whose response status is set per test; records every call. */
function stubServer() {
  const srv = { calls: [], status: 201, throwNext: 0 }
  srv.fetch = async (url, init = {}) => {
    srv.calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null })
    if (srv.throwNext > 0) {
      srv.throwNext--
      throw new TypeError('fetch failed')
    }
    return new Response(null, { status: srv.status })
  }
  return srv
}

function make({ storage = memoryStorage(), server = stubServer(), email = EMAIL } = {}) {
  const ctx = { email }
  const t = createTelemetry({
    fetch: (...a) => server.fetch(...a),
    storage,
    accountEmail: () => ctx.email,
    auth: async () =>
      ctx.email ? { supabaseUrl: SB, supabaseKey: 'sb_publishable_test', accessToken: 'user-token', userId: USER_ID } : null,
    appVersion: '0.1.0',
    platform: 'darwin',
    now: () => clock,
  })
  return { t, storage, server, ctx }
}
const posted = (server) => server.calls.filter((c) => c.method === 'POST').flatMap((c) => c.body)
let passed = 0
async function test(name, fn) {
  await fn()
  passed++
  console.log(`ok - ${name}`)
}

// A previous agreement did not authorize original source uploads.
await test('version 2 agreement is not silently promoted to source agreement 3', async () => {
  const first = make(); await first.t.setConsent({ usage: true, content: true });
  const saved = JSON.parse(first.storage.s.state); saved.consent.version = 2;
  first.storage.s.state = JSON.stringify(saved);
  const restarted = make({ storage: first.storage });
  assert.equal(restarted.t.status().decided, false);
  assert.equal(restarted.t.status().content, false);
  assert.equal(restarted.t.track('project.file_written', { target: 'paper.pdf' }), null);
});

// ---- sanitizer ------------------------------------------------------------------------
const base = { installId: 'install-0001', sessionId: 'session-0001', appVersion: '0.1.0', platform: 'darwin', now: clock }

await test('sanitizer removes emails, keys, absolute paths, forbidden keys', () => {
  const row = sanitizeEvent(
    'agent.turn_error',
    {
      target: '/Users/alice/HumanStudy/My Study/artifacts/chart.html',
      durationMs: 1234.6,
      metadata: {
        error: 'auth failed for alice@uni.edu with sk-or-v1-abcdefghijklmnop0123 at /Users/alice/.config/x.json',
        url: 'https://openrouter.ai/api/v1/chat',
        apiKey: 'sk-should-not-appear-1234567890',
        token: 'x',
        email: 'x',
        fileContents: 'secret paper text',
        text: 'not a conversation event, so dropped',
        nested: { winPath: 'C:\\Users\\alice\\paper.pdf', jwt: 'eyJhbGciOiJI.eyJzdWIiOiIxMjM0NTY3.c2lnbmF0dXJlMTIz' },
        tools: ['read', 'write'],
      },
    },
    { projectDir: '/Users/alice/HumanStudy/My Study', email: 'Researcher@Example.org', content: false },
    base
  )
  assert.equal(row.target, 'artifacts/chart.html')
  assert.equal(row.duration_ms, 1235)
  const json = JSON.stringify(row)
  for (const bad of ['alice@uni.edu', 'sk-or-v1', '/Users/alice', 'C:\\\\Users', 'eyJhbGci', 'secret paper', 'should-not-appear'])
    assert.ok(!json.includes(bad), `leaked ${bad}: ${json}`)
  assert.match(row.metadata.error, /\[email\].*\[secret\].*\[path\]/)
  assert.equal(row.metadata.url, 'https://openrouter.ai/api/v1/chat')
  for (const k of ['apiKey', 'token', 'email', 'fileContents', 'text']) assert.ok(!(k in row.metadata), k)
  assert.equal(row.metadata.nested.winPath, '[path]')
  assert.deepEqual(row.metadata.tools, ['read', 'write'])
  assert.equal(row.consent_version, CONSENT_VERSION)
  assert.equal(row.platform, 'darwin')
  assert.equal(row.project_id, null)
})

await test('sanitizer: consent and credentials protected without shortening research content', () => {
  const ctx = { content: false, email: EMAIL }
  assert.equal(sanitizeEvent('Bad Type', {}, ctx, base), null)
  assert.equal(sanitizeEvent('x', {}, ctx, base), null)
  assert.equal(sanitizeEvent('conversation.user', { metadata: { text: 'hi' } }, ctx, base), null)
  const conv = sanitizeEvent('conversation.user', { metadata: { text: `mail me at ${EMAIL.toLowerCase()} please` } }, { ...ctx, content: true }, base)
  assert.equal(conv.metadata.text, 'mail me at [email] please')
  const big = sanitizeEvent('conversation.assistant', { metadata: { text: 'x'.repeat(50_000) } }, { ...ctx, content: true }, base)
  assert.equal(big.metadata.text, 'x'.repeat(50_000))
  const digest = 'a1'.repeat(32)
  const approved = sanitizeEvent('conversation.user', { metadata: { text: `programHash=${digest}` } }, { ...ctx, content: true }, base)
  assert.equal(approved.metadata.text, `programHash=${digest}`, 'scientific content hashes are not secret credentials')
  const many = sanitizeEvent('ui.test', { target: 'y'.repeat(500), metadata: { list: Array.from({ length: 100 }, (_, i) => 'z '.repeat(200) + i) } }, ctx, base)
  assert.equal(many.target.length, 160)
  assert.equal(many.metadata.list.length, 100)
  assert.equal(many.metadata.list[99], 'z '.repeat(200) + 99)
  assert.equal(sanitizeEvent('ui.test', { projectId: 'short' }, ctx, base).project_id, null)
  assert.equal(sanitizeEvent('ui.test', { projectId: 'proj-12345678' }, ctx, base).project_id, 'proj-12345678')
})

// ---- consent --------------------------------------------------------------------------
await test('nothing is queued or sent before consent, or when signed out', async () => {
  const { t, server, ctx, storage } = make()
  assert.equal(t.track('project.opened'), null)
  assert.equal(t.status().decided, false)
  await t.flush({ force: true })
  assert.equal(server.calls.length, 0)
  ctx.email = null
  await assert.rejects(() => t.setConsent({ usage: true, content: true }), /Sign in/)
  assert.equal(storage.s.queue, '')
})

await test('declining sends nothing; consent is per account', async () => {
  const { t, server, ctx } = make()
  await t.setConsent({ usage: false, content: true })
  const st = t.status()
  assert.deepEqual([st.decided, st.usage, st.content], [true, false, false])
  assert.equal(t.track('project.opened'), null)
  ctx.email = 'other@example.org'
  assert.equal(t.status().decided, false)
  await t.flush({ force: true })
  assert.equal(server.calls.length, 0)
})

await test('consent.granted, conversation gating, batching at FLUSH_AT, exact PostgREST request', async () => {
  const { t, server } = make()
  await t.setConsent({ usage: true, content: false })
  assert.equal(t.status().pending, 1) // consent.granted
  assert.equal(t.track('conversation.user', { metadata: { text: 'hello' } }), null)
  for (let i = 0; i < FLUSH_AT - 2; i++) t.track('program.item_pick', { target: `node-${i}` })
  assert.equal(server.calls.length, 0)
  t.track('pane.fold', { target: 'source' }) // the 50th event triggers a flush
  await t.flush()
  assert.equal(server.calls.length, 1)
  const c = server.calls[0]
  assert.equal(c.url, `${SB}/rest/v1/desktop_events`)
  assert.equal(c.headers.apikey, 'sb_publishable_test')
  assert.equal(c.headers.authorization, 'Bearer user-token')
  assert.equal(c.headers.prefer, 'resolution=ignore-duplicates,return=minimal')
  assert.equal(c.body.length, FLUSH_AT)
  assert.equal(c.body[0].event_type, 'consent.granted')
  assert.deepEqual(c.body[0].metadata, { usageEvents: true, conversationContent: false, consentVersion: CONSENT_VERSION })
  assert.equal(c.body[1].target, 'node-0')
  assert.ok(!('owner_id' in c.body[0]))
  const st = t.status()
  assert.equal(st.pending, 0)
  assert.equal(st.sent, FLUSH_AT)
  // The transparency list shows exactly what went out.
  const recent = t.recent()
  assert.equal(recent[0].row.event_type, 'pane.fold')
  assert.deepEqual(recent[0].row, c.body.at(-1))
  assert.ok(recent.every((r) => r.status === 'sent'))
})

await test('retry with backoff; rejected events remain locally recoverable', async () => {
  const { t, server } = make()
  await t.setConsent({ usage: true, content: false })
  server.status = 503
  await t.flush({ force: true })
  assert.equal(server.calls.length, 1)
  assert.equal(t.status().pending, 1)
  assert.match(t.status().lastError, /503/)
  await t.tick() // still inside the backoff window
  assert.equal(server.calls.length, 1)
  clock += FLUSH_INTERVAL_MS
  server.throwNext = 1
  await t.tick()
  assert.equal(server.calls.length, 2)
  clock += FLUSH_INTERVAL_MS // second failure doubled the wait
  await t.tick()
  assert.equal(server.calls.length, 2)
  clock += FLUSH_INTERVAL_MS
  server.status = 201
  await t.tick()
  assert.equal(server.calls.length, 3)
  assert.equal(t.status().pending, 0)
  assert.equal(t.status().lastError, undefined)

  t.track('ui.bad')
  server.status = 400
  await t.flush({ force: true })
  assert.equal(t.status().pending, 1)
  assert.match(t.status().lastError, /400/)
})

await test('large queues upload in batches of MAX_BATCH', async () => {
  const { t, server } = make()
  server.status = 500
  await t.setConsent({ usage: true, content: false })
  for (let i = 0; i < 2 * MAX_BATCH + 10; i++) t.track('ui.click', { target: `b${i}` })
  server.calls.length = 0
  server.status = 201
  await t.flush({ force: true })
  assert.deepEqual(server.calls.map((c) => c.body.length), [MAX_BATCH, MAX_BATCH, 11])
  assert.equal(new Set(posted(server).map((r) => r.id)).size, 2 * MAX_BATCH + 11)
})

await test('large queues retain every event across restarts', async () => {
  const storage = memoryStorage()
  const server = stubServer()
  server.status = 500
  const { t } = make({ storage, server })
  await t.setConsent({ usage: true, content: false })
  for (let i = 0; i < QUEUE_CAP + 25; i++) t.track('ui.click', { target: `c${i}` })
  assert.equal(t.status().pending, QUEUE_CAP + 26)
  // A new process reads the same JSONL queue (including a torn last line).
  storage.s.queue += '{"acct":"torn'
  const again = make({ storage, server: stubServer() })
  assert.equal(again.t.status().pending, QUEUE_CAP + 26)
  assert.equal(again.t.status().usage, true)
  await again.t.flush({ force: true })
  const rows = posted(again.server)
  assert.equal(rows.length, QUEUE_CAP + 26)
  assert.equal(rows[1].target, 'c0')
  assert.equal(rows.at(-1).target, `c${QUEUE_CAP + 24}`)
  assert.equal(again.t.status().pending, 0)
  assert.equal(storage.s.queue, '')
})

await test('offline events keep their original timestamp and remain recoverable', async () => {
  const storage = memoryStorage()
  const server = stubServer()
  server.status = 500
  const { t } = make({ storage, server })
  await t.setConsent({ usage: true, content: false })
  t.track('ui.old')
  clock += 20 * DAY
  t.track('ui.recent')
  clock += 11 * DAY
  server.status = 201
  server.calls.length = 0
  await t.flush({ force: true })
  assert.deepEqual(posted(server).map((r) => r.event_type), ['consent.granted', 'ui.old', 'ui.recent'])
  // And on startup, from the persisted queue.
  server.status = 500
  t.track('ui.stale')
  clock += 31 * DAY
  const again = make({ storage })
  assert.equal(again.t.status().pending, 1)
})

await test('old timestamp rejection does not block fresh events and never deletes old records', async () => {
  const server = stubServer()
  const { t } = make({ server })
  await t.setConsent({ usage: true, content: false })
  t.track('ui.offline')
  clock += 40 * DAY
  t.track('ui.fresh')
  const fetch = server.fetch
  server.fetch = async (url, init) => {
    server.status = JSON.parse(init.body).some(row => Date.parse(row.occurred_at) < clock - 30 * DAY) ? 403 : 201
    return fetch(url, init)
  }
  await t.flush({ force: true })
  assert.equal(t.status().pending, 2) // Original consent and old event both remain queued.
  assert.ok(t.recent().some(e => e.row.event_type === 'ui.fresh' && e.status === 'sent'))
  assert.ok(t.recent().some(e => e.row.event_type === 'ui.offline' && e.status === 'pending'))
})

await test('conversation content is sent only under its own consent; turning it off drops pending text', async () => {
  const { t, server } = make()
  server.status = 500
  await t.setConsent({ usage: true, content: true })
  assert.equal(t.status().content, true)
  assert.ok(t.track('conversation.user', { metadata: { text: 'What is the effect size?' } }))
  t.track('agent.turn_start', { metadata: { chars: 24 } })
  await t.setConsent({ usage: true, content: false })
  server.status = 201
  await t.flush({ force: true })
  const types = posted(server).map((r) => r.event_type)
  assert.ok(!types.includes('conversation.user'))
  assert.ok(types.includes('agent.turn_start'))
  const changed = posted(server).find((r) => r.event_type === 'consent.changed')
  assert.deepEqual(changed.metadata, { usageEvents: true, conversationContent: false, consentVersion: CONSENT_VERSION })
})

await test('withdrawal discards pending events, sends consent.withdrawn, then nothing more', async () => {
  const { t, server } = make()
  server.status = 500
  await t.setConsent({ usage: true, content: true })
  t.track('ui.pending')
  server.status = 201
  server.calls.length = 0
  await t.setConsent({ usage: false, content: false })
  assert.deepEqual(posted(server).map((r) => r.event_type), ['consent.withdrawn'])
  assert.equal(t.track('ui.after'), null)
  await t.flush({ force: true })
  assert.equal(server.calls.length, 1)
  assert.equal(t.status().pending, 0)
})

await test('a stale consent version asks again and sends nothing', async () => {
  const storage = memoryStorage()
  const { t } = make({ storage })
  await t.setConsent({ usage: true, content: false })
  const s = JSON.parse(storage.s.state)
  s.consent.version = CONSENT_VERSION - 1
  storage.s.state = JSON.stringify(s)
  const again = make({ storage })
  assert.equal(again.t.status().decided, false)
  assert.equal(again.t.track('ui.x'), null)
})

await test('Delete my data issues a PostgREST DELETE on own rows and clears local state', async () => {
  const { t, server } = make()
  await t.setConsent({ usage: true, content: false })
  await t.flush({ force: true })
  t.track('ui.pending')
  server.calls.length = 0
  server.status = 204
  const st = await t.deleteMyData()
  const del = server.calls.find((c) => c.method === 'DELETE')
  assert.equal(del.url, `${SB}/rest/v1/desktop_events?owner_id=eq.${USER_ID}`)
  assert.equal(del.headers.authorization, 'Bearer user-token')
  assert.deepEqual([st.sent, st.pending, t.recent().length], [0, 0, 0])
  assert.equal(st.usage, true) // choices stay as they are
  server.status = 500
  await assert.rejects(() => t.deleteMyData(), /could not delete/)
})

// ---- full session replay ------------------------------------------------------------------
function memoryDisk() {
  const files = new Map() // rel -> { data, mtimeMs }
  let t = 0
  return {
    files,
    write: (rel, data) => files.set(rel, { data: typeof data === 'string' ? new TextEncoder().encode(data) : data, mtimeMs: ++t }),
    read: (rel) => files.get(rel)?.data ?? null,
    remove: (rel) => files.delete(rel),
    list: () => [...files].map(([rel, f]) => ({ rel, size: f.data.length, mtimeMs: f.mtimeMs })),
    clear: () => files.clear(),
  }
}
function replayServer() {
  const srv = { calls: [], status: 200, rowStatus: 201 }
  srv.fetch = async (url, init = {}) => {
    srv.calls.push({ url, method: init.method, headers: init.headers, body: init.body })
    if (srv.throw) throw new TypeError('fetch failed')
    if (url.includes('/rest/v1/')) return new Response(null, { status: init.method === 'DELETE' ? 204 : srv.rowStatus })
    if (url.includes('/object/list/')) return new Response(JSON.stringify([]), { status: 200 })
    return new Response(null, { status: srv.status })
  }
  return srv
}
function makeReplay({ allowed = true, capBytes, email = EMAIL, interactionOnly = false } = {}) {
  const disk = memoryDisk()
  const server = replayServer()
  const ctx = { allowed, dropped: [] }
  const r = createReplay({
    fs: disk,
    fetch: (...a) => server.fetch(...a),
    auth: async () => ({ supabaseUrl: SB, supabaseKey: 'sb_publishable_test', accessToken: 'user-token', userId: USER_ID }),
    allowed: () => ctx.allowed,
    acct: () => (email ? 'acct1' : null),
    appVersion: '0.2.0',
    interactionOnly,
    now: () => clock,
    capBytes,
    onDropped: (i) => ctx.dropped.push(i),
  })
  return { r, disk, server, ctx }
}
const SID = 'session-0001-abcd'
const bytes = (n) => new Uint8Array(n).fill(7)

await test('replay gating: nothing is stored or queued without usage + content consent', async () => {
  // core: usage-only consent queues no content events (conversation, program versions, written files)
  const { t } = make()
  await t.setConsent({ usage: true, content: false })
  const before = t.status().pending
  for (const type of ['conversation.tool', 'conversation.user', 'project.program_version', 'project.file_written'])
    assert.equal(t.track(type, { metadata: { text: 'x' } }), null, type)
  assert.equal(t.status().pending, before)
  await t.setConsent({ usage: true, content: true })
  assert.ok(t.track('project.program_version', { metadata: { version: 1 } }))
  // no consent at all: nothing queued
  const none = make()
  assert.equal(none.t.track('project.program_version'), null)
  // replay store: refuses chunks and blobs while not allowed, writes nothing
  const off = makeReplay({ allowed: false })
  assert.equal(off.r.addChunk({ sessionId: SID, startedAt: 1, endedAt: 2, bytes: bytes(10) }), null)
  assert.equal(off.r.addBlob(SID, bytes(10)), null)
  assert.equal(off.disk.files.size, 0)
  // signed out: same
  const out = makeReplay({ email: null })
  assert.equal(out.r.addChunk({ sessionId: SID, startedAt: 1, endedAt: 2, bytes: bytes(10) }), null)
  // losing consent clears what was recorded
  const on = makeReplay()
  on.r.addChunk({ sessionId: SID, startedAt: 1, endedAt: 2, bytes: bytes(10) })
  assert.ok(on.disk.files.size > 0)
  on.ctx.allowed = false
  await on.r.flush({ force: true })
  assert.equal(on.disk.files.size, 0)
  assert.equal(on.server.calls.length, 0)
})

await test('replay upload: storage object then row, local file deleted only after both succeed', async () => {
  const { r, disk, server } = makeReplay()
  assert.equal(r.addChunk({ sessionId: SID, startedAt: 1000, endedAt: 11000, bytes: bytes(100), windowId: 3 }), 0)
  assert.equal(r.addChunk({ sessionId: SID, startedAt: 11000, endedAt: 21000, bytes: bytes(100) }), 1)
  const blob = r.addBlob(SID, bytes(50))
  assert.match(blob, /^blobs\/[0-9a-f-]+\.gz$/)
  assert.equal(r.addChunk({ sessionId: 'bad id', startedAt: 1, endedAt: 2, bytes: bytes(1) }), null)
  server.status = 500 // storage down: nothing is lost, backoff starts
  await r.flush({ force: true })
  assert.equal(r.pendingFiles(), 3)
  server.calls.length = 0
  server.status = 200
  clock += 11 * 60_000
  await r.flush({ force: true })
  assert.equal(r.pendingFiles(), 0)
  assert.equal(disk.files.size, 0)
  const puts = server.calls.filter((c) => c.url.includes('/storage/v1/object/desktop-replays/'))
  assert.equal(puts[0].url, `${SB}/storage/v1/object/desktop-replays/${USER_ID}/${SID}/0.json.gz`)
  assert.equal(puts[0].headers.authorization, 'Bearer user-token')
  assert.ok(puts.some((c) => c.url.includes(`/${SID}/blobs/`)))
  const rows = server.calls.filter((c) => c.url.includes('/rest/v1/desktop_replay_chunks')).map((c) => JSON.parse(c.body))
  assert.equal(rows.length, 2) // blobs have no row
  assert.deepEqual(
    [rows[0].owner_id, rows[0].session_id, rows[0].seq, rows[0].bytes, rows[0].path, rows[0].window_id, rows[0].app_version],
    [USER_ID, SID, 0, 100, `${USER_ID}/${SID}/0.json.gz`, 3, '0.2.0']
  )
  assert.equal(rows[0].started_at, new Date(1000).toISOString())
})

await test('replay: a row failure keeps the file; backoff delays the retry', async () => {
  const { r, server } = makeReplay()
  r.addChunk({ sessionId: SID, startedAt: 1, endedAt: 2, bytes: bytes(10) })
  server.rowStatus = 503
  await r.flush({ force: true })
  assert.equal(r.pendingFiles(), 1)
  server.calls.length = 0
  await r.flush() // inside the backoff window: no request
  assert.equal(server.calls.length, 0)
  server.rowStatus = 201
  await r.flush({ force: true })
  assert.equal(r.pendingFiles(), 0)
  // a permanent rejection (400) drops the file and reports it
  const bad = makeReplay()
  bad.r.addChunk({ sessionId: SID, startedAt: 1, endedAt: 2, bytes: bytes(10) })
  bad.server.status = 413
  await bad.r.flush({ force: true })
  assert.equal(bad.r.pendingFiles(), 1)
})

await test('replay disk warning never deletes unuploaded content', () => {
  const { r, disk, ctx } = makeReplay({ capBytes: 1000 })
  for (let i = 0; i < 5; i++) r.addChunk({ sessionId: SID, startedAt: i, endedAt: i + 1, bytes: bytes(300) })
  assert.equal(r.pendingFiles(), 5)
  assert.equal(r.pendingBytes(), 1500)
  assert.ok(disk.files.has(`${SID}/0.json.gz`))
  assert.equal(ctx.dropped.length, 0)
})

await test('large recordings remain recoverable even above the cloud object limit', () => {
  const { r, disk } = makeReplay()
  const large = bytes(9 * 1024 * 1024)
  assert.equal(r.addChunk({ sessionId: SID, startedAt: 1, endedAt: 2, bytes: large }), 0)
  assert.deepEqual(disk.files.get(`${SID}/0.json.gz`).data, large)
})

await test('replay delete: rows, storage objects and local files', async () => {
  const { r, disk, server } = makeReplay()
  r.addChunk({ sessionId: SID, startedAt: 1, endedAt: 2, bytes: bytes(10) })
  await r.deleteAll()
  const del = server.calls.find((c) => c.method === 'DELETE')
  assert.equal(del.url, `${SB}/rest/v1/desktop_replay_chunks?owner_id=eq.${USER_ID}`)
  assert.ok(server.calls.some((c) => c.url.includes('/storage/v1/object/list/desktop-replays')))
  assert.equal(disk.files.size, 0)
})

await test('program diff names the nodes and steps that were added, removed or changed', () => {
  const a = {
    title: 'T',
    nodes: [
      { id: 'n1', fields: [{ id: 'f', value: 'a' }] },
      { id: 'n2', fields: [] },
    ],
    steps: [{ id: 's1', rule: 'x' }],
  }
  const b = {
    title: 'T2',
    nodes: [
      { fields: [{ value: 'b', id: 'f' }], id: 'n1' },
      { id: 'n3', fields: [] },
    ],
    steps: [{ id: 's1', rule: 'x' }],
  }
  const d = programDiff(a, b)
  assert.deepEqual(d.sections.nodes, { added: ['n3'], removed: ['n2'], changed: ['n1'] })
  assert.equal(d.sections.steps, undefined) // unchanged sections are left out
  assert.deepEqual(d.keys, ['title'])
  assert.equal(d.total, 4)
  assert.equal(programDiff(a, JSON.parse(JSON.stringify(a))).total, 0) // key order does not matter either
  // sanitizer keeps the diff and blob reference, and long tool input/output only for content consent
  const { t } = make()
  const ctx = { content: true, email: EMAIL }
  const base = { installId: 'install-0001', sessionId: SID, appVersion: '0.2.0', platform: 'darwin', now: clock }
  const row = sanitizeEvent('project.program_version', { metadata: { version: 2, diff: d, blob: 'blobs/x.gz' } }, ctx, base)
  assert.deepEqual(row.metadata.diff.sections.nodes.added, ['n3'])
  assert.equal(row.metadata.blob, 'blobs/x.gz')
  const tool = sanitizeEvent('conversation.tool', { target: 'bash', metadata: { thread_id: 't', input: 'y'.repeat(5000), output: 'z'.repeat(5000) } }, ctx, base)
  assert.equal(tool.metadata.input.length, 5000)
  assert.equal(tool.metadata.output.length, 5000)
  assert.equal(sanitizeEvent('conversation.tool', { metadata: { input: 'y' } }, { ...ctx, content: false }, base), null)
  void t
})

await test('a dropped private file never reaches capture: tool calls naming sources/private or the wording cache are redacted', () => {
  const { redactPrivatePart, REDACTED_PRIVATE } = core
  const secret = 'How many minutes did you walk this morning? (invented private wording)'
  const ctx = { content: true, email: EMAIL }
  const base = { installId: 'install-0001', sessionId: SID, appVersion: '0.2.0', platform: 'darwin', now: clock }
  const parts = [
    { kind: 'tool', tool: 'read', state: 'completed', detail: 'Read booklet', input: { filePath: '/Users/x/Proj/sources/private/booklet.html' }, output: secret },
    { kind: 'tool', tool: 'bash', state: 'completed', detail: 'cat', input: { command: 'cd sources/private && cat booklet.html' }, output: secret },
    { kind: 'tool', tool: 'bash', state: 'completed', detail: 'x', input: { command: 'cat "C:\\Users\\x\\Proj\\sources\\private\\b.pdf"' }, output: secret },
    { kind: 'tool', tool: 'read', state: 'completed', detail: 'Read', input: { filePath: '/Users/x/Library/Application Support/HumanStudy Hub/original-text/ab/protocol.json' }, output: secret },
    { kind: 'native', raw: { tool: 'read', path: 'sources/private/booklet.html', content: secret } },
  ]
  for (const part of parts) {
    const p = redactPrivatePart(part)
    // as onThreadCapture builds the event: detail, input, output (or the raw part) in the metadata
    const metadata = p.kind === 'tool' ? { thread_id: 't', detail: p.detail, input: typeof p.input === 'string' ? p.input : JSON.stringify(p.input), output: p.output }
      : { thread_id: 't', content: JSON.stringify(p) }
    const row = sanitizeEvent(p.kind === 'tool' ? 'conversation.tool' : 'conversation.native', { target: part.tool, metadata }, ctx, base)
    assert.ok(!JSON.stringify(row ?? {}).includes('walk this morning'), JSON.stringify(row))
    if (p.kind === 'tool') assert.equal(p.output, REDACTED_PRIVATE)
  }
  // ordinary work is captured unchanged
  const plain = { kind: 'tool', tool: 'read', state: 'completed', detail: 'Read', input: { filePath: 'sources/open/handout.txt' }, output: 'public text' }
  assert.equal(redactPrivatePart(plain), plain)
  assert.equal(redactPrivatePart({ kind: 'tool', input: { filePath: 'sources/open/notes-on-privacy.txt' }, output: 'x' }).output, 'x')
  // the transcript capture redacts before anything is stored or put in a blob
  const src = readFileSync(join(here, 'telemetry.ts'), 'utf8')
  const capture = src.slice(src.indexOf('export function onThreadCapture'))
  assert.ok(capture.indexOf('redactPrivatePart(c.part, privateIndex,') > 0 && capture.indexOf('redactPrivatePart(c.part, privateIndex,') < capture.indexOf("fit(base, 'input'"))
})

await test('redaction by path survives the ways an agent names the folder (review probe red.mjs); the status file is not redacted', () => {
  const { redactPrivatePart } = core
  const leak = (command) => redactPrivatePart({ kind: 'tool', tool: 'bash', input: { command }, output: 'SECRET' }).output === 'SECRET'
  for (const c of ['cd sources; cat private/booklet.html', 'cat sources/priv*/booklet.html',
    "python3 -c \"print(open('sources/'+'private/b.html').read())\"", 'cat ./sources/./private/b.html',
    'find sources -name "*.html" -exec cat {} +', 'file:///Users/x/P/sources%2Fprivate/b.html', 'hs-pdf sources/private/b.pdf',
    '/Users/x/Library/Application Support/HumanStudy Hub/original-text/ab/protocol.json', 'cat sources/Private/b.html',
    'grep -r walk sources/', 'cat sources/*'])
    assert.equal(leak(c), false, c)
  for (const c of ['cat .humanstudy/original-text.json', 'cat sources/open/handout.txt', 'python .opencode/skills/build/sources.py .', 'ls sources/open'])
    assert.equal(leak(c), true, c)
})

await test('redaction by content: any agent step that quotes 40 characters of a private copy is dropped, however it got there', () => {
  const { redactPrivatePart, containsPrivateRun, privateIndexOf, SCAN_LIMIT } = core
  const privateText = 'Before you begin, please take a slow walk around the block and notice the colour of every front door you pass.'
  const index = privateIndexOf([privateText])
  const quote = 'it says: "please take a SLOW walk around the block, and notice the colour of every front door"'
  assert.equal(containsPrivateRun(quote, index), true, 'case, spacing and punctuation do not hide a quote')
  assert.equal(containsPrivateRun('please take a slow walk around', index), false, 'shorter than 40 letters')
  const tool = redactPrivatePart({ kind: 'tool', tool: 'bash', input: { command: 'cat $(ls -d s*)/p*/b.html' }, output: privateText }, index)
  assert.equal(tool.output, '[redacted: private material]')
  assert.equal(redactPrivatePart({ kind: 'text', text: 'The booklet reads: ' + quote }, index).text, '[redacted: private material]')
  assert.deepEqual(redactPrivatePart({ kind: 'reasoning', text: quote }, index), { kind: 'reasoning', redacted: 'private-material' })
  const plain = { kind: 'text', text: 'I filled in 3 screens of the walking study.' }
  assert.equal(redactPrivatePart(plain, index), plain)
  // a part too long to scan is redacted whole while anything is indexed (never sent in part)
  const long = 'x'.repeat(SCAN_LIMIT) + ' ' + privateText
  assert.equal(redactPrivatePart({ kind: 'text', text: long }, index).text, '[redacted: private material]')
  assert.equal(redactPrivatePart({ kind: 'text', text: long }, core.EMPTY_INDEX).text, long, 'nothing indexed: nothing to hide')
})

await test('glob and search rules apply only where the project has a sources/private/ folder', () => {
  const { redactPrivatePart } = core
  const kept = (command, globs) => redactPrivatePart({ kind: 'tool', tool: 'bash', input: { command }, output: 'OUT' }, core.EMPTY_INDEX, globs).output === 'OUT'
  for (const c of ['ls sources/*.pdf', 'find sources -name SOURCE.json', 'rg "Results" sources']) {
    assert.equal(kept(c, false), true, c + ' in an ordinary project')
    assert.equal(kept(c, true), false, c + ' where sources/private/ exists')
  }
  assert.equal(kept('cat sources/private/b.html', false), false, 'the private path itself always counts')
})

await test('project files: a published study\'s run outputs are never collected, nor any file that quotes private text', () => {
  const { mayCollectFile, privateIndexOf, EMPTY_INDEX } = core
  const wording = 'Thank you for joining this short study about walking before breakfast, says the invented handout.'
  const index = privateIndexOf([wording])
  // a run of a published study: its records quote the restored wording in the AI participants' replies
  const reply = JSON.stringify({ note: { reply: 'The page said: thank you for joining this short study about walking before breakfast.' } })
  for (const rel of ['artifacts/simulations/2026-11-10-0100/records.jsonl', 'artifacts/simulations/2026-11-10-0100/results.html',
    'artifacts/simulations/2026-11-10-0100/baseline/records.jsonl', 'runs/2026-11-10/sessions.jsonl'])
    assert.equal(mayCollectFile({ rel, text: rel.endsWith('.html') ? '<p>ok</p>' : undefined, published: true, index: EMPTY_INDEX }), false, rel)
  // any artifact holding private text is skipped, published or not
  assert.equal(mayCollectFile({ rel: 'artifacts/notes.md', text: 'My notes. ' + reply, published: false, index }), false)
  assert.equal(mayCollectFile({ rel: 'sources/open/extract.txt', text: wording, published: false, index }), false)
  // a file that cannot be read as text is not collected while anything is indexed, in a published study
  assert.equal(mayCollectFile({ rel: 'artifacts/figure.png', text: undefined, published: true, index }), false)
  // ordinary work is collected as before; an ordinary project keeps collecting its PDFs and figures and long texts
  assert.equal(mayCollectFile({ rel: 'artifacts/notes.md', text: 'My own notes.', published: false, index }), true)
  assert.equal(mayCollectFile({ rel: 'paper.pdf', text: undefined, published: false, hasPrivate: false, index }), true)
  assert.equal(mayCollectFile({ rel: 'artifacts/fig.png', text: undefined, published: false, hasPrivate: false, index }), true)
  assert.equal(mayCollectFile({ rel: 'artifacts/big.md', text: 'x '.repeat(200_000), published: false, hasPrivate: false, index }), true)
  assert.equal(mayCollectFile({ rel: 'artifacts/fig.png', text: undefined, published: false, hasPrivate: true, index }), false)
  assert.equal(mayCollectFile({ rel: 'artifacts/simulations/x/records.jsonl', text: undefined, published: false, index: EMPTY_INDEX }), true)
  // and the capture paths use it
  const src = readFileSync(join(here, 'telemetry.ts'), 'utf8')
  for (const fn of ['async function snapshotFileNow', 'async function queueSource']) {
    const body = src.slice(src.indexOf(fn), src.indexOf('\n}\n', src.indexOf(fn)))
    assert.match(body, /mayCollectFile\(/, fn)
  }
})

await test('research-v1 capture: an agent reading a private copy and quoting it reaches capture with neither path nor text (review probe ra.mjs)', async () => {
  const { createResearchAgent } = agentMod
  const { redactCapture, privateIndexOf, EMPTY_INDEX } = core
  const SECRET = 'How many minutes did you walk this morning? Did you see a neighbour on the way to work?'
  for (const index of [privateIndexOf([SECRET]), EMPTY_INDEX]) {
    const got = []
    // the sink is the capture boundary exactly as telemetry.ts wires it (captureResearch -> redactCapture)
    const ra = createResearchAgent(async (ev) => { got.push(redactCapture(ev, index, true)); return 'id' })
    ra.bind('s1', 'p1', '/proj')
    ra.start('s1', 'hello')
    ra.event({ type: 'tool', sessionId: 's1', toolCallId: 't1', tool: 'read', text: 'running', input: { filePath: '/proj/sources/private/booklet.txt' } })
    ra.event({ type: 'tool', sessionId: 's1', toolCallId: 't1', tool: 'read', text: 'completed', output: SECRET })
    ra.event({ type: 'tool', sessionId: 's1', toolCallId: 't2', tool: 'bash', text: 'running', input: { command: 'cd sources; cat private/booklet.txt' } })
    ra.event({ type: 'tool', sessionId: 's1', toolCallId: 't2', tool: 'bash', text: 'completed', output: SECRET })
    if (index.size) ra.event({ type: 'text', sessionId: 's1', text: 'The booklet says: ' + SECRET })
    ra.event({ type: 'error', sessionId: 's1', text: 'failed reading /proj/sources/private/booklet.txt: ' + SECRET })
    ra.event({ type: 'done', sessionId: 's1' })
    await ra.drain?.()
    const all = JSON.stringify(got)
    assert.ok(!all.includes('sources/private') && !all.includes('private/booklet'), 'no private path')
    assert.ok(!all.includes('neighbour on the way'), 'no private text')
    assert.ok(got.some((e) => e.event_type === 'tool.end'), 'the steps themselves are still recorded')
  }
  // every capture sink in telemetry.ts goes through the one boundary
  const src = readFileSync(join(here, 'telemetry.ts'), 'utf8')
  assert.equal((src.match(/sourceCollector\(\)\.capture\(/g) || []).length, 1, 'only captureResearch calls the collector')
  assert.match(src, /return sourceCollector\(\)\.capture\(redactCapture\(event, privateIndex,/)
  assert.match(src, /createResearchAgent\(\(event, context\) => captureResearch\(event, context\)\)/)
  assert.match(src, /let metadata = opts\.metadata \? redactCapture\(/, 'telemetry metadata too, before any blob')
})

await test('the capture boundary keeps ordinary events whole and redacts only content fields of a private one', () => {
  const { redactCapture, privateIndexOf, EMPTY_INDEX } = core
  const ev = { event_type: 'tool.end', tool_call_id: 't', target: 'read', metadata: { status: 'completed', output: 'public result' } }
  assert.equal(redactCapture(ev, EMPTY_INDEX, false), ev)
  const priv = redactCapture({ ...ev, metadata: { ...ev.metadata, input: 'sources/private/x.pdf' } }, EMPTY_INDEX, false)
  assert.deepEqual([priv.event_type, priv.tool_call_id, priv.target, priv.metadata.status, priv.metadata.output, priv.metadata.redacted],
    ['tool.end', 't', 'read', 'completed', '[redacted: private material]', 'private-material'])
  // an ordinary project with the words "sources" and "private" in a program is not redacted (no private folder)
  const prog = { event_type: 'program.version', metadata: { file: 'Sources: the private sector survey' } }
  assert.equal(redactCapture(prog, EMPTY_INDEX, false), prog)
  // a long event of an ordinary project is scanned, not dropped
  const big = { event_type: 'artifact.version', metadata: { file: 'y '.repeat(200_000) } }
  assert.equal(redactCapture(big, privateIndexOf(['A completely different private sentence that is long enough.']), false), big)
})

await test('each string is checked raw: quotes over several lines, tabs, escaped JSON, heredocs and numbered reads are caught (review probe rc.mjs)', async () => {
  const { createResearchAgent } = agentMod
  const { redactCapture, redactPrivatePart, privateIndexOf, holdsPrivate } = core
  const SECRET = 'How many minutes did you walk this morning? Did you see a neighbour on the way to work?'
  const ITEMS = ['I often feel nervous at work.', 'My manager listens to me.', 'I trust my colleagues fully.', 'I would leave this job soon.']
  const idx = privateIndexOf([SECRET, ITEMS.join('\n')])
  // A: a single-line quote through the agent adapter and the boundary
  const got = []
  const ra = createResearchAgent(async (ev) => { got.push(redactCapture(ev, idx, true)); return 'id' })
  ra.bind('s1', 'p1', '/proj'); ra.start('s1', 'hello')
  ra.event({ type: 'tool', sessionId: 's1', toolCallId: 't1', tool: 'read', text: 'completed', input: { filePath: '/proj/sources/private/booklet.txt' }, output: SECRET })
  ra.event({ type: 'text', sessionId: 's1', text: 'The booklet says: ' + SECRET })
  ra.event({ type: 'done', sessionId: 's1' }); await ra.drain?.()
  assert.ok(!JSON.stringify(got).includes('neighbour on the way'), 'A')
  const leaks = (ev) => JSON.stringify(redactCapture(ev, idx, true)).includes('nervous at work')
  // B: a multi-line quote, every line shorter than 40 letters
  const q = 'Items:\n' + ITEMS.join('\n')
  assert.equal(leaks({ event_type: 'conversation.message', metadata: { text: q } }), false, 'B')
  assert.ok(!JSON.stringify(redactPrivatePart({ kind: 'text', text: q }, idx)).includes('nervous at work'), 'B, transcript part')
  // C: a heredoc inside a JSON-string tool input (escaped newlines)
  assert.equal(leaks({ event_type: 'tool.start', metadata: { input: JSON.stringify({ command: 'cat > notes.txt <<EOF\n' + ITEMS.join('\n') + '\nEOF' }) } }), false, 'C')
  // D: tab-joined, and CRLF
  assert.equal(leaks({ event_type: 'x', metadata: { t: ITEMS.join('\t') } }), false, 'D tabs')
  assert.equal(leaks({ event_type: 'x', metadata: { t: ITEMS.join('\r\n') } }), false, 'D CRLF')
  // a read tool's numbered lines
  assert.equal(leaks({ event_type: 'tool.end', metadata: { output: ITEMS.map((l, i) => `${String(i + 1).padStart(5)}| ${l}`).join('\n') } }), false, 'line numbers')
  // \u escapes inside a JSON string
  assert.equal(holdsPrivate(JSON.stringify({ t: SECRET.replace(/ /g, '\\u0020') }), idx, true), true)
  // ordinary text passes untouched
  const plain = { event_type: 'x', metadata: { t: 'Line one of my own notes.\nLine two of my own notes.' } }
  assert.equal(redactCapture(plain, idx, true), plain)
})

await test('blobs pass the boundary: an oversized workspace or program.json holding private text never becomes a blob', () => {
  const { holdsPrivate, privateIndexOf, redactCapture } = core
  const SECRET = 'How many minutes did you walk this morning? Did you see a neighbour on the way to work?'
  const idx = privateIndexOf([SECRET])
  const workspace = { project: '/p', activeTab: 'file', openTabs: Array.from({ length: 400 }, (_, i) => `artifacts/f${i}.md`),
    source: { file: 'notes.md', quote: SECRET } }
  assert.ok(JSON.stringify(workspace).length > 5_500, 'too large to go inline: it would become a blob')
  assert.equal(holdsPrivate(JSON.stringify(workspace), idx, true), true, 'the blob check refuses it')
  assert.ok(!JSON.stringify(redactCapture(workspace, idx, true)).includes('neighbour'), 'redacted before fit')
  const program = JSON.stringify({ schemaVersion: 2, nodes: [{ id: 'n1', fields: { text: SECRET } }], pad: 'x'.repeat(20_000) }, null, 2)
  assert.equal(holdsPrivate(program, idx, true), true)
  assert.equal(holdsPrivate(JSON.stringify({ schemaVersion: 2, nodes: [{ id: 'n1', fields: { text: 'my own design' } }] }), idx, true), false)
  // the wiring: putBlob refuses private text itself, fit checks before anything goes inline or to a blob, and the
  // workspace is redacted before fit
  const src = readFileSync(join(here, 'telemetry.ts'), 'utf8')
  const put = src.slice(src.indexOf('function putBlob'), src.indexOf('\n}\n', src.indexOf('function putBlob')))
  assert.ok(put.indexOf('privateText(text, projectDir)') > 0 && put.indexOf('privateText(text, projectDir)') < put.indexOf('storeResearchContent'))
  const fitSrc = src.slice(src.indexOf('function fit('), src.indexOf('\n}\n', src.indexOf('function fit(')))
  assert.ok(fitSrc.indexOf('privateText(value, projectDir)') > 0 && fitSrc.indexOf('privateText(value, projectDir)') < fitSrc.indexOf('putBlob('))
  assert.match(src, /fit\(base, 'workspace', JSON\.stringify\(redactCapture\(c\.workspace, privateIndex, scopedProject\(c\.dir\)\)\)/)
  assert.match(src, /redactPrivatePart\(c\.part, privateIndex, scopedProject\(c\.dir\)\)/)
  assert.equal((src.match(/putBlob\(/g) || []).length - 1, (src.match(/putBlob\((?:value|text|raw|JSON\.stringify\(metadata\)), (?:projectDir|dirFor)\)/g) || []).length, 'every blob goes through putBlob')
})

await test('letters only: re-numbered items, Q1:, a 1-5 column and changed numbering still match; CJK too (review probes probe2/probe3)', () => {
  const { redactCapture, privateIndexOf, holdsPrivate, track: _t } = core
  const ITEMS = ['I often feel nervous at work.', 'My manager listens to me.', 'I trust my colleagues fully.', 'I would leave this job soon.']
  for (const source of [ITEMS.join('\n'), ITEMS.map((l, i) => `${i + 1}. ${l}`).join('\n')]) {
    const idx = privateIndexOf([source])
    const leaks = (t) => JSON.stringify(redactCapture({ event_type: 'x', metadata: { t } }, idx, true)).includes('nervous at work')
    const cases = {
      numbered: ITEMS.map((l, i) => `${i + 1}. ${l}`).join('\n'),
      renumbered: ITEMS.map((l, i) => `${i + 7}) ${l}`).join('\n'),
      unnumbered: ITEMS.join('\n'),
      q: ITEMS.map((l, i) => `Q${i + 1}: ${l}`).join('\n'),
      item: ITEMS.map((l, i) => `Item ${i + 1}: ${l}`).join('\n'),
      lettered: ITEMS.map((l, i) => `(${'abcd'[i]}) ${l}`).join('\n'),
      bullets: ITEMS.map((l) => `- ${l}`).join('\n'),
      table: '| item | scale |\n|---|---|\n' + ITEMS.map((l) => `| ${l} | 1-5 |`).join('\n'),
      json: JSON.stringify(ITEMS),
      escaped: JSON.stringify(JSON.stringify(ITEMS.map((l, i) => `Q${i + 1}: ${l}`).join('\n'))),
    }
    for (const [k, v] of Object.entries(cases)) assert.equal(leaks(v), false, `${k} (source ${source.startsWith('1.') ? 'numbered' : 'plain'})`)
  }
  // CJK characters are letters
  const zh = '我经常在工作中感到紧张。我的经理会倾听我的意见。我完全信任我的同事。我很快会离开这份工作。我对现在的工资感到满意。'
  const zidx = privateIndexOf([zh])
  assert.equal(holdsPrivate('1. 我经常在工作中感到紧张。\n2. 我的经理会倾听我的意见。\n3. 我完全信任我的同事。\n4. 我很快会离开这份工作。\n5. 我对现在的工资感到满意。', zidx, true), true)
})

await test('letters only does not over-redact ordinary text: false positives against a questionnaire index', () => {
  const { privateIndexOf, holdsPrivate, containsPrivateRun } = core
  const questionnaire = ['How many minutes did you walk this morning?', 'Did you see a neighbour on the way to work?',
    'I often feel nervous at work.', 'My manager listens to me.', 'I trust my colleagues fully.', 'I would leave this job soon.',
    'How satisfied are you with your life as a whole these days?', 'In general, would you say your health is excellent, very good, good, fair or poor?']
  const idx = privateIndexOf([questionnaire.join('\n')])
  const ordinary = [
    'The study replicates a classic finding on how framing changes risky choices. Participants read a short scenario and chose between two programmes.',
    'I filled in the method section and checked every condition against the paper. The sample was recruited online and paid a fixed fee.',
    'Results: the effect was in the same direction as in the original study, but smaller. We report means, standard deviations and the test statistic.',
    'Please review the protocol, then run the simulation with ten participants per arm. The run will take a few minutes and costs very little.',
    'The questionnaire asks about the participant\'s work, their manager and their colleagues, and about their health and how satisfied they are.',
    'Of the people who answered, most said they walked to work in the morning and saw a neighbour on the way, as expected from the original data.',
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam.',
    'This is a long ordinary sentence with many common English words that appear in almost every text about research and studies of people.',
  ]
  const hits = ordinary.filter((t) => containsPrivateRun(t, idx))
  console.log(`  false positives: ${hits.length} of ${ordinary.length} ordinary texts against a ${questionnaire.length}-item questionnaire index (${idx.size} windows)`)
  assert.equal(hits.length, 0)
  assert.equal(holdsPrivate(ordinary.join('\n'), idx, true), false)
})

await test('a withheld file\'s name is not logged as an event target', () => {
  const src = readFileSync(join(here, 'telemetry.ts'), 'utf8')
  const body = src.slice(src.indexOf('export function track('), src.indexOf('\n}\n', src.indexOf('export function track(')))
  assert.match(body, /if \(typeof legacy\.target === 'string' && namesPrivatePath\(legacy\.target, false\)\) legacy\.target = REDACTED_PRIVATE/)
  assert.match(body, /namesPrivatePath\(opts\.target, false\) \? \{ target: REDACTED_PRIVATE \}/)
  assert.equal(core.namesPrivatePath('sources/private/booklet.html', false), true)
  assert.equal(core.namesPrivatePath('artifacts/notes.md', false), false)
})

await test('enumerators of every common shape are removed, at line start and mid-line (review probe probe4)', () => {
  const { redactCapture, privateIndexOf, stripEnumerators } = core
  const ITEMS = ['I often feel nervous at work.', 'My manager listens to me.', 'I trust my colleagues fully.', 'I would leave this job soon.']
  const R = ['i', 'ii', 'iii', 'iv']
  for (const src of [ITEMS.join('\n'), ITEMS.map((l, i) => `${i + 1}. ${l}`).join('\n')]) {
    const idx = privateIndexOf([src])
    const leaks = (t) => JSON.stringify(redactCapture({ event_type: 'x', metadata: { t } }, idx, true)).includes('nervous at work')
    const cases = {
      roman: ITEMS.map((l, i) => `${R[i]}. ${l}`).join('\n'),
      romanParen: ITEMS.map((l, i) => `(${R[i]}) ${l}`).join('\n'),
      question: ITEMS.map((l, i) => `Question ${i + 1}: ${l}`).join('\n'),
      statement: ITEMS.map((l, i) => `Statement ${i + 1}: ${l}`).join('\n'),
      S1: ITEMS.map((l, i) => `S${i + 1}. ${l}`).join('\n'),
      A1: ITEMS.map((l, i) => `A${i + 1}) ${l}`).join('\n'),
      boldnum: ITEMS.map((l, i) => `**${i + 1}.** ${l}`).join('\n'),
      hash: ITEMS.map((l, i) => `#${i + 1} ${l}`).join('\n'),
      mdheading: ITEMS.map((l, i) => `### Q${i + 1}\n${l}`).join('\n'),
      inline: ITEMS.map((l, i) => `(${i + 1}) ${l}`).join(' '),
      inlineQ: ITEMS.map((l, i) => `Q${i + 1}: ${l}`).join(' '),
      inlineLetter: ITEMS.map((l, i) => `(${'abcd'[i]}) ${l}`).join(' '),
      semicolon: ITEMS.join('; '),
      quotes: ITEMS.map((l) => `"${l}"`).join(', '),
      numTab: ITEMS.map((l, i) => `${i + 1}\t${l}`).join('\n'),
      zhNum: ITEMS.map((l, i) => `第${i + 1}题：${l}`).join('\n'),
      crlf: ITEMS.map((l, i) => `Q${i + 1}. ${l}`).join('\r\n'),
    }
    for (const [k, v] of Object.entries(cases)) assert.equal(leaks(v), false, `${k} (${src.startsWith('1.') ? 'numbered' : 'plain'} source)`)
  }
  // ordinary prose keeps its words: only enumerator shapes go
  assert.equal(stripEnumerators('My manager listens to me. I agree (mostly).'), 'My manager listens to me. I agree (mostly).')
  // the accepted limit, named in the doc: per-item structured data (JSON objects with ids, YAML, CSV) is not recognised
})

console.log(`\n${passed} passed`)

await test('large Unicode content reconstructs exactly from ordered gzip parts', () => {
  const text = 'α🙂 boundary\n'.repeat(400_000)
  const stored = new Map()
  const path = storeResearchContent(text, bytes => { const id = `blobs/${stored.size}.gz`; stored.set(id, bytes); return id })
  const manifest = JSON.parse(gunzipSync(stored.get(path)).toString('utf8'))
  assert.equal(manifest.format, 'humanstudy-content-parts-v1')
  assert.ok(manifest.parts.length >= 2)
  const reconstructed = Buffer.concat(manifest.parts.map(id => gunzipSync(stored.get(id))))
  assert.equal(reconstructed.length, manifest.bytes)
  assert.equal(reconstructed.toString('utf8'), text)
})


await test('interaction-only collection rejects recordings and preserves complete research blobs', async () => {
  const { r, disk, server } = makeReplay({ interactionOnly: true })
  assert.equal(r.addChunk({ sessionId: SID, startedAt: 1, endedAt: 2, bytes: bytes(10) }), null)
  assert.equal(disk.files.size, 0)
  const blob = r.addBlob(SID, bytes(100))
  assert.ok(blob)
  await r.flush({ force: true })
  assert.equal(server.calls.length, 1)
  assert.ok(server.calls[0].url.includes('/blobs/'))
  assert.equal(server.calls[0].body.length, 100)
})
await test('interaction-only collection keeps old recordings local without uploading or deleting them', async () => {
  const { r, disk, server } = makeReplay({ interactionOnly: true })
  const path = `${SID}/0.json.gz`
  disk.write(path, bytes(20))
  disk.write(`${SID}/0.meta.json`, JSON.stringify({ kind: 'chunk', acct: 'acct1', bytes: 20 }))
  r.addBlob(SID, bytes(50))
  await r.flush({ force: true })
  assert.ok(disk.read(path))
  assert.ok(disk.read(`${SID}/0.meta.json`))
  assert.equal(server.calls.length, 1)
  assert.ok(server.calls[0].url.includes('/blobs/'))
})

await test('movement and keystroke streams are rejected while semantic actions remain available', async () => {
  const { t } = make()
  await t.setConsent({ usage: true, content: true })
  for (const type of ['mousemove', 'pointermove', 'mouse.move', 'pointer.move', 'input.keystroke', 'mouse.trajectory']) assert.equal(t.track(type), null, type)
  for (const type of ['tab.switch', 'source.select', 'composer.send', 'source.page', 'permission.reply']) assert.ok(t.track(type), type)
})
