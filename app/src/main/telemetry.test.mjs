// Research data: consent gating, sanitizer, queue/batching/backoff and deletion against a stubbed
// fetch (no network, no Electron):
//   node src/main/telemetry.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
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
const T = await import(pathToFileURL(join(out, 'telemetry-core.js')).href)

// ---- sanitizer --------------------------------------------------------------------------
const base = { installId: 'install-1234', sessionId: 'session-1234', appVersion: '0.1.0', platform: 'darwin', now: Date.UTC(2026, 9, 1) }
const ctx = { projectDir: '/Users/r/HumanStudy/Knobe 2003', email: 'Ann.Lee@Uni.edu', content: false }

assert.equal(T.sanitizeEvent('Bad Type', {}, ctx, base), null, 'event_type must match the server pattern')
assert.equal(T.sanitizeEvent('conversation.user', { metadata: { text: 'hi' } }, ctx, base), null, 'no conversation without content consent')

let row = T.sanitizeEvent(
  'artifact.created',
  {
    target: '/Users/r/HumanStudy/Knobe 2003/artifacts/flow.html',
    durationMs: 12.7,
    projectId: 'proj-abcdef12',
    metadata: {
      file: '/Users/r/HumanStudy/Knobe 2003/exports/a.csv',
      outside: 'read /etc/passwd and ~/secrets.txt',
      note: 'mail ann.lee@uni.edu or bob@x.org',
      apiKey: 'sk-or-v1-abcdefabcdefabcdef',
      token: 'x',
      email: 'ann.lee@uni.edu',
      text: 'conversation text is not allowed here',
      leaked: 'key sk-ant-api03-ABCDEFGHIJKLMNOP and hsk_12345678abcd',
      url: 'https://github.com/HumanStudy-Hub/x',
      nested: { deeper: { path: 'C:\\Users\\r\\paper.pdf' } },
      tools: ['read', 'write'],
      n: 3,
    },
  },
  ctx,
  base
)
assert.equal(row.target, 'artifacts/flow.html', 'project paths become project-relative')
assert.equal(row.duration_ms, 13)
assert.equal(row.project_id, 'proj-abcdef12')
assert.equal(row.metadata.file, 'exports/a.csv')
assert.equal(row.metadata.outside, 'read [path] and [path]')
assert.equal(row.metadata.note, 'mail [email] or [email]')
assert.equal(row.metadata.leaked, 'key [secret] and [secret]')
assert.equal(row.metadata.url, 'https://github.com/HumanStudy-Hub/x', 'URLs are not paths')
assert.equal(row.metadata.nested.deeper.path, '[path]')
for (const k of ['apiKey', 'token', 'email', 'text']) assert.ok(!(k in row.metadata), `${k} must be dropped`)
assert.deepEqual(row.metadata.tools, ['read', 'write'])
assert.equal(row.consent_version, T.CONSENT_VERSION)
assert.equal(row.platform, 'darwin')
assert.match(row.id, /^[0-9a-f-]{36}$/)
const flat = JSON.stringify(row)
assert.ok(!/ann\.lee|sk-or|sk-ant|hsk_|\/Users\//i.test(flat), 'no email, key or absolute path anywhere: ' + flat)

row = T.sanitizeEvent('conversation.user', { metadata: { text: `Look at /Users/r/HumanStudy/Knobe 2003/program.json, I am ann.lee@uni.edu` } }, { ...ctx, content: true }, base)
assert.equal(row.metadata.text, 'Look at program.json, I am [email]')
row = T.sanitizeEvent('conversation.assistant', { metadata: { text: 'x'.repeat(50_000) } }, { ...ctx, content: true }, base)
assert.ok(Buffer.byteLength(JSON.stringify(row.metadata)) <= 16_000, 'metadata stays under 16KB')
row = T.sanitizeEvent('a.b', { target: 'y'.repeat(400), projectId: 'short' }, ctx, base)
assert.equal(row.target.length, 160)
assert.equal(row.project_id, null, 'project ids outside 8-80 chars are dropped')

// ---- telemetry with stubbed storage, auth and fetch ---------------------------------------
let clock = Date.UTC(2026, 9, 1, 12)
let email = null
let online = true
let failNext = 0
const posts = []
const deletes = []
const files = { state: null, queue: '', recent: [] }
const storage = {
  readState: () => (files.state ? structuredClone(files.state) : null),
  writeState: (s) => (files.state = structuredClone(s)),
  readQueue: () => files.queue,
  appendQueue: (l) => (files.queue += l),
  writeQueue: (c) => (files.queue = c),
  readRecent: () => structuredClone(files.recent),
  writeRecent: (r) => (files.recent = structuredClone(r)),
}
const SB = 'https://sb.test'
const stubFetch = async (url, init = {}) => {
  if (!online) throw new TypeError('fetch failed')
  const h = init.headers
  assert.equal(h.apikey, 'pub-key')
  assert.equal(h.authorization, 'Bearer AT')
  if (init.method === 'POST') {
    assert.equal(url, `${SB}/rest/v1/desktop_events`)
    assert.equal(h.prefer, 'resolution=ignore-duplicates,return=minimal')
    if (failNext > 0) {
      failNext--
      return new Response('{}', { status: 503 })
    }
    posts.push(JSON.parse(init.body))
    return new Response(null, { status: 201 })
  }
  if (init.method === 'DELETE') {
    deletes.push(url)
    return new Response(null, { status: 204 })
  }
  throw new Error('unexpected ' + url)
}
const deps = {
  fetch: stubFetch,
  storage,
  accountEmail: () => email,
  auth: async () => (email ? { supabaseUrl: SB, supabaseKey: 'pub-key', accessToken: 'AT', userId: 'user-1' } : null),
  appVersion: '0.1.0',
  platform: 'darwin',
  now: () => clock,
}
let t = T.createTelemetry(deps)

// Signed out: nothing is queued and consent cannot be given.
assert.equal(t.track('pane.fold', { target: 'agent' }), null)
await assert.rejects(t.setConsent({ usage: true, content: false }), /Sign in/)
assert.equal(t.status().signedIn, false)

// Signed in but undecided: still nothing.
email = 'ann.lee@uni.edu'
assert.equal(t.status().decided, false)
assert.equal(t.track('pane.fold', { target: 'agent' }), null)

// Declining sends nothing, not even a consent record.
let st = await t.setConsent({ usage: false, content: true })
assert.deepEqual([st.decided, st.usage, st.content, st.pending], [true, false, false, 0])
assert.equal(files.queue, '')

// Usage on: consent.granted then events; conversation stays blocked.
st = await t.setConsent({ usage: true, content: false })
assert.equal(st.pending, 1)
assert.equal(t.track('conversation.user', { metadata: { text: 'hi' } }), null)
t.track('pane.fold', { target: 'agent' })
assert.equal(t.status().pending, 2)
assert.equal(files.queue.trim().split('\n').length, 2, 'queue is persisted as JSONL')
await t.flush()
assert.equal(posts.length, 1)
assert.deepEqual(posts[0].map((r) => r.event_type), ['consent.granted', 'pane.fold'])
assert.equal(posts[0][0].metadata.usage, true)
assert.ok(!('owner_id' in posts[0][0]), 'owner_id is set by the server')
assert.equal(t.status().sent, 2)
assert.equal(t.status().pending, 0)
assert.equal(t.recent()[0].status, 'sent')

// Batching: reaching 50 events triggers a flush; large queues go in chunks of MAX_BATCH.
posts.length = 0
for (let i = 0; i < T.FLUSH_AT; i++) t.track('program.item_pick', { target: `n${i}` })
await t.flush() // joins the in-flight automatic flush
assert.equal(posts.length, 1)
assert.equal(posts[0].length, T.FLUSH_AT)

// Offline: retried with backoff, nothing lost; persisted queue survives a restart.
posts.length = 0
online = false
t.track('tab.switch', { target: 'protocol' })
await t.flush()
assert.equal(t.status().pending, 1)
assert.ok(t.status().lastError)
online = true
await t.flush()
assert.equal(posts.length, 0, 'inside the backoff window nothing is attempted')
t = T.createTelemetry(deps) // restart
assert.equal(t.status().pending, 1, 'pending events reload from JSONL')
failNext = 2
await t.flush() // fails: retry after 15s
assert.equal(t.status().pending, 1)
clock += 16_000
await t.flush() // fails again: retry after 30s
assert.equal(failNext, 0)
clock += 16_000
await t.flush()
assert.equal(posts.length, 0, 'second failure doubles the backoff')
clock += 15_000
await t.flush()
assert.equal(posts.length, 1)
assert.equal(t.status().pending, 0)

// Old events are dropped; the queue is capped.
online = false
for (let i = 0; i < 3; i++) t.track('old.event')
clock += 31 * 86_400_000
t.track('new.event')
t = T.createTelemetry(deps)
assert.equal(t.status().pending, 1, 'events older than 30 days are dropped')
for (let i = 0; i < T.QUEUE_CAP + 10; i++) t.track('cap.event')
assert.ok(t.status().pending <= T.QUEUE_CAP)
online = true
posts.length = 0
await t.flush({ force: true })
assert.equal(t.status().pending, 0)
assert.ok(posts.every((b) => b.length <= T.MAX_BATCH))

// Content on, then off: pending conversation events are discarded.
online = false
st = await t.setConsent({ usage: true, content: true })
assert.equal(st.content, true)
t.track('conversation.user', { metadata: { text: 'hello' } })
assert.equal(t.status().pending, 2) // consent.changed + conversation.user
st = await t.setConsent({ usage: true, content: false })
const pendingTypes = files.queue.trim().split('\n').map((l) => JSON.parse(l).row.event_type)
assert.ok(!pendingTypes.includes('conversation.user'))
assert.deepEqual(pendingTypes, ['consent.changed', 'consent.changed'])

// Withdrawal: pending events discarded, consent.withdrawn sent, nothing afterwards.
online = true
posts.length = 0
t.track('pane.fold')
st = await t.setConsent({ usage: false, content: false })
assert.equal(posts.length, 1)
assert.deepEqual(posts[0].map((r) => r.event_type), ['consent.withdrawn'])
assert.equal(st.pending, 0)
assert.equal(t.track('pane.fold'), null)

// A different account does not inherit the decision and cannot flush another account's queue.
email = 'other@uni.edu'
assert.equal(t.status().decided, false)
assert.equal(t.track('pane.fold'), null)

// Delete my data: DELETE own rows, local queue and history cleared.
email = 'ann.lee@uni.edu'
await t.setConsent({ usage: true, content: false })
st = await t.deleteMyData()
assert.deepEqual(deletes, [`${SB}/rest/v1/desktop_events?owner_id=eq.user-1`])
assert.equal(st.sent, 0)
assert.equal(st.pending, 0)
assert.equal(t.recent().length, 0)

console.log('telemetry tests passed')
