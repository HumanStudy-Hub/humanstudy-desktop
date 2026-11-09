// node --test src/main/run-registry.test.mjs — removals by owner (review 5, M2): a stopped run whose process exits
// late never closes or frees the next run's relay or project.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'run-registry-'))
await build({ entryPoints: [join(here, 'run-registry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'r.mjs'), logLevel: 'error' })
const { RunRegistry } = await import(pathToFileURL(join(out, 'r.mjs')).href)

test('two relays on one session: the old run ending forgets and frees only its own', async () => {
  const runs = new RunRegistry()
  const closed = []
  const relay = (name) => ({ project: '/p', close: async () => { closed.push(name) } })
  // Run A starts, the researcher presses Stop (the relay closes), then Run again: run B on the same session.
  const ownerA = runs.claim('/p'); const a = relay('A'); runs.register('s', a)
  await runs.closeCurrent('s'); runs.release('/p', ownerA)
  const ownerB = runs.claim('/p'); assert.ok(ownerB, 'the project is free for B'); const b = relay('B'); runs.register('s', b)
  // A's process exits late: its onExit / onClose forget A and release A's claim, which must not touch B.
  runs.forget('s', a.close); runs.release('/p', ownerA)
  assert.equal(runs.relays.get('s'), b, 'B is still the session\'s relay')
  assert.equal(runs.busy('/p'), true, 'B still holds the project')
  assert.equal(runs.claim('/p'), null, 'so a third start is refused')
  assert.deepEqual(closed, ['A'], 'only A was closed')
  runs.forget('s', b.close); runs.release('/p', ownerB)
  assert.equal(runs.relays.has('s'), false); assert.equal(runs.busy('/p'), false)
})

test('the main process uses owner-checked removal for relays and projects, and no descriptor for protocol runs', async () => {
  const { readFileSync } = await import('node:fs')
  const index = readFileSync(join(here, 'index.ts'), 'utf8')
  const send = index.slice(index.indexOf("ipcMain.handle('kernel:send'"))
  assert.match(send, /publish: route !== 'protocol'/)
  assert.match(send, /onClose: \(\) => \{ if \(ownClose\) runs\.forget\(id, ownClose\); runs\.release\(projectDir!, owner\) \}/)
  assert.match(send, /startProtocolRun\(projectDir, approved, binding as ProtocolBinding, relay, \(\) => \{ runs\.forget\(id, relay\.close\); void relay\.close\(\) \}\)/)
  assert.match(send, /const owner = runs\.claim\(projectDir\)\n\s+if \(!owner\) throw Error\('A simulation is already active in this project\.'\)/, 'pre-relay path: one run per project')
  assert.ok(!/relayProjects/.test(index))
})
