import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const out = mkdtempSync(join(tmpdir(), 'budget-recovery-'))
await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'k.mjs'), logLevel: 'error' })
const { OpencodeKernel } = await import(pathToFileURL(join(out, 'k.mjs')).href)
const tick = () => new Promise(r => setImmediate(r))
async function scenario(name, run) {
  const k = new OpencodeKernel({ binary: '/bin/true', provider: 'humanstudy' })
  k.register('s', { dir: out, exited: false })
  const events = [], requests = []
  k.onEvent(e => events.push(e))
  k.request = async (_server, method, path, body) => {
    requests.push({ method, path, body })
    return new Response(path === '/question' ? '[]' : 'true')
  }
  let id = 0
  const finish = (reason = 'length', output = 0) => k.handle({ type: 'message.updated', properties: { info: { sessionID: 's', id: `${name}-${++id}`, role: 'assistant', finish: reason, time: { completed: 1 }, tokens: { input: 20, output, reasoning: 32000 } } } })
  const idle = () => k.handle({ type: 'session.idle', properties: { sessionID: 's' } })
  try { await run({ k, events, requests, finish, idle }) } finally { await k.dispose() }
}
await scenario('success', async ({ k, events, requests, finish, idle }) => {
  await k.send('s', 'Create the full human program')
  finish(); idle(); idle(); await tick()
  assert.equal(requests.length, 2, 'one adjusted request, despite duplicate idle')
  assert.equal(events.some(e => e.type === 'done' || e.type === 'error'), false, 'busy stays active during recovery')
  assert.equal(requests[1].body.variant, 'humanstudy-recovery')
  assert.match(requests[1].body.parts[0].text, /First inspect existing files/)
  assert.match(requests[1].body.parts[0].text, /Preserve every required detail/)
  assert.match(requests[1].body.parts[0].text, /Do not repeat completed actions/)
  finish('stop', 10); idle()
  assert.equal(events.filter(e => e.type === 'done').length, 1)
  assert.equal(events.filter(e => e.type === 'error').length, 0)
  assert.equal(events.filter(e => e.type === 'usage').length, 2, 'failed and recovered usage remain visible')
})
await scenario('no-progress', async ({ k, events, requests, finish, idle }) => {
  await k.send('s', 'Write')
  finish(); idle(); await tick()
  finish(); idle(); await tick()
  assert.equal(requests.length, 2, 'zero-output adjusted attempt must not keep retrying')
  assert.match(events.find(e => e.type === 'error').text, /no visible output or successful tool action/)
  assert.equal(events.filter(e => e.type === 'done').length, 1)
})
await scenario('bounded-progress', async ({ k, events, requests, finish, idle }) => {
  await k.send('s', 'Write')
  finish(); idle(); await tick()
  finish('length', 12); idle(); await tick()
  assert.equal(requests.length, 3)
  assert.match(requests[2].body.parts[0].text, /Further reduce the size/)
  finish('length', 12); idle(); await tick()
  assert.equal(requests.length, 3, 'at most two adjustments even with progress')
  assert.equal(events.filter(e => e.type === 'error').length, 1)
})
await scenario('abort-before-adjustment', async ({ k, events, requests, finish, idle }) => {
  await k.send('s', 'Write')
  finish(); idle(); await k.abort('s'); await tick()
  assert.equal(requests.filter(r => r.path.endsWith('prompt_async')).length, 1)
  idle()
  assert.equal(events.filter(e => e.type === 'done').length, 1)
})
await scenario('native-continues', async ({ k, events, requests, finish, idle }) => {
  await k.send('s', 'Write')
  finish()
  k.handle({ type: 'message.updated', properties: { info: { sessionID: 's', id: 'native-next', role: 'assistant' } } })
  finish('stop', 10); idle(); await tick()
  assert.equal(requests.length, 1, 'native continuation supersedes recovery')
  assert.equal(events.filter(e => e.type === 'done').length, 1)
})
await scenario('http-failure', async ({ k, events, finish, idle }) => {
  await k.send('s', 'Write')
  k.request = async () => { throw new Error('fixture transport failed') }
  finish(); idle(); await tick()
  assert.match(events.find(e => e.type === 'error').text, /could not start/)
  assert.equal(events.filter(e => e.type === 'done').length, 1)
})
await scenario('superseded', async ({ k, requests, finish, idle }) => {
  await k.send('s', 'Old task')
  finish(); idle()
  await k.send('s', 'New user instruction')
  await tick()
  assert.equal(requests.length, 2, 'a new user request cancels the queued automatic adjustment')
  assert.equal(requests[1].body.parts[0].text, 'New user instruction')
})
await scenario('unrelated-error', async ({ k, events, requests, idle }) => {
  await k.send('s', 'Write')
  k.handle({ type: 'session.error', properties: { sessionID: 's', error: { name: 'APIError', data: { message: 'fixture credentials rejected' } } } })
  idle(); await tick()
  assert.equal(requests.length, 1, 'credential and other errors are not output-budget recoveries')
  assert.match(events.find(e => e.type === 'error').text, /credentials rejected/)
})
await scenario('abort-during-dispatch', async ({ k, events, finish, idle }) => {
  await k.send('s', 'Write')
  let release
  k.request = async (_server, _method, path) => {
    if (path.endsWith('prompt_async')) await new Promise(resolve => { release = resolve })
    return new Response(path === '/question' ? '[]' : 'true')
  }
  finish(); idle(); await tick()
  await k.abort('s'); idle()
  assert.equal(events.filter(e => e.type === 'done').length, 1, 'stop finishes even while recovery dispatch is pending')
  release(); await tick()
  assert.equal(events.filter(e => e.type === 'error').length, 0)
})
console.log('Adjusted recovery, budget, progress gate, cancellation, native continuation and failed dispatch passed')

if (process.env.HUMANSTUDY_KERNEL_BIN) {
  let count = 0
  const bodies = []
  const model = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body)
    // Titles can be separate requests; only the main request has tools.
    const main = Boolean(body.tools?.length)
    const first = main && ++count === 1
    const chunk = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: first ? { reasoning_content: 'Thinking' } : { content: 'Recovered from saved work.' }, finish_reason: null }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.end(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: first ? 'length' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: first ? 32000 : 6, completion_tokens_details: { reasoning_tokens: first ? 32000 : 0 } } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(r => model.listen(0, '127.0.0.1', r))
  const k = new OpencodeKernel({ binary: process.env.HUMANSTUDY_KERNEL_BIN, home: join(out, 'home'), provider: 'humanstudy', model: 'anthropic/claude-haiku-5.5' })
  const originalConfig = JSON.parse(k.configContent())
  assert.equal(originalConfig.provider.humanstudy.models['anthropic/claude-haiku-5.5'].variants['humanstudy-recovery'].reasoningEffort, 'low')
  k.configContent = () => JSON.stringify({ ...originalConfig, provider: { humanstudy: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only' }, models: { 'anthropic/claude-haiku-5.5': { name: 'Fixture', tool_call: true, limit: { context: 200000, output: 32000 }, variants: { 'humanstudy-recovery': { reasoningEffort: 'low' } } } } } } })
  try {
    const sid = await k.startSession(out)
    const events = []
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Recovery timed out: ${JSON.stringify(events)}`)), 45000)
      k.onEvent(e => { if (e.sessionId === sid) { events.push(e); if (e.type === 'done') { clearTimeout(timer); resolve() } } })
    })
    await k.send(sid, 'Prepare the complete human program')
    await done
    assert.equal(count, 2, 'real native loop automatically resumes exactly once')
    const adjusted = bodies.find(b => b.messages?.some(m => typeof m.content === 'string' && m.content.includes('HumanStudy automatic recovery')))
    assert.ok(adjusted)
    assert.equal(adjusted.reasoning_effort, 'low', 'low effort must reach the actual compatible-provider request body')
    assert.ok(events.some(e => e.type === 'text' && e.text.includes('Recovered')))
    assert.equal(events.some(e => e.type === 'error'), false)
    console.log('Real installed OpenCode length → adjusted prompt/low effort → output passed (localhost fixture, no hosted quota)')
  } finally { await k.dispose(); await new Promise(r => model.close(r)) }
}
rmSync(out, { recursive: true, force: true })
