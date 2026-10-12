// Research data (telemetry-core.ts) test against a stubbed fetch and in-memory storage:
//   node src/main/telemetry.test.mjs
// Covers consent gating, the payload sanitizer, batching, retry/backoff, the queue cap, the
// 30-day age drop, persistence, withdrawal and "Delete my data".
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'telemetry-test-'))
await build({
  entryPoints: [join(here, 'telemetry-core.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: out,
  logLevel: 'error',
})
const core = await import(pathToFileURL(join(out, 'telemetry-core.js')).href)
rmSync(out, { recursive: true, force: true })
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

await test('sanitizer: event type, conversation gating, account email, size caps', () => {
  const ctx = { content: false, email: EMAIL }
  assert.equal(sanitizeEvent('Bad Type', {}, ctx, base), null)
  assert.equal(sanitizeEvent('x', {}, ctx, base), null)
  assert.equal(sanitizeEvent('conversation.user', { metadata: { text: 'hi' } }, ctx, base), null)
  const conv = sanitizeEvent('conversation.user', { metadata: { text: `mail me at ${EMAIL.toLowerCase()} please` } }, { ...ctx, content: true }, base)
  assert.equal(conv.metadata.text, 'mail me at [email] please')
  const big = sanitizeEvent('conversation.assistant', { metadata: { text: 'x'.repeat(50_000) } }, { ...ctx, content: true }, base)
  assert.ok(Buffer.byteLength(JSON.stringify(big.metadata)) <= 16_000)
  const many = sanitizeEvent('ui.test', { target: 'y'.repeat(500), metadata: { list: Array.from({ length: 100 }, (_, i) => 'z'.repeat(400) + i) } }, ctx, base)
  assert.equal(many.target.length, 160)
  assert.ok(Buffer.byteLength(JSON.stringify(many.metadata)) <= 16_000)
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

await test('retry with backoff on 5xx and network errors; 4xx rejections are dropped', async () => {
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
  assert.equal(t.status().pending, 0)
  assert.equal(t.recent()[0].status, 'dropped')
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

await test('the queue is capped at QUEUE_CAP (oldest dropped) and persists across restarts', async () => {
  const storage = memoryStorage()
  const server = stubServer()
  server.status = 500
  const { t } = make({ storage, server })
  await t.setConsent({ usage: true, content: false })
  for (let i = 0; i < QUEUE_CAP + 25; i++) t.track('ui.click', { target: `c${i}` })
  assert.equal(t.status().pending, QUEUE_CAP)
  // A new process reads the same JSONL queue (including a torn last line).
  storage.s.queue += '{"acct":"torn'
  const again = make({ storage, server: stubServer() })
  assert.equal(again.t.status().pending, QUEUE_CAP)
  assert.equal(again.t.status().usage, true)
  await again.t.flush({ force: true })
  const rows = posted(again.server)
  assert.equal(rows.length, QUEUE_CAP)
  assert.equal(rows[0].target, 'c25')
  assert.equal(again.t.status().pending, 0)
  assert.equal(storage.s.queue, '')
})

await test('events older than 30 days are dropped instead of sent', async () => {
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
  assert.deepEqual(posted(server).map((r) => r.event_type), ['ui.recent'])
  // And on startup, from the persisted queue.
  server.status = 500
  t.track('ui.stale')
  clock += 31 * DAY
  const again = make({ storage })
  assert.equal(again.t.status().pending, 0)
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

console.log(`\n${passed} passed`)
