import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
  const finish = (reason = 'length', output = 0, visible = false) => {
    const mid = `${name}-${++id}`
    const info = { sessionID: 's', id: mid, role: 'assistant' }
    k.handle({ type: 'message.updated', properties: { info } })
    if (visible) k.handle({ type: 'message.part.updated', properties: { part: { sessionID: 's', messageID: mid, id: 'part-' + mid, type: 'text', text: 'A saved checkpoint.' } } })
    k.handle({ type: 'message.updated', properties: { info: { ...info, finish: reason, time: { completed: 1 }, tokens: { input: 20, output, reasoning: 32000 } } } })
  }
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
  finish('length', 12, true); idle(); await tick()
  assert.equal(requests.length, 3)
  assert.match(requests[2].body.parts[0].text, /Further reduce the size/)
  finish('length', 12, true); idle(); await tick()
  assert.equal(requests.length, 3, 'at most two adjustments even with progress')
  assert.equal(events.filter(e => e.type === 'error').length, 1)
})
await scenario('tokens-without-visible-progress', async ({ k, requests, finish, idle, events }) => {
  await k.send('s', 'Write')
  finish(); idle(); await tick()
  finish('length', 32000); idle(); await tick()
  assert.equal(requests.length, 2, 'token counts alone must not authorize another recovery attempt')
  assert.match(events.find(e => e.type === 'error').text, /no visible output/)
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
const invalid = (k, mid, id = 'broken') => k.handle({ type: 'message.part.updated', properties: { part: {
  sessionID: 's', messageID: mid, id, type: 'tool', tool: 'invalid',
  state: { status: 'completed', input: { tool: 'write', error: 'JSON parsing failed: Unterminated string' }, output: 'Invalid Tool' },
} } })
const assistant = (k, id) => k.handle({ type: 'message.updated', properties: { info: { sessionID: 's', id, role: 'assistant' } } })
await scenario('invalid-tool', async ({ k, events, requests, finish, idle }) => {
  await k.send('s', 'Build from the paper')
  assistant(k, 'bad'); invalid(k, 'bad')
  idle(); idle(); await tick()
  assert.equal(requests.length, 2, 'one adjusted request for a malformed tool call')
  assert.match(requests[1].body.parts[0].text, /malformed arguments/)
  assert.match(requests[1].body.parts[0].text, /Do not assume an interrupted tool call wrote a file/)
  assert.match(requests[1].body.parts[0].text, /program_io.py/)
  assert.equal(events.find(e => e.type === 'status' && e.text === 'recovering').input.reason, 'invalid_tool_call')
  finish('stop', 20); idle()
  assert.equal(events.filter(e => e.type === 'done').length, 1)
})
await scenario('invalid-not-progress', async ({ k, requests, finish, idle, events }) => {
  await k.send('s', 'Build')
  finish(); idle(); await tick()
  assistant(k, 'bad-again'); invalid(k, 'bad-again'); idle(); await tick()
  assert.equal(requests.length, 2, 'synthetic invalid tool is not a successful action')
  assert.match(events.find(e => e.type === 'error').text, /no visible output or successful tool action/)
})
await scenario('native-promises-only', async ({ k, requests, finish, idle }) => {
  await k.send('s', 'Build')
  assistant(k, 'bad'); invalid(k, 'bad')
  finish('stop', 20, true); idle(); await tick()
  assert.equal(requests.length, 2, 'a native promise without repairing the tool does not hide the failure')
})
await scenario('native-repairs-invalid', async ({ k, requests, finish, idle }) => {
  await k.send('s', 'Build')
  assistant(k, 'bad'); invalid(k, 'bad')
  assistant(k, 'repair')
  k.handle({ type: 'message.part.updated', properties: { part: { sessionID: 's', messageID: 'repair', id: 'valid-write', type: 'tool', tool: 'write', state: { status: 'completed', output: 'Wrote file successfully' } } } })
  finish('stop', 20); idle(); await tick()
  assert.equal(requests.length, 1, 'a successful native repair must not be repeated')
})
await scenario('native-starts-before-dispatch', async ({ k, requests, finish, idle }) => {
  await k.send('s', 'Build'); finish(); idle()
  assistant(k, 'native-caught-up'); await tick()
  assert.equal(requests.length, 1, 'native continuation between idle and dispatch supersedes the queued request')
})
await scenario('late-finish-metadata', async ({ k, requests, idle }) => {
  await k.send('s', 'Build')
  const info = { sessionID: 's', id: 'late', role: 'assistant', time: { completed: 1 }, tokens: { output: 32000 } }
  k.handle({ type: 'message.updated', properties: { info } })
  k.handle({ type: 'message.updated', properties: { info: { ...info, finish: 'length' } } })
  idle(); await tick()
  assert.equal(requests.length, 2, 'usage metadata cannot swallow a later output-limit signal')
})
for (const wait of ['question', 'permission']) await scenario('waiting-' + wait, async ({ k, requests, finish, idle }) => {
  await k.send('s', 'Build')
  finish()
  k.handle({ type: wait + '.asked', properties: { sessionID: 's', id: 'needs-user', permission: 'external_directory', patterns: ['/outside-project'], questions: [{ question: 'Which condition?', header: 'Condition', options: [{ label: 'A', description: 'A' }] }] } })
  idle(); await tick()
  assert.equal(requests.length, 1, 'never dispatch through an unanswered ' + wait)
  k.handle({ type: wait === 'question' ? 'question.rejected' : 'permission.replied', properties: { sessionID: 's', requestID: 'needs-user', reply: 'reject' } })
  idle(); await tick()
  assert.equal(requests.length, 1, 'a rejection is not permission to retry')
})
await scenario('invalid-after-stop', async ({ k, requests, idle }) => {
  await k.send('s', 'Build'); assistant(k, 'bad')
  await k.abort('s'); invalid(k, 'bad'); idle(); await tick()
  assert.equal(requests.filter(r => r.path.endsWith('prompt_async')).length, 1)
})
console.log('Output limits, malformed tools, late finish, native repairs, researcher waits and stop guards passed')

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
if (process.env.HUMANSTUDY_KERNEL_BIN) {
  let count = 0
  // Bun canonicalizes macOS /var aliases differently; a real workspace path keeps
  // the write inside the native project's permission boundary.
  const project = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.native-recovery-'))
  const checkpoint = join(project, 'repaired-checkpoint.txt')
  const model = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const main = Boolean(body.tools?.length), n = main ? ++count : 0
    const delta = n === 1 ? { tool_calls: [{ index: 0, id: 'broken_write', type: 'function', function: { name: 'write', arguments: '{"filePath":"unfinished' } }] }
      : n === 3 ? { tool_calls: [{ index: 0, id: 'fixed_write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ filePath: checkpoint, content: '完整原文 retained\nFINAL EVIDENCE' }) } }] }
      : { content: n === 2 ? "I'll write a smaller valid call next." : 'Saved and checked the checkpoint.' }
    const chunk = { id: 'fixture-' + n, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    res.end(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: n === 1 || n === 3 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(r => model.listen(0, '127.0.0.1', r))
  const k = new OpencodeKernel({ binary: process.env.HUMANSTUDY_KERNEL_BIN, home: join(out, 'malformed-home'), provider: 'humanstudy', model: 'anthropic/claude-haiku-5.5' })
  const cfg = JSON.parse(k.configContent())
  k.configContent = () => JSON.stringify({ ...cfg, provider: { humanstudy: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'fixture-only' }, models: { 'anthropic/claude-haiku-5.5': { name: 'Fixture', tool_call: true, limit: { context: 200000, output: 32000 }, variants: { 'humanstudy-recovery': { reasoningEffort: 'low' } } } } } } })
  try {
    const sid = await k.startSession(project), events = []
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Malformed-call recovery timed out: ' + JSON.stringify(events))), 45000)
      k.onEvent(e => { if (e.sessionId === sid) { events.push(e); if (e.type === 'done') { clearTimeout(timer); resolve() } } })
    })
    await k.send(sid, 'Save the complete checkpoint inside this project. Do not run simulations.')
    await done
    assert.equal(count, 4, 'native invalid → promise-only stop → adjusted valid write → final answer')
    assert.equal(readFileSync(checkpoint, 'utf8'), '完整原文 retained\nFINAL EVIDENCE')
    assert.equal(events.filter(e => e.type === 'status' && e.text === 'recovering' && e.input?.reason === 'invalid_tool_call').length, 1)
    assert.equal(events.some(e => e.type === 'error'), false)
    console.log('Real installed OpenCode malformed JSON → native stop → automatic repair → actual file saved passed')
  } finally { await k.dispose(); await new Promise(r => model.close(r)); rmSync(project, { recursive: true, force: true }) }
}
rmSync(out, { recursive: true, force: true })
