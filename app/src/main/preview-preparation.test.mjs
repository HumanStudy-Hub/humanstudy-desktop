import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

test('preview preparation retries unavailable runtime and I/O failures on the next open', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-preview-test-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bundle = join(dir, 'preview.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('./preview-preparation.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', outfile: bundle })
  const { createPreviewPreparation } = await import(pathToFileURL(bundle))
  await writeFile(join(dir, 'protocol.json'), '{"id":"preview-fixture"}')
  let calls = 0
  let settled
  const preview = createPreviewPreparation({
    python: async () => {
      calls++
      if (calls === 2) throw Error('Transient fixture I/O error')
      return null
    },
    files: () => [],
    version: () => 1,
    busy: () => false,
    settled: (_dir, result) => settled(result),
  })

  for (const [i, error] of ['runtime_unavailable', 'io', 'runtime_unavailable', 'runtime_unavailable'].entries()) {
    const result = new Promise(resolve => { settled = resolve })
    if (i === 3) preview.runtimeReady()
    else assert.equal(await preview.prepare(dir), 'preparing')
    assert.deepEqual(await result, { written: false, error })
    assert.equal(await preview.prepare(dir, true), 'failed')
    assert.equal(calls, i + 1)
  }
})
