import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'pdf-annotations-'))
await build({ entryPoints: [join(here, 'pdf-annotations.ts'), join(here, 'source-anchor.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error' })
const { readPdfAnnotations } = await import(pathToFileURL(join(out, 'pdf-annotations.js')).href)
const { quoteRects } = await import(pathToFileURL(join(out, 'source-anchor.js')).href)
const annotation = () => ({ id: 'one', text: 'Selected original passage '.repeat(200), createdAt: new Date().toISOString(), pages: [{ page: 81, rects: [{ x: 10, y: 20, w: 30, h: 2 }] }, { page: 82, rects: [{ x: 10, y: 5, w: 25, h: 2 }] }] })
test('round-trips complete long selections, multi-page anchors, and pages after 80', () => {
  const value = { version: 1, annotations: [annotation()] }
  assert.deepEqual(readPdfAnnotations(JSON.stringify(value)), value)
  assert.ok(value.annotations[0].text.length > 2000)
})
test('rejects malformed files instead of erasing annotations', () => {
  for (const change of [a => { a.pages[0].page = 0 }, a => { a.pages[0].rects[0].x = 95 }, a => { a.text = '' }, a => { a.pages = [] }]) {
    const a = annotation(); change(a)
    assert.throws(() => readPdfAnnotations(JSON.stringify({ version: 1, annotations: [a] })))
  }
  assert.throws(() => readPdfAnnotations('{broken'))
  assert.throws(() => readPdfAnnotations(JSON.stringify({ version: 2, annotations: [] })))
  assert.throws(() => readPdfAnnotations(JSON.stringify({ version: 1, annotations: [annotation(), annotation()] })))
})
test('source quotation boxes are not silently cut after 64 lines', () => {
  const words = Array.from({ length: 80 }, (_, i) => ({ t: `unique${i}`, x: 5, y: i, w: 20, h: 0.5 }))
  assert.equal(quoteRects(words, words.map(w => w.t).join(' ')).length, 80)
})
