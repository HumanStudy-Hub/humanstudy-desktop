import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const out = mkdtempSync(join(tmpdir(), 'opencode-exit-'))
await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'opencode.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'k.mjs'), logLevel: 'error' })
const { OpencodeKernel, exitMessage, exitLogTail } = await import(pathToFileURL(join(out, 'k.mjs')).href)

// Plain-language messages name the cause and say nothing was lost.
assert.match(exitMessage(null, 'SIGKILL', true), /stopped by the system \(SIGKILL\).*online workspace.*time limit or runs out of memory.*saved/)
assert.doesNotMatch(exitMessage(null, 'SIGKILL', false), /online workspace/)
assert.match(exitMessage(1, null), /stopped unexpectedly \(exit code 1\)/)
assert.match(exitMessage(0, null), /closed\. Your project and chat are saved/)
assert.doesNotMatch(exitMessage(null, 'SIGTERM'), /opencode/)

// A conversation dropped by an exit is reopened on its next message, keeping the model selection.
{
  const k = new OpencodeKernel({ binary: '/bin/true', provider: 'humanstudy' })
  const sent = []
  k.lost.set('s', { dir: out, selection: { model: { providerID: 'p', modelID: 'm' } } })
  k.resumeSession = async (dir, id) => { assert.equal(dir, out); k.register(id, { dir, exited: false }); return id }
  k.request = async (_server, method, path, body) => { sent.push({ method, path, body }); return new Response('true') }
  await k.send('s', 'hello again')
  assert.equal(k.lost.has('s'), false)
  assert.deepEqual(k.sessions.get('s').selection, { model: { providerID: 'p', modelID: 'm' } })
  assert.ok(sent.some(r => r.method === 'POST' && /prompt/.test(r.path)), 'the message was sent after reopening')
  await k.dispose()
}

// If the conversation cannot be reopened, the error says what to do.
{
  const k = new OpencodeKernel({ binary: '/bin/true', provider: 'humanstudy' })
  k.lost.set('gone', { dir: out })
  k.resumeSession = async () => null
  await assert.rejects(k.send('gone', 'hi'), /could not be reopened.*Start a new conversation/)
  await k.dispose()
}

// Processes the app stops on purpose are marked, so their exit is not shown as an error.
{
  const k = new OpencodeKernel({ binary: '/bin/true', provider: 'humanstudy' })
  const srv = { exited: true, proc: { kill() {} }, sse: new AbortController() }
  k.live.add(srv)
  k.killAll('SIGTERM')
  assert.equal(srv.intentional, true)
  k.live.clear()
  await k.dispose()
}
// Logged output never carries keys, bearer tokens or long user text.
{
  const tail = exitLogTail('Authorization: Bearer sk-or-v1-LEAKME0123456789\n{"apiKey":"tok_secret_value"}\npassword=hunter2hunter\n' + 'x'.repeat(500))
  assert.doesNotMatch(tail, /LEAKME|tok_secret_value|hunter2hunter/)
  assert.doesNotMatch(exitLogTail('PROMPT {"parts":[{"type":"text","text":"my private wording"}]}'), /private wording/)
  assert.ok(tail.length < 1100)
}
// A send and a thread resume reopening the same lost session share one reopen: registered once.
{
  const k = new OpencodeKernel({ binary: '/bin/true', provider: 'humanstudy' })
  let registers = 0, calls = 0
  const orig = k.register.bind(k)
  k.register = (id, server) => { registers++; return orig(id, server) }
  k.reopen = async (dir, id) => { calls++; await new Promise(r => setTimeout(r, 20)); k.register(id, { dir, exited: false }); return id }
  const [a, b] = await Promise.all([k.resumeSession(out, 's'), k.resumeSession(out, 's')])
  assert.equal(a, 's'); assert.equal(b, 's'); assert.equal(calls, 1); assert.equal(registers, 1)
  await k.dispose()
}
// Stop after the assistant already stopped is a no-op, not an "unknown session" error.
{
  const k = new OpencodeKernel({ binary: '/bin/true', provider: 'humanstudy' })
  k.lost.set('z', { dir: out })
  await k.abort('z')
  await k.dispose()
}
console.log('opencode exit tests passed')
