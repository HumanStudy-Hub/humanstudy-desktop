// Runs the built web server and real main process with a mock kernel. The request fixture bypasses
// TCP and replaces the upstream fetch so the tests work offline. Build with node scripts/build-web.mjs.
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'

const server = fileURLToPath(new URL('../out/web/server.cjs', import.meta.url))
const owner = '11111111-1111-4111-8111-111111111111'
const visit = '22222222-2222-4222-8222-222222222222'
const fixture = `
const { Readable } = require('node:stream')
const { EventEmitter } = require('node:events')
const http = require('node:http')
const { appendFileSync } = require('node:fs')
const streams = new Map()
let receive, stalled = false
http.createServer = fn => { receive = fn; return { listen(_port, _hostname, ready) { ready() } } }
global.fetch = async (input, options = {}) => {
  const path = new URL(input).pathname
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

async function setup(t, { envVisit, grant = true, deadlineAt } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hs-research-runtime-'))
  const runner = join(dir, 'mock-upstream.cjs')
  const userData = join(dir, 'userData')
  const remote = join(dir, 'uploaded.jsonl')
  const events = join(userData, 'research-v1', 'web', owner, 'events')
  await writeFile(runner, fixture)
  const child = fork(runner, [], {
    env: { PATH: process.env.PATH, HOME: dir, HS_USER_DATA: userData, HS_WEB_TOKEN: 'fixture-token',
      HS_WEB_DISCONNECT_GRACE_MS: '160', HUMANSTUDY_KERNEL: 'mock', HUMANSTUDY_SERVER: 'http://127.0.0.1',
      ...(envVisit ? { HS_VISIT_ID: visit } : {}), ...(deadlineAt ? { HS_DEADLINE_AT: new Date(deadlineAt).toISOString() } : {}), TEST_SERVER: server, TEST_REMOTE: remote },
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
