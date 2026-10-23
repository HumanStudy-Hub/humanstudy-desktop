// One primary action per user operation (T10): node --test src/shared/research-operations.test.mjs
import { build } from 'esbuild'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const temp = await mkdtemp(join(tmpdir(), 'research-operations-'))
await build({ entryPoints: [fileURLToPath(new URL('./research-operations.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'ops.mjs'), logLevel: 'error' })
const { createOperations, actionRef, FALLBACK_MS } = await import(pathToFileURL(join(temp, 'ops.mjs')).href)
const sleep = ms => new Promise(r => setTimeout(r, ms))
function setup() {
  const sent = []
  const ops = createOperations({ send: (type, opts) => sent.push([type, opts]), uuid: () => crypto.randomUUID(), now: () => Date.now(),
    later: (fn, ms) => setTimeout(fn, ms), cancel: h => clearTimeout(h), microtask: fn => queueMicrotask(fn) })
  const primaries = () => sent.filter(([, o]) => o.action?.primary)
  return { ops, sent, primaries }
}

test('a click with a semantic handler is one primary named by the handler; no generic click follows', async () => {
  const { ops, sent, primaries } = setup()
  const ref = ops.begin('button', 'pointer'); ops.track('program.item_pick', { target: 's1' }); ops.track('selection.change', { metadata: { count: 1 } })
  ops.begin('button', 'pointer') // a synthetic click dispatched by the same handler joins the operation
  await sleep(FALLBACK_MS + 50)
  assert.deepEqual(primaries().map(([t]) => t), ['program.item_pick'])
  assert.ok(sent.every(([, o]) => o.action.id === ref.id))
  assert.equal(sent[1][1].action.primary, false)
})

test('a click nothing semantic claimed is recorded once as a generic click, before its records', async () => {
  const { ops, sent, primaries } = setup()
  ops.begin('tab', 'pointer'); ops.track('tab.switch', { target: 'study:x', durationMs: 900 })
  await sleep(FALLBACK_MS + 50)
  assert.deepEqual(sent.map(([t]) => t), ['ui.click', 'tab.switch'])
  assert.equal(primaries().length, 1)
})

test('a shortcut and the product action it triggers count once; a late semantic event within the window names it', async () => {
  const { ops, sent, primaries } = setup()
  ops.begin('shortcut:cmd+b', 'shortcut'); await sleep(10); ops.track('files.toggle')
  await sleep(FALLBACK_MS + 50)
  assert.deepEqual(primaries().map(([t, o]) => [t, o.action.via]), [['files.toggle', 'shortcut']])
  ops.begin('shortcut:cmd+1', 'shortcut'); await sleep(10); ops.menu('menu:pane.study', true)
  await sleep(FALLBACK_MS + 50)
  assert.deepEqual(sent.at(-1).slice(0, 1), ['menu.command'], 'the accelerator and its menu command are one operation')
  assert.equal(primaries().length, 2)
})

test('claims carry one operation to downstream requests; without input a request is a system operation', async () => {
  const { ops, sent } = setup()
  const click = ops.begin('button', 'pointer'), claimed = ops.claim('composer.send')
  assert.equal(claimed.id, click.id); assert.equal(claimed.target, 'composer.send')
  await sleep(FALLBACK_MS + 50)
  assert.equal(sent.length, 0, 'the main process records the claimed primary with the request')
  const later = ops.claim('paper.build')
  assert.notEqual(later.id, click.id); assert.equal(later.via, 'system')
  assert.equal(ops.claim('source.import', false, 'pointer').via, 'pointer')
  ops.begin('button', 'pointer'); ops.track('simulation.run'); ops.hold(10_000); await sleep(FALLBACK_MS + 50)
  assert.equal(ops.claim('composer.send').target, 'button', 'a held operation is continued by its awaited request')
  ops.track('ui.scroll', { durationMs: 900 })
  assert.equal(sent.at(-1)[1].action, undefined, 'passive summaries are never attributed')
})

test('actionRef accepts only well-formed references from another process', () => {
  assert.equal(actionRef({ id: 'nope', via: 'pointer' }), undefined)
  assert.equal(actionRef({ id: crypto.randomUUID(), via: 'mouse' }), undefined)
  const ok = actionRef({ id: crypto.randomUUID(), via: 'menu', target: 'x'.repeat(500), primary: 'yes', parent: 'bad' })
  assert.equal(ok.target.length, 160); assert.equal(ok.primary, undefined); assert.equal(ok.parent, undefined)
})

test.after(() => rm(temp, { recursive: true, force: true }))
