// A repeated identical tool call (opencode doom_loop) stops the turn: a plain reject (no message, so opencode ends its
// loop instead of continuing with feedback) and no automatic recovery, even inside a cascade window.
//   node src/main/kernel/doom.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const out = mkdtempSync(join(tmpdir(), 'doom-loop-'))
process.on('exit', () => rmSync(out, { recursive: true, force: true }))
const here = dirname(fileURLToPath(import.meta.url))
await build({ entryPoints: [join(here, 'index.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'k.mjs'), logLevel: 'error' })
const { OpencodeKernel } = await import(pathToFileURL(join(out, 'k.mjs')).href)
const replies = []
const api = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c)
  replies.push(JSON.parse(Buffer.concat(chunks).toString()))
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('true')
})
await new Promise(r => api.listen(0, '127.0.0.1', r))
try {
  const k = new OpencodeKernel({ binary: '/bin/true', permission: 'project' })
  k.register('s', { dir: out, base: `http://127.0.0.1:${api.address().port}`, auth: 'Basic fixture', exited: false })
  const s = k.sessions.get('s')
  s.inFlight = true
  s.recovery.cancelled = false
  const events = []; k.onEvent(e => events.push(e))
  const decided = (id) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`automatic reject of ${id} timed out`)) }, 5000)
    const off = k.onEvent(e => { if (e.permission?.id === id && e.permission?.automatic && e.permission?.resolved === 'reject') { clearTimeout(timer); off(); resolve() } })
  })
  // An ordinary disallowed call first: rejected with a reason, the turn continues (cascade window open).
  let done = decided('outside')
  k.handle({ type: 'permission.asked', properties: { sessionID: 's', id: 'outside', permission: 'bash', patterns: ['sudo ls'] } })
  await done
  assert.ok(replies.at(-1).message, 'an ordinary automatic reject tells the agent why')
  assert.equal(s.recovery.cancelled, false)

  done = decided('loop')
  k.handle({ type: 'permission.asked', properties: { sessionID: 's', id: 'loop', permission: 'doom_loop', patterns: ['bash'] } })
  await done
  assert.deepEqual(replies.at(-1), { reply: 'reject' }, 'doom_loop: a plain reject, which ends the agent loop')
  assert.equal(s.recovery.cancelled, true, 'no automatic recovery after doom_loop')
  assert.equal(s.recovery.pending, false)
  k.handle({ type: 'permission.replied', properties: { sessionID: 's', requestID: 'loop', reply: 'reject' } })
  // opencode cascades the reject to other pending requests: still no resume.
  s.pendingPermissions.set('cascaded', { id: 'cascaded', type: 'bash', patterns: ['ls'] })
  k.handle({ type: 'permission.replied', properties: { sessionID: 's', requestID: 'cascaded', reply: 'reject' } })
  assert.equal(s.recovery.pending, false, 'a cascade after doom_loop does not schedule a recovery')
  assert.ok(events.some(e => e.permission?.id === 'loop' && e.permission.type === 'doom_loop' && e.permission.automatic && e.permission.resolved === 'reject'),
    'the renderer gets the resolved doom_loop permission and shows the stopped note')
  await k.dispose()
  console.log('doom_loop stops the turn without recovery')
} finally { await new Promise(r => api.close(r)) }
