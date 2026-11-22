import assert from 'node:assert/strict'
import { test } from 'node:test'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
const [{ text: source }] = (await build({
  entryPoints: [fileURLToPath(new URL('./browser-electron.ts', import.meta.url))],
  bundle: true, write: false, format: 'cjs',
})).outputFiles
function harness({ config = { uploads: '/uploads', sep: '/' }, href = 'https://workspace.test/', stored = new Map(), respond } = {}) {
  const pending = [], calls = [], elements = []
  let events, eventUrl
  const make = tag => ({ tag, children: [], style: {}, attrs: {}, listeners: {},
    setAttribute(k, v) { this.attrs[k] = v }, appendChild(v) { this.children.push(v) },
    addEventListener(k, fn) { this.listeners[k] = fn }, remove() { this.removed = true }, click() {},
  })
  const body = make('body')
  const exports = {}
  const context = { module: { exports }, exports, console, URL, clearTimeout, setTimeout: () => 1, Uint8Array, Event, AbortSignal, performance, navigator: { language: 'en', onLine: true },
    crypto: { randomUUID: config.workspace ? randomUUID : () => `upload-${pending.length}` },
    sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    document: { body, createElement(tag) { const e = make(tag); elements.push(e); return e }, createTextNode: text => ({ text }) },
    window: { __HS_WEB__: config, location: { href }, addEventListener() {}, dispatchEvent() {}, open: () => null },
    EventSource: class { constructor(url) { events = this; eventUrl = url } addEventListener() {} close() {} },
    fetch: async (url, options) => {
      calls.push({ url, options })
      if (url.startsWith('/upload/')) return new Promise(resolve => pending.push(resolve))
      return respond?.(url, options) ?? { status: 200, json: async () => ({ ok: true, value: 'ok' }) }
    },
  }
  vm.runInNewContext(source, context)
  return { ...context.module.exports, pending, calls, elements, body, eventUrl, emit: data => events.onmessage({ data: JSON.stringify(data) }) }
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


test('visit fallback survives reload within a workspace and differs in a fresh browser session', () => {
  const config = { uploads: '/uploads', sep: '/', workspace: 'fixture' }
  const stored = new Map()
  const first = harness({ config, stored }).eventUrl
  assert.match(first, /^\/events\?hs_visit=[0-9a-f-]{36}$/)
  assert.equal(harness({ config, stored }).eventUrl, first)
  assert.notEqual(harness({ config }).eventUrl, first)
  assert.notEqual(harness({ config: { ...config, workspace: 'other' }, stored }).eventUrl, first)
})

test('a transport-failed send while online adds one failed submission with the dispatch action', async () => {
  let sends = 0
  const h = harness({
    config: { uploads: '/uploads', sep: '/', workspace: 'fixture', scope: 'consented' },
    respond(url) {
      if (url !== '/ipc/kernel%3Asend') return
      if (++sends === 1) throw new TypeError('connection lost')
      return { status: 200, json: async () => ({ ok: false, error: { message: 'main process refusal' } }) }
    },
  })
  await assert.rejects(h.ipcRenderer.invoke('kernel:send', 'session', 'first message'), /connection to HumanStudy Hub was lost/)
  await assert.rejects(h.ipcRenderer.invoke('kernel:send', 'session', 'second message'), /main process refusal/)
  await settle()
  const args = call => JSON.parse(call.options.body).args
  const dispatch = h.calls.find(call => call.url === '/ipc/kernel%3Asend')
  const writes = h.calls.filter(call => call.url === '/ipc/telemetry%3AoutboxWrite')
  assert.equal(writes.length, 1)
  const [entry] = args(writes[0])
  assert.equal(entry.channel, 'telemetry:chatSubmission')
  assert.deepEqual(entry.args, ['session', 'first message', 'failed', args(dispatch)[3]])
  assert.match(entry.args[3].id, /^[0-9a-f-]{36}$/)
})
