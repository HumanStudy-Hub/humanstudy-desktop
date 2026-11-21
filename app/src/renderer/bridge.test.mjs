// Artifact iframe -> app bridge: message validation, frame/origin checks, dispatch, CSP, source resolution.
//   node --test src/renderer/bridge.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'bridge-test-'))
await build({
  stdin: { contents: `export * from './bridge'; export { captureArtifactDwell } from './capture'; export { artifactSourceRef } from './artifact-source'`, resolveDir: here, loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'b.mjs'), logLevel: 'error',
})
const B = await import(pathToFileURL(join(out, 'b.mjs')).href)

test('hs.openSource: valid shapes are normalised', () => {
  assert.deepEqual(B.parseBridgeMessage({ type: 'hs.openSource', page: 5 }), { type: 'hs.openSource', page: 5 })
  assert.deepEqual(B.parseBridgeMessage({ type: 'hs.openSource', page: '14', quote: 'a quote', programId: 'result-s34/effect', file: 'sources/a.pdf' }),
    { type: 'hs.openSource', page: 14, quote: 'a quote', programId: 'result-s34/effect', file: 'sources/a.pdf' })
  assert.deepEqual(B.parseBridgeMessage({ type: 'hs.openSource', programId: 's1-read-story', quote: '  ' }), { type: 'hs.openSource', programId: 's1-read-story' })
  assert.equal(B.parseBridgeMessage({ type: 'hs.openSource', page: 3, quote: 'x'.repeat(5000) }).quote.length, 5000)
})

test('hs.openSource: bad shapes are rejected', () => {
  for (const bad of [
    null, 'hs.openSource', [], { type: 'hs.openSource' }, { type: 'hs.openSource', page: 0 }, { type: 'hs.openSource', page: 2.5 },
    { type: 'hs.openSource', page: -1 }, { type: 'hs.openSource', page: 'abc' }, { type: 'hs.openSource', page: 1, quote: 7 },
    { type: 'hs.openSource', programId: '../etc' }, { type: 'hs.openSource', programId: 'a b' }, { type: 'hs.openSource', programId: 'x'.repeat(300) },
    { type: 'hs.openSource', page: 1, file: '/etc/passwd' }, { type: 'hs.openSource', page: 1, file: '../x.pdf' },
    { type: 'hs.openSource', page: 1, file: 'https://evil.example/x.pdf' }, { type: 'hs.openSource', page: 1, file: 'C:\\x.pdf' },
    { type: 'other', page: 1 }, { type: 'program-view-pick', id: 'x' },
  ]) assert.equal(B.parseBridgeMessage(bad), null, JSON.stringify(bad))
})

test('hs.ask: text is required, trimmed, capped and stripped of control characters', () => {
  assert.deepEqual(B.parseBridgeMessage({ type: 'hs.ask', text: '  Why p. 14?\u0007 ' }), { type: 'hs.ask', text: 'Why p. 14?' })
  assert.equal(B.parseBridgeMessage({ type: 'hs.ask', text: 'y'.repeat(9000) }).text.length, 4000)
  assert.equal(B.parseBridgeMessage({ type: 'hs.ask', text: '   ' }), null)
  assert.equal(B.parseBridgeMessage({ type: 'hs.ask', text: 3 }), null)
  assert.equal(B.parseBridgeMessage({ type: 'hs.ask' }), null)
})

test('acceptFrom: only the viewer frame, only an opaque or hsfile origin', () => {
  const win = {}, frame = { contentWindow: win }
  const data = { type: 'hs.openSource', page: 2 }
  assert.deepEqual(B.acceptFrom({ source: win, origin: 'null', data }, frame), data)
  assert.deepEqual(B.acceptFrom({ source: win, origin: 'hsfile://local', data }, frame), data)
  assert.equal(B.acceptFrom({ source: {}, origin: 'null', data }, frame), null)
  assert.equal(B.acceptFrom({ source: win, origin: 'https://evil.example', data }, frame), null)
  assert.equal(B.acceptFrom({ source: win, origin: 'null', data }, null), null)
  assert.equal(B.acceptFrom({ source: null, origin: 'null', data }, { contentWindow: null }), null)
})

test('dispatch: subscribers receive requests; asks are throttled; unsubscribe works', () => {
  const opened = [], asked = []
  const off1 = B.onOpenSource((r) => opened.push(r)), off2 = B.onAsk((r) => asked.push(r.text))
  B.dispatchBridge({ type: 'hs.openSource', page: 4, programId: 'n1' })
  assert.deepEqual(opened, [{ page: 4, programId: 'n1' }])
  B.dispatchBridge({ type: 'hs.ask', text: 'a' }, 10_000)
  B.dispatchBridge({ type: 'hs.ask', text: 'b' }, 10_100)
  B.dispatchBridge({ type: 'hs.ask', text: 'c' }, 10_700)
  assert.deepEqual(asked, ['a', 'c'])
  off1(); off2()
  B.dispatchBridge({ type: 'hs.openSource', page: 9 })
  assert.equal(opened.length, 1)
})

test('withArtifactCsp: no-network policy goes first in <head>', () => {
  const html = B.withArtifactCsp('<!doctype html><html><head><title>x</title></head><body></body></html>')
  assert.match(html, /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none';[^"]*connect-src 'none'/)
  assert.ok(B.withArtifactCsp('<p>bare</p>').startsWith('<meta http-equiv="Content-Security-Policy"'))
  assert.ok(!/unsafe-eval/.test(B.ARTIFACT_CSP))
})

test('artifactSourceRef: explicit page wins; otherwise the item\'s first cited source', () => {
  const program = {
    nodes: [{ id: 'n1', evidenceIds: ['e1'], fields: [] }], steps: [{ id: 's1', evidenceIds: ['e2'] }],
    evidence: [{ id: 'e1', sourceId: 'paper', locator: { page: 7 }, quote: 'node quote', verification: 'verified' },
      { id: 'e2', sourceId: 'paper', locator: { page: 3 }, quote: 'step quote', verification: 'verified' }],
  }
  assert.deepEqual(B.artifactSourceRef(program, { programId: 'n1' }), { page: 7, quote: 'node quote', file: undefined, sourceId: 'paper', nodeId: 'n1' })
  assert.equal(B.artifactSourceRef(program, { programId: 's1' }).page, 3)
  const own = B.artifactSourceRef(program, { programId: 'n1', page: 12, quote: 'table cell' })
  assert.equal(own.page, 12); assert.equal(own.quote, 'table cell'); assert.equal(own.sourceId, undefined)
  assert.equal(B.artifactSourceRef(null, { page: 2 }).page, 2)
  assert.equal(B.artifactSourceRef(program, { programId: 'unknown' }).page, 1)
})

test('semantic interaction accepts an exact allowlisted shape from its own opaque frame', () => {
  const win = {}, frame = { contentWindow: win }
  const data = { type: 'hs.interact', action: 'answer', controlId: 'q1', label: 'response', step: 0, arm: 'control', valueKind: 'text' }
  assert.deepEqual(B.acceptFrom({ source: win, origin: 'null', data }, frame), data)
  assert.equal(B.acceptFrom({ source: {}, origin: 'null', data }, frame), null)
  assert.equal(B.acceptFrom({ source: win, origin: 'hsfile://local', data }, frame), null)
  for (const fields of [{ action: 'keypress' }, { value: 'typed response' }, { key: 'a' }, { study_id: 'forged-study' },
    { label: 'a typed phrase' }, { controlId: '/a/b' }, { step: undefined }, { step: -1 }, { arm: undefined }, { valueKind: 'object' }]) {
    assert.equal(B.parseBridgeMessage({ ...data, ...fields }), null)
  }
})

test('interaction budget is bounded per frame and refills over time', () => {
  const first = B.artifactRateLimit(), second = B.artifactRateLimit()
  for (let i = 0; i < 12; i++) assert.equal(first(0), true)
  assert.equal(first(0), false)
  assert.equal(second(0), true)
  assert.equal(first(100), false)
  assert.equal(first(200), true)
  assert.equal(first(200), false)
})

test('artifact dwell measures visible intervals and closes them on hide or unmount', () => {
  const old = { window: globalThis.window, document: globalThis.document }
  const elapsed = []
  try {
    globalThis.window = new EventTarget()
    globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const dispose = B.captureArtifactDwell(ms => elapsed.push(ms))
    document.visibilityState = 'hidden'
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('pagehide'))
    assert.equal(elapsed.length, 1)
    document.visibilityState = 'visible'
    document.dispatchEvent(new Event('visibilitychange'))
    dispose()
    window.dispatchEvent(new Event('pagehide'))
    assert.equal(elapsed.length, 2)
    assert.ok(elapsed.every(ms => ms >= 0))
  } finally { Object.assign(globalThis, old) }
})

test('the shipped preview reports control semantics without reading participant text', async () => {
  const { readFile } = await import('node:fs/promises')
  const { runInNewContext } = await import('node:vm')
  const html = await readFile(new URL('../../resources/protocol-sample/artifacts/preview.html', import.meta.url), 'utf8')
  const script = html.match(/<script>\s*(\/\* Participant preview renderer[\s\S]*?)<\/script>/)[1]
  const data = JSON.parse(html.match(/<script[^>]*id="hs-preview"[^>]*>([\s\S]*?)<\/script>/)[1])
  const handlers = {}, messages = []
  const app = { innerHTML: '', querySelectorAll: () => [] }
  const document = {
    getElementById: id => id === 'app' ? app : { textContent: JSON.stringify(data), getAttribute: () => null },
    documentElement: { getAttribute: () => 'en', removeAttribute() {} },
    body: { classList: { toggle() {} } },
    addEventListener: (name, handler) => { handlers[name] = handler },
  }
  const window = { parent: { postMessage: message => messages.push(B.parseBridgeMessage(message)) }, addEventListener() {} }
  runInNewContext(script, { document, window })
  await new Promise(resolve => setImmediate(resolve))
  assert.doesNotMatch(app.innerHTML, /hs-error/)
  const response = { getAttribute: () => 'authored-question' }
  const target = { id: '', closest: () => response, matches: selector => selector.includes('textarea'),
    get value() { throw new Error('The artifact must not read a participant answer') } }
  handlers.change({ target, isTrusted: true })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].action, 'answer')
  assert.equal(messages[0].valueKind, 'text')
  assert.equal(messages[0].controlId, 'authored-question')
  assert.equal(messages[0].step, 0)
})
