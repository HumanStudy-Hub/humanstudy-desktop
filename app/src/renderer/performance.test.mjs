import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'renderer-performance-'))
await build({ entryPoints: [join(here, 'text-batcher.ts'), join(here, 'settled-width.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error' })
const { createTextBatcher } = await import(pathToFileURL(join(out, 'text-batcher.js')).href)
const { observeSettledWidth } = await import(pathToFileURL(join(out, 'settled-width.js')).href)
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const text = (value, sessionId = 's') => ({ sessionId, type: 'text', text: value })
test('large Unicode streams keep every character but publish one UI update per batch', () => {
  const events = [], batch = createTextBatcher(e => events.push(e))
  const pieces = Array.from({ length: 10000 }, (_, i) => `证据 ${i} 🧪\n`)
  for (const piece of pieces) batch.push(text(piece))
  assert.equal(events.length, 0)
  batch.flush()
  assert.equal(events.length, 1)
  assert.equal(events[0].text, pieces.join(''))
})
test('questions, tools, errors and completion flush text first and arrive immediately in order', () => {
  for (const type of ['question', 'tool', 'error', 'done', 'permission']) {
    const events = [], batch = createTextBatcher(e => events.push(e))
    batch.push(text('First')); batch.push(text(' second'))
    batch.push({ sessionId: 's', type })
    assert.deepEqual(events.map(e => [e.type, e.text]), [['text', 'First second'], [type, undefined]])
    batch.flush(); assert.equal(events.length, 2)
  }
})
test('session changes do not combine transcripts and cancellation discards only pending UI data', () => {
  const events = [], batch = createTextBatcher(e => events.push(e))
  batch.push(text('one', 'a')); batch.push(text('two', 'b')); batch.flush()
  assert.deepEqual(events.map(e => [e.sessionId, e.text]), [['a', 'one'], ['b', 'two']])
  batch.push(text('stale')); batch.cancel(); batch.flush()
  assert.equal(events.length, 2)
})
test('text batches flush on a timer and stay idle after completion', async () => {
  const events = [], batch = createTextBatcher(e => events.push(e), 5)
  batch.push(text('full')); await wait(20)
  assert.equal(events.length, 1)
  batch.push({ sessionId: 's', type: 'done' }); await wait(20)
  assert.equal(events.length, 2)
})
test('PDF resizing paints the settled width, cancels hidden pages and cleans up pending work', async () => {
  let callback, disconnected = false
  globalThis.ResizeObserver = class {
    constructor(cb) { callback = cb }
    observe() {}
    disconnect() { disconnected = true }
  }
  const widths = [], stop = observeSettledWidth({}, width => widths.push(width), 5)
  const resize = width => callback([{ contentRect: { width } }])
  resize(400); resize(401); resize(500.1); resize(500.2)
  assert.deepEqual(widths, [])
  await wait(20); assert.deepEqual(widths, [500])
  resize(600); resize(0); await wait(20)
  assert.deepEqual(widths, [500, 0])
  resize(700); stop(); await wait(20)
  assert.ok(disconnected); assert.deepEqual(widths, [500, 0])
})
