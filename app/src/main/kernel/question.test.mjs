// Native question contract, history, and optional real installed OpenCode tool round trip.
// HUMANSTUDY_KERNEL_BIN=<HumanStudy edition binary> node .../question.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'native-question-'))
await build({ stdin: { contents: `export { MockKernel, OpencodeKernel } from './index'; export { appendEvent, transcript, ThreadManager } from '../threads-core'; export { validateAnswers } from '../../shared/question';`, resolveDir: here }, bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'q.mjs'), logLevel: 'error' })
const Q = await import(pathToFileURL(join(out, 'q.mjs')).href)
const questions = [
  { header: 'Participants', question: 'Which population?', options: [{ label: 'Default to study', description: 'Use the paper.' }, { label: 'Customize', description: 'Specify another population.' }] },
  { header: 'Conditions', question: 'Which conditions?', multiple: true, custom: false, options: [{ label: 'Control', description: 'Baseline.' }, { label: 'Treatment', description: 'Experimental.' }] },
]
const answers = [['Canadian adults, age 18–65'], ['Control', 'Treatment']]
Q.validateAnswers({ id: 'q', questions }, answers)
assert.throws(() => Q.validateAnswers({ id: 'empty', questions: [] }, []))
assert.equal(Q.appendEvent([], { sessionId: 's', type: 'question', question: { id: 'empty', questions: [] } })[0].parts[0].id, 'empty', 'an empty native request is visible and dismissible')
assert.throws(() => Q.validateAnswers({ id: 'q', questions }, [[], []]))
assert.throws(() => Q.validateAnswers({ id: 'q', questions }, [['Default to study', 'Customize'], ['Control']]))
assert.throws(() => Q.validateAnswers({ id: 'q', questions }, [['Customize'], ['Unknown condition']]))

let history = Q.appendEvent([], { sessionId: 's', type: 'question', question: { id: 'q', questions } })
history = [...history, ...Array.from({ length: 6 }, (_, i) => ({ id: `u${i}`, role: 'user', at: '', parts: [{ kind: 'text', text: 'Later message' }] }))]
history = Q.appendEvent(history, { sessionId: 's', type: 'question', question: { id: 'q', questions: [], answers, resolved: 'answered' } })
history = Q.appendEvent(history, { sessionId: 's', type: 'question', question: { id: 'q', questions } })
assert.equal(history.length, 7, 'late and duplicate events update the original card')
assert.deepEqual(history[0].parts[0].answers, answers)
assert.equal(history[0].parts[0].resolved, 'answered', 'stale asked event cannot reopen a resolved question')
assert.ok(Q.transcript(history).includes('Canadian adults'))

for (const action of ['answer', 'reject', 'abort']) {
  const kernel = new Q.MockKernel({ tickMs: 1 })
  const id = await kernel.startSession(out)
  const captures = []
  const manager = new Q.ThreadManager({ kernelName: () => 'mock', start: async () => id, resume: async () => id }, () => {}, { onCapture: c => captures.push(c) })
  const thread = await manager.create(join(out, action))
  manager.beforeSend(id, 'ask question')
  const events = []
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Question did not resume')), 5000)
    kernel.onEvent(e => {
      events.push(e); manager.onEvent(e)
      if (e.type === 'done') { clearTimeout(timer); resolve() }
    })
  })
  await kernel.send(id, 'ask question')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(events.at(-1).type, 'question', 'turn remains paused until a deliberate answer')
  const [pending] = await kernel.questions(id)
  assert.equal(pending.questions.length, 2)
  await assert.rejects(kernel.answerQuestion('another-session', pending.id, answers))
  await assert.rejects(kernel.answerQuestion(id, pending.id, [[], []]))
  if (action === 'answer') await kernel.answerQuestion(id, pending.id, answers)
  else if (action === 'reject') await kernel.rejectQuestion(id, pending.id)
  else await kernel.abort(id)
  await done
  assert.deepEqual(await kernel.questions(id), [])
  await assert.rejects(kernel.answerQuestion(id, pending.id, answers))
  await manager.flush()
  const stored = await manager.get(join(out, action), thread.id)
  const card = stored.messages.flatMap(m => m.parts).find(p => p.kind === 'question')
  assert.ok(card.questions[0].question)
  assert.equal(card.resolved, action === 'answer' ? 'answered' : action === 'reject' ? 'rejected' : undefined)
  if (action === 'answer') assert.deepEqual(card.answers, answers)
  assert.equal(captures.filter(c => c.kind === 'part' && c.part.kind === 'question').length, action === 'abort' ? 1 : 2, 'pending and resolved research records captured exactly once')
  await kernel.dispose()
}
console.log('Question validation, pause/resume/reject/abort, durable history and research capture passed')

// Drive the actual native question tool with a deterministic local model response.
// This verifies the real OpenCode server/SSE/HTTP loop, not the quality of a hosted model.
if (process.env.HUMANSTUDY_KERNEL_BIN) {
  const seenResults = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const result = body.messages?.findLast(m => m.role === 'tool')
    if (result) seenResults.push(result.content)
    const call = body.tools?.some(t => t.function?.name === 'question') && !result
    const delta = call ? { tool_calls: [{ index: 0, id: 'call_native_question', type: 'function', function: { name: 'question', arguments: JSON.stringify({ questions }) } }] } : { content: result ? 'Continued after researcher decision.' : 'Study settings' }
    const response = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify(response)}\n\n`)
    res.write(`data: ${JSON.stringify({ ...response, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  try {
    for (const action of ['answer', 'reject', 'abort']) {
      const kernel = new Q.OpencodeKernel({ binary: process.env.HUMANSTUDY_KERNEL_BIN, home: join(out, `live-${action}`), provider: 'fixture', model: 'fixture' })
      kernel.configContent = () => JSON.stringify({ model: 'fixture/fixture', small_model: 'fixture/fixture', permission: { question: 'allow' }, provider: { fixture: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only' }, models: { fixture: { name: 'Fixture', tool_call: true, limit: { context: 200000, output: 10000 } } } } } })
      try {
        const sid = await kernel.startSession(join(out, action))
        const ev = []
        let answered = false
        let actionPromise
        const done = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Native question timed out: ${JSON.stringify(ev)}`)), 45000)
          kernel.onEvent(e => {
            if (e.sessionId !== sid) return
            ev.push(e)
            if (e.type === 'question' && !e.question.resolved && !answered) {
              answered = true
              actionPromise = (async () => {
                const pending = await kernel.questions(sid)
                assert.equal(pending[0].id, e.question.id)
                // Re-register mimics the app reopening this live session. Listing restores inFlight.
                kernel.register(sid, kernel.session(sid).server)
                await kernel.questions(sid)
                if (action === 'answer') await kernel.answerQuestion(sid, e.question.id, answers)
                else if (action === 'reject') await kernel.rejectQuestion(sid, e.question.id)
                else await kernel.abort(sid)
              })().catch(error => { clearTimeout(timer); reject(error) })
            }
            if (e.type === 'done') { clearTimeout(timer); resolve() }
          })
        })
        await kernel.send(sid, 'Ask me for participant and condition settings using the question tool.')
        await done
        await actionPromise
        assert.ok(answered, 'real native question.asked event received')
        if (action !== 'abort') assert.ok(ev.some(e => e.type === 'question' && e.question.resolved === (action === 'answer' ? 'answered' : 'rejected')))
        if (action === 'answer') assert.ok(ev.some(e => e.type === 'text' && e.text.includes('Continued')), 'agent continues the same turn after answering')
        else assert.ok(ev.some(e => e.type === 'done'), 'dismissal or abort ends the turn without getting stuck')
        assert.deepEqual(await kernel.questions(sid), [])
        console.log(`Real OpenCode native question ${action} round trip passed`)
      } finally { await kernel.dispose() }
    }
    assert.ok(seenResults.some(s => JSON.stringify(s).includes('Canadian adults')), 'actual question answers reached the model tool result')
  } finally { await new Promise(r => server.close(r)) }
}
rmSync(out, { recursive: true, force: true })
