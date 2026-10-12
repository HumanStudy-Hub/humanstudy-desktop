// Kernel smoke test. Bundles the TS sources with the app's esbuild, then:
//   node src/main/kernel/kernel.test.mjs              -> mock kernel (always)
//   node src/main/kernel/kernel.test.mjs --opencode   -> also a live opencode round trip
//     (needs `opencode` on PATH; with OPENROUTER_API_KEY expect text + done, without it
//      expect an auth `error` followed by `done`)
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
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

process.env.HUMANSTUDY_KERNEL = 'mock'
assert.equal(k.createKernel().name, 'mock')
delete process.env.HUMANSTUDY_KERNEL
console.log(`createKernel() would pick: ${k.createKernel().name} (opencode at ${k.findOpencode() ?? 'none'})`)

// ---- optional live opencode -----------------------------------------------------------
if (process.argv.includes('--opencode')) {
  const kernel = new k.OpencodeKernel()
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
