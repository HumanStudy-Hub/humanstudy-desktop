// Subagent (OpenCode task tool) sessions: their permissions, questions and progress reach the conversation
// that started them, and the autonomy policy answers their requests like the parent's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'subagent-'))
await build({ entryPoints: [join(here, 'index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'k.mjs'), logLevel: 'error' })
await build({ entryPoints: [join(here, '../notify-core.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'n.mjs'), logLevel: 'error' })
await build({ entryPoints: [join(here, '../paper-build.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'b.mjs'), logLevel: 'error' })
const { OpencodeKernel } = await import(pathToFileURL(join(out, 'k.mjs')).href)
const { notifyKind } = await import(pathToFileURL(join(out, 'n.mjs')).href)
const { createPaperBuilds, writePaperBuild, readPaperBuild } = await import(pathToFileURL(join(out, 'b.mjs')).href)
process.on('exit', () => rmSync(out, { recursive: true, force: true }))

async function fixture(run, mode = 'project') {
  const replies = []
  const api = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    replies.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || 'null') })
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('true')
  })
  await new Promise(r => api.listen(0, '127.0.0.1', r))
  const project = mkdtempSync(join(tmpdir(), 'subagent-project-'))
  const k = new OpencodeKernel({ binary: '/bin/true', permission: mode })
  const server = { dir: project, base: `http://127.0.0.1:${api.address().port}`, auth: 'Basic fixture', exited: false }
  k.register('s', server)
  const sessions = { child: { id: 'child', parentID: 's', title: 'Find the SI (@general subagent)', agent: 'general' } }
  const questions = []
  k.request = async (_server, method, path) => {
    if (method === 'GET' && path.startsWith('/session/')) {
      const info = sessions[decodeURIComponent(path.slice(9))]
      return info ? Response.json(info) : new Response('{}', { status: 404 })
    }
    if (method === 'GET' && path === '/question') return Response.json(questions)
    return Response.json(true)
  }
  const events = []
  k.onEvent(e => events.push(e))
  // Automatic replies are HTTP round trips: wait until the expected replies arrived (or 3 s), not a fixed delay.
  const settle = async (n = 0) => { for (let i = 0; i < 300 && (replies.length < n || i < 8); i++) await new Promise(r => setTimeout(r, 10)) }
  try { await run({ k, server, project, events, replies, sessions, questions, settle }) }
  finally { await k.dispose(); api.close(); rmSync(project, { recursive: true, force: true }) }
}
const created = (id = 'child', parentID = 's', title = 'Find the SI (@general subagent)') =>
  ({ type: 'session.created', properties: { sessionID: id, info: { id, parentID, title, agent: 'general' } } })
const asked = (id, command, sessionID = 'child') =>
  ({ type: 'permission.asked', properties: { id, sessionID, permission: 'bash', patterns: [command], metadata: { command }, always: [] } })

test('a subagent is reported to its parent with its latest step; it is never dropped', () => fixture(async ({ k, events }) => {
  k.handle(created())
  const start = events.find(e => e.type === 'subagent')
  assert.equal(start.sessionId, 's')
  assert.deepEqual(start.subagent, { id: 'child', name: 'general', title: 'Find the SI', state: 'running' })
  k.handle({ type: 'message.part.updated', properties: { part: { sessionID: 'child', messageID: 'm1', id: 'p1', type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'python3 .opencode/skills/build/check_program.py' } } } } })
  const step = events.filter(e => e.type === 'subagent').at(-1)
  assert.equal(step.sessionId, 's')
  assert.equal(step.tool, 'bash')
  assert.match(step.subagent.step, /check_program/)
  assert.ok(!events.some(e => e.type === 'tool'), 'a subagent step is not a parent transcript tool row')
  k.handle({ type: 'session.idle', properties: { sessionID: 'child' } })
  assert.equal(events.filter(e => e.type === 'subagent').at(-1).subagent.state, 'done')
}))

test('subagent permissions: routine work is approved, sensitive work asks the researcher, app credentials are denied', () => fixture(async ({ k, events, replies, settle }) => {
  k.handle(created())
  k.handle(asked('per_ls', 'ls sources/open'))
  k.handle(asked('per_private', 'cat human-data/responses.csv'))
  k.handle(asked('per_key', 'security find-generic-password -s x -w'))
  await settle(2)
  for (let i = 0; i < 300 && !events.some(e => e.permission?.id === 'per_key' && e.permission.resolved); i++) await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(replies.find(r => r.path === '/permission/per_ls/reply').body, { reply: 'once' })
  const denied = replies.find(r => r.path === '/permission/per_key/reply').body
  assert.equal(denied.reply, 'reject')
  assert.match(denied.message, /HumanStudy policy/, 'a policy denial carries a message so the agent loop continues')
  assert.ok(!replies.some(r => r.path.includes('per_private')), 'sensitive material waits for the researcher')
  const ask = events.find(e => e.type === 'permission' && e.permission.id === 'per_private' && !e.permission.resolved)
  assert.equal(ask.sessionId, 's', 'shown in the parent conversation')
  assert.equal(ask.permission.subagent, 'general')
  assert.match(ask.permission.reason, /participant data/)
  assert.equal(events.filter(e => e.type === 'subagent').at(-1).subagent.state, 'waiting')
  assert.ok(events.some(e => e.permission?.id === 'per_key' && e.permission.automatic && e.permission.resolved === 'reject'))
  // The build's "waiting" and the background notification both key off this parent event.
  assert.equal(notifyKind({ enabled: true, anyWindowFocused: false, eventType: ask.type, resolved: false }), 'waiting')
  // The parent is waiting: no liveness timeout, no idle completion while it is pending.
  assert.ok(k.sessions.get('s').pendingPermissions.has('per_private'))
  await k.reply('s', 'per_private', 'once')
  assert.deepEqual(replies.find(r => r.path === '/permission/per_private/reply').body, { reply: 'once' })
  k.handle({ type: 'permission.replied', properties: { sessionID: 'child', requestID: 'per_private', reply: 'once' } })
  assert.equal(events.filter(e => e.type === 'subagent').at(-1).subagent.state, 'running')
}))

test('a policy denial does not count as the researcher stopping the turn', () => fixture(async ({ k, settle }) => {
  const s = k.sessions.get('s')
  s.recovery.cancelled = false
  k.handle(asked('per_kc', 'security find-generic-password -w', 's'))
  await settle()
  k.handle({ type: 'permission.replied', properties: { sessionID: 's', requestID: 'per_kc', reply: 'reject' } })
  assert.equal(s.recovery.cancelled, false)
  k.handle({ type: 'permission.replied', properties: { sessionID: 's', requestID: 'per_researcher', reply: 'reject' } })
  assert.equal(s.recovery.cancelled, true)
}))

test('subagent questions reach the parent and can be answered there', () => fixture(async ({ k, events, questions, replies }) => {
  k.handle(created())
  const q = { id: 'que_1', sessionID: 'child', questions: [{ question: 'Do you have the SI?', header: 'SI', options: [{ label: 'Yes', description: '' }] }] }
  questions.push(q)
  k.handle({ type: 'question.asked', properties: q })
  const ev = events.find(e => e.type === 'question')
  assert.equal(ev.sessionId, 's')
  assert.equal(ev.question.subagent, 'general')
  assert.equal(notifyKind({ enabled: true, anyWindowFocused: false, eventType: 'question', resolved: false }), 'waiting')
  const pending = await k.questions('s')
  assert.deepEqual(pending.map(x => [x.id, x.subagent]), [['que_1', 'general']])
  k.request = async (_s, method, path, body) => { replies.push({ path, body }); return method === 'GET' ? Response.json(questions) : Response.json(true) }
  await k.answerQuestion('s', 'que_1', [['Yes']])
  assert.ok(replies.some(r => r.path === '/question/que_1/reply'))
}))

test('a nested subagent seen first through its permission is looked up and routed', () => fixture(async ({ k, events, sessions, settle }) => {
  k.handle(created())
  sessions.grand = { id: 'grand', parentID: 'child', title: 'Check quotes (@explore subagent)' }
  k.handle(asked('per_g', 'cat human-data/trials.csv', 'grand'), k.sessions.get('s').server)
  await settle()
  const ask = events.find(e => e.permission?.id === 'per_g')
  assert.equal(ask?.sessionId, 's')
  assert.equal(ask.permission.subagent, 'explore')
  assert.equal(k.rootOf('grand'), 's')
  // Sessions this app did not start stay out.
  k.handle(asked('per_x', 'ls', 'stranger'), k.sessions.get('s').server)
  await settle()
  assert.ok(!events.some(e => e.permission?.id === 'per_x'))
}))

test('the parent turn closes its subagents; a task tool registers its child', () => fixture(async ({ k, events }) => {
  const s = k.sessions.get('s')
  s.inFlight = true
  k.handle({ type: 'message.updated', properties: { info: { sessionID: 's', id: 'a1', role: 'assistant' } } })
  k.handle({ type: 'message.part.updated', properties: { part: { sessionID: 's', messageID: 'a1', id: 't1', type: 'tool', tool: 'task', state: { status: 'running', input: { subagent_type: 'general', description: 'Read the SI' }, metadata: { sessionId: 'kid' } } } } })
  assert.equal(k.rootOf('kid'), 's')
  assert.equal(events.find(e => e.type === 'subagent').subagent.name, 'general')
  k.handle({ type: 'session.idle', properties: { sessionID: 's' } })
  assert.equal(events.filter(e => e.type === 'subagent').at(-1).subagent.state, 'done')
}))

test('Ask mode: everything but read-only project commands goes to the researcher', () => fixture(async ({ k, events, replies, settle }) => {
  k.handle(asked('per_ls', 'ls', 's'))
  k.handle(asked('per_py', 'python3 x.py', 's'))
  await settle()
  assert.ok(replies.some(r => r.path === '/permission/per_ls/reply'))
  assert.ok(events.some(e => e.permission?.id === 'per_py' && !e.permission.resolved))
}, 'ask'))

test('a subagent check that passes counts for the build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subagent-build-'))
  try {
    const builds = createPaperBuilds(() => {})
    writePaperBuild(dir, { status: 'pending', phase: 'reading' })
    builds.bind('s', dir)
    assert.ok(builds.start(dir, 's'))
    builds.event({ sessionId: 's', type: 'subagent', subagent: { id: 'child', name: 'general', state: 'running' }, tool: 'bash', text: 'running', input: { command: 'python3 .opencode/skills/build/program_io.py add x' } })
    assert.equal(readPaperBuild(dir).phase, 'writing', 'a subagent writing program.json moves the build phase')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("OpenCode's doom_loop prompt is answered automatically three times per turn, then the researcher decides", () => fixture(async ({ k, events, replies, settle }) => {
  const loop = id => ({ type: 'permission.asked', properties: { id, sessionID: 's', permission: 'doom_loop', patterns: ['bash'], metadata: {}, always: [] } })
  for (const id of ['d1', 'd2', 'd3', 'd4']) k.handle(loop(id))
  await settle(3)
  assert.deepEqual(['d1', 'd2', 'd3'].map(id => replies.find(r => r.path === `/permission/${id}/reply`)?.body.reply), ['once', 'once', 'once'])
  assert.ok(!replies.some(r => r.path.includes('d4')), 'the fourth repeat waits for the researcher')
  assert.match(events.find(e => e.permission?.id === 'd4' && !e.permission.resolved).permission.reason, /repeating/)
  // A new message starts a new turn with a fresh allowance.
  await k.send('s', 'go on').catch(() => {})
  k.handle(loop('d5'))
  await settle(4)
  assert.equal(replies.find(r => r.path === '/permission/d5/reply')?.body.reply, 'once')
}))

test('a shell command the researcher approves after an ask runs once outside the OS sandbox; routine ones stay confined', () => fixture(async ({ k, server }) => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-shell-'))
  try {
    server.agentShell = { kind: 'sandbox-exec', shell: join(dir, 'zsh'), dir }
    const tokens = () => (existsSync(join(dir, 'approved')) ? readdirSync(join(dir, 'approved')) : [])
    k.handle(asked('per_data', 'cat human-data/a.csv', 's'))
    await k.reply('s', 'per_data', 'once')
    assert.deepEqual(tokens(), [createHash('sha256').update('cat human-data/a.csv').digest('hex')])
    // In "Ask before changes" the researcher also approves routine commands: those stay in the sandbox.
    k.setPermissionMode('ask')
    k.handle(asked('per_ls', 'ls artifacts', 's'))
    await k.reply('s', 'per_ls', 'once')
    k.handle(asked('per_no', 'cat human-data/b.csv', 's'))
    await k.reply('s', 'per_no', 'reject')
    assert.equal(tokens().length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}, 'ask'))
