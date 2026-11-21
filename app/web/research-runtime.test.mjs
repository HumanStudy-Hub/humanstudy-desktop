// Runs the built web server and real main process with a mock kernel. The request fixture bypasses
// TCP and replaces the upstream fetch so the tests work offline. Build with node scripts/build-web.mjs.
import assert from 'node:assert/strict'
import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'
import { build } from 'esbuild'

const server = fileURLToPath(new URL('../out/web/server.cjs', import.meta.url))
const owner = '11111111-1111-4111-8111-111111111111'
const visit = '22222222-2222-4222-8222-222222222222'
const fixture = `
const { Readable } = require('node:stream')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const { appendFileSync, readFileSync } = require('node:fs')
const library = process.env.TEST_LIBRARY && JSON.parse(readFileSync(process.env.TEST_LIBRARY, 'utf8'))
const streams = new Map()
let receive, stalled = false
http.createServer = fn => { receive = fn; return { listen(_port, _hostname, ready) { ready() } } }
global.fetch = async (input, options = {}) => {
  const path = new URL(input).pathname
  if (library) {
    if (path.endsWith('/research_index.json')) return Response.json({ papers: [library.entry] })
    if (path.endsWith('/commits/main')) return new Response(library.commit)
    if (path.endsWith('/commits')) return Response.json([])
    const prefix = '/' + library.commit + '/' + library.entry.assetRoot + '/'
    const asset = path.includes(prefix) && library.assets[path.split(prefix)[1]]
    if (asset) return new Response(asset)
  }
  if (path === '/api/desktop/config') return Response.json({ supabaseUrl: 'http://127.0.0.1', supabaseKey: 'fixture' })
  if (path === '/auth/v1/user') {
    if (stalled) { process.send({ uploading: true }); return new Promise(() => {}) }
    return Response.json({ id: '${owner}' })
  }
  if (path === '/rest/v1/research_events' && options.method === 'POST')
    appendFileSync(process.env.TEST_REMOTE, options.body + '\\n')
  if (path.startsWith('/rest/v1/') || path.startsWith('/storage/'))
    return options.method === 'POST' ? new Response(null, { status: 201 }) : Response.json([])
  return new Response(null, { status: 404 })
}
process.on('message', async ({ id, path, args, method = 'POST' }) => {
  const done = (status, value) => process.send({ id, status, value })
  if (path === 'stall') { stalled = true; return done(200) }
  if (path === 'env') return done(200, JSON.stringify(Object.keys(process.env).filter(key => /^HS_(?:VISIT_ID|DEADLINE_AT)$/.test(key))))
  if (path === 'crash') { done(200); setImmediate(() => { throw Error('fixture crash') }); return }
  if (path === 'disconnect') { streams.get(args[0])?.emit('close'); return done(200) }
  const req = Readable.from(args === undefined ? [] : [Buffer.from(JSON.stringify(args))])
  Object.assign(req, { method, url: path, headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' } })
  const res = Object.assign(new EventEmitter(), {
    status: 200, headersSent: false,
    writeHead(status) { this.status = status; this.headersSent = true },
    end(body) { done(this.status, body) },
    write(body) {
      if (body.startsWith('retry:')) { streams.set(id, this); done(this.status, id) }
      return true
    },
  })
  await receive(req, res)
})
require(process.env.TEST_SERVER)
process.send({ ready: true })
`

async function setup(t, { envVisit, grant = true, deadlineAt, library, prepareUserData } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hs-research-runtime-'))
  const runner = join(dir, 'mock-upstream.cjs')
  const userData = join(dir, 'userData')
  const remote = join(dir, 'uploaded.jsonl')
  const events = join(userData, 'research-v1', 'web', owner, 'events')
  await prepareUserData?.(dir, userData)
  const libraryPath = join(dir, 'library.json')
  if (library) await writeFile(libraryPath, JSON.stringify(library))
  await writeFile(runner, fixture)
  const child = fork(runner, [], {
    env: { PATH: process.env.PATH, HOME: dir, HS_USER_DATA: userData, HS_WEB_TOKEN: 'fixture-token',
      HS_WEB_DISCONNECT_GRACE_MS: '160', HUMANSTUDY_KERNEL: 'mock', HUMANSTUDY_SERVER: 'http://127.0.0.1',
      ...(envVisit ? { HS_VISIT_ID: visit } : {}), ...(deadlineAt ? { HS_DEADLINE_AT: new Date(deadlineAt).toISOString() } : {}),
      ...(library ? { TEST_LIBRARY: libraryPath } : {}), TEST_SERVER: server, TEST_REMOTE: remote },
    execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const exited = once(child, 'exit')
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exited
    await rm(dir, { recursive: true, force: true })
  })
  const readiness = await Promise.race([once(child, 'message'), exited])
  assert.equal(readiness[0]?.ready, true, 'Build the web runtime first with node scripts/build-web.mjs')
  let nextId = 0, uploading = false
  const pending = new Map()
  child.on('message', answer => {
    if (answer.uploading) uploading = true
    pending.get(answer.id)?.(answer)
    pending.delete(answer.id)
  })
  const request = (path, args, method) => {
    const id = ++nextId
    return new Promise(resolve => { pending.set(id, resolve); child.send({ id, path, args, method }) })
  }
  const ipc = async (channel, ...args) => JSON.parse((await request('/ipc/' + channel, { args })).value)
  const config = async () => JSON.parse((await request('/web-config.js', undefined, 'GET')).value.slice('window.__HS_WEB__='.length, -1))
  if (!envVisit) await request('/?hs_visit=' + visit, undefined, 'GET')
  assert.equal((await config()).visit, visit)
  await request('/__seed', { session: {
    accessToken: 'fixture.' + Buffer.from(JSON.stringify({ sub: owner })).toString('base64url') + '.fixture',
    refreshToken: 'fixture', expiresAt: Date.now() + 3_600_000, email: 'fixture@example.test',
  } })
  const entry = { id: randomUUID(), scope: 'invalid', workspace: (await config()).workspace, visit,
    occurredAt: new Date().toISOString(), channel: 'telemetry:track', args: ['ui.click', { target: 'fixture' }] }
  if (grant) {
    assert.equal((await ipc('telemetry:setConsent', { usage: true, content: true })).ok, true)
    entry.scope = (await config()).scope
  }
  async function local() {
    return Promise.all((await readdir(events)).filter(name => name.endsWith('.json')).map(async name => JSON.parse(await readFile(join(events, name), 'utf8'))))
  }
  async function uploaded() {
    const lines = await readFile(remote, 'utf8').catch(() => '')
    return lines.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  return { child, exited, request, ipc, config, entry, events, local, uploaded, userData, uploading: () => uploading }
}

test('cloud prepares a verified fork and repairs outdated previews on open', { timeout: 25_000 }, async t => {
  const python = ['python3.12', 'python3.13', 'python3.11', 'python3'].map(command => spawnSync(command,
    ['-c', 'import sys; print(sys.executable) if sys.version_info >= (3, 11) else sys.exit(1)'], { encoding: 'utf8' }))
    .find(probe => probe.status === 0)?.stdout.trim()
  if (!python || process.platform === 'win32') return t.skip('needs Python 3.11+ and a POSIX runtime fixture')
  const protocol = await readFile(new URL('../src/main/fixtures/protocol-mini/protocol.json', import.meta.url), 'utf8')
  const program = '{"schemaVersion":2,"id":"fork-preview"}'
  const assets = { 'protocol.json': protocol, 'program.json': program }
  const hash = text => createHash('sha256').update(text).digest('hex')
  const assetFiles = Object.entries(assets).map(([path, text]) => ({ path, sha256: hash(text), bytes: Buffer.byteLength(text) }))
  const revision = hash(JSON.stringify(assetFiles.map(({ path, sha256 }) => ({ path, sha256 }))))
  const id = 'paper_' + 'a'.repeat(24)
  const entry = { id, title: 'Preview fixture', year: 2026, authors: [], currentRevision: revision, assetFiles,
    assetRoot: 'community/fixture/revisions/' + revision }
  const f = await setup(t, {
    library: { entry, assets, commit: 'c'.repeat(40) },
    prepareUserData: async (dir, userData) => {
      const module = join(dir, 'runtime-core.mjs')
      await build({ entryPoints: [fileURLToPath(new URL('../src/main/runtime-core.ts', import.meta.url))],
        bundle: true, platform: 'node', format: 'esm', outfile: module })
      const { runtimeVersion, runtimePaths } = await import(pathToFileURL(module))
      const lock = await readFile(new URL('../../pack/runtime/requirements.lock', import.meta.url), 'utf8')
      const runtime = runtimePaths(join(userData, 'runtime', runtimeVersion(lock)), process.platform)
      await mkdir(dirname(runtime.python), { recursive: true })
      // Slow only the fixture interpreter so the preparing state and concurrent edit are deterministic.
      await writeFile(runtime.python, '#!/bin/sh\n/bin/sleep 0.4\nexec "' + python + '" "$@"\n', { mode: 0o755 })
      await writeFile(runtime.ok, runtimeVersion(lock))
    },
  })
  const until = async (read, predicate) => {
    for (let i = 0; i < 100; i++) {
      const value = await read()
      if (predicate(value)) return value
      await pause(50)
    }
    assert.fail('Preview job did not reach the expected state')
  }
  const forked = await f.ipc('community:fork', id, revision)
  assert.equal(forked.ok, true, JSON.stringify(forked))
  const dir = forked.value
  const path = join(dir, 'artifacts', 'preview.html')
  const backup = join(dir, 'artifacts', 'preview.prev.html')
  const read = () => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const snapshot = async () => {
    const reply = await f.ipc('project:read', dir)
    assert.equal(reply.ok, true, JSON.stringify(reply))
    return reply.value
  }
  const generated = await until(async () => {
    const error = (await f.local().catch(() => [])).find(row => row.metadata?.operation === 'project.preview_failed')
    assert.equal(error?.metadata?.error, undefined, 'fork preview preparation failed')
    return read()
  }, html => html.includes('hs.interact'))
  assert.match(generated, /name="hs-preview-template-version" content="\d+"/)
  assert.ok(generated.includes(hash(protocol)))
  const prepared = await until(f.local, rows => rows.find(row => row.metadata?.operation === 'project.preview_prepared'))
  const success = prepared.find(row => row.metadata?.operation === 'project.preview_prepared')
  assert.equal(success.target, 'artifacts/preview.html')
  assert.deepEqual(success.metadata, { operation: 'project.preview_prepared', via: 'system' })
  await assert.rejects(stat(backup), { code: 'ENOENT' })
  await until(snapshot, snap => !snap.previewPreparation)
  const current = generated + '\n<!-- hand-edited current preview -->'
  await writeFile(path, current)
  const inode = (await stat(path)).ino
  assert.equal((await snapshot()).previewPreparation, undefined)
  assert.equal(await read(), current)
  assert.equal((await stat(path)).ino, inode)

  const handAuthored = '<html><head><meta name="hs-artifact" content="participant-preview">' +
    '<!-- <meta name="hs-preview-template-version" content="0"> --></head><body><p>Custom preview</p></body></html>'
  await writeFile(path, handAuthored)
  assert.equal((await snapshot()).previewPreparation, undefined)
  assert.equal(await read(), handAuthored)

  const legacy = current.replace(/<meta name="hs-preview-template-version"[^>]*>/, '')
  await writeFile(path, legacy)
  assert.equal((await snapshot()).previewPreparation, undefined)
  assert.equal(await read(), legacy)
  await assert.rejects(stat(backup), { code: 'ENOENT' })

  const old = current.replace(/name="hs-preview-template-version" content="\d+"/, 'name="hs-preview-template-version" content="0"')
  await writeFile(path, old)
  assert.equal((await snapshot()).previewPreparation, 'preparing')
  await until(read, html => !html.includes('hand-edited current preview') && html.includes('hs.interact'))
  assert.equal((await until(snapshot, snap => !snap.previewPreparation)).program.id, 'fork-preview')
  assert.equal(await readFile(backup, 'utf8'), old)

  const wrongHash = generated.replace(hash(protocol), '0'.repeat(64))
  await writeFile(path, wrongHash)
  assert.equal((await snapshot()).previewPreparation, 'preparing')
  await writeFile(path, current)
  await until(snapshot, snap => !snap.previewPreparation)
  assert.equal(await read(), current, 'a current edit made while the old preview was being built survives')
  assert.equal(await readFile(backup, 'utf8'), old)

  await writeFile(path, wrongHash)
  assert.equal((await snapshot()).previewPreparation, 'preparing')
  await until(read, html => html.includes(hash(protocol)))
  await until(snapshot, snap => !snap.previewPreparation)
  assert.equal(await readFile(backup, 'utf8'), wrongHash)

  // Hold the mock turn open until it is explicitly aborted. The job must restart without a project read.
  const { kernelSessionId: sid } = (await f.ipc('threads:create', dir)).value
  assert.equal((await f.ipc('kernel:send', sid, 'Ask question')).ok, true)
  await rm(path)
  assert.equal((await snapshot()).previewPreparation, undefined)
  assert.equal((await snapshot()).previewPreparation, undefined)
  await pause(650)
  assert.equal(await read(), '')
  assert.equal((await f.ipc('kernel:abort', sid)).ok, true)
  await until(read, html => html.includes(hash(protocol)))
  await until(snapshot, snap => !snap.previewPreparation)

  const buildState = join(dir, '.humanstudy', 'paper-build.json')
  await writeFile(buildState, '{"status":"pending","phase":"reading"}')
  assert.equal((await f.ipc('project:startBuild', dir, sid)).value, true)
  await rm(path)
  assert.equal((await snapshot()).previewPreparation, undefined)
  assert.equal(await read(), '')
  assert.equal((await f.ipc('project:releaseBuild', dir, sid)).ok, true)
  await until(read, html => html.includes(hash(protocol)))
  await until(snapshot, snap => !snap.previewPreparation)

  const previous = await read()
  await writeFile(join(dir, 'protocol.json'), '{"id":"fixture-mini"}')
  assert.equal((await snapshot()).previewPreparation, 'preparing')
  const failed = await until(snapshot, snap => snap.previewPreparation === 'failed')
  assert.equal(failed.program.id, 'fork-preview')
  assert.equal(await read(), previous, 'a failed build leaves the last artifact on disk')
  await until(f.local, rows => rows.some(row => row.metadata?.operation === 'project.preview_failed'))
})

test('ACK follows the atomic event write and retry stays idempotent after upload', { timeout: 10_000 }, async t => {
  const f = await setup(t, { grant: false })
  const write = entry => f.ipc('telemetry:outboxWrite', entry)
  assert.equal((await write(f.entry)).value.status, 'scope_changed')
  await f.ipc('telemetry:setConsent', { usage: true, content: true })
  f.entry.scope = (await f.ipc('telemetry:outboxScope')).value
  await mkdir(join(f.events, '..'), { recursive: true })
  await rm(f.events, { recursive: true, force: true })
  await writeFile(f.events, 'blocked directory')
  assert.equal((await write(f.entry)).ok, false)
  await rm(f.events)
  assert.deepEqual((await write(f.entry)).value, { status: 'ack', id: f.entry.id })
  const row = (await f.local()).find(row => row.id === f.entry.id)
  assert.deepEqual([row.visit_id, row.occurred_at], [visit, f.entry.occurredAt])
  assert.deepEqual((await write(f.entry)).value, { status: 'ack', id: f.entry.id })
  await f.ipc('telemetry:flush')
  assert.deepEqual((await write(f.entry)).value, { status: 'ack', id: f.entry.id })
  assert.equal((await f.uploaded()).filter(row => row.id === f.entry.id).length, 1)
  assert.deepEqual(await f.local(), [])
})

test('late browser events retain their original visit while sandbox events use the active visit', { timeout: 10_000 }, async t => {
  const f = await setup(t, { envVisit: true })
  assert.equal((await f.ipc('telemetry:outboxWrite', f.entry)).value.status, 'ack')
  const lastVisit = '33333333-3333-4333-8333-333333333333'
  const late = { ...f.entry, visit: lastVisit, id: randomUUID() }
  assert.equal((await f.ipc('telemetry:outboxWrite', late)).value.status, 'ack')
  const rows = await f.local()
  const current = rows.find(row => row.id === f.entry.id)
  const replayed = rows.find(row => row.id === late.id)
  assert.deepEqual([current.visit_id, replayed.visit_id], [visit, lastVisit])
  assert.notEqual(current.research_session_id, replayed.research_session_id)
})

test('chat captures queued, accepted, and pre-turn rejected submissions under content rules', { timeout: 10_000 }, async t => {
  const f = await setup(t, { envVisit: true })
  const dir = (await f.ipc('projects:create', { name: 'Dispatch fixture', sample: true })).value
  const { kernelSessionId: sid } = (await f.ipc('threads:create', dir)).value
  const message = 'Research question from fixture@example.test'
  assert.equal((await f.ipc('kernel:send', sid, message)).ok, true)
  assert.equal((await f.ipc('telemetry:outboxWrite', { ...f.entry, channel: 'telemetry:chatSubmission',
    args: [sid, message, 'queued', { id: randomUUID(), via: 'pointer', target: 'message.queue' }] })).value.status, 'ack')
  assert.equal((await f.ipc('kernel:send', 'unknown_session', message)).ok, false)
  // The send answers first; its receipt is written behind it on the collector's queue.
  let rows = await f.local()
  for (let i = 0; i < 80 && rows.filter(row => row.event_type === 'conversation.submission').length < 3; i++) { await pause(25); rows = await f.local() }
  const submissions = rows.filter(row => row.event_type === 'conversation.submission')
  assert.deepEqual(submissions.map(row => row.metadata.dispatch_outcome).sort(), ['failed', 'queued', 'sent'])
  assert.ok(rows.every(row => row.visit_id === visit))
  assert.ok(submissions.every(row => row.metadata.text === 'Research question from [email]' && rows.some(action => action.id === row.action_id)))
  assert.equal(rows.filter(row => row.event_type === 'agent.turn_start').length, 1)
})

for (const reason of ['closed', 'timeout', 'user_stop', 'crash', 'disconnect']) {
  test('session end records ' + reason, { timeout: 10_000 }, async t => {
    const f = await setup(t, { envVisit: true })
    assert.equal((await f.ipc('telemetry:outboxWrite', f.entry)).value.status, 'ack')
    if (reason === 'disconnect') {
      const stream = await f.request('/events', undefined, 'GET')
      await f.request('disconnect', [stream.value])
      // Reopening promptly cancels the first grace timer.
      const resumed = await f.request('/events', undefined, 'GET')
      await pause(210)
      assert.ok(!(await f.uploaded()).some(row => row.event_type === 'session.end'))
      await f.request('disconnect', [resumed.value])
      for (let i = 0; i < 80 && !(await f.uploaded()).some(row => row.event_type === 'session.end'); i++) await pause(25)
    } else {
      if (reason === 'timeout' || reason === 'user_stop')
        await writeFile(join(f.userData, 'web-stop-reason.json'), JSON.stringify({ visit_id: visit, reason }))
      if (reason === 'crash') await f.request('crash')
      else f.child.kill('SIGTERM')
      assert.equal((await f.exited)[0], reason === 'crash' ? 1 : 0)
    }
    const ends = (await f.uploaded()).filter(row => row.event_type === 'session.end')
    assert.deepEqual(ends.map(row => [row.visit_id, row.metadata.reason]), [[visit, reason]])
  })
}

test('SIGTERM attempts unified upload and exits within its bound if upload stalls', { timeout: 10_000 }, async t => {
  const f = await setup(t)
  assert.equal((await f.ipc('telemetry:outboxWrite', f.entry)).value.status, 'ack')
  await f.request('stall')
  const started = performance.now()
  f.child.kill('SIGTERM')
  assert.equal((await f.exited)[0], 0)
  assert.ok(f.uploading(), 'Shutdown never attempted the unified upload')
  assert.ok(performance.now() - started < 7_000, 'Shutdown fell through to the 8-second forced exit')
  assert.ok((await f.local()).some(row => row.event_type === 'session.end'))
})

// The server ends the visit 25 s before the provider's hard limit; these deadlines leave 3 s for setup.
const LEAD = 25_000
for (const hub of [null, 'user_stop']) {
  test(hub ? 'a Hub stop marker present at the deadline keeps its reason' : 'the provider deadline ends the visit as a timeout before the hard limit', { timeout: 15_000 }, async t => {
    const deadlineAt = Date.now() + LEAD + 3_000
    const f = await setup(t, { envVisit: true, deadlineAt })
    assert.deepEqual(JSON.parse((await f.request('env', undefined, 'GET')).value), [], 'visit and deadline stay out of the environment')
    const left = (await f.config()).deadlineIn
    assert.ok(left > LEAD && left <= LEAD + 3_000, 'the page receives the time left')
    assert.equal((await f.ipc('telemetry:outboxWrite', f.entry)).value.status, 'ack')
    if (hub) await writeFile(join(f.userData, 'web-stop-reason.json'), JSON.stringify({ visit_id: visit, reason: hub }))
    assert.equal((await f.exited)[0], 0)
    assert.ok(Date.now() < deadlineAt - LEAD / 2, 'the workspace ended well before the provider limit')
    const ends = (await f.uploaded()).filter(row => row.event_type === 'session.end')
    assert.deepEqual(ends.map(row => [row.visit_id, row.metadata.reason]), [[visit, hub ?? 'timeout']])
  })
}

test('no deadline means no countdown and no deadline stop', { timeout: 10_000 }, async t => {
  const f = await setup(t, { envVisit: true })
  assert.equal((await f.config()).deadlineIn, null)
})
