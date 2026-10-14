import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const out = mkdtempSync(join(tmpdir(), 'account-password-'))
try {
  await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'account-core.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'a.mjs'), logLevel: 'error' })
  const { createAccount } = await import(pathToFileURL(join(out, 'a.mjs')).href)
  let store = {}, failEmail = '', oldAccepted = true, writeAccepted = true, password = 'old-password'
  const requests = []
  const response = (status, body) => new Response(JSON.stringify(body), { status })
  const deps = { server: 'https://preview.test', readStore: () => structuredClone(store), writeStore: value => { store = structuredClone(value) }, encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString(), hasOwnKey: () => false,
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : undefined
      requests.push({ url, init, body })
      if (String(url).endsWith('/api/desktop/config')) return response(200, { supabaseUrl: 'https://sb.test', supabaseKey: 'publishable', authOrigin: 'https://humanstudy-hub.test', models: [] })
      if (/\/recover\?|\/resend\?/.test(url)) return failEmail ? response(429, { error_code: failEmail, msg: 'Please wait.' }) : response(200, {})
      if (String(url).includes('grant_type=password')) return oldAccepted && body.password === password ? response(200, { access_token: 'fresh-token', refresh_token: 'fresh-refresh', expires_in: 3600, user: { email: body.email } }) : response(400, { error_code: 'invalid_credentials', msg: 'Invalid login credentials' })
      if (String(url).endsWith('/user')) {
        assert.equal(init.method, 'PUT'); assert.equal(init.headers.authorization, 'Bearer fresh-token')
        if (!writeAccepted) return response(422, { error_code: 'weak_password', msg: 'Use a stronger password.' })
        password = body.password; return response(200, { email: 'owner@test.org' })
      }
      if (String(url).endsWith('/logout')) return response(200, {})
      throw new Error('Unexpected fixture request')
    },
  }
  const account = createAccount(deps)
  await account.forgotPassword(' owner@test.org ')
  assert.equal(new URL(requests.at(-1).url).searchParams.get('redirect_to'), 'https://humanstudy-hub.test/auth/reset')
  assert.deepEqual(requests.at(-1).body, { email: 'owner@test.org' })
  await account.resendConfirmation('owner@test.org')
  assert.equal(new URL(requests.at(-1).url).searchParams.get('redirect_to'), 'https://humanstudy-hub.test/auth/confirm')
  assert.equal(requests.at(-1).body.type, 'signup')
  failEmail = 'over_email_send_rate_limit'
  await assert.rejects(account.forgotPassword('owner@test.org'), /Please wait/)
  failEmail = ''
  await assert.rejects(account.forgotPassword('invalid'), /valid email/)
  await assert.rejects(account.changePassword('old-password', 'new-password'), /Sign in first/)
  await account.signIn('owner@test.org', 'old-password')
  const before = structuredClone(store)
  await assert.rejects(account.changePassword('wrong', 'new-password'), /current password is incorrect/)
  assert.deepEqual(store, before, 'failed reauthentication cannot modify the stored session')
  await assert.rejects(account.changePassword('old-password', 'short'), /between 8 and 128/)
  writeAccepted = false
  await assert.rejects(account.changePassword('old-password', 'new-password'), /stronger/)
  assert.deepEqual(store, before, 'failed update leaves session intact')
  writeAccepted = true
  const status = await account.changePassword('old-password', 'new-password')
  assert.equal(status.signedIn, true)
  assert.equal(status.email, 'owner@test.org')
  assert.equal(JSON.stringify(store).includes('new-password'), false, 'passwords are never persisted')
  await assert.rejects(account.signIn('owner@test.org', 'old-password'), /Invalid login/)
  assert.equal((await account.signIn('owner@test.org', 'new-password')).signedIn, true)
  const beta = createAccount({ ...deps, authOrigin: 'https://auth-preview.test' })
  await beta.forgotPassword('owner@test.org')
  assert.equal(new URL(requests.at(-1).url).searchParams.get('redirect_to'), 'https://auth-preview.test/auth/reset')
  assert.equal(beta.status().server, 'https://preview.test', 'an auth callback override never switches the model backend')
  assert.throws(() => createAccount({ ...deps, authOrigin: 'https://evil.test/?redirect=elsewhere' }), /Invalid auth origin/)
  console.log('Password recovery/resend redirects, failed delivery, current-password verification and new login passed (stubbed Auth)')
} finally { rmSync(out, { recursive: true, force: true }) }
