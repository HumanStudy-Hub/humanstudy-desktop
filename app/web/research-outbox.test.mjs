import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { build } from 'esbuild'

const chrome = [process.env.HUMANSTUDY_TEST_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path))
const visit = '11111111-1111-4111-8111-111111111111'

test('IndexedDB replays on reload and reconnect, and purges withdrawn consent', { skip: !chrome && 'Chrome unavailable' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-outbox-browser-'))
  const [{ text: script }] = (await build({
    bundle: true, write: false, format: 'iife',
    stdin: { resolveDir: fileURLToPath(new URL('.', import.meta.url)), contents: `
      import { ipcRenderer } from './browser-electron'
      const send = type => ipcRenderer.invoke('telemetry:track', type)
      const consent = enabled => ipcRenderer.invoke('telemetry:setConsent', {usage:enabled, content:enabled})
      const mode = path => fetch(path, {method:'POST'})
      async function rows() {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('humanstudy-research-outbox', 1)
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        return new Promise((resolve, reject) => {
          const req = db.transaction('events').objectStore('events').count()
          req.onsuccess = () => { resolve(req.result); db.close() }
          req.onerror = () => reject(req.error)
        })
      }
      async function until(check, detail) {
        for (let i = 0; i < 160; i++) {
          if (await check()) return
          await new Promise(resolve => setTimeout(resolve, 25))
        }
        throw Error(detail)
      }
      async function run() {
        if (!sessionStorage.reloaded) {
          await send('before-consent')
          await consent(true)
          await new Promise(resolve => setTimeout(resolve, 100))
          await send('reload')
          await until(async () => (await (await fetch('/count')).json()) > 0 && await rows() === 1, 'Event missing before reload')
          sessionStorage.reloaded = '1'
          await mode('/deliver')
          location.replace('/')
          return
        }
        await until(async () => await rows() === 0, 'Event did not replay after reload')
        await mode('/hold')
        await send('reconnect')
        await until(async () => await rows() === 1, 'Event missing while disconnected')
        await mode('/deliver')
        window.dispatchEvent(new Event('online'))
        await until(async () => await rows() === 0, 'Event did not replay on reconnect')
        await mode('/hold')
        await send('withdrawn')
        await until(async () => await rows() === 1, 'Missing pending event')
        await consent(false)
        await until(async () => await rows() === 0, 'Pending event survived withdrawal')
        await fetch('/result', {method:'POST', body:'ok'})
      }
      run().catch(error => fetch('/result', {method:'POST', body:error.message}))
    ` },
  })).outputFiles
  let scope = null, hold = true, finish, browser
  const history = []
  const result = new Promise(resolve => { finish = resolve })
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/events') return res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end()
    if (path === '/script.js') return res.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script)
    if (path === '/deliver' || path === '/hold') { hold = path === '/hold'; return res.end() }
    if (path === '/count') return res.end(JSON.stringify(history.length))
    if (path === '/result' || path.startsWith('/ipc/')) {
      let body = ''
      for await (const chunk of req) body += chunk
      if (path === '/result') { finish(body); return res.end() }
      const { args } = JSON.parse(body)
      const channel = decodeURIComponent(path.slice('/ipc/'.length))
      let value
      if (channel === 'telemetry:setConsent') scope = args[0].usage ? 'fixture-scope' : null
      if (channel === 'telemetry:outboxScope') value = scope
      if (channel === 'telemetry:outboxWrite') {
        history.push({ ...args[0], header: req.headers['x-hs-visit'] })
        if (hold) return res.destroy()
        value = { status: 'ack', id: args[0].id }
      }
      return res.end(JSON.stringify({ ok: true, value }))
    }
    const config = JSON.stringify({ uploads:'/uploads', sep:'/', workspace:'fixture', scope })
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      `<!doctype html><script>window.__HS_WEB__=${config}</script><script src="/script.js"></script>`)
  })
  try {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
    } catch (error) {
      if (error.code !== 'EPERM') throw error
      t.skip('Loopback listener denied by the environment')
      return
    }
    let nativeMac = false
    try { nativeMac = process.platform === 'darwin' && !process.env.HUMANSTUDY_TEST_CHROME && execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding:'utf8' }).trim() === '1' } catch {}
    browser = spawn(nativeMac ? '/usr/bin/arch' : chrome, [
      ...(nativeMac ? ['-arm64', chrome] : []), '--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []), `--user-data-dir=${join(dir, 'chrome')}`,
      `http://127.0.0.1:${server.address().port}/?hs_visit=${visit}`,
    ], { stdio:'ignore' })
    browser.once('error', error => finish(error.message))
    browser.once('exit', code => finish('Chrome exited early: ' + code))
    const timer = setTimeout(() => finish('Chrome did not complete the replay fixture'), 20_000)
    try { assert.equal(await result, 'ok') } finally { clearTimeout(timer) }
    const replay = history.filter(entry => entry.args[0] === 'reload')
    assert.ok(replay.length >= 2)
    assert.equal(new Set(replay.map(entry => entry.id)).size, 1)
    assert.ok(history.every(entry => entry.visit === visit && entry.header === visit))
    assert.ok(history.some(entry => entry.args[0] === 'reconnect'))
    assert.ok(history.every(entry => entry.args[0] !== 'before-consent'))
  } finally {
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const closed = new Promise(resolve => browser.once('close', resolve))
      browser.kill('SIGKILL')
      await closed
    }
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await rm(dir, { recursive:true, force:true })
  }
})

test('the browser commits before POST, reuses the ID after a lost response and waits for a matching ACK', async () => {
  const { runInNewContext } = await import('node:vm')
  const { randomUUID } = await import('node:crypto')
  const { setImmediate: turn } = await import('node:timers/promises')
  const [{ text }] = (await build({
    entryPoints: [fileURLToPath(new URL('./research-outbox.ts', import.meta.url))],
    bundle: true, write: false, format: 'cjs',
  })).outputFiles
  const stored = new Map()
  const db = {
    createObjectStore: () => ({ createIndex() {} }),
    transaction() {
      const tx = {}
      const request = run => {
        const req = {}
        setImmediate(() => { req.result = run(); tx.oncomplete() })
        return req
      }
      tx.objectStore = () => ({
        add: entry => request(() => stored.set(JSON.stringify([entry.workspace, entry.id]), entry)),
        delete: key => request(() => stored.delete(JSON.stringify(key))),
        getAll: () => request(() => [...stored.values()]),
        index: () => ({ getAll: workspace => request(() => [...stored.values()].filter(entry => entry.workspace === workspace)) }),
      })
      return tx
    },
  }
  const indexedDB = {
    open() {
      const request = { result: db }
      queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess() })
      return request
    },
  }
  let scope = null
  const posted = []
  function load(reply) {
    const module = { exports: {} }
    runInNewContext(text, { module, indexedDB, crypto: { randomUUID }, performance, setTimeout: () => 1, clearTimeout() {} })
    return module.exports.createResearchOutbox('workspace', visit, scope, async entry => {
      assert.ok(stored.has(JSON.stringify(['workspace', entry.id])), 'POST ran before the transaction committed')
      posted.push(entry)
      return reply(entry)
    }, async () => scope)
  }
  async function until(check) {
    for (let i = 0; i < 100 && !check(); i++) await turn()
    assert.ok(check())
  }
  const first = load(() => { throw Error('lost response') })
  await first.append('telemetry:track', ['not-consented'])
  assert.equal(stored.size, 0)
  scope = 'accepted'
  await first.refresh()
  await first.append('telemetry:track', ['first-click'])
  await until(() => posted.length === 1)
  const replacement = load(() => ({ status: 'ack', id: randomUUID() }))
  replacement.replay()
  await until(() => posted.length === 2)
  assert.equal(posted[1].id, posted[0].id)
  assert.equal(stored.size, 1)
  const connected = load(entry => ({ status: 'ack', id: entry.id }))
  await connected.refresh()
  await until(() => stored.size === 0)
  assert.equal(posted[2].id, posted[0].id)

  const offline = load(() => { throw Error('offline') })
  await offline.append('telemetry:track', ['withdrawn-click'])
  await until(() => stored.size === 1)
  scope = null
  await offline.refresh()
  await until(() => stored.size === 0)
})

test('withdrawal, sign-out or a changed scope also clears rows other workspaces left in this origin', async () => {
  const { runInNewContext } = await import('node:vm')
  const { randomUUID } = await import('node:crypto')
  const { setImmediate: turn } = await import('node:timers/promises')
  const [{ text }] = (await build({
    entryPoints: [fileURLToPath(new URL('./research-outbox.ts', import.meta.url))],
    bundle: true, write: false, format: 'cjs',
  })).outputFiles
  const stored = new Map()
  const put = entry => stored.set(JSON.stringify([entry.workspace, entry.id]), entry)
  const db = {
    createObjectStore: () => ({ createIndex() {} }),
    transaction() {
      const tx = {}
      const request = run => {
        const req = {}
        setImmediate(() => { req.result = run(); tx.oncomplete() })
        return req
      }
      tx.objectStore = () => ({
        add: entry => request(() => put(entry)),
        delete: key => request(() => stored.delete(JSON.stringify(key))),
        getAll: () => request(() => [...stored.values()]),
        index: () => ({ getAll: workspace => request(() => [...stored.values()].filter(entry => entry.workspace === workspace)) }),
      })
      return tx
    },
  }
  const indexedDB = { open() { const request = { result: db }; queueMicrotask(() => { request.onupgradeneeded(); request.onsuccess() }); return request } }
  let scope = 'first'
  const load = (workspace = 'workspace') => {
    const module = { exports: {} }
    runInNewContext(text, { module, indexedDB, crypto: { randomUUID }, performance, setTimeout: () => 1, clearTimeout() {} })
    return module.exports.createResearchOutbox(workspace, visit, scope, async () => { throw Error('offline') }, async () => scope)
  }
  const row = (workspace, rowScope) => put({ workspace, visit, scope: rowScope, id: randomUUID(), occurredAt: new Date().toISOString(), order: 0, channel: 'telemetry:track', args: ['x'] })
  async function until(check) {
    for (let i = 0; i < 100 && !check(); i++) await turn()
    assert.ok(check())
  }
  const left = () => [...stored.values()].map(entry => `${entry.workspace}:${entry.scope}`).sort()

  // A first grant on a page keeps another workspace's pending rows.
  scope = null
  row('other', 'other-scope')
  const granting = load()
  scope = 'first'
  await granting.refresh()
  await granting.append('telemetry:track', ['mine'])
  await until(() => stored.size === 2)
  assert.deepEqual(left(), ['other:other-scope', 'workspace:first'])

  // The account or agreement changes: earlier rows here and in every other workspace go.
  scope = 'second'
  await granting.refresh()
  await until(() => stored.size === 0)

  // Sign-out or withdrawal on a fresh page clears the whole origin, too.
  row('other', 'other-scope'); row('workspace', 'second')
  scope = null
  await load().refresh()
  await until(() => stored.size === 0)

  // Suspending (consent switched off in this tab) does the same.
  scope = 'third'
  const suspended = load()
  row('other', 'other-scope')
  suspended.suspend()
  await until(() => stored.size === 0)
})
