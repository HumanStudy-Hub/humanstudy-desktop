// Project sync (project-sync-core.ts, project-sync-cloud.ts, project-sync.ts) against real temp folders and an
// in-memory Supabase (PostgREST rows with owner-only access, a private Storage bucket). No network:
//   node --test src/main/project-sync.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync as require_rename, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'project-sync-'))
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))
await build({
  entryPoints: [join(here, 'project-sync.ts'), join(here, 'project-sync-core.ts'), join(here, 'project-sync-cloud.ts'), join(here, 'study-transfer.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outdir: join(temp, 'out'), logLevel: 'error',
})
const E = await import(pathToFileURL(join(temp, 'out', 'project-sync.js')).href)
const C = await import(pathToFileURL(join(temp, 'out', 'project-sync-core.js')).href)
const K = await import(pathToFileURL(join(temp, 'out', 'project-sync-cloud.js')).href)
const S = await import(pathToFileURL(join(temp, 'out', 'study-transfer.js')).href)

const sha = (b) => createHash('sha256').update(b).digest('hex')
const USER = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const NOW = Date.UTC(2026, 10, 16, 12, 0)
let n = 0
const fresh = (label) => { const d = join(temp, `${label}-${++n}`); mkdirSync(d, { recursive: true }); return d }
function put(root, rel, data) {
  const p = join(root, ...rel.split('/'))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, data)
}
const read = (root, rel) => readFileSync(join(root, ...rel.split('/')), 'utf8')
const jwt = (sub) => `x.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.y`

/** A Supabase stand-in: rows filtered by the caller's user id (RLS), the table's revision rule, a private bucket where
 *  each user reaches only their own folder. `offline` makes every request fail as a network error. */
function fakeSupabase() {
  const rows = new Map() // user/project -> row
  const objects = new Map() // path -> { data, created }
  const calls = []
  const state = { offline: false, rejectUpload: null, clock: NOW }
  const url = 'https://db.test'
  const owner = (init) => {
    const auth = new Headers(init?.headers).get('authorization') ?? ''
    const token = auth.replace(/^Bearer /, '')
    try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub } catch { return null }
  }
  const json = (status, body) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const filters = (u) => {
    const f = {}
    for (const [k, v] of u.searchParams) if (!['select', 'order', 'limit'].includes(k)) f[k] = v
    return f
  }
  const matches = (row, f) => Object.entries(f).every(([k, v]) => {
    if (v === 'is.null') return row[k] === null
    if (v === 'not.is.null') return row[k] !== null
    const [op, val] = [v.slice(0, v.indexOf('.')), v.slice(v.indexOf('.') + 1)]
    return op === 'eq' && String(row[k]) === val
  })
  async function fetch(input, init = {}) {
    const res = await handle(input, init)
    state.afterRequest?.(new URL(String(input)).pathname, init.method ?? 'GET')
    return res
  }
  async function handle(input, init = {}) {
    const u = new URL(String(input))
    calls.push(`${init.method ?? 'GET'} ${u.pathname}`)
    if (state.offline) throw new TypeError('fetch failed')
    const uid = owner(init)
    if (!uid) return json(401, { message: 'no token' })
    const method = init.method ?? 'GET'
    if (u.pathname === '/rest/v1/project_sync') {
      const f = filters(u)
      const mine = [...rows.values()].filter((r) => r.user_id === uid)
      if (method === 'GET') return json(200, mine.filter((r) => matches(r, f)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)))
      if (method === 'POST') {
        const body = JSON.parse(init.body)
        if (body.user_id !== uid) return json(403, { message: 'rls' })
        if (body.revision !== 1) return json(400, { message: 'revision' })
        const key = `${uid}/${body.project_id}`
        if (rows.has(key)) return json(409, { message: 'duplicate key' })
        const row = { deleted_at: null, ...body, updated_at: new Date(state.clock++).toISOString() }
        rows.set(key, row)
        return json(201, [row])
      }
      if (method === 'PATCH') {
        const body = JSON.parse(init.body)
        const hit = mine.filter((r) => matches(r, f))
        for (const r of hit) {
          if ('revision' in body && body.revision !== r.revision + 1) return json(400, { message: 'revision must increase by one' })
          // As the table's trigger does: deleted_at is stamped by the server's clock, kept if already set.
          const stamped = 'deleted_at' in body ? { deleted_at: body.deleted_at == null ? null : (r.deleted_at ?? new Date(state.clock).toISOString()) } : {}
          Object.assign(r, body, stamped, { updated_at: new Date(state.clock++).toISOString() })
        }
        return json(200, hit)
      }
      if (method === 'DELETE') {
        // The table's policy: only rows deleted more than 30 days ago (by the server's clock).
        const gone = mine.filter((r) => matches(r, f) && r.deleted_at && state.clock - Date.parse(r.deleted_at) > 30 * 24 * 3600_000)
        for (const r of gone) rows.delete(`${uid}/${r.project_id}`)
        return json(200, gone)
      }
    }
    const store = '/storage/v1/object/'
    if (u.pathname === `${store}list/projects` && method === 'POST') {
      const { prefix, limit, offset } = JSON.parse(init.body)
      if (!prefix.startsWith(`${uid}/`)) return json(200, [])
      const names = [...objects.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).sort()
      return json(200, names.slice(offset, offset + limit).map((k) => ({ name: k.slice(prefix.length), created_at: new Date(objects.get(k).created).toISOString() })))
    }
    if (u.pathname === `${store}projects` && method === 'DELETE') {
      for (const p of JSON.parse(init.body).prefixes) if (p.startsWith(`${uid}/`)) objects.delete(p)
      return json(200, [])
    }
    if (u.pathname.startsWith(`${store}authenticated/projects/`) && method === 'GET') {
      const path = decodeURIComponent(u.pathname.slice(`${store}authenticated/projects/`.length))
      if (path.includes('/blobs/')) state.onBlob?.(path)
      if (!path.startsWith(`${uid}/`) || !objects.has(path)) return json(400, { error: 'not_found', message: 'Object not found' })
      return new Response(objects.get(path).data, { status: 200 })
    }
    if (u.pathname.startsWith(`${store}projects/`) && method === 'POST') {
      const path = decodeURIComponent(u.pathname.slice(`${store}projects/`.length))
      if (!path.startsWith(`${uid}/`)) return json(403, { message: 'rls' })
      if (state.rejectUpload?.(path)) return json(413, { message: 'Payload too large' })
      const upsert = new Headers(init.headers).get('x-upsert') === 'true'
      if (objects.has(path) && !upsert) return json(409, { error: 'Duplicate', message: 'The resource already exists' })
      const data = typeof init.body === 'string' ? Buffer.from(init.body) : Buffer.from(init.body)
      objects.set(path, { data, created: state.clock })
      return json(200, { Key: path })
    }
    return json(404, { message: `unhandled ${method} ${u.pathname}` })
  }
  return { url, rows, objects, calls, state, fetch }
}

/** One device: its own projects folder and engine, sharing the fake Supabase. */
function device(db, name, { user = USER, signedIn = true, ...extra } = {}) {
  const root = fresh(`root-${name}`)
  const timers = []
  const pending = { ids: [] }
  let who = signedIn ? user : null
  const cloud = K.createCloud({
    auth: async () => (who ? { supabaseUrl: db.url, supabaseKey: 'publishable', accessToken: jwt(who), userId: who } : null),
    fetch: db.fetch,
  })
  const installed = []
  const engine = E.createProjectSync({
    cloud,
    signedInUser: () => who,
    projectsRoot: () => root,
    syncable: (dir) => dir.startsWith(root + '/') || dir.startsWith(root + '\\'),
    localProjects: async () => readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && existsSync(join(root, d.name, '.humanstudy', 'project.json')))
      .map((d) => join(root, d.name)),
    device: name,
    platform: 'desktop',
    appVersion: '0.8.2',
    afterInstall: async (dir) => { installed.push(dir); put(dir, '.opencode/skills/x.md', 'reinstalled agent file') },
    busy: () => false,
    release: () => undefined,
    onChange: () => undefined,
    readPending: () => pending.ids,
    writePending: (ids) => { pending.ids = ids },
    now: () => db.state.clock,
    random: () => 0.5,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t },
    clearTimer: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) },
    ...extra,
  })
  return { root, engine, timers, pending, installed, signIn: (u) => { who = u }, signOut: () => { who = null } }
}

function project(root, name, files = {}) {
  const dir = join(root, name)
  put(dir, '.humanstudy/project.json', JSON.stringify({ format: 1, createdAt: '2026-11-01T00:00:00.000Z' }))
  put(dir, 'program.json', '{"title":"Anchoring"}')
  put(dir, 'notes/plan.md', 'plan v1')
  for (const [rel, data] of Object.entries(files)) put(dir, rel, data)
  return dir
}

// ---- pure decisions ---------------------------------------------------------------------------------------------

const row = (o = {}) => ({ project_id: 'p-12345678', name: 'P', revision: 3, manifest_sha256: 'c'.repeat(64), size_bytes: 1, file_count: 1, updated_at: '', updated_by_device: 'Laptop', deleted_at: null, ...o })
const st = (o = {}) => ({ format: 1, userId: USER, projectId: 'p-12345678', baseRevision: 3, baseDigest: 'b'.repeat(64), syncedAt: '', ...o })
const decide = (state, localDigest, cloud, signedIn = true, userId = USER) => C.decide({ signedIn, userId, state, localDigest, cloud })

test('decide: push and pull follow the revisions; both changed is a conflict, never an overwrite', () => {
  const base = 'b'.repeat(64), changed = 'd'.repeat(64)
  assert.equal(decide(st(), base, row({ manifest_sha256: base })), 'up-to-date')
  assert.equal(decide(st(), changed, row({ manifest_sha256: base })), 'push', 'local changed, cloud still at the base')
  assert.equal(decide(st(), base, row({ revision: 4 })), 'pull', 'cloud newer, local unchanged')
  assert.equal(decide(st(), changed, row({ revision: 4 })), 'conflict', 'both changed')
  assert.equal(decide(st(), changed, row({ revision: 4, manifest_sha256: changed })), 'up-to-date', 'both made the same change')
  assert.equal(decide(null, changed, null), 'push', 'a project new to the cloud')
  assert.equal(decide(null, changed, row({ revision: 1 })), 'conflict', 'same id in the cloud with other files: keep both')
  assert.equal(decide(st({ baseRevision: 0, baseDigest: '' }), changed, null), 'push')
})

test('decide: signed out is local only; another account and deleted copies are left alone', () => {
  assert.equal(decide(st(), 'x', row(), false), 'local-only')
  assert.equal(decide(null, 'x', null, true, ''), 'local-only')
  assert.equal(decide(st({ userId: OTHER }), 'x', row()), 'other-account')
  assert.equal(decide(st(), 'x', row({ deleted_at: '2026-11-10T00:00:00Z' })), 'deleted')
  assert.equal(decide(st({ cloudDeleted: true }), 'x', null), 'deleted')
  assert.equal(decide(st({ cloudDeleted: true }), 'b'.repeat(64), row({ revision: 4 })), 'pull', 'restored on another device: syncs again')
  assert.equal(decide(st(), 'x', null), 'deleted', 'synced before and the row is gone (purged): never resurrected')
})

test('the excluded-files list: keys, caches, app state, agent config and OS junk never sync', () => {
  for (const rel of ['.opencode/skills/a.md', 'opencode.json', 'opencode.jsonc', '.git/config', '.env', 'node_modules/x/index.js', 'analysis/__pycache__/a.pyc',
    '.DS_Store', 'Thumbs.db', 'sources/desktop.ini', '.humanstudy/sync.json', '.humanstudy/sync-cache.json', '.humanstudy/versions/program.json/1.json',
    '.humanstudy/original-text.json', '.humanstudy/tmp/x', '.humanstudy/sync-incoming-1/abc', 'schema/human-program.schema.json', 'Study.humanstudy.zip',
    'program.json.123.0123456789abcdef0123456789abcdef.tmp'])
    assert.equal(C.syncIncluded(rel), false, rel)
  for (const rel of ['program.json', 'protocol.json', 'paper.pdf', 'notes/plan.md', 'artifacts/simulations/r1/results.html', 'AGENTS.md',
    '.humanstudy/project.json', '.humanstudy/community.json', '.humanstudy/threads/thr_1.json', '.humanstudy/thread-history/a.json'])
    assert.equal(C.syncIncluded(rel), true, rel)
})

test('private files are part of the cloud copy (sources/private, researcher, quarantine, original-text)', async () => {
  for (const rel of ['sources/private/my copy.pdf', 'sources/researcher/booklet.txt', 'sources/quarantine/q.txt', 'package/original-text/a.txt'])
    assert.equal(C.syncIncluded(rel), true, rel)
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Anchoring', { 'sources/private/my copy.pdf': '%PDF private', '.humanstudy/threads/thr_1.json': '{"id":"thr_1","messages":[]}' })
  await a.engine.syncNow(dir)
  const blobs = [...db.objects.keys()].filter((k) => k.includes('/blobs/'))
  assert.ok(blobs.some((k) => k.endsWith(sha(Buffer.from('%PDF private')))), 'the private PDF was uploaded')
  const manifestKey = [...db.objects.keys()].find((k) => k.includes('/manifests/'))
  const manifest = JSON.parse(db.objects.get(manifestKey).data.toString())
  assert.ok(manifest.files.some((f) => f.path === 'sources/private/my copy.pdf'))
  assert.ok(manifest.files.some((f) => f.path === '.humanstudy/threads/thr_1.json'), 'chats are included')
  assert.deepEqual(manifest.includes.privateFiles, ['sources/private/my copy.pdf'])
  assert.equal(manifest.format, 'humanstudy-study', 'the study-transfer manifest format')
  assert.ok(blobs.every((k) => k.startsWith(`${USER}/`)), 'everything under the owner\'s folder')
})

test('size cap: a project over the limit is not synced and says so', async () => {
  const root = fresh('cap')
  const dir = project(root, 'Big', { 'data/big.bin': Buffer.alloc(5000) })
  await assert.rejects(C.scanSnapshot(dir, {}, { maxBytes: 4000 }), (e) => e.code === 'too-large')
  const db = fakeSupabase()
  const a = device(db, 'Laptop', { maxBytes: 4000 })
  const big = project(a.root, 'Big', { 'data/big.bin': Buffer.alloc(5000) })
  await assert.rejects(a.engine.syncNow(big), (e) => e.code === 'too-large')
  assert.equal((await a.engine.statusOf(big)).status, 'too-large')
  assert.equal(db.rows.size, 0, 'nothing reached the cloud')
  assert.equal(a.timers.length, 0, 'too large is not retried in a loop; the next change tries again')
  assert.equal(C.MAX_PROJECT_BYTES, 500_000_000)
})

test('a file the storage refuses as too large is named, not retried forever', async () => {
  const db = fakeSupabase()
  db.state.rejectUpload = (path) => path.endsWith(sha(Buffer.from('huge video')))
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Video', { 'media/clip.mp4': 'huge video' })
  await assert.rejects(a.engine.syncNow(dir), (e) => e.code === 'file-too-large' && e.file === 'media/clip.mp4')
  const s = await a.engine.statusOf(dir)
  assert.deepEqual([s.status, s.detail, s.file], ['not-synced', 'file-too-large', 'media/clip.mp4'])
})

test('retry and backoff: doubling from 30 s, capped at 30 min, with jitter', () => {
  assert.equal(C.retryDelay(0, () => 1), 30_000)
  assert.equal(C.retryDelay(1, () => 1), 60_000)
  assert.equal(C.retryDelay(3, () => 1), 240_000)
  assert.equal(C.retryDelay(50, () => 1), 30 * 60_000)
  assert.equal(C.retryDelay(0, () => 0), 15_000, 'jitter takes off up to half')
  for (let i = 0; i < 12; i++) assert.ok(C.retryDelay(i) <= C.retryDelay(i + 1, () => 1))
})

test('offline: the sync fails quietly, the project keeps working, and a retry is scheduled with backoff', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Offline')
  db.state.offline = true
  await assert.rejects(a.engine.syncNow(dir), (e) => e.code === 'offline')
  assert.equal(a.timers.length, 1)
  assert.equal(a.timers[0].ms, 15_000 + 7_500, 'first retry after about 30 s (jitter 0.5)')
  const s = await a.engine.statusOf(dir)
  assert.deepEqual([s.status, s.detail], ['not-synced', 'retrying'])
  assert.deepEqual(await a.engine.beforeOpen(dir), { dir }, 'opening never waits on or fails because of sync')
  db.state.offline = false
  const retry = a.timers.shift()
  retry.fn()
  await a.engine.syncNow(dir) // runs after the queued retry
  assert.equal(db.rows.size, 1)
  assert.equal((await a.engine.statusOf(dir)).status, 'synced')
})

test('signed out: local only, no request leaves the computer', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop', { signedIn: false })
  const dir = project(a.root, 'Local')
  a.engine.touch(dir)
  a.engine.closed(dir)
  assert.equal(a.timers.length, 0, 'nothing is scheduled')
  assert.deepEqual(await a.engine.beforeOpen(dir), { dir })
  assert.deepEqual(await a.engine.list(), { signedIn: false, offline: false, local: [], cloudOnly: [], deleted: [], maxBytes: C.MAX_PROJECT_BYTES })
  await a.engine.trashed(dir)
  await a.engine.flushAll(100)
  assert.deepEqual(db.calls, [])
  assert.equal(existsSync(join(dir, '.humanstudy', 'sync.json')), false)
})

test('a change is pushed after the project is quiet (debounced), and closing pushes now', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Debounce')
  a.engine.touch(dir)
  a.engine.touch(dir)
  assert.equal(a.timers.length, 1, 'one pending push however many changes')
  assert.equal(a.timers[0].ms, C.DEBOUNCE_MS)
  a.engine.closed(dir)
  assert.equal(a.timers.length, 1)
  assert.equal(a.timers[0].ms, 0)
})

// ---- two devices -------------------------------------------------------------------------------------------------

test('push, list on another device, download a cloud-only project, then pull on open', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const dir = project(a.root, 'Anchoring', {
    'notes/old.md': 'to be removed', '.opencode/opencode.json': '{"key":"sk-secret"}', 'opencode.json': '{"provider":{"key":"sk-secret"}}',
    '.humanstudy/versions/x.json': 'local history', 'node_modules/a/i.js': 'x',
  })
  await a.engine.syncNow(dir)
  const [r1] = [...db.rows.values()]
  assert.equal(r1.revision, 1)
  assert.equal(r1.updated_by_device, 'Laptop')
  assert.ok(![...db.objects.values()].some((o) => o.data.includes('sk-secret')), 'provider keys never leave the computer')

  const listed = await b.engine.list()
  assert.deepEqual(listed.cloudOnly.map((c) => c.name), ['Anchoring'])
  const got = await b.engine.download(listed.cloudOnly[0].projectId)
  assert.equal(read(got, 'notes/plan.md'), 'plan v1')
  assert.equal(existsSync(join(got, 'opencode.json')), false)
  assert.equal(read(got, '.opencode/skills/x.md'), 'reinstalled agent file', 'the app re-installs its agent files')
  assert.deepEqual(b.installed, [got])
  assert.equal((await b.engine.list()).cloudOnly.length, 0, 'now local')
  assert.equal((await b.engine.statusOf(got)).status, 'synced')

  // B edits and pushes revision 2; A has no unsynced changes, so opening pulls it.
  put(got, 'notes/plan.md', 'plan v2 from the office')
  rmSync(join(got, 'notes', 'old.md'))
  put(got, 'analysis/new.R', 'summary(x)')
  await b.engine.syncNow(got)
  assert.equal([...db.rows.values()][0].revision, 2)
  assert.equal((await a.engine.list()).local[0].status, 'behind', 'shown as an update until opened')
  const opened = await a.engine.beforeOpen(dir)
  assert.deepEqual(opened, { dir })
  assert.equal(read(dir, 'notes/plan.md'), 'plan v2 from the office')
  assert.equal(read(dir, 'analysis/new.R'), 'summary(x)')
  assert.equal(existsSync(join(dir, 'notes', 'old.md')), false, 'a deletion on the other device comes through')
  assert.equal(read(dir, 'opencode.json'), '{"provider":{"key":"sk-secret"}}', 'local-only files stay')
  assert.equal(read(dir, '.humanstudy/versions/x.json'), 'local history')
  assert.equal(existsSync(join(dir, 'node_modules', 'a', 'i.js')), true)
  const state = JSON.parse(read(dir, '.humanstudy/sync.json'))
  assert.equal(state.baseRevision, 2, 'the device records the base revision it synced from')
  assert.equal((await a.engine.statusOf(dir)).status, 'synced')
})

test('conflict: both changed, so the incoming version becomes a copy and nothing is overwritten', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const dir = project(a.root, 'Anchoring')
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  put(other, 'notes/plan.md', 'office edit')
  await b.engine.syncNow(other)
  put(dir, 'notes/plan.md', 'laptop edit')

  const opened = await a.engine.beforeOpen(dir)
  assert.equal(opened.dir, dir)
  assert.equal(read(dir, 'notes/plan.md'), 'laptop edit', 'the local copy is untouched')
  assert.ok(opened.copy)
  assert.equal(opened.copy.name, 'Anchoring (synced copy from Office PC, Nov 16)')
  assert.equal(opened.copy.device, 'Office PC')
  assert.equal(read(opened.copy.dir, 'notes/plan.md'), 'office edit', 'the other device\'s version is kept')
  const copyMarker = JSON.parse(read(opened.copy.dir, '.humanstudy/project.json'))
  const marker = JSON.parse(read(dir, '.humanstudy/project.json'))
  assert.notEqual(copyMarker.id, marker.id, 'the copy is a project of its own')
  assert.equal(copyMarker.copyOf, marker.id)
  // The local copy then continued from the cloud revision and pushed on top.
  const mainRow = db.rows.get(`${USER}/${marker.id}`)
  assert.equal(mainRow.revision, 3)
  assert.equal(mainRow.updated_by_device, 'Laptop')
  assert.equal((await a.engine.statusOf(opened.copy.dir)).status, 'not-synced')
  const pushCopy = a.timers.find((t) => t.ms === 1_000)
  assert.ok(pushCopy, 'the copy is pushed right after')
  await a.engine.syncNow(opened.copy.dir)
  assert.equal(db.rows.size, 2)
  assert.equal((await a.engine.statusOf(opened.copy.dir)).status, 'conflict-copy')
  // B, unchanged since its push, takes the laptop's version on open; the office version lives on as the copy.
  await b.engine.beforeOpen(other)
  assert.equal(read(other, 'notes/plan.md'), 'laptop edit')
  assert.ok((await b.engine.list()).cloudOnly.some((c) => c.name.startsWith('Anchoring (synced copy from Office PC')))
})

test('a push that loses the race to another device keeps both, too', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const dir = project(a.root, 'Race')
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  put(other, 'notes/plan.md', 'office first')
  await b.engine.syncNow(other)
  put(dir, 'notes/plan.md', 'laptop second')
  await a.engine.syncNow(dir) // background push: the row moved on, so the cloud version becomes a copy
  const names = readdirSync(a.root).filter((d) => !d.startsWith('.'))
  assert.equal(names.length, 2)
  assert.equal(read(dir, 'notes/plan.md'), 'laptop second')
  assert.equal(read(join(a.root, names.find((x) => x !== 'Race')), 'notes/plan.md'), 'office first')
})

test('soft delete: restorable for 30 days, other devices keep their copy as local only, then the cloud copy is removed', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const dir = project(a.root, 'Gone')
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  await a.engine.trashed(dir)
  const r = [...db.rows.values()][0]
  assert.ok(r.deleted_at, 'deleted_at set; the row and its files stay')
  assert.ok([...db.objects.keys()].some((k) => k.includes('/blobs/')))
  const listed = await b.engine.list()
  assert.deepEqual(listed.deleted.map((c) => c.name), ['Gone'])
  assert.equal(listed.local[0].status, 'deleted')
  put(other, 'notes/plan.md', 'edited after the delete')
  await b.engine.syncNow(other)
  assert.equal([...db.rows.values()][0].revision, 1, 'a deleted project is never pushed back on its own')
  assert.equal(read(other, 'notes/plan.md'), 'edited after the delete', 'and never removed from another device')

  await b.engine.restore(r.project_id)
  assert.equal([...db.rows.values()][0].deleted_at, null)
  assert.equal(JSON.parse(read(other, '.humanstudy/sync.json')).cloudDeleted, undefined)
  await b.engine.syncNow(other)
  assert.equal([...db.rows.values()][0].revision, 2, 'restored, it syncs again')

  // A device whose clock runs 40 days ahead cannot cut the 30 days short: the server keeps row and files.
  await b.engine.trashed(other)
  const ahead = device(db, 'Fast clock', { now: () => db.state.clock + 40 * 24 * 3600_000 })
  assert.deepEqual((await ahead.engine.list()).deleted, [])
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(db.rows.size, 1)
  assert.ok([...db.objects.keys()].some((k) => k.includes('/blobs/')))
  // Deleted 31 days ago: the next list removes the cloud copy for good.
  ;[...db.rows.values()][0].deleted_at = new Date(NOW - 31 * 24 * 3600_000).toISOString()
  const c = device(db, 'Tablet')
  const later = await c.engine.list()
  assert.deepEqual(later.deleted, [])
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(db.rows.size, 0)
  assert.equal([...db.objects.keys()].length, 0)
})

test('a delete made offline is sent later, and the project does not reappear meanwhile', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Later')
  await a.engine.syncNow(dir)
  db.state.offline = true
  await a.engine.trashed(dir)
  rmSync(dir, { recursive: true })
  assert.equal(a.pending.ids.length, 1)
  db.state.offline = false
  const listed = await a.engine.list()
  assert.deepEqual(listed.cloudOnly, [])
  assert.deepEqual(listed.deleted.map((c) => c.name), ['Later'])
  assert.deepEqual(a.pending.ids, [])
})

test('another account: a project synced with one account is not uploaded to the next', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Mine')
  await a.engine.syncNow(dir)
  a.signIn(OTHER)
  put(dir, 'notes/plan.md', 'changed')
  await a.engine.syncNow(dir)
  assert.equal([...db.rows.values()].filter((r) => r.user_id === OTHER).length, 0)
  assert.equal((await a.engine.list()).local[0].status, 'other-account')
  assert.deepEqual((await a.engine.list()).cloudOnly, [], 'one account never sees another\'s projects')
})

test('conversations: a device-bound model session does not count as a change and survives a pull', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const thread = (sid, extra = '') => JSON.stringify({ id: 'thr_1', kernelSessionId: sid, messages: [{ text: 'hi' + extra }] }, null, 2)
  const dir = project(a.root, 'Chat', { '.humanstudy/threads/thr_1.json': thread('ses_laptop') })
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  assert.equal(JSON.parse(read(other, '.humanstudy/threads/thr_1.json')).kernelSessionId, '', 'the session stays on its device')
  put(other, '.humanstudy/threads/thr_1.json', thread('ses_office'))
  await b.engine.syncNow(other)
  assert.equal([...db.rows.values()][0].revision, 1, 'only the session id differs: no new revision')
  put(other, 'notes/plan.md', 'office edit')
  await b.engine.syncNow(other)
  await a.engine.beforeOpen(dir)
  assert.equal(read(dir, 'notes/plan.md'), 'office edit')
  assert.equal(JSON.parse(read(dir, '.humanstudy/threads/thr_1.json')).kernelSessionId, 'ses_laptop', 'the laptop keeps its own session')
})

test('a damaged or tampered cloud copy is refused before anything is written', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const dir = project(a.root, 'Tamper')
  await a.engine.syncNow(dir)
  const blobKey = [...db.objects.keys()].find((k) => k.endsWith(sha(Buffer.from('plan v1'))))
  db.objects.get(blobKey).data = Buffer.from('evil')
  await assert.rejects(b.engine.download((await b.engine.list()).cloudOnly[0].projectId), (e) => e.code === 'damaged')
  assert.deepEqual(readdirSync(b.root), [], 'no half project, no leftover temp folder')
  // A manifest that names an unsafe path is refused as a study file would be.
  assert.throws(() => S.checkManifest({ format: 'humanstudy-study', version: 1, files: [{ path: '../evil', size: 1, sha256: 'a'.repeat(64) }] }))
})

test('unchanged files are not uploaded again', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Incremental', { 'data/big.csv': 'x'.repeat(10_000) })
  await a.engine.syncNow(dir)
  const before = db.calls.filter((c) => c.startsWith('POST /storage/v1/object/projects/')).length
  put(dir, 'notes/plan.md', 'plan v2')
  await a.engine.syncNow(dir)
  const uploads = db.calls.filter((c) => c.startsWith('POST /storage/v1/object/projects/')).slice(before)
  assert.equal(uploads.length, 2, 'one changed file and the new file list')
})

test('names: synced copies, device labels', () => {
  const at = new Date(Date.UTC(2026, 10, 16, 12))
  assert.equal(C.conflictName('Anchoring', 'Office PC', at), 'Anchoring (synced copy from Office PC, Nov 16)')
  assert.ok(C.conflictName('x'.repeat(200), 'Laptop', at).length <= 80)
  assert.equal(C.deviceLabel('desktop', 'Janes-MacBook.local'), 'Janes-MacBook')
  assert.equal(C.deviceLabel('online', 'sandbox-123'), 'online workspace')
})

// ---- review follow-ups: renames, interrupted pulls, edits during a pull, restores, outside folders ----------------

test('a file renamed only in capitals on another device arrives, and the old name does not take it with it', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Online')
  const dir = project(a.root, 'Caps', { 'data/data.csv': 'x,y\n1,2\n' })
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  rmSync(join(other, 'data', 'data.csv'))
  put(other, 'data/Data.csv', 'x,y\n1,2\n')
  await b.engine.syncNow(other)
  await a.engine.beforeOpen(dir)
  const names = readdirSync(join(dir, 'data'))
  assert.deepEqual(names, ['Data.csv'])
  assert.equal(read(dir, 'data/Data.csv'), 'x,y\n1,2\n')
})

test('a project edited while its update downloads is not replaced', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const dir = project(a.root, 'Busy')
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  put(other, 'notes/plan.md', 'office edit')
  await b.engine.syncNow(other)
  db.state.onBlob = () => { db.state.onBlob = null; put(dir, 'notes/plan.md', 'saved by an editor meanwhile') }
  assert.deepEqual(await a.engine.beforeOpen(dir), { dir })
  assert.equal(read(dir, 'notes/plan.md'), 'saved by an editor meanwhile')
  assert.equal(JSON.parse(read(dir, '.humanstudy/sync.json')).pulling, undefined)
  assert.equal(readdirSync(join(dir, '.humanstudy')).some((n) => n.startsWith('sync-incoming-')), false, 'no staging folder left')
  // Next time both changed: the office version becomes a copy, the editor's save stays.
  const again = await a.engine.beforeOpen(dir)
  assert.ok(again.copy)
  assert.equal(read(dir, 'notes/plan.md'), 'saved by an editor meanwhile')
  assert.equal(read(again.copy.dir, 'notes/plan.md'), 'office edit')
})

test('an interrupted pull is finished next time; with an edit made since, the copy is kept instead', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const dir = project(a.root, 'Crash', { 'notes/b.md': 'b1' })
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  put(other, 'notes/plan.md', 'plan v2')
  put(other, 'notes/b.md', 'b2')
  await b.engine.syncNow(other)
  const r2 = [...db.rows.values()][0]
  // A crash after one of two files was replaced.
  const st = JSON.parse(read(dir, '.humanstudy/sync.json'))
  writeFileSync(join(dir, '.humanstudy', 'sync.json'), JSON.stringify({ ...st, pulling: { revision: r2.revision, digest: r2.manifest_sha256 } }))
  put(dir, 'notes/plan.md', 'plan v2')
  mkdirSync(join(dir, '.humanstudy', 'sync-incoming-left-over'))
  const opened = await a.engine.beforeOpen(dir)
  assert.equal(opened.copy, undefined, 'finished, not split into a copy')
  assert.equal(read(dir, 'notes/b.md'), 'b2')
  assert.equal(JSON.parse(read(dir, '.humanstudy/sync.json')).baseRevision, r2.revision)
  assert.equal(readdirSync(join(dir, '.humanstudy')).some((n) => n.startsWith('sync-incoming-')), false)

  // Same, but the researcher also edited a file afterwards: nothing of theirs is replaced.
  put(other, 'notes/plan.md', 'plan v3')
  await b.engine.syncNow(other)
  const r3 = [...db.rows.values()][0]
  const st2 = JSON.parse(read(dir, '.humanstudy/sync.json'))
  writeFileSync(join(dir, '.humanstudy', 'sync.json'), JSON.stringify({ ...st2, pulling: { revision: r3.revision, digest: r3.manifest_sha256 } }))
  put(dir, 'notes/mine.md', 'my own note')
  const kept = await a.engine.beforeOpen(dir)
  assert.ok(kept.copy, 'the cloud version is kept as a copy')
  assert.equal(read(dir, 'notes/mine.md'), 'my own note')
  assert.equal(read(kept.copy.dir, 'notes/plan.md'), 'plan v3')
})

test('a rename reaches the other device on open and is not sent back', async () => {
  const db = fakeSupabase()
  const moves = []
  const a = device(db, 'Laptop'), b = device(db, 'Office PC', { moved: (from, to) => { moves.push([from, to]) } })
  const dir = project(a.root, 'Old name')
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  const renamed = join(a.root, 'New name')
  require_rename(dir, renamed)
  await a.engine.syncNow(renamed)
  assert.equal([...db.rows.values()][0].name, 'New name')
  await b.engine.syncNow(other) // background: must not undo the rename
  assert.equal([...db.rows.values()][0].name, 'New name')
  const opened = await b.engine.beforeOpen(other)
  assert.equal(opened.dir, join(b.root, 'New name'))
  // the app's path-keyed records follow the folder (real paths, the old one taken before the rename)
  assert.deepEqual(moves, [[realpathSync.native(dirname(other)) + sep + basename(other), realpathSync.native(opened.dir)]])
  assert.ok(existsSync(join(b.root, 'New name', 'program.json')))
  await b.engine.syncNow(opened.dir)
  assert.equal([...db.rows.values()][0].name, 'New name')
})

test('restored on one device, a copy kept on another syncs again', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const dir = project(a.root, 'Back')
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  await a.engine.trashed(dir)
  await b.engine.syncNow(other)
  assert.equal(JSON.parse(read(other, '.humanstudy/sync.json')).cloudDeleted, true)
  await a.engine.restore([...db.rows.values()][0].project_id)
  put(other, 'notes/plan.md', 'after the restore')
  await b.engine.syncNow(other)
  assert.equal([...db.rows.values()][0].revision, 2)
  assert.equal((await b.engine.statusOf(other)).status, 'synced')
})

test('a folder opened from outside the projects folder stays local', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const outside = project(fresh('elsewhere'), 'Opened with Open')
  a.engine.touch(outside)
  a.engine.closed(outside)
  assert.equal(a.timers.length, 0)
  assert.deepEqual(await a.engine.syncNow(outside), { dir: outside })
  assert.deepEqual(await a.engine.beforeOpen(outside), { dir: outside })
  assert.equal(db.rows.size, 0)
})

test('a conversation being saved (.json.tmp) is not part of the cloud copy', () => {
  assert.equal(C.syncIncluded('.humanstudy/threads/thr_1.json.tmp'), false)
  assert.equal(C.syncIncluded('.humanstudy/threads/thr_1.json'), true)
})

test('an account switch during an upload stops the run; nothing is written under the new account', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Switch', { 'data/a.csv': 'a', 'data/b.csv': 'b', 'data/c.csv': 'c' })
  let uploads = 0
  db.state.rejectUpload = (path) => { if (path.includes('/blobs/') && ++uploads === 1) { a.signIn(OTHER); a.engine.accountChanged() } return false }
  await a.engine.syncNow(dir)
  assert.equal(uploads, 1, 'the run stopped at its next cloud operation')
  assert.equal([...db.objects.keys()].filter((k) => k.startsWith(`${OTHER}/`)).length, 0, 'no object under the new account')
  assert.equal(db.rows.size, 0, 'no revision committed for either account')
  const stamp = JSON.parse(read(dir, '.humanstudy/sync.json'))
  assert.equal(stamp.baseRevision, 0, 'not recorded as synced')
  assert.equal(stamp.userId, USER, 'but owned by the account that started it')
  assert.equal(a.timers.length, 0, 'no retry scheduled for the old account')
  // The new account's list sees another account's project and never uploads it.
  const listed = await a.engine.list()
  assert.equal(listed.local[0].status, 'other-account')
  for (const t of [...a.timers]) { a.timers.splice(a.timers.indexOf(t), 1); t.fn() }
  await a.engine.syncNow(dir)
  assert.equal([...db.objects.keys()].filter((k) => k.startsWith(`${OTHER}/`)).length, 0, 'still nothing under the new account')
  assert.equal(db.rows.size, 0)
})

test('a switch noticed only through the credentials still stops the run (no accountChanged call)', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Switch2', { 'data/a.csv': 'a', 'data/b.csv': 'b' })
  db.state.rejectUpload = (path) => { if (path.includes('/blobs/')) a.signIn(OTHER); return false }
  await a.engine.syncNow(dir)
  assert.equal([...db.objects.keys()].filter((k) => k.startsWith(`${OTHER}/`)).length, 0)
  assert.equal(db.rows.size, 0)
})

test('a sync never deletes cloud objects, even ones the new revision no longer uses', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Keep')
  await a.engine.syncNow(dir)
  const before = new Set(db.objects.keys())
  for (let i = 2; i <= 3; i++) {
    db.state.clock += 8 * 24 * 3600_000 // older than any cleanup age
    put(dir, 'notes/plan.md', `plan v${i}`)
    await a.engine.syncNow(dir)
  }
  assert.equal([...db.rows.values()][0].revision, 3)
  assert.ok(!db.calls.some((c) => c.startsWith('DELETE /storage/')), 'no delete request')
  for (const k of before) assert.ok(db.objects.has(k), `kept ${k}`)
})

test('a file that became a folder on another device arrives (materials -> materials/items.csv)', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const dir = project(a.root, 'Shape', { materials: 'one file' })
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  rmSync(join(other, 'materials'))
  put(other, 'materials/items.csv', 'id,item\n1,cup\n')
  await b.engine.syncNow(other)
  const opened = await a.engine.beforeOpen(dir)
  assert.equal(opened.copy, undefined, 'a plain update, not a conflict')
  assert.equal(read(dir, 'materials/items.csv'), 'id,item\n1,cup\n')
  assert.equal(JSON.parse(read(dir, '.humanstudy/sync.json')).baseRevision, 2)
  assert.equal((await a.engine.statusOf(dir)).status, 'synced')
})

test('a file changed here where the other device made a folder is kept (conflict copy), never replaced', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop'), b = device(db, 'Office PC')
  const dir = project(a.root, 'Shape2', { materials: 'one file' })
  await a.engine.syncNow(dir)
  const other = await b.engine.download((await b.engine.list()).cloudOnly[0].projectId)
  rmSync(join(other, 'materials'))
  put(other, 'materials/items.csv', 'id,item\n1,cup\n')
  await b.engine.syncNow(other)
  put(dir, 'materials', 'edited here')
  const opened = await a.engine.beforeOpen(dir)
  assert.equal(read(dir, 'materials'), 'edited here')
  assert.ok(opened.copy)
  assert.equal(read(opened.copy.dir, 'materials/items.csv'), 'id,item\n1,cup\n')
})

test('a project made while signed in belongs to that account before its first upload; one made signed out is adopted', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const mine = project(a.root, 'Made by A')
  await a.engine.claim(mine)
  a.signOut()
  const loose = project(a.root, 'Made signed out')
  await a.engine.claim(loose) // signed out: no owner
  a.signIn(OTHER); a.engine.accountChanged()
  const listed = await a.engine.list()
  assert.equal(listed.local.find((e) => e.dir === mine).status, 'other-account')
  for (const t of [...a.timers]) { a.timers.splice(a.timers.indexOf(t), 1); t.fn() }
  await a.engine.syncNow(mine)
  await a.engine.syncNow(loose)
  const owners = [...db.rows.values()].map((r) => [r.user_id, r.name])
  assert.deepEqual(owners, [[OTHER, 'Made signed out']], 'only the ownerless project is adopted by the next account')
})

test('queued deletes are sent only with the account they belong to', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Trash me')
  await a.engine.syncNow(dir)
  db.state.offline = true
  await a.engine.trashed(dir)
  assert.deepEqual(a.pending.ids.map((p) => p.userId), [USER])
  db.state.offline = false
  a.signIn(OTHER); a.engine.accountChanged()
  await a.engine.list()
  assert.equal(a.pending.ids.length, 1, 'kept while another account is signed in')
  assert.equal([...db.rows.values()][0].deleted_at, null)
  a.signIn(USER); a.engine.accountChanged()
  await a.engine.list()
  assert.deepEqual(a.pending.ids, [])
  assert.ok([...db.rows.values()][0].deleted_at, 'sent once its account is back')
})

test('a list whose account changed while it was read shows no rows and schedules nothing', async () => {
  const db = fakeSupabase()
  const a = device(db, 'Laptop')
  const dir = project(a.root, 'Fresh')
  db.state.afterRequest = (path, method) => { if (method === 'GET' && path === '/rest/v1/project_sync') { db.state.afterRequest = null; a.signIn(OTHER) } }
  const listed = await a.engine.list()
  assert.equal(listed.offline, true, 'the rows read for the previous account are dropped')
  assert.equal(a.timers.length, 0, 'nothing scheduled')
  // The next list (for the new account) does the work: the project made signed out is adopted by it.
  await a.engine.list()
  assert.equal(a.timers.length, 1)
  assert.equal((await a.engine.statusOf(dir)).status, 'not-synced')
})
