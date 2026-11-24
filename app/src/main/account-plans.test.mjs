// Usage plans in the account core, against a stubbed fetch (no network, no real credentials).
import { test } from 'node:test'
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'account-plans-test-'))
await build({ entryPoints: [join(here, 'account-core.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outdir: out, logLevel: 'error' })
const { createAccount } = await import(pathToFileURL(join(out, 'account-core.js')).href)

const SERVER = 'https://hub.test', SB = 'https://sb.test'
const ALL = ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5']
const USAGE = { plan: 'free', label: 'Free', usedUsd: 0.42, limitUsd: 3, renewsAt: '2026-12-01T00:00:00.000Z', exhausted: false, period: '2026-11-01', remainingUsd: 2.58 }
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup({ plansOn }) {
  const calls = [], hooks = {}
  let clock = 1_800_000_000_000, store = {}
  const fetch = async (url, init = {}) => {
    const u = String(url), h = init.headers ?? {}
    calls.push({ url: u, auth: h.authorization ?? null, body: init.body ?? null })
    if (u === `${SERVER}/api/desktop/config`) {
      const base = { supabaseUrl: SB, supabaseKey: 'anon', defaultModel: ALL[0], models: ALL, ...(plansOn ? { plans: true } : {}) }
      if (plansOn && h.authorization === 'Bearer hsd_free') return json(200, { ...base, models: [ALL[1]], defaultModel: ALL[1], usage: USAGE })
      return json(200, base)
    }
    if (u === `${SB}/auth/v1/token?grant_type=password`) return json(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, user: { email: 'a@b.org' } })
    if (u === `${SERVER}/api/desktop/key`) {
      if (hooks.onKey) await hooks.onKey()
      const body = JSON.parse(init.body)
      if (!plansOn && body.code !== 'GOOD') return json(403, { error: 'invalid_code' })
      return json(200, { key: 'hsd_free', expiresAt: new Date(clock + 30 * 86_400_000).toISOString() })
    }
    throw new Error('unexpected fetch ' + u)
  }
  const acct = createAccount({
    server: SERVER, fetch,
    readStore: () => structuredClone(store), writeStore: (s) => (store = structuredClone(s)),
    encrypt: (s) => 'enc:' + s, decrypt: (c) => c.slice(4), hasOwnKey: () => false, now: () => clock,
  })
  return { acct, calls, hooks, tick: (ms) => (clock += ms) }
}

test('with plans on, signing in yields a Free key without a code, the plan models and the usage', async () => {
  const { acct, calls, tick } = setup({ plansOn: true })
  await acct.signIn('a@b.org', 'pw')
  await acct.refreshPlan(true)
  const st = acct.status()
  assert.equal(st.unlocked, true)
  assert.equal(st.modelAccess, 'hosted')
  assert.deepEqual(st.models, [ALL[1]], 'the free plan model list replaces the public one')
  assert.equal(st.usage.usedUsd, 0.42)
  assert.equal(st.usage.renewsAt, '2026-12-01T00:00:00.000Z')
  const keyCall = calls.find((c) => c.url.endsWith('/api/desktop/key'))
  assert.equal(keyCall.body, '{}', 'no code is sent')
  assert.equal(calls.filter((c) => c.url.endsWith('/config')).at(-1).auth, 'Bearer hsd_free', 'config is fetched with the key')
  assert.equal(acct.hostedAccess(ALL[0]).model, ALL[1], 'a model outside the plan falls back to the plan default')
  const n = calls.length
  await acct.refreshPlan()
  assert.equal(calls.length, n, 'throttled to once a minute')
  tick(61_000); await acct.refreshPlan()
  assert.ok(calls.length > n)
  await acct.signOut()
  assert.equal(acct.status().usage, undefined)
})

test('with plans off, nothing changes: no key without a code, no usage line', async () => {
  const { acct, calls } = setup({ plansOn: false })
  await acct.signIn('a@b.org', 'pw')
  await acct.refreshPlan(true)
  assert.equal(calls.filter((c) => c.url.endsWith('/api/desktop/key')).length, 0, 'no key request unless the server offers plans')
  const st = acct.status()
  assert.equal(st.unlocked, false)
  assert.equal(st.usage, undefined)
  await acct.unlock('GOOD')
  await acct.refreshPlan(true)
  assert.equal(acct.status().unlocked, true)
  assert.equal(acct.status().usage, undefined)
  assert.deepEqual(acct.status().models, ALL)
})

test('refreshPlan never throws when signed out or offline', async () => {
  const { acct } = setup({ plansOn: true })
  await acct.refreshPlan(true)
  assert.equal(acct.status().signedIn, false)
})

test('a sign-out during the key request never leaves that key for the next account', async () => {
  const { acct, hooks } = setup({ plansOn: true })
  await acct.signIn('a@b.org', 'pw')
  hooks.onKey = async () => { await acct.signOut() }
  await acct.refreshPlan(true)
  hooks.onKey = null
  assert.equal(acct.status().signedIn, false)
  await acct.signIn('a@b.org', 'pw')
  assert.equal(acct.status().unlocked, false, 'the in-flight key was dropped')
})
