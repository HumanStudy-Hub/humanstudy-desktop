import assert from 'node:assert/strict'
import fs, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { syncBuiltinESMExports } from 'node:module'
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

test('inspection reuses the result until a preview or protocol stamp changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-preview-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const bundle = join(dir, 'preview.mjs')
  await build({ entryPoints: [fileURLToPath(new URL('./preview-preparation.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', outfile: bundle })
  const { createPreviewPreparation } = await import(pathToFileURL(bundle))
  const protocol = join(dir, 'protocol.json')
  const preview = join(dir, 'artifacts', 'preview.html')
  const raw = '{"id":"cache-fixture"}'
  const hash = createHash('sha256').update(raw).digest('hex')
  const html = `<head><meta name="hs-preview-template-version" content="1"></head><script id="hs-protocol">{"sha256":"${hash}"}</script>`
  await mkdir(join(dir, 'artifacts'))
  await writeFile(protocol, raw)
  await writeFile(preview, html)
  const reads = []
  const original = fs.readFile
  t.after(() => { fs.readFile = original; syncBuiltinESMExports() })
  fs.readFile = (path, ...args) => {
    if (path === protocol || path === preview) reads.push(path)
    return original(path, ...args)
  }
  syncBuiltinESMExports()
  const prep = createPreviewPreparation({
    python: async () => assert.fail('the fixture preview is already current'),
    files: () => [],
    version: () => 1,
    busy: () => false,
    settled: () => assert.fail('nothing should be generated'),
  })
  assert.equal(await prep.prepare(dir), undefined)
  assert.deepEqual(reads, [preview, protocol])
  assert.equal(await prep.prepare(dir), undefined)
  assert.deepEqual(reads, [preview, protocol], 'unchanged files are not read')
  await writeFile(preview, html + '\n')
  assert.equal(await prep.prepare(dir), undefined)
  assert.deepEqual(reads, [preview, protocol, preview, protocol])
})
