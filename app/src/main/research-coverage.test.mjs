// T10 coverage check: drives a scripted source-to-program session through the real collector, agent
// adapter and operation tracker (mocked kernel events and network) on desktop and headless, then checks
// the delivered rows against docs/research-coverage-map.json:
//   node --test src/main/research-coverage.test.mjs
import { build } from 'esbuild'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = new URL('.', import.meta.url).pathname
const temp = await mkdtemp(join(tmpdir(), 'research-coverage-'))
await build({
  stdin: { contents: `export {createResearchCollector} from './research-collector.ts'; export {createResearchAgent} from './research-agent.ts';
    export {createOperations, actionRef} from '../shared/research-operations.ts'; export {createWriteAttribution} from './write-capture.ts';
    export {EVENTS, DATA_TYPES, PROHIBITED_EVENT_RE, validateResearchEvent} from '../shared/research-contract.ts'`, resolveDir: here, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'bundle.mjs'), logLevel: 'error',
})
const R = await import(pathToFileURL(join(temp, 'bundle.mjs')).href)
const { startHeadlessResearch } = await import(new URL('../../scripts/headless-research.mjs', import.meta.url).href)
const { controlAssets } = await import(new URL('../../scripts/asset-control.mjs', import.meta.url).href)
const MAP = JSON.parse(await readFile(new URL('../../../docs/research-coverage-map.json', import.meta.url), 'utf8'))

const OWNER = '11111111-1111-4111-8111-111111111111', PROJECT = '33333333-3333-4333-8333-333333333333'
// Credentials that must never reach a row or a content object.
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.c2lnbmF0dXJlLW9mLXRlc3Q', API_KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789'
const EMAIL = 'researcher@example.org', HOME_FILE = join(homedir(), 'Private', 'notes.txt')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function network() {
  const objects = new Map(), events = new Map(), content = new Map()
  const fetch = async (url, init = {}) => {
    const u = new URL(url), p = u.pathname
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`)
    if (p === '/auth/v1/user') return Response.json({ id: OWNER })
    if (p === '/rest/v1/research_consents') return new Response(null, { status: 201 })
    if (p === '/rest/v1/research_content') {
      if (init.method === 'POST') { const row = JSON.parse(init.body); content.set(row.sha256, row); return new Response(null, { status: 201 }) }
      const q = u.searchParams.get('sha256').slice(3); return Response.json(content.has(q) ? [{ sha256: q }] : [])
    }
    if (p.startsWith('/storage/v1/object/')) {
      if (init.method === 'POST') { objects.set(p.split('/').pop(), Buffer.from(init.body)); return new Response(null, { status: 201 }) }
      const k = p.split('/').pop(); return new Response(objects.get(k), { status: objects.has(k) ? 200 : 404 })
    }
    if (p === '/rest/v1/research_events') { const row = JSON.parse(init.body); events.set(row.id, row); return new Response(null, { status: 201 }) }
    throw Error('unexpected route ' + p)
  }
  return { fetch, objects, events, content }
}
function collector(root, surface, net) {
  return R.createResearchCollector({ root, surface, appVersion: 'test', ownerId: () => OWNER, allowed: () => true, fetch: net.fetch,
    auth: async () => ({ supabaseUrl: 'https://db.test', supabaseKey: 'public-anon', accessToken: TOKEN, userId: OWNER }) })
}
/** Every stored content object, decompressed, as text (sources included: they are scanned as well). */
function contentText(net) {
  return [...net.content.values()].map(row => {
    const bytes = net.objects.get(row.sha256)
    return (row.encoding === 'gzip' ? gunzipSync(bytes) : bytes).toString('utf8')
  }).join('\n')
}

/** Checks the delivered rows of one surface against the coverage map. */
function checkCoverage(rows, net, surface, { project, expectedOperations }) {
  const byId = new Map(rows.map(r => [r.id, r]))
  const primaries = rows.filter(r => r.event_type === 'action.invoke')
  const errors = rows.flatMap(r => R.validateResearchEvent(r).map(e => `${r.event_type}: ${e}`))
  assert.deepEqual(errors, [], 'every delivered row satisfies the vendored contract')

  // Every agreed data type that applies to this surface is present.
  const applicable = Object.entries(MAP.data_types).filter(([, spec]) => Object.values(spec.event_types).some(s => !/^not_applicable/.test(s[surface] ?? '')))
  for (const [type] of applicable) assert.ok(rows.some(r => r.data_type === type), `${surface}: data type ${type} is present`)
  if (surface === 'headless') for (const type of ['navigation', 'selection_layout'])
    assert.ok(!rows.some(r => r.data_type === type), `headless: ${type} is explicitly not applicable`)

  // One primary action per operation: unique ids, action_id === id, and exactly the expected operations.
  assert.equal(new Set(primaries.map(r => r.id)).size, primaries.length, 'no duplicate primary actions')
  for (const p of primaries) assert.equal(p.action_id, p.id)
  for (const [id, label] of expectedOperations) assert.equal(primaries.filter(p => p.id === id).length, 1, `exactly one action.invoke for ${label}`)
  assert.equal(primaries.length, expectedOperations.size, `${surface}: one action.invoke per operation, no generic duplicates (${primaries.map(p => p.target).join(', ')})`)

  // Causality: links resolve; downstream records are linked or explicitly labelled.
  const linkage = Object.fromEntries(Object.values(MAP.data_types).flatMap(spec => Object.keys(spec.event_types).map(t => [t, spec.linkage])))
  for (const r of rows) {
    if (r.action_id) assert.equal(byId.get(r.action_id)?.event_type, 'action.invoke', `${r.event_type}.action_id resolves to a primary action (no orphan)`)
    if (r.caused_by) assert.ok(byId.has(r.caused_by), `${r.event_type}.caused_by resolves`)
    if (r.metadata.parent_action_id) assert.equal(byId.get(r.metadata.parent_action_id)?.event_type, 'action.invoke', `${r.event_type} parent resolves`)
    const rule = linkage[r.event_type]
    assert.ok(rule, `${r.event_type} is in the coverage map`)
    if (rule === 'required') assert.ok(r.action_id || r.metadata.trigger === 'external', `${r.event_type} carries its initiating action`)
    if (rule === 'required_or_labelled') assert.ok(r.action_id || ['baseline', 'external'].includes(r.metadata.trigger), `${r.event_type} is linked or labelled (${r.metadata.trigger})`)
    if (MAP.data_types.navigation.event_types[r.event_type] && /passive/.test(MAP.data_types.navigation.event_types[r.event_type].desktop)) assert.ok(!r.action_id, 'passive navigation is never linked')
  }
  // Native OpenCode identities on agent/tool records.
  for (const r of rows.filter(r => r.event_type === 'tool.start' || r.event_type === 'tool.end')) {
    assert.match(r.tool_call_id, /^call_/); assert.equal(r.metadata.native_id_reported, true)
    assert.match(r.metadata.native_message_id, /^msg_/); assert.match(r.metadata.native_part_id, /^prt_/)
  }
  for (const r of rows.filter(r => r.data_type === 'agent_execution' || r.data_type === 'conversation')) assert.match(r.thread_id, /^ses_/)
  const assistant = rows.filter(r => r.event_type === 'conversation.message' && r.metadata.role === 'assistant')
  assert.ok(assistant.length && assistant.every(r => /^msg_/.test(r.message_id) && r.metadata.native_part_ids?.length), 'assistant text carries native message/part ids')
  assert.ok(rows.filter(r => r.event_type === 'agent.turn_end').every(r => /^msg_/.test(r.metadata.native_user_message_id)), 'turn records the native user message id')

  // Prohibited streams and private values are absent from rows and from stored content.
  assert.ok(!rows.some(r => R.PROHIBITED_EVENT_RE.test(r.event_type)), 'no pointer/keystroke/recording types')
  assert.ok(rows.every(r => R.EVENTS[r.event_type]), 'only contract event types')
  const everything = JSON.stringify(rows) + '\n' + contentText(net)
  for (const secret of [TOKEN, API_KEY, EMAIL, homedir(), project]) assert.ok(!everything.includes(secret), `absent from the dataset: ${secret.slice(0, 12)}…`)
  return { primaries, byId }
}

// A scripted OpenCode turn: native ids, a write tool, a question and a permission in the middle.
function turnEvents(sid, project, step) {
  const msg = `msg_${step}_assistant`
  return {
    identity: { sessionId: sid, type: 'identity', detail: `msg_${step}_user` },
    text: t => ({ sessionId: sid, type: 'text', text: t, messageId: msg, partId: `prt_${step}_text` }),
    write: (status, rel) => ({ sessionId: sid, type: 'tool', tool: 'write', toolCallId: `call_${step}_write`, messageId: msg, partId: `prt_${step}_tool`,
      text: status, input: { filePath: join(project, rel), content: `see ${HOME_FILE}` }, ...(status === 'completed' ? { output: 'Wrote file' } : {}) }),
    question: resolved => ({ sessionId: sid, type: 'question', question: resolved ? { id: `que_${step}`, questions: [], answers: [['Original']], resolved: 'answered' }
      : { id: `que_${step}`, questions: [{ question: 'Which condition?', options: [] }] } }),
    permission: resolved => ({ sessionId: sid, type: 'permission', permission: { id: `per_${step}`, type: 'bash', ...(resolved ? { resolved: 'once' } : {}) } }),
    usage: { sessionId: sid, type: 'usage', messageId: msg, usage: { input: 1000, output: 200 } },
    done: { sessionId: sid, type: 'done' },
  }
}

test('coverage map lists every contract event type exactly once under its data type', () => {
  const listed = Object.entries(MAP.data_types).flatMap(([type, spec]) => Object.keys(spec.event_types).map(e => [e, type]))
  assert.deepEqual(new Set(Object.keys(MAP.data_types)), new Set(R.DATA_TYPES))
  assert.equal(new Set(listed.map(([e]) => e)).size, listed.length)
  assert.deepEqual(listed.map(([e]) => e).sort(), Object.keys(R.EVENTS).sort())
  for (const [e, type] of listed) assert.equal(R.EVENTS[e].dataType, type, `${e} belongs to ${type}`)
  for (const spec of Object.values(MAP.data_types)) for (const [e, surfaces] of Object.entries(spec.event_types))
    for (const s of ['desktop', 'headless']) assert.ok(surfaces[s], `${e} states its ${s} capture point, gap or not_applicable`)
})

test('desktop: scripted source-to-program session has one primary action per operation and linked records', async () => {
  const root = await mkdtemp(join(temp, 'desktop-')), project = join(root, 'Project With Paper'), net = network()
  await mkdir(join(project, 'artifacts'), { recursive: true })
  const c = collector(join(root, 'queue'), 'desktop', net), agent = R.createResearchAgent((e, ctx) => c.capture(e, ctx))
  const writes = R.createWriteAttribution(), expected = new Map()
  const ctx = { project_id: PROJECT, dir: project }
  // Renderer -> IPC -> main exactly as telemetry.ts routes it (JSON round trip and actionRef validation).
  // IPC messages from one renderer arrive in order, so each is routed before the next request.
  const route = (type, opts) => { const o = JSON.parse(JSON.stringify(opts)); agent.interaction(type, { ...o, action: R.actionRef(o.action) }, ctx) }
  const ops = R.createOperations({ send: route, uuid: () => crypto.randomUUID(),
    now: () => Date.now(), later: (fn, ms) => setTimeout(fn, ms), cancel: h => clearTimeout(h), microtask: fn => queueMicrotask(fn) })
  const main = () => sleep(0)
  const op = (label, ref) => { expected.set(ref.id, label); return ref }
  // Each user input is its own browser task (`await main()` lets the previous dispatch finish); its
  // handler then runs synchronously, as a React click handler does.
  const click = target => ops.begin(target, 'pointer')
  const version = async (rel, text, by, human) => {
    await writeFile(join(project, rel), text)
    const link = agent.versionLink(project, rel, by, human)
    const cols = Object.fromEntries(['action_id', 'caused_by', 'thread_id', 'tool_call_id'].filter(k => link[k]).map(k => [k, link[k]]))
    return c.capture({ event_type: rel === 'program.json' ? 'program.version' : 'artifact.version', project_id: PROJECT, artifact_id: rel, artifact_version: 1,
      ...cols, metadata: { ...link.metadata, by, [rel === 'program.json' ? 'program' : 'file']: text } }, { projectDir: project, email: EMAIL })
  }

  // 1. Import a paper: "From paper" tile, system dialog, create; opening the project continues the operation.
  await main(); click('button')
  const create = op('project.create_from_paper', ops.claim('project.create_from_paper', true)); ops.hold(60_000)
  await writeFile(join(project, 'paper.pdf'), Buffer.from('%PDF-1.4 original paper bytes\n'))
  await c.queueSource(join(project, 'paper.pdf'), PROJECT, 'application/pdf', agent.sourceLink(create))
  const opened = ops.claim('project.open', true); ops.track('project.opened', { durationMs: 40 }, opened)
  assert.equal(opened.id, create.id, 'opening the created project is the same operation')
  await main()

  // 2. Navigate: a tab click whose only semantic record is the dwell it ends -> one generic primary + linked dwell.
  const tab = op('tab click', (await main(), click('button'))); ops.track('tab.switch', { target: 'study:paper', durationMs: 1500 })
  await sleep(350); await main()
  // A keyboard shortcut whose handler fires a product action: only the product action is recorded.
  await main(); const shortcut = op('files.toggle via shortcut', ops.begin('shortcut:cmd+b', 'shortcut')); ops.track('files.toggle', { metadata: { open: true } })
  // A menu accelerator that also reached the page: shortcut keydown + menu command are one operation.
  await main(); const accel = op('settings via accelerator', ops.begin('shortcut:cmd+,', 'shortcut')); await sleep(20); ops.menu('menu:settings', true)
  ops.track('settings.opened', { target: 'general' })
  // A click a generic listener and a semantic handler both saw.
  const pick = op('program.item_pick', (await main(), click('button'))); ops.track('program.item_pick', { target: 's1' })
  await main()

  // 3. Select (mouse-up selection, no click) and annotate (click Save note -> file + annotation record).
  ops.track('source.select', { target: 'page.2', metadata: { page: 2, chars: 40 } })
  await main(); click('button'); const annotate = op('source.annotate', ops.claim('source.annotate'))
  writes.note(join(project, 'paper.pdf.annotations.json'), '{"version":1}', annotate)
  await version('paper.pdf.annotations.json', '{"version":1}', 'human', annotate)
  ops.track('source.annotated', { metadata: { annotation_id: 'ann-1', anchor: { source: join(project, 'paper.pdf'), pages: [{ page: 2, rects: [[0.1, 0.2, 0.3, 0.05]] }] } } }, annotate)
  ops.track('ui.scroll', { durationMs: 900, metadata: { endDepth: 400, distance: 300, direction: 'down' } })
  await main()

  // 4. Ask the agent (composer Enter); question, permission and a write tool inside the turn.
  const sid = 'ses_desktop'; agent.bind(sid, PROJECT, project, 'reported-model')
  await main(); ops.begin('composer.send', 'keyboard')
  const ask = op('composer.send', ops.claim('composer.send'))
  agent.start(sid, `Build the program. My key is ${API_KEY}, mail ${EMAIL}.`, ask)
  const ev = turnEvents(sid, project, 'a')
  agent.event(ev.identity); agent.event(ev.text('Reading the paper. ')); agent.event(ev.question(false))
  await main(); click('button'); const answer = op('question.reply', ops.claim('question.reply'))
  agent.answer(sid, 'que_a', answer); agent.event(ev.question(true)); ops.track('question.reply', { metadata: { question_id: 'que_a' } }, answer)
  agent.event(ev.permission(false))
  await main(); click('button'); ops.track('permission.reply', { target: 'bash' }); const permit = ops.claim('permission.reply'); op('permission.reply', permit)
  agent.permit(sid, 'per_a', permit); agent.event(ev.permission(true))
  agent.event(ev.write('running', 'program.json'))
  const agentProgram = JSON.stringify({ nodes: [{ id: 's1', title: 'Study 1' }] })
  await version('program.json', agentProgram, writes.by(join(project, 'program.json'), agentProgram))
  agent.event(ev.write('completed', 'program.json'))
  agent.event(ev.text('Program saved.')); agent.event(ev.usage); agent.event(ev.done)
  await main()

  // 5. Save a program change (human edit) and open an artifact the agent wrote.
  await main(); click('button'); const save = op('program.edit', ops.claim('program.edit'))
  const humanProgram = JSON.stringify({ nodes: [{ id: 's1', title: 'Study 1 (confirmed)' }] })
  writes.note(join(project, 'program.json'), humanProgram, save)
  await version('program.json', humanProgram, writes.by(join(project, 'program.json'), humanProgram), writes.action(join(project, 'program.json'), humanProgram))
  ops.track('program.edited', { target: 's1', metadata: { field: 'title' } }, save)
  await version('artifacts/report.md', '# Report\nFull generated text.\n', 'agent')
  const openArtifact = op('file.open', (await main(), click('button'))); ops.track('file.open', { target: 'artifacts/report.md', metadata: { ext: 'md' } })
  await main()

  // 6. Simulation run: the approval is awaited, then sent; the turn belongs to the run operation.
  const run = op('simulation.run', (await main(), click('button'))); ops.track('simulation.run', { metadata: { perCondition: 5 } }); ops.hold(60_000)
  await sleep(400)
  const runSend = ops.claim('composer.send'); assert.equal(runSend.id, run.id, 'the awaited approval send continues the run operation')
  agent.start(sid, 'Run the approved simulation.', runSend)
  const ev2 = turnEvents(sid, project, 'b'); agent.event(ev2.identity); agent.event(ev2.text('Running.'))
  const stop = op('simulation.stop', (await main(), click('button'))); ops.track('simulation.stop', { metadata: { done: 2, total: 10 } })
  const stopRef = ops.claim('simulation.stop'); agent.abort(sid, stopRef)
  await main()

  await sleep(350); await main()
  await agent.close(); await c.end('closed'); await c.flush()
  assert.equal(await c.pending(), 0, 'everything delivered')
  const rows = [...net.events.values()].sort((a, b) => a.client_seq - b.client_seq)
  const { byId } = checkCoverage(rows, net, 'desktop', { project, expectedOperations: expected })

  // Specific causal links.
  const by = (type, f = () => true) => rows.filter(r => r.event_type === type && f(r))
  assert.equal(by('action.invoke', r => r.id === shortcut.id)[0].target, 'files.toggle')
  assert.equal(by('action.invoke', r => r.id === shortcut.id)[0].metadata.via, 'shortcut')
  assert.equal(by('action.invoke', r => r.id === accel.id)[0].metadata.via, 'shortcut')
  assert.equal(by('action.invoke', r => r.id === tab.id)[0].target, 'button', 'generic click only because nothing semantic claimed it')
  assert.equal(by('view.dwell')[0].action_id, tab.id)
  assert.equal(by('action.invoke', r => r.id === pick.id).length, 1)
  assert.equal(by('source.import')[0].action_id, create.id)
  assert.equal(by('annotation.commit')[0].action_id, annotate.id)
  assert.equal(by('annotation.commit')[0].metadata.anchor.source, 'paper.pdf', 'annotation keeps its project-relative source identity')
  assert.ok(!by('selection.commit')[0].action_id, 'a selection without a click is a standalone completion record')
  const [agentVersion, humanVersion] = by('program.version')
  assert.equal(agentVersion.tool_call_id, 'call_a_write'); assert.equal(agentVersion.metadata.writer_link, 'tool-input')
  assert.equal(byId.get(agentVersion.caused_by).event_type, 'tool.start'); assert.equal(agentVersion.action_id, ask.id)
  assert.equal(humanVersion.action_id, save.id); assert.equal(humanVersion.metadata.trigger, 'human-save')
  assert.equal(by('artifact.version', r => r.artifact_id === 'artifacts/report.md')[0].tool_call_id, 'call_a_write', 'recent tool in the project')
  const resolvedQ = by('conversation.question', r => r.metadata.status === 'answered')[0]
  assert.equal(resolvedQ.action_id, answer.id); assert.equal(resolvedQ.metadata.parent_action_id, ask.id)
  assert.equal(by('action.invoke', r => r.id === answer.id)[0].metadata.parent_action_id, ask.id)
  assert.equal(by('permission.decision')[0].action_id, permit.id)
  const runTurn = by('agent.turn_start').find(r => r.action_id === run.id); assert.ok(runTurn, 'the simulation turn links to the run operation')
  const stopped = by('agent.turn_end').find(r => r.action_id === run.id)
  assert.equal(stopped.metadata.status, 'aborted'); assert.equal(stopped.metadata.stopped_by_action_id, stop.id)
  assert.ok(by('tool.start').every(r => r.action_id === ask.id))
  assert.ok(!by('action.invoke').some(r => /^ui\.click$|^shortcut$/.test(r.metadata.operation) && expected.get(r.id) !== 'tab click'))
  await rm(root, { recursive: true, force: true })
})

test('headless: commands are the primary actions and drive the same linked records', async t => {
  const root = realpathSync(await mkdtemp(join(temp, 'headless-'))), project = join(root, 'project'), net = network()
  await mkdir(join(project, 'artifacts'), { recursive: true })
  await writeFile(join(project, 'paper.pdf'), Buffer.from('%PDF-1.4 headless paper\n'))
  await writeFile(join(project, 'CONVERT.md'), 'Build the program from paper.pdf.')
  await writeFile(join(project, 'program.json'), '{"nodes":[]}')
  const c = collector(join(root, 'queue'), 'headless', net)
  const hr = await startHeadlessResearch({ research: c, createResearchAgent: R.createResearchAgent, project, projectId: PROJECT, model: 'test-model', provider: 'humanstudy', auto: 'off' })
  const sid = 'ses_headless'
  class Kernel {
    listeners = new Set(); onEvent(cb) { this.listeners.add(cb); return () => this.listeners.delete(cb) }
    emit(e) { for (const cb of this.listeners) cb({ sessionId: sid, ...e }) }
    async startSession() { return sid } async resumeSession() { return null } async send() {} async dispose() {}
    async abort() { this.emit({ type: 'done' }) } async reply(_s, id, r) { this.emit({ type: 'permission', permission: { id, type: 'bash', resolved: r } }) }
    async answerQuestion(_s, id, answers) { this.emit({ type: 'question', question: { id, questions: [], answers, resolved: 'answered' } }) }
    async rejectQuestion() {} async questions() { return [] } setPermissionMode() {}
  }
  const kernel = new Kernel(), input = new PassThrough(), output = new PassThrough(), replies = []
  output.on('data', d => { for (const l of String(d).trim().split('\n')) if (l) replies.push(JSON.parse(l)) })
  const bridge = await controlAssets({ kernel, project, input, output, logDir: join(root, 'log'), onOperation: hr.onOperation, onRequest: hr.onRequest,
    onSession: hr.onSession, onEvent: hr.onEvent })
  const command = async body => { const id = 'r' + replies.length + Math.random(); input.write(JSON.stringify({ ...body, id }) + '\n')
    for (let i = 0; i < 200 && !replies.some(r => r.id === id); i++) await sleep(5); return replies.find(r => r.id === id) }
  const ev = turnEvents(sid, project, 'h')
  assert.equal((await command({ op: 'build' })).ok, true)
  kernel.emit(ev.identity); kernel.emit(ev.text('Converting. ')); kernel.emit(ev.question(false))
  assert.equal((await command({ op: 'answer', questionId: 'que_h', answers: [['Original']] })).ok, true)
  kernel.emit(ev.permission(false))
  assert.equal((await command({ op: 'permission', permissionId: 'per_h', reply: 'once' })).ok, true)
  kernel.emit(ev.write('running', 'artifacts/materials.md'))
  await writeFile(join(project, 'artifacts', 'materials.md'), `# Materials\nverbatim ${HOME_FILE}\n`)
  kernel.emit(ev.write('completed', 'artifacts/materials.md'))
  // Two program checkpoints written through bash (program_io.py) during one turn: each is a version.
  for (const n of [1, 2]) {
    const call = { type: 'tool', tool: 'bash', toolCallId: 'call_h_ckpt' + n, messageId: 'msg_h_assistant', partId: 'prt_h_ckpt' + n, input: { command: 'python .opencode/skills/build/program_io.py batch-' + n + '.json' } }
    kernel.emit({ ...call, text: 'running' }); await writeFile(join(project, 'program.json'), JSON.stringify({ nodes: [{ id: 'n' + n }] }))
    kernel.emit({ ...call, text: 'completed', output: 'saved' }); await sleep(50)
  }
  kernel.emit(ev.text('Done.')); kernel.emit(ev.usage); kernel.emit(ev.done)
  await sleep(50)
  assert.equal((await command({ op: 'questions' })).ok, true)
  input.write(JSON.stringify({ op: 'quit', id: 'quit' }) + '\n')
  await bridge.exited
  await hr.close(); await c.end('worker-exit'); await c.flush()
  assert.equal(await c.pending(), 0)
  const rows = [...net.events.values()].sort((a, b) => a.client_seq - b.client_seq)
  const commands = rows.filter(r => r.event_type === 'action.invoke')
  const expected = new Map(commands.map(r => [r.id, r.target]))
  assert.deepEqual(commands.map(r => r.target), ['command.start', 'command.build', 'command.answer', 'command.permission', 'command.questions', 'command.quit'])
  assert.ok(commands.every(r => r.metadata.ui_actions === 'not_applicable' && r.metadata.via === 'system' && r.view === 'headless'))
  const { byId } = checkCoverage(rows, net, 'headless', { project, expectedOperations: expected })
  const id = target => commands.find(r => r.target === target).id
  assert.ok(rows.filter(r => r.event_type === 'source.import' || (r.data_type === 'knowledge_artifact' && r.metadata.trigger === 'baseline')).every(r => r.action_id === id('command.start')))
  assert.equal(rows.find(r => r.event_type === 'agent.turn_start').action_id, id('command.build'))
  const answered = rows.find(r => r.event_type === 'conversation.question' && r.metadata.status === 'answered')
  assert.equal(answered.action_id, id('command.answer')); assert.equal(answered.metadata.parent_action_id, id('command.build'))
  assert.equal(rows.find(r => r.event_type === 'permission.decision').action_id, id('command.permission'))
  const written = rows.find(r => r.artifact_id === 'artifacts/materials.md')
  assert.equal(written.tool_call_id, 'call_h_write'); assert.equal(byId.get(written.caused_by).event_type, 'tool.end'); assert.equal(written.action_id, id('command.build'))
  assert.ok(!rows.some(r => r.data_type === 'interaction' && r.metadata.via !== 'system'), 'no UI actions on headless')
  const programs = rows.filter(r => r.event_type === 'program.version')
  assert.deepEqual(programs.map(r => r.artifact_version), [1, 2, 3], 'baseline plus both mid-turn checkpoints')
  assert.deepEqual(programs.slice(1).map(r => r.tool_call_id), ['call_h_ckpt1', 'call_h_ckpt2'])
  await rm(root, { recursive: true, force: true })
})

test.after(() => rm(temp, { recursive: true, force: true }))
