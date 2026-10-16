// Threads test (mock kernel, temp project folder, no network):
//   node src/main/threads.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'threads-test-'))
await build({
  entryPoints: [join(here, 'threads-core.ts'), join(here, 'kernel', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: out,
  logLevel: 'error',
})
const T = await import(pathToFileURL(join(out, 'threads-core.js')).href)
const K = await import(pathToFileURL(join(out, 'kernel', 'index.js')).href)

// ---- appendEvent ---------------------------------------------------------------------
{
  let n = 0
  const ids = () => `x${++n}`
  const at = () => '2026-01-01T00:00:00.000Z'
  const ev = (type, o = {}) => ({ sessionId: 's', type, ...o })
  let ms = []
  ms = T.appendEvent(ms, ev('status', { text: 'busy' }), at, ids)
  assert.equal(ms.length, 0)
  const frozen = Object.freeze([])
  ms = T.appendEvent(frozen, ev('text', { text: 'Hel' }), at, ids)
  ms = T.appendEvent(ms, ev('text', { text: 'lo' }), at, ids)
  assert.deepEqual(ms[0].parts, [{ kind: 'text', text: 'Hello' }])
  ms = T.appendEvent(ms, ev('tool', { tool: 'bash', text: 'pending', detail: '{}' }), at, ids)
  ms = T.appendEvent(ms, ev('tool', { tool: 'bash', text: 'running', detail: 'ls' }), at, ids)
  ms = T.appendEvent(ms, ev('tool', { tool: 'bash', text: 'completed', detail: 'ls' }), at, ids)
  assert.equal(ms[0].parts.length, 2)
  assert.deepEqual(ms[0].parts[1], { kind: 'tool', tool: 'bash', detail: 'ls', state: 'completed' })
  // a finished tool is not overwritten by the next call of the same tool
  ms = T.appendEvent(ms, ev('tool', { tool: 'bash', text: 'running', detail: 'pwd' }), at, ids)
  assert.equal(ms[0].parts.length, 3)
  // a permission card between a tool's pending and running events does not split the tool row
  {
    let t = []
    t = T.appendEvent(t, ev('tool', { tool: 'bash', text: 'pending', detail: '{}' }), at, ids)
    t = T.appendEvent(t, ev('permission', { permission: { id: 'per_9', type: 'bash', title: 'ls -la', patterns: ['ls -la'] } }), at, ids)
    t = T.appendEvent(t, ev('tool', { tool: 'bash', text: 'running', detail: 'ls -la' }), at, ids)
    const tools = t[0].parts.filter((p) => p.kind === 'tool')
    assert.equal(tools.length, 1)
    assert.equal(tools[0].detail, 'ls -la')
  }
  // permission request, then its answer
  ms = T.appendEvent(ms, ev('permission', { permission: { id: 'per_1', type: 'bash', title: 'pwd', patterns: ['pwd'] } }), at, ids)
  const before = ms
  ms = T.appendEvent(ms, ev('permission', { permission: { id: 'per_1', type: 'bash', title: 'pwd' } }), at, ids)
  assert.equal(ms[0].parts.length, 4, 'a repeated request is not added twice')
  ms = T.appendEvent(ms, ev('permission', { permission: { id: 'per_1', type: '', resolved: 'once' } }), at, ids)
  assert.equal(ms[0].parts[3].resolved, 'once')
  assert.equal(before[0].parts[3].resolved, undefined, 'input not mutated')
  ms = T.appendEvent(ms, ev('permission', { permission: { id: 'per_zzz', type: '', resolved: 'once' } }), at, ids)
  assert.equal(ms[0].parts.length, 4)
  ms = T.appendEvent(ms, ev('error', { text: 'boom' }), at, ids)
  assert.deepEqual(ms[0].parts.at(-1), { kind: 'error', text: 'boom' })
  // a new assistant message after a user message; late permission answer reaches the earlier one
  ms = [...ms, { id: 'u', role: 'user', parts: [{ kind: 'text', text: 'hi' }], at: at() }]
  ms = T.appendEvent(ms, ev('text', { text: 'next' }), at, ids)
  assert.equal(ms.length, 3)
  assert.equal(ms[2].role, 'assistant')
  assert.equal(T.autoTitle('  What   is\nthe design? '), 'What is the design?')
  assert.equal(T.autoTitle('x'.repeat(100)).length, 60)
  assert.equal(T.autoTitle('   '), 'New thread')
  assert.deepEqual(T.addUsage({ input: 1, output: 2, cost: 0.5 }, { input: 3, output: 4 }), { input: 4, output: 6, cost: 0.5 })
  assert.match(T.contextPrompt(ms, 'and now?'), /User: hi[\s\S]*and now\?$/)
  console.log('appendEvent ok')
}

// Session recovery must retain the beginning and end of long conversations and tool outputs.
{
  const payload = 'begin ' + 'research detail '.repeat(5000) + ' end'
  const history = [{ id: 'u', role: 'user', at: 'now', parts: [{ kind: 'text', text: payload }] },
    { id: 'a', role: 'assistant', at: 'now', parts: [{ kind: 'tool', tool: 'read', detail: payload, input: { path: 'sources/data.csv' }, output: payload, state: 'completed' }] }]
  const prompt = T.contextPrompt(history, 'Continue')
  assert.ok(prompt.includes('User: ' + payload))
  assert.ok(prompt.includes(JSON.stringify({ tool: 'read', detail: payload, input: { path: 'sources/data.csv' }, output: payload, state: 'completed' })))
  assert.ok(!prompt.includes('[earlier messages omitted]'))
}

// ---- capture hook: each part once, when final; tool input/output are stored ---------------
{
  const dir = mkdtempSync(join(tmpdir(), 'workspace-context-'))
  const captured = []
  const manager = new T.ThreadManager({ kernelName: () => 'mock', start: async () => 'ctx-session', resume: async () => null }, () => undefined, { onCapture: c => captured.push(c) })
  const thread = await manager.create(dir)
  const focus = { project:'Paper project', programId:'p1', study:{id:'study2',title:'Study 2',type:'empirical'}, activeTab:'file', openTabs:['study','paper','artifacts/report.md'], file:{path:'artifacts/report.md',ext:'md',unsaved:true} }
  const sent = manager.beforeSend(thread.kernelSessionId, '这里需要改什么？', focus)
  assert.ok(sent.startsWith('这里需要改什么？'))
  assert.ok(sent.includes('"id":"study2"') && sent.includes('"unsaved":true'))
  focus.study.id = 'study3' // A later view switch must not rewrite a past turn's focus.
  const stored = await manager.get(dir, thread.id)
  assert.equal(stored.messages[0].parts[0].text, '这里需要改什么？', 'UI metadata must not clutter the chat bubble')
  assert.equal(stored.messages[0].workspace.study.id, 'study2')
  assert.equal(captured[0].workspace.study.id, 'study2')
  await manager.flush()
  const saved = JSON.parse(readFileSync(join(dir,'.humanstudy','threads',`${thread.id}.json`),'utf8'))
  assert.equal(saved.messages[0].workspace.file.path,'artifacts/report.md')
  assert.ok(T.contextPrompt(saved.messages, '继续').includes('"id":"study2"'), 'thread recovery must preserve historic UI focus')
}

{
  const caps = []
  const m = new T.ThreadManager({ kernelName: () => 'mock', start: async () => 'sess-1', resume: async () => null }, () => undefined, { saveDelayMs: 1, onCapture: (c) => caps.push(c) })
  const th = await m.create(mkdtempSync(join(tmpdir(), 'cap-')))
  const sid = th.kernelSessionId
  m.beforeSend(sid, 'hello')
  const ev = (e) => m.onEvent({ sessionId: sid, ...e })
  ev({ type: 'text', text: 'Looking' })
  ev({ type: 'text', text: ' now.' })
  assert.equal(caps.filter((c) => c.role === 'assistant').length, 0) // text not final yet
  ev({ type: 'tool', tool: 'bash', text: 'running', input: { command: 'ls' } })
  assert.equal(caps.filter((c) => c.role === 'assistant').length, 1) // the text is final once a tool follows
  ev({ type: 'tool', tool: 'bash', text: 'completed', detail: 'ls', output: 'a.txt' })
  ev({ type: 'permission', permission: { id: 'p1', type: 'bash', title: 'rm x' } })
  ev({ type: 'permission', permission: { id: 'p1', type: '', resolved: 'once' } })
  ev({ type: 'usage', usage: { input: 3, output: 4 } })
  ev({ type: 'done' })
  ev({ type: 'done' })
  const parts = caps.filter((c) => c.kind === 'part')
  assert.deepEqual(parts.map((c) => c.part.kind), ['text', 'text', 'tool', 'permission'])
  const tool = parts.find((c) => c.part.kind === 'tool')
  assert.deepEqual([tool.part.input, tool.part.output, tool.part.state], [{ command: 'ls' }, 'a.txt', 'completed'])
  assert.equal(parts[3].part.resolved, 'once')
  assert.ok(parts.every((c) => c.threadId === th.id && c.messageId))
  assert.equal(caps.filter((c) => c.kind === 'usage').length, 1)
  assert.equal(new Set(parts.map((c) => `${c.messageId}:${c.index}`)).size, parts.length) // never twice
  console.log('capture ok')
}

// ---- manager with the mock kernel ------------------------------------------------------
const project = mkdtempSync(join(tmpdir(), 'threads-proj-'))
let kernel = new K.MockKernel({ tickMs: 1 })
const changed = []
const host = () => ({
  kernelName: () => kernel.name,
  start: (dir) => kernel.startSession(dir),
  resume: (dir, sid) => kernel.resumeSession(dir, sid),
})
const mk = () => {
  const m = new T.ThreadManager(host(), (e) => changed.push(e), { saveDelayMs: 5 })
  kernel.onEvent((e) => m.onEvent(e))
  return m
}
let mgr = mk()

async function turn(m, sid, text) {
  const done = new Promise((resolve) => {
    const off = kernel.onEvent((e) => {
      if (e.sessionId === sid && e.type === 'done') (off(), resolve())
    })
  })
  const prompt = m.beforeSend(sid, text)
  await kernel.send(sid, prompt)
  await done
  await m.flush() // Await persistence rather than assuming disk writes finish within 20 ms.
  return prompt
}

const t = await mgr.create(project)
assert.equal(t.messages.length, 0)
assert.equal(t.kernel, 'mock')
assert.deepEqual(await mgr.list(project), [], 'empty threads are not listed')
assert.ok(!existsSync(join(project, '.humanstudy', 'threads')))

await turn(mgr, t.kernelSessionId, 'Summarise the study design in detail please')
let got = await mgr.get(project, t.id)
assert.equal(got.title, 'Summarise the study design in detail please')
assert.equal(got.messages.length, 2)
assert.equal(got.messages[0].role, 'user')
assert.equal(got.messages[1].role, 'assistant')
assert.match(got.messages[1].parts[0].text, /You asked/)
assert.ok(got.messages[1].parts.some((p) => p.kind === 'tool' && p.tool === 'read' && p.state === 'completed'))
assert.ok(got.usage.input > 0 && got.usage.output > 0)
await mgr.flush()
const file = join(project, '.humanstudy', 'threads', `${t.id}.json`)
assert.ok(existsSync(file))
const disk = JSON.parse(readFileSync(file, 'utf8'))
assert.equal(disk.kernelSessionId, t.kernelSessionId)
assert.equal(disk.messages.length, 2)
assert.ok(changed.some((c) => c.id === t.id && c.dir === project))

// kernel title replaces the auto title, a user rename wins over later kernel titles
mgr.onEvent({ sessionId: t.kernelSessionId, type: 'title', text: 'Study design overview' })
await new Promise((r) => setTimeout(r, 20))
assert.equal((await mgr.get(project, t.id)).title, 'Study design overview')
await mgr.rename(project, t.id, 'My name')
mgr.onEvent({ sessionId: t.kernelSessionId, type: 'title', text: 'Kernel again' })
assert.equal((await mgr.get(project, t.id)).title, 'My name')

// permission recorded and resolved
{
  const offs = []
  const sid = t.kernelSessionId
  const answered = new Promise((resolve) =>
    offs.push(
      kernel.onEvent((e) => {
        if (e.sessionId === sid && e.type === 'permission' && !e.permission.resolved)
          setTimeout(() => kernel.reply(sid, e.permission.id, 'always').then(resolve), 5)
      })
    )
  )
  await turn(mgr, sid, 'please run it')
  await answered
  offs.forEach((o) => o())
  got = await mgr.get(project, t.id)
  const perm = got.messages.at(-1).parts.find((p) => p.kind === 'permission')
  assert.equal(perm?.type, 'bash')
  assert.equal(perm?.resolved, 'always')
}

// second thread, list order, then a restart of everything (new kernel, new manager)
const t2 = await mgr.create(project)
await turn(mgr, t2.kernelSessionId, 'Second thread')
let list = await mgr.list(project)
assert.deepEqual(list.map((x) => x.id), [t2.id, t.id])
assert.equal(list[1].title, 'My name')
assert.equal(list[1].messageCount, got.messages.length)

await mgr.flush()
await kernel.dispose()
kernel = new K.MockKernel({ tickMs: 1 })
mgr = mk()
const r = await mgr.resume(project, t.id)
assert.equal(r.resumedWithContext, true, 'lost session -> new session with context')
assert.notEqual(r.kernelSessionId, t.kernelSessionId)
assert.equal(r.messages.length, got.messages.length)
const first = await turn(mgr, r.kernelSessionId, 'And what next?')
assert.match(first, /<transcript>[\s\S]*Summarise the study design[\s\S]*<\/transcript>[\s\S]*And what next\?$/)
const second = await turn(mgr, r.kernelSessionId, 'Thanks')
assert.equal(second, 'Thanks', 'context only goes with the first prompt')
const after = await mgr.get(project, t.id)
assert.equal(after.messages[got.messages.length].parts[0].text, 'And what next?', 'stored message is the original text')
assert.equal(after.kernelSessionId, r.kernelSessionId)

// resume while the kernel still has the session: re-attach, nothing lost, no context
const again = await mgr.resume(project, t.id)
assert.equal(again.kernelSessionId, r.kernelSessionId)
assert.equal(again.messages.length, after.messages.length)
await mgr.flush()

// adopt (legacy startSession path): lazily saved
const sid = await kernel.startSession(project)
const adopted = mgr.adopt(project, sid)
assert.ok(!existsSync(join(project, '.humanstudy', 'threads', `${adopted.id}.json`)))
await turn(mgr, sid, 'Legacy')
assert.ok(existsSync(join(project, '.humanstudy', 'threads', `${adopted.id}.json`)))

// delete and bad ids
await mgr.delete(project, t2.id)
assert.ok(!existsSync(join(project, '.humanstudy', 'threads', `${t2.id}.json`)))
assert.ok(!(await mgr.list(project)).some((x) => x.id === t2.id))
await assert.rejects(mgr.get(project, '../etc/passwd'))
await assert.rejects(mgr.delete(project, '../x'))
assert.equal(readdirSync(join(project, '.humanstudy', 'threads')).filter((f) => f.endsWith('.tmp')).length, 0)

// Real filesystem failure blocks quit; retry preserves the complete final reply.
const failDir = mkdtempSync(join(tmpdir(), 'threads-disk-failure-'))
const failing = new T.ThreadManager({kernelName:()=> 'mock',start:async()=> 'failed-session',resume:async()=>null},()=>{}, {saveDelayMs:60_000})
const unsaved = await failing.create(failDir)
writeFileSync(join(failDir, '.humanstudy'), 'blocks directory creation')
failing.beforeSend(unsaved.kernelSessionId, 'Keep the complete reply')
const lastReply = 'complete content '.repeat(10000) + 'FINAL SENTENCE'
failing.onEvent({sessionId:unsaved.kernelSessionId,type:'text',text:lastReply})
const oldError=console.error
try {
  console.error=()=>{}
  await assert.rejects(failing.flush(), /Could not save conversations/)
} finally { console.error=oldError }
unlinkSync(join(failDir,'.humanstudy'))
await failing.flush()
const saved=JSON.parse(readFileSync(join(failDir,'.humanstudy','threads',unsaved.id+'.json'),'utf8'))
assert.equal(saved.messages.at(-1).parts[0].text,lastReply)
rmSync(failDir,{recursive:true,force:true})

await mgr.flush()
await kernel.dispose()
rmSync(out, { recursive: true, force: true })
rmSync(project, { recursive: true, force: true })
console.log('threads ok')
