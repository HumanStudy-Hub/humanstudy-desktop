// Account smoke test against a stubbed fetch (no network, no real credentials):
//   node src/main/account.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'account-test-'))
await build({
  entryPoints: [join(here, 'account-core.ts'), join(here, 'kernel', 'opencode.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outdir: out,
  logLevel: 'error',
})
const { createAccount } = await import(pathToFileURL(join(out, 'account-core.js')).href)
const oc = await import(pathToFileURL(join(out, 'kernel', 'opencode.js')).href)

const SERVER = 'https://hub.test'
const SB = 'https://sb.test'
let clock = 1_000_000_000_000
const calls = []
let refreshOk = true
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const stubFetch = async (url, init = {}) => {
  const u = String(url)
  const h = init.headers ?? {}
  const body = init.body ? JSON.parse(init.body) : undefined
  calls.push({ url: u, method: init.method ?? 'GET', headers: h, body })
  if (u === `${SERVER}/api/desktop/config`)
    return json(200, { supabaseUrl: SB + '/', supabaseKey: 'anon-key', defaultModel: 'anthropic/claude-haiku-5.5', models: ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-chat'] })
  if (u.startsWith(SB)) assert.equal(h.apikey, 'anon-key')
  if (u === `${SB}/auth/v1/token?grant_type=password`) {
    if (body.password !== 'pw') return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' })
    return json(200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, user: { email: body.email } })
  }
  if (u === `${SB}/auth/v1/token?grant_type=refresh_token`) {
    assert.ok(['RT1', 'RT2'].includes(body.refresh_token))
    if (!refreshOk) return json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token' })
    return json(200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, user: { email: 'a@b.org' } })
  }
  if (u.startsWith(`${SB}/auth/v1/signup?redirect_to=`)) {
    assert.equal(decodeURIComponent(u.split('redirect_to=')[1]), `${SERVER}/auth/confirm`)
    return json(200, { id: 'u1', email: body.email }) // confirmation required: no session
  }
  if (u === `${SB}/auth/v1/logout`) return new Response(null, { status: 204 })
  if (u === `${SERVER}/api/desktop/key`) {
    if (h.authorization !== 'Bearer AT2') return json(401, { error: 'not_signed_in' })
    if (body.code !== 'GOOD') return json(403, { error: 'invalid_code' })
    return json(200, { key: 'hsk_secret', expiresAt: new Date(clock + 30 * 86_400_000).toISOString(), email: 'a@b.org' })
  }
  throw new Error('unexpected fetch ' + u)
}

let store = {}
let ownKey = false
const enc = (s) => 'enc:' + Buffer.from(s).toString('base64').split('').reverse().join('')
const dec = (c) => Buffer.from(c.slice(4).split('').reverse().join(''), 'base64').toString()
const acct = createAccount({
  server: SERVER + '/',
  fetch: stubFetch,
  readStore: () => structuredClone(store),
  writeStore: (s) => (store = structuredClone(s)),
  encrypt: enc,
  decrypt: dec,
  hasOwnKey: () => ownKey,
  now: () => clock,
})

assert.deepEqual(acct.status(), { signedIn: false, email: undefined, unlocked: false, keyExpiresAt: undefined, server: SERVER, modelAccess: 'none' })

await assert.rejects(acct.signIn('a@b.org', 'bad'), /Invalid login credentials/)
assert.deepEqual(await acct.signUp('a@b.org', 'pw'), { needsConfirmation: true })

let st = await acct.signIn('a@b.org', 'pw')
assert.equal(st.signedIn, true)
assert.equal(st.email, 'a@b.org')
assert.equal(st.modelAccess, 'none')
const disk = JSON.stringify(store)
assert.ok(!disk.includes('AT1') && !disk.includes('RT1'), 'tokens must be stored encrypted')

// Access token expired -> unlock refreshes first, then uses the new token.
clock += 2 * 3600_000
await assert.rejects(acct.unlock('NOPE'), /not valid/)
assert.ok(calls.some((c) => c.url.endsWith('grant_type=refresh_token')))
st = await acct.unlock('GOOD')
assert.equal(st.unlocked, true)
assert.equal(st.modelAccess, 'hosted')
assert.ok(!JSON.stringify(store).includes('hsk_secret'), 'desktop key must be stored encrypted')

// Model choice: settings model when the server offers it, else the server default.
assert.equal(acct.hostedAccess('deepseek/deepseek-chat').model, 'deepseek/deepseek-chat')
assert.equal(acct.hostedAccess('openai/gpt-x').model, 'anthropic/claude-haiku-5.5')
assert.equal(acct.hostedAccess('x').server, SERVER)

// Own key takes precedence.
ownKey = true
assert.equal(acct.status().modelAccess, 'own-key')
assert.equal(acct.hostedAccess('x'), null)
ownKey = false

// Key expiry drops hosted access.
clock += 31 * 86_400_000
assert.equal(acct.status().unlocked, false)
assert.equal(acct.status().modelAccess, 'none')

// A rejected refresh signs out.
refreshOk = false
await assert.rejects(acct.unlock('GOOD'), /Sign in first/)
assert.equal(acct.status().signedIn, false)

// Sign out clears session and key.
refreshOk = true
await acct.signIn('a@b.org', 'pw')
st = await acct.signOut()
assert.equal(st.signedIn, false)
assert.ok(calls.some((c) => c.url.endsWith('/auth/v1/logout') && c.headers.authorization === 'Bearer AT1'))
assert.equal(store.session, undefined)
assert.equal(store.desktopKey, undefined)

// Kernel inline config adds recovery controls without redefining provider credentials.
const k = new oc.OpencodeKernel({ binary: '/bin/true', provider: 'humanstudy', model: 'anthropic/claude-haiku-5.5' })
let content = JSON.parse(k.configContent())
assert.equal(content.model, 'humanstudy/anthropic/claude-haiku-5.5')
assert.equal(content.small_model, content.model)
assert.deepEqual(content.provider, { humanstudy: { models: { 'anthropic/claude-haiku-5.5': { variants: { 'humanstudy-recovery': { reasoningEffort: 'low' } } } } } })
assert.equal(JSON.stringify(content).includes('apiKey'), false, 'recovery configuration contains no credential')
assert.equal(content.permission.edit, 'ask')
const bash = content.permission.bash
assert.equal(bash['*'], 'ask')
assert.equal(bash['ls *'], 'allow')
assert.equal(bash['pdftotext *'], 'allow')
assert.equal(bash['python *'], undefined)
assert.equal(bash['find *-delete*'], 'ask')
assert.equal(bash['*>*'], 'ask')
// last match wins, so the risky forms must come after the allows
const keys = Object.keys(bash)
assert.ok(keys.indexOf('find *-exec*') > keys.indexOf('find *'))
assert.ok(keys.indexOf('*>*') > keys.indexOf('echo *'))
await k.dispose()
assert.equal(oc.toolDetail('bash', 'List files', { command: 'ls -la', description: 'List files' }), 'ls -la')
assert.equal(oc.toolDetail('bash', '', {}), '')
assert.equal(oc.toolDetail('read', '', { filePath: '/a/b.md' }), '/a/b.md')
// A hosted model the fork does not know is declared; no key ever appears in the config.
const k2 = new oc.OpencodeKernel({ binary: '/bin/true', provider: 'humanstudy', model: 'deepseek/deepseek-chat' })
content = JSON.parse(k2.configContent())
assert.deepEqual(Object.keys(content.provider.humanstudy.models), ['deepseek/deepseek-chat'])
assert.ok(!JSON.stringify(content).includes('apiKey'))
await k2.dispose()

console.log(`account ok: ${calls.length} stubbed requests`)
