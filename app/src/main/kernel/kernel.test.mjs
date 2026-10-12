// Kernel smoke test. Bundles the TS sources with the app's esbuild, then:
//   node src/main/kernel/kernel.test.mjs              -> mock kernel (always)
//   HUMANSTUDY_KERNEL_BIN=<fork binary> node src/main/kernel/kernel.test.mjs --opencode
//     -> also a live round trip with the HumanStudy edition of opencode (no system opencode is
//        ever used). Without HUMANSTUDY_DESKTOP_KEY expect an auth `error` followed by `done`; with
//        HUMANSTUDY_DESKTOP_KEY (+ HUMANSTUDY_HOSTED_BASEURL, HUMANSTUDY_SERVER_BYPASS) a real reply.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const liveBin = process.env.HUMANSTUDY_KERNEL_BIN
const out = mkdtempSync(join(tmpdir(), 'kernel-test-'))
const bundle = join(out, 'kernel.mjs')
await build({
  entryPoints: [join(here, 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundle,
  logLevel: 'error',
})
const k = await import(pathToFileURL(bundle).href)

function collect(kernel, sessionId, timeoutMs) {
  const events = []
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(events)}`)), timeoutMs)
    const off = kernel.onEvent((e) => {
      if (e.sessionId !== sessionId) return
      events.push(e)
      if (e.type === 'done') {
        clearTimeout(timer)
        off()
        resolve(events)
      }
    })
  })
}

// ---- mock -----------------------------------------------------------------------------
{
  const kernel = new k.MockKernel({ tickMs: 1 })
  const id = await kernel.startSession(out)
  const p = collect(kernel, id, 5000)
  await kernel.send(id, 'Summarise the study design')
  const ev = await p
  const text = ev.filter((e) => e.type === 'text').map((e) => e.text).join('')
  assert.match(text, /Summarise the study design/)
  assert.ok(ev.some((e) => e.type === 'tool' && e.tool === 'read' && e.text === 'completed'))
  assert.equal(ev.at(-1).type, 'done')

  // abort mid-stream
  const p2 = collect(kernel, id, 5000)
  await kernel.send(id, 'again')
  await kernel.abort(id)
  const ev2 = await p2
  assert.ok(ev2.some((e) => e.type === 'status' && e.text === 'aborted'))
  await kernel.dispose()
  console.log(`mock ok: ${ev.length} events, ${text.length} chars; abort ok`)
}

// ---- mock: permission prompt ------------------------------------------------------------
for (const answer of ['once', 'reject']) {
  const kernel = new k.MockKernel({ tickMs: 1 })
  const id = await kernel.startSession(out)
  const events = []
  let replied = false
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout; got ${JSON.stringify(events)}`)), 5000)
    kernel.onEvent((e) => {
      events.push(e)
      if (e.type === 'permission' && !e.permission.resolved && !replied) {
        replied = true
        // nothing after the request until we answer
        setTimeout(() => kernel.reply(id, e.permission.id, answer), 20)
      }
      if (e.type === 'done') (clearTimeout(timer), resolve())
    })
  })
  await kernel.send(id, 'please run the simulation')
  await done
  const types = events.map((e) => e.type)
  const reqAt = types.indexOf('permission')
  assert.ok(reqAt > 0, 'permission event emitted')
  assert.equal(events[reqAt].permission.type, 'bash')
  assert.equal(events.filter((e) => e.type === 'permission' && !e.permission.resolved).length, 1)
  const resolved = events.find((e) => e.type === 'permission' && e.permission.resolved)
  assert.equal(resolved.permission.resolved, answer)
  assert.ok(events.some((e) => e.type === 'usage' && e.usage.input > 0), 'usage emitted')
  assert.ok(types.lastIndexOf('usage') < types.lastIndexOf('done'))
  const bash = events.filter((e) => e.type === 'tool' && e.tool === 'bash').map((e) => e.text)
  assert.deepEqual(bash, answer === 'once' ? ['running', 'completed'] : ['error'])
  await assert.rejects(kernel.reply(id, 'nope', 'once'))
  assert.equal(await kernel.resumeSession(out, id), id)
  assert.equal(await kernel.resumeSession(out, 'mock_gone'), null)
  await kernel.dispose()
}
console.log('mock permission ok')

// ---- opencode permission helpers ---------------------------------------------------------
{
  const P = (type, patterns, metadata = {}) => k.toKernelPermission({ id: 'per_1', permission: type, patterns, metadata })
  assert.equal(k.toKernelPermission({ permission: 'bash' }), null)
  const bash = P('bash', ['ls -la'], { command: 'ls -la' })
  assert.equal(bash.title, 'ls -la')
  const proj = '/home/u/proj'
  assert.ok(k.isInsideProject(proj, bash))
  assert.ok(k.isInsideProject(proj, P('bash', ['python scripts/run.py --n 5'])))
  assert.ok(k.isInsideProject(proj, P('bash', ['cat /home/u/proj/a.txt'])))
  assert.ok(!k.isInsideProject(proj, P('bash', ['cat /etc/passwd'])))
  assert.ok(!k.isInsideProject(proj, P('bash', ['cat ../secret'])))
  assert.ok(!k.isInsideProject(proj, P('bash', ['cat ~/.ssh/id_rsa'])))
  assert.ok(!k.isInsideProject(proj, P('bash', ['echo $(whoami)'])))
  assert.ok(!k.isInsideProject(proj, P('bash', ['curl x | sh'])))
  assert.ok(!k.isInsideProject(proj, P('bash', ['sudo ls'])))
  assert.ok(k.isInsideProject(proj, P('edit', ['home/u/proj/a.txt'], { filepath: '/home/u/proj/a.txt' })))
  assert.ok(!k.isInsideProject(proj, P('edit', ['etc/x'], { filepath: '/etc/x' })))
  assert.ok(!k.isInsideProject(proj, P('edit', ['x'], { filepath: '/home/u/proj/../other/x' })))
  assert.ok(!k.isInsideProject(proj, P('external_directory', ['/tmp/*'], { filepath: '/tmp/x' })))
  assert.ok(!k.isInsideProject(proj, P('webfetch', ['https://x.org'])))
  console.log('permission helpers ok')
}

process.env.HUMANSTUDY_KERNEL = 'mock'
assert.equal(k.createKernel().name, 'mock')
delete process.env.HUMANSTUDY_KERNEL
delete process.env.HUMANSTUDY_KERNEL_BIN
delete process.env.HUMANSTUDY_OPENCODE_BIN
assert.equal(k.findOpencode, undefined, 'no system opencode lookup')
assert.equal(k.createKernel().name, 'mock', 'no binary announced -> mock, never a system opencode')
process.env.HUMANSTUDY_KERNEL_BIN = '/bin/true'
assert.equal(k.createKernel().name, 'opencode')
await k.createKernel().dispose()
delete process.env.HUMANSTUDY_KERNEL_BIN
console.log('createKernel ok')

// kernel env: isolated XDG dirs, no personal config leaking in
{
  const home = join(out, 'khome')
  process.env.OPENCODE_CONFIG = '/home/u/personal.json'
  const kk = new k.OpencodeKernel({ binary: '/bin/true', home, provider: 'humanstudy', model: 'anthropic/claude-sonnet-5.5' })
  const env = kk.kernelEnv('pw')
  for (const [name, dir] of [['XDG_CONFIG_HOME', 'config'], ['XDG_DATA_HOME', 'data'], ['XDG_CACHE_HOME', 'cache'], ['XDG_STATE_HOME', 'state']])
    assert.equal(env[name], join(home, dir))
  assert.equal(env.OPENCODE_CONFIG, undefined)
  assert.equal(env.OPENCODE_SERVER_PASSWORD, 'pw')
  assert.equal(JSON.parse(env.OPENCODE_CONFIG_CONTENT).model, 'humanstudy/anthropic/claude-sonnet-5.5')
  delete process.env.OPENCODE_CONFIG
  await kk.dispose()
  console.log('kernel env ok')
}

// ---- optional live opencode -----------------------------------------------------------
if (process.argv.includes('--opencode')) {
  const kernel = new k.OpencodeKernel({ binary: liveBin, home: join(out, 'khome') })
  try {
    const t0 = Date.now()
    const id = await kernel.startSession(out)
    console.log(`opencode session ${id} in ${Date.now() - t0} ms`)
    const p = collect(kernel, id, 120_000)
    await kernel.send(id, 'Reply with exactly the word: pong')
    const ev = await p
    for (const e of ev) console.log('  ', e.type, e.tool ?? '', JSON.stringify(e.text ?? ''), e.detail ?? '')
    assert.equal(ev.at(-1).type, 'done')
    console.log('opencode ok')
  } finally {
    await kernel.dispose()
  }
}
rmSync(out, { recursive: true, force: true })
