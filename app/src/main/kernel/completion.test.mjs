// Reproduce a completed native request with reasoning usage but no visible answer.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const out = mkdtempSync(join(tmpdir(), 'completion-limit-'))
try {
  await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'k.mjs'), logLevel: 'error' })
  const { OpencodeKernel } = await import(pathToFileURL(join(out, 'k.mjs')).href)
  const k = new OpencodeKernel({ binary: '/bin/true' })
  try {
    k.register('s', { dir: out, exited: false })
    const events = []
    k.onEvent(e => events.push(e))
    const complete = (id, finish, output) => k.handle({ type: 'message.updated', properties: { info: { sessionID: 's', id, role: 'assistant', time: { completed: 1 }, finish, tokens: { input: 45114, output, reasoning: 32000 } } } })
    complete('empty', 'length', 0)
    complete('empty', 'length', 0)
    assert.equal(events.filter(e => e.type === 'error').length, 1, 'duplicate completion must not duplicate the warning')
    assert.match(events.find(e => e.type === 'error').text, /not retried/)
    assert.equal(events.find(e => e.type === 'usage').usage.reasoning, 32000)
    assert.equal(events.find(e => e.type === 'usage').usage.output, 0)
    k.handle({ type: 'message.updated', properties: { info: { sessionID: 's', id: 'partial', role: 'assistant', time: { created: 1 } } } })
    k.handle({ type: 'message.part.updated', properties: { part: { sessionID: 's', messageID: 'partial', id: 'p', type: 'text', text: 'Full received text is preserved.' } } })
    complete('partial', 'length', 12)
    assert.match(events.filter(e => e.type === 'error').at(-1).text, /output and saved files have been kept/)
    assert.equal(events.find(e => e.type === 'text').text, 'Full received text is preserved.')
    // T10: research records carry OpenCode's own message/part/call ids.
    assert.equal(events.find(e => e.type === 'text').messageId, 'partial')
    assert.equal(events.find(e => e.type === 'text').partId, 'p')
    k.handle({ type: 'message.part.updated', properties: { part: { sessionID: 's', messageID: 'partial', id: 'prt_tool', callID: 'call_1', type: 'tool', tool: 'write', state: { status: 'running', input: { filePath: 'a' } } } } })
    const tool = events.find(e => e.type === 'tool')
    assert.deepEqual([tool.toolCallId, tool.messageId, tool.partId], ['call_1', 'partial', 'prt_tool'])
    complete('ok', 'stop', 12)
    complete('tool', 'tool-calls', 0)
    assert.equal(events.filter(e => e.type === 'error').length, 2, 'normal and tool completions are not errors')
    k.sessions.get('s').inFlight = true
    k.handle({ type: 'session.idle', properties: { sessionID: 's' } })
    k.handle({ type: 'session.idle', properties: { sessionID: 's' } })
    assert.equal(events.filter(e => e.type === 'done').length, 1)
    assert.equal(events.at(-1).type, 'done', 'turn still finishes after warning and preserves usage')
  } finally { await k.dispose() }
} finally { rmSync(out, { recursive: true, force: true }) }
console.log('Empty/partial response limits, usage, duplicate completion and normal finish passed')
