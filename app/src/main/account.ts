// Electron wiring for the HumanStudy Hub account (logic in account-core.ts). Secrets are encrypted
// with safeStorage (OS keychain) in userData/account.json, the same approach as credentials.ts.
import { app, safeStorage } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { providers } from './credentials'
import { getSettings } from './settings'
import { createAccount, DEFAULT_SERVER, type Account, type AccountStore } from './account-core'

/** Dogfooding against a protected Vercel preview: requests to our own server carry the
 * deployment-protection bypass header (HUMANSTUDY_SERVER_BYPASS); Supabase requests do not. */
function withBypass(input: Parameters<typeof fetch>[0], init?: RequestInit): RequestInit | undefined {
  const secret = process.env.HUMANSTUDY_SERVER_BYPASS?.trim()
  const server = process.env.HUMANSTUDY_SERVER?.trim()
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (!secret || !server || !url.startsWith(server)) return init
  const headers = new Headers(init?.headers)
  headers.set('x-vercel-protection-bypass', secret)
  return { ...init, headers }
}

const file = (): string => join(app.getPath('userData'), 'account.json')

let account: Account | null = null

export function getAccount(): Account {
  if (account) return account
  account = createAccount({
    server: process.env.HUMANSTUDY_SERVER?.trim() || DEFAULT_SERVER,
    fetch: (input, init) => fetch(input, withBypass(input, init)),
    readStore: (): AccountStore => {
      try {
        return JSON.parse(readFileSync(file(), 'utf8')) as AccountStore
      } catch {
        return {}
      }
    },
    writeStore: (s) => {
      mkdirSync(app.getPath('userData'), { recursive: true })
      writeFileSync(file(), JSON.stringify(s, null, 2), { mode: 0o600 })
    },
    encrypt: (plain) => {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available')
      return safeStorage.encryptString(plain).toString('base64')
    },
    decrypt: (b64) => {
      try {
        return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(b64, 'base64')) : null
      } catch {
        return null
      }
    },
    hasOwnKey: () => providers().some((p) => p.id === 'openrouter' && p.configured),
  })
  return account
}

/**
 * Puts the kernel's provider, model and hosted key into process.env (kernels read env when they
 * are created) and returns a signature of that state, so callers can tell when it changed.
 */
export function applyAccount(): string {
  const settings = getSettings()
  const hosted = getAccount().hostedAccess(settings.model)
  if (hosted) {
    process.env.HUMANSTUDY_PROVIDER = 'humanstudy'
    process.env.HUMANSTUDY_MODEL = hosted.model
    process.env.HUMANSTUDY_HOSTED_BASEURL = `${hosted.server}/api/desktop/v1`
    process.env.HUMANSTUDY_HOSTED_MODELS = JSON.stringify(hosted.models)
    process.env.HUMANSTUDY_DESKTOP_KEY = hosted.key
  } else {
    delete process.env.HUMANSTUDY_PROVIDER
    delete process.env.HUMANSTUDY_HOSTED_BASEURL
    delete process.env.HUMANSTUDY_HOSTED_MODELS
    delete process.env.HUMANSTUDY_DESKTOP_KEY
    process.env.HUMANSTUDY_MODEL = settings.model
  }
  const keyId = hosted ? createHash('sha256').update(hosted.key).digest('hex').slice(0, 12) : ''
  return hosted ? `hosted|${hosted.model}|${hosted.models.join(',')}|${keyId}` : `own|${settings.model}`
}
