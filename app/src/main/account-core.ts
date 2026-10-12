// HumanStudy Hub account: Supabase email/password auth over its REST API, plus the desktop key that
// unlocks hosted models. Electron-free (storage, encryption and fetch are injected) so it can be
// tested against a stubbed fetch; src/main/account.ts wires it to safeStorage and userData.
// Tokens and keys are never logged and never returned to the renderer.
import type { AccountStatus } from '../preload/types'

export const DEFAULT_SERVER = 'https://humanstudy-hub-web.vercel.app'

export interface DesktopConfig {
  supabaseUrl: string
  supabaseKey: string
  defaultModel: string
  models: string[]
}

interface Session {
  accessToken: string
  refreshToken: string
  /** Epoch ms when the access token expires. */
  expiresAt: number
  email: string
}

interface DesktopKey {
  key: string
  /** ISO time. */
  expiresAt: string
}

/** On-disk shape: secrets are ciphertext (base64) produced by `encrypt`. */
export interface AccountStore {
  session?: string
  desktopKey?: string
  /** Last config fetched from the server (public values), used when offline. */
  config?: DesktopConfig
}

export interface AccountDeps {
  server: string
  fetch: typeof fetch
  readStore(): AccountStore
  writeStore(s: AccountStore): void
  encrypt(plain: string): string
  decrypt(cipher: string): string | null
  /** True when the user saved an OpenRouter key in Settings (it takes precedence). */
  hasOwnKey(): boolean
  now?(): number
}

export class AccountError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

const REFRESH_MARGIN_MS = 60_000

export function createAccount(deps: AccountDeps) {
  const server = deps.server.replace(/\/+$/, '')
  const now = (): number => (deps.now ? deps.now() : Date.now())
  let config: DesktopConfig | null = null

  // ---- storage ------------------------------------------------------------------------
  function readSecret<T>(field: 'session' | 'desktopKey'): T | null {
    const enc = deps.readStore()[field]
    if (!enc) return null
    const plain = deps.decrypt(enc)
    if (!plain) return null
    try {
      return JSON.parse(plain) as T
    } catch {
      return null
    }
  }
  function writeSecret(field: 'session' | 'desktopKey', value: unknown): void {
    const store = deps.readStore()
    if (value === null) delete store[field]
    else store[field] = deps.encrypt(JSON.stringify(value))
    deps.writeStore(store)
  }
  const getSession = (): Session | null => readSecret<Session>('session')
  const getKey = (): DesktopKey | null => readSecret<DesktopKey>('desktopKey')
  const keyValid = (k: DesktopKey | null): k is DesktopKey => {
    if (!k?.key) return false
    const t = Date.parse(k.expiresAt)
    return Number.isNaN(t) || t > now()
  }

  // ---- server config ------------------------------------------------------------------
  async function getConfig(force = false): Promise<DesktopConfig> {
    if (config && !force) return config
    try {
      const res = await deps.fetch(`${server}/api/desktop/config`, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`config -> ${res.status}`)
      const c = (await res.json()) as Partial<DesktopConfig>
      if (typeof c.supabaseUrl !== 'string' || typeof c.supabaseKey !== 'string')
        throw new Error('config is missing Supabase values')
      config = {
        supabaseUrl: c.supabaseUrl.replace(/\/+$/, ''),
        supabaseKey: c.supabaseKey,
        defaultModel: typeof c.defaultModel === 'string' ? c.defaultModel : '',
        models: Array.isArray(c.models) ? c.models.filter((m): m is string => typeof m === 'string') : [],
      }
      const store = deps.readStore()
      store.config = config
      deps.writeStore(store)
      return config
    } catch (err) {
      const cached = deps.readStore().config
      if (cached) {
        config = cached
        return cached
      }
      throw new AccountError(`Could not reach HumanStudy Hub (${(err as Error).message}).`, 'offline')
    }
  }
  /** Config without network: the in-memory or on-disk copy. */
  const cachedConfig = (): DesktopConfig | null => config ?? deps.readStore().config ?? null

  // ---- Supabase REST ------------------------------------------------------------------
  async function supabase(path: string, body: unknown, bearer?: string): Promise<Record<string, unknown>> {
    const c = await getConfig()
    const res = await deps.fetch(`${c.supabaseUrl}/auth/v1/${path}`, {
      method: 'POST',
      headers: {
        apikey: c.supabaseKey,
        'content-type': 'application/json',
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json: Record<string, unknown> = {}
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const msg = [json.error_description, json.msg, json.message, json.error].find((v) => typeof v === 'string')
      throw new AccountError(
        typeof msg === 'string' ? msg : `Sign-in service returned ${res.status}.`,
        typeof json.error_code === 'string' ? json.error_code : String(res.status)
      )
    }
    return json
  }

  function sessionFrom(json: Record<string, unknown>, fallbackEmail: string): Session | null {
    const access = json.access_token
    const refresh = json.refresh_token
    if (typeof access !== 'string' || typeof refresh !== 'string') return null
    const expiresAt =
      typeof json.expires_at === 'number'
        ? json.expires_at * 1000
        : now() + (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000
    const user = json.user as { email?: unknown } | undefined
    const email = typeof user?.email === 'string' ? user.email : fallbackEmail
    return { accessToken: access, refreshToken: refresh, expiresAt, email }
  }

  /** A non-expired access token, refreshing it when needed; null when signed out. */
  async function accessToken(): Promise<string | null> {
    const s = getSession()
    if (!s) return null
    if (s.expiresAt - REFRESH_MARGIN_MS > now()) return s.accessToken
    try {
      const json = await supabase('token?grant_type=refresh_token', { refresh_token: s.refreshToken })
      const next = sessionFrom(json, s.email)
      if (!next) throw new AccountError('Refresh returned no session.')
      writeSecret('session', next)
      return next.accessToken
    } catch (err) {
      // A rejected refresh token means the session is gone; a network error keeps it for later.
      if (err instanceof AccountError && err.code !== 'offline') writeSecret('session', null)
      return null
    }
  }

  // ---- public -------------------------------------------------------------------------
  function status(): AccountStatus {
    const s = getSession()
    const k = s ? getKey() : null
    const unlocked = keyValid(k)
    return {
      signedIn: Boolean(s),
      email: s?.email,
      unlocked,
      keyExpiresAt: unlocked ? k.expiresAt : undefined,
      server,
      modelAccess: deps.hasOwnKey() ? 'own-key' : unlocked ? 'hosted' : 'none',
      models: cachedConfig()?.models.length ? cachedConfig()?.models : undefined,
    }
  }

  async function signIn(email: string, password: string): Promise<AccountStatus> {
    const e = (email ?? '').trim()
    if (!e || !password) throw new AccountError('Enter your email and password.')
    const json = await supabase('token?grant_type=password', { email: e, password })
    const s = sessionFrom(json, e)
    if (!s) throw new AccountError('Sign-in returned no session.')
    const prev = getSession()
    // A different account must not inherit the previous account's desktop key.
    if (prev && prev.email.toLowerCase() !== s.email.toLowerCase()) writeSecret('desktopKey', null)
    writeSecret('session', s)
    return status()
  }

  async function signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
    const e = (email ?? '').trim()
    if (!e || !password) throw new AccountError('Enter your email and password.')
    // The website confirms the address at /auth/confirm (allowed in Supabase Auth redirect URLs).
    const json = await supabase(`signup?redirect_to=${encodeURIComponent(`${server}/auth/confirm`)}`, { email: e, password })
    // With email confirmation on, Supabase returns the user without a session.
    const s = sessionFrom(json, e)
    if (s) {
      writeSecret('session', s)
      return { needsConfirmation: false }
    }
    return { needsConfirmation: true }
  }

  async function signOut(): Promise<AccountStatus> {
    const s = getSession()
    if (s) {
      try {
        if (s.expiresAt > now()) await supabase('logout', undefined, s.accessToken)
      } catch {
        /* best effort: the local session is cleared regardless */
      }
    }
    writeSecret('session', null)
    writeSecret('desktopKey', null)
    return status()
  }

  async function unlock(code: string): Promise<AccountStatus> {
    const c = (code ?? '').trim()
    if (!c) throw new AccountError('Enter a promo code.')
    const token = await accessToken()
    if (!token) throw new AccountError('Sign in first, then enter your code.', 'not_signed_in')
    let res: Response
    try {
      res = await deps.fetch(`${server}/api/desktop/key`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ code: c }),
      })
    } catch (err) {
      throw new AccountError(`Could not reach HumanStudy Hub (${(err as Error).message}).`, 'offline')
    }
    const json = (await res.json().catch(() => ({}))) as { key?: unknown; expiresAt?: unknown; error?: unknown }
    if (!res.ok) {
      const code = typeof json.error === 'string' ? json.error : String(res.status)
      if (res.status === 401) {
        writeSecret('session', null)
        throw new AccountError('Your session has ended. Sign in again.', code)
      }
      if (res.status === 403) throw new AccountError('That code is not valid.', code)
      if (res.status === 503) throw new AccountError('Hosted models are not available yet. Try again later.', code)
      throw new AccountError(`HumanStudy Hub returned ${res.status}.`, code)
    }
    if (typeof json.key !== 'string' || !json.key) throw new AccountError('HumanStudy Hub returned no key.')
    writeSecret('desktopKey', {
      key: json.key,
      expiresAt: typeof json.expiresAt === 'string' ? json.expiresAt : '',
    } satisfies DesktopKey)
    return status()
  }

  /** What the kernel needs for hosted access, or null when hosted access is not in use. */
  function hostedAccess(preferredModel: string): { server: string; key: string; model: string; models: string[] } | null {
    const st = status()
    if (st.modelAccess !== 'hosted') return null
    const k = getKey()
    if (!keyValid(k)) return null
    const c = cachedConfig()
    const models = c?.models.length ? c.models : [c?.defaultModel || preferredModel]
    const model = models.includes(preferredModel) ? preferredModel : c?.defaultModel || models[0] || preferredModel
    if (!models.includes(model)) models.push(model)
    return { server, key: k.key, model, models }
  }

  /**
   * What a PostgREST call on the user's own rows needs (research data): a fresh access token, the
   * Supabase URL and publishable key, and the user id (the JWT `sub`). Null when signed out.
   */
  async function restAuth(): Promise<RestAuth | null> {
    const token = await accessToken()
    if (!token) return null
    const c = await getConfig()
    return { supabaseUrl: c.supabaseUrl, supabaseKey: c.supabaseKey, accessToken: token, userId: jwtSub(token) }
  }

  return { status, signIn, signUp, signOut, unlock, getConfig, hostedAccess, restAuth }
}

export type Account = ReturnType<typeof createAccount>

export interface RestAuth {
  supabaseUrl: string
  supabaseKey: string
  accessToken: string
  /** auth.uid() of the signed-in user, or '' when the token carries no subject. */
  userId: string
}

function jwtSub(token: string): string {
  try {
    const part = token.split('.')[1] ?? ''
    const json = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as {
      sub?: unknown
    }
    return typeof json.sub === 'string' ? json.sub : ''
  } catch {
    return ''
  }
}
