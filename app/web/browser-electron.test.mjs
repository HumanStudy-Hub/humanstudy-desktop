import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import vm from 'node:vm'
const require = createRequire(import.meta.url)
const ts = require('typescript')
const source = ts.transpileModule(readFileSync(new URL('./browser-electron.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
function harness() {
  const pending = [], calls = [], elements = []
  let events
  const make = tag => ({ tag, children: [], style: {}, attrs: {}, listeners: {},
    setAttribute(k, v) { this.attrs[k] = v }, appendChild(v) { this.children.push(v) },
    addEventListener(k, fn) { this.listeners[k] = fn }, remove() { this.removed = true }, click() {},
  })
  const body = make('body')
  const exports = {}
  const context = { exports, console, URL, Uint8Array, Event, navigator: { language: 'en' },
    crypto: { randomUUID: () => `upload-${pending.length}` },
    document: { body, createElement(tag) { const e = make(tag); elements.push(e); return e }, createTextNode: text => ({ text }) },
    window: { __HS_WEB__: { uploads: '/uploads', sep: '/' }, addEventListener() {}, dispatchEvent() {}, open: () => null },
    EventSource: class { constructor() { events = this } addEventListener() {} close() {} },
    fetch: async (url, options) => {
      calls.push({ url, options })
      if (url.startsWith('/upload/')) return new Promise(resolve => pending.push(resolve))
      return { status: 200, json: async () => ({ ok: true, value: 'ok' }) }
    },
  }
  vm.runInNewContext(source, context)
  return { ...exports, pending, calls, elements, body, emit: data => events.onmessage({ data: JSON.stringify(data) }) }
}
const settle = () => new Promise(resolve => setImmediate(resolve))

test('slow PDF uploads do not block Stop/questions; only file-dependent IPC waits', async () => {
  const h = harness()
  const first = h.webUtils.getPathForFile({ name: 'paper.pdf' })
  const second = h.webUtils.getPathForFile({ name: 'supplement.pdf' })
  let finished = false
  const create = h.ipcRenderer.invoke('projects:create', { pdfPath: first }).then(() => { finished = true })
  await h.ipcRenderer.invoke('kernel:abort', 'session')
  await h.ipcRenderer.invoke('kernel:answerQuestion', 'session', 'q', [['Yes']])
  assert.equal(finished, false)
  assert.ok(h.calls.some(c => c.url === '/ipc/kernel%3Aabort'))
  assert.ok(h.calls.some(c => c.url === '/ipc/kernel%3AanswerQuestion'))
  h.pending[0]({ ok: true })
  await create
  assert.equal(finished, true, 'import should not wait for unrelated supplement')
  h.pending[1]({ ok: false, status: 413 })
  await settle()
  await assert.rejects(h.ipcRenderer.invoke('project:importFiles', '/project', [second]), /413/)
  // A mention in ordinary chat is not a file argument and must not inherit the upload failure.
  await h.ipcRenderer.invoke('kernel:send', 'session', `What happened to ${second}?`)
  await h.ipcRenderer.invoke('settings:get')
})

test('blocked external popups leave an actionable safe link instead of silently disappearing', () => {
  const h = harness()
  h.emit({ c: 'web:openExternal', p: 'https://humanstudy-hub.com/contribute' })
  const notice = h.body.children.at(-1)
  assert.equal(notice.attrs.role, 'status')
  const link = notice.children.find(e => e.tag === 'a')
  assert.equal(link.href, 'https://humanstudy-hub.com/contribute')
  assert.equal(link.rel, 'noopener noreferrer')
  link.listeners.click()
  assert.equal(notice.removed, true)
  const count = h.body.children.length
  h.emit({ c: 'web:openExternal', p: 'javascript:alert(1)' })
  assert.equal(h.body.children.length, count)
})
