// Provider API keys, encrypted with Electron safeStorage (OS keychain) and stored as base64
// ciphertext in userData/credentials.json. Keys are never logged or sent to the renderer.
import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderStatus } from '../preload/types'

type ProviderId = ProviderStatus['id']
const PROVIDERS: Array<{ id: ProviderId; label: string; env: string }> = [
  { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
  { id: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
  { id: 'deepseek', label: 'DeepSeek', env: 'DEEPSEEK_API_KEY' },
]

const file = (): string => join(app.getPath('userData'), 'credentials.json')
// Values inherited from the launching shell, restored when a stored key is removed.
const inherited: Partial<Record<string, string>> = {}
for (const p of PROVIDERS) if (process.env[p.env]) inherited[p.env] = process.env[p.env]

function readStore(): Partial<Record<ProviderId, string>> {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Partial<Record<ProviderId, string>>
  } catch {
    return {}
  }
}

function decrypt(b64: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'))
  } catch {
    return null
  }
}

/** Puts stored keys into process.env so kernels spawned afterwards pick them up. */
export function applyCredentials(): void {
  const store = readStore()
  for (const p of PROVIDERS) {
    const enc = store[p.id]
    const key = enc && safeStorage.isEncryptionAvailable() ? decrypt(enc) : null
    if (key) process.env[p.env] = key
    else if (inherited[p.env]) process.env[p.env] = inherited[p.env]
    else delete process.env[p.env]
  }
}

export function providers(): ProviderStatus[] {
  const store = readStore()
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    configured: Boolean(store[p.id]) || Boolean(inherited[p.env]),
  }))
}

export function setKey(id: ProviderId, key: string): ProviderStatus[] {
  if (!PROVIDERS.some((p) => p.id === id)) throw new Error(`unknown provider ${String(id)}`)
  const store = readStore()
  const trimmed = (key ?? '').trim()
  if (trimmed) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is not available')
    store[id] = safeStorage.encryptString(trimmed).toString('base64')
  } else {
    delete store[id]
  }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(store, null, 2), { mode: 0o600 })
  applyCredentials()
  return providers()
}
