// Hosted allowance (GET /api/desktop/allowance) against a stubbed fetch: value on 200, null on
// 401/404/timeout/offline/malformed, a one-minute cache per key, and never a throw.
//   node src/main/account-allowance.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'account-allowance-'))
try {
  await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'account-core.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'a.mjs'), logLevel: 'error' })
  const { createAccount, parseAllowance } = await import(pathToFileURL(join(out, 'a.mjs')).href)

  let clock = 1_000_000_000_000
  const enc = (v) => Buffer.from(v).toString('base64')
  const session = (email) => enc(JSON.stringify({ accessToken: 'AT', refreshToken: 'RT', expiresAt: clock + 3_600_000, email }))
  const desktopKey = (key) => enc(JSON.stringify({ key, expiresAt: new Date(clock + 86_400_000).toISOString() }))
  let store = { session: session('a@b.org'), desktopKey: desktopKey('hsk_one') }
  let ownKey = false
  let reply = () => new Response(JSON.stringify({ available: true, percentLeft: 87, requestsLeft: 870, revoked: false, expired: false }), { status: 200 })
  const calls = []
  const account = createAccount({
    server: 'https://hub.test/',
    readStore: () => structuredClone(store),
    writeStore: (s) => { store = structuredClone(s) },
    encrypt: enc,
    decrypt: (v) => Buffer.from(v, 'base64').toString(),
    hasOwnKey: () => ownKey,
    now: () => clock,
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init })
      return reply(init)
    },
  })

  // 200: the parsed value, sent with the desktop key to the allowance endpoint.
  assert.deepEqual(await account.allowance(), { available: true, percentLeft: 87, requestsLeft: 870, revoked: false, expired: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://hub.test/api/desktop/allowance')
  assert.equal(calls[0].init.headers.authorization, 'Bearer hsk_one')
  assert.ok(calls[0].init.signal instanceof AbortSignal, 'request has a timeout signal')

  // Cached for a minute; refresh bypasses the cache; expiry refetches.
  await account.allowance()
  assert.equal(calls.length, 1, 'second read within 60 s is served from cache')
  clock += 59_000
  await account.allowance()
  assert.equal(calls.length, 1)
  await account.allowance(true)
  assert.equal(calls.length, 2, 'refresh forces a request')
  clock += 61_000
  await account.allowance()
  assert.equal(calls.length, 3, 'stale cache refetches')

  // Concurrent readers share one request.
  clock += 61_000
  const before = calls.length
  await Promise.all([account.allowance(), account.allowance(), account.allowance()])
  assert.equal(calls.length, before + 1)

  // 401 / 404 / 500 / malformed / offline / timeout -> null, never a throw.
  const cases = {
    401: () => new Response(JSON.stringify({ error: 'invalid_key' }), { status: 401 }),
    404: () => new Response('Not found', { status: 404 }),
    500: () => new Response('boom', { status: 500 }),
    malformed: () => new Response('not json', { status: 200 }),
    wrongShape: () => new Response(JSON.stringify({ percentLeft: 'lots' }), { status: 200 }),
    offline: () => { throw new TypeError('fetch failed') },
    timeout: (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  }
  for (const [name, fn] of Object.entries(cases)) {
    reply = fn
    if (name === 'timeout') {
      // The real 5 s AbortSignal.timeout: simulate it by aborting immediately instead of waiting.
      reply = (init) => {
        const ctl = new AbortController()
        const p = fn({ signal: ctl.signal })
        ctl.abort(new DOMException('timed out', 'TimeoutError'))
        return p
      }
    }
    assert.equal(await account.allowance(true), null, `${name} -> null`)
  }
  // A null result is cached too, so a server without the endpoint is not asked on every read.
  reply = cases[404]
  const n = calls.length
  assert.equal(await account.allowance(true), null)
  assert.equal(await account.allowance(), null)
  assert.equal(calls.length, n + 1)

  // Not hosted (signed out, own key, expired key) -> null without a request.
  reply = () => new Response(JSON.stringify({ available: true, percentLeft: 12, requestsLeft: 3, revoked: false, expired: false }), { status: 200 })
  ownKey = true
  const m = calls.length
  assert.equal(await account.allowance(true), null)
  ownKey = false
  const saved = store
  store = {}
  assert.equal(await account.allowance(true), null)
  assert.equal(calls.length, m, 'no request without hosted access')
  store = saved

  // A different key does not reuse the previous key's cache.
  store = { ...store, desktopKey: desktopKey('hsk_two') }
  assert.equal((await account.allowance()).percentLeft, 12)
  assert.equal(calls.at(-1).init.headers.authorization, 'Bearer hsk_two')

  // A store that cannot be read is null, not a throw.
  const broken = createAccount({ server: 'https://hub.test', readStore: () => { throw new Error('disk') }, writeStore() {}, encrypt: enc, decrypt: () => null, hasOwnKey: () => false, fetch: async () => { throw new Error('unused') } })
  assert.equal(await broken.allowance(), null)

  // Parser: clamps and rounds, rejects missing fields.
  assert.deepEqual(parseAllowance({ available: true, percentLeft: 104.6, requestsLeft: -2 }), { available: true, percentLeft: 100, requestsLeft: 0, revoked: false, expired: false })
  assert.equal(parseAllowance({ percentLeft: 50 }), null)
  assert.equal(parseAllowance(null), null)

  console.log('account allowance ok')
} finally {
  rmSync(out, { recursive: true, force: true })
}
