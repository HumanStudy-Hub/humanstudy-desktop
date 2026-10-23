// One decision is one event: OpenCode's own `*.replied` event after the app's reply (or an Auto
// approval) must not be reported as a second, differently attributed decision.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const out = mkdtempSync(join(tmpdir(), 'resolved-dedup-'))
const here = dirname(fileURLToPath(import.meta.url))
await build({ entryPoints: [join(here, 'index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'k.mjs'), logLevel: 'error' })
const { OpencodeKernel } = await import(pathToFileURL(join(out, 'k.mjs')).href)
const api = createServer(async (req, res) => {
  for await (const _ of req);
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(req.method === 'GET' && req.url.startsWith('/question') ? JSON.stringify([{ id: 'q1', sessionID: 's', questions: [{ question: 'Which?', header: 'Which', options: [{ label: 'A', description: '' }] }] }]) : 'true')
})
await new Promise(r => api.listen(0, '127.0.0.1', r))
try {
  const k = new OpencodeKernel({ binary: '/bin/true', permission: 'project' })
  k.register('s', { dir: out, base: `http://127.0.0.1:${api.address().port}`, auth: 'Basic fixture', exited: false })
  const events = []; k.onEvent(e => events.push(e))
  const resolved = id => events.filter(e => e.type === 'permission' && e.permission.id === id && e.permission.resolved)
  // Auto approval inside the project, then OpenCode's own replied event (observed order).
  k.handle({ type: 'permission.asked', properties: { sessionID: 's', id: 'p1', permission: 'bash', patterns: ['echo x > note.txt'] } })
  for (let i = 0; i < 100 && !resolved('p1').length; i++) await new Promise(r => setTimeout(r, 10))
  k.handle({ type: 'permission.replied', properties: { sessionID: 's', requestID: 'p1', reply: 'once' } })
  assert.equal(resolved('p1').length, 1); assert.equal(resolved('p1')[0].permission.automatic, true)
  // A researcher's question answer, then the native replied event.
  k.handle({ type: 'question.asked', properties: { sessionID: 's', id: 'q1', questions: [] } })
  await k.answerQuestion('s', 'q1', [['A']])
  k.handle({ type: 'question.replied', properties: { sessionID: 's', requestID: 'q1', answers: [['A']] } })
  assert.equal(events.filter(e => e.type === 'question' && e.question.id === 'q1' && e.question.resolved).length, 1)
  // Without an app reply the native event is still reported once.
  k.handle({ type: 'permission.replied', properties: { sessionID: 's', requestID: 'p2', reply: 'reject' } })
  k.handle({ type: 'permission.replied', properties: { sessionID: 's', requestID: 'p2', reply: 'reject' } })
  assert.equal(resolved('p2').length, 1)
  await k.dispose()
  console.log('Each permission/question resolution is reported once, keeping the automatic flag')
} finally { await new Promise(r => api.close(r)); rmSync(out, { recursive: true, force: true }) }
