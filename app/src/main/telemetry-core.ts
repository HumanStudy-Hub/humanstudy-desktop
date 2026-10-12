// Research data (desktop_events): consent, sanitizing, a persisted queue and batched upload to
// Supabase over PostgREST. Electron-free (storage, auth, fetch and the clock are injected) so it
// can be tested against a stubbed fetch; src/main/telemetry.ts wires it to userData and the account.
//
// Rules this file enforces:
// - Nothing is queued unless the signed-in account has confirmed the current consent version with
//   usage events on; conversation.* events additionally need conversation content on.
// - Withdrawal is recorded (consent.withdrawn), flushed, and everything else still pending for
//   that account is discarded; nothing more is sent.
// - Every event passes `sanitizeEvent`: no emails, no key/token-shaped strings, no absolute paths
//   (project paths become project-relative), bounded sizes.
import { createHash, randomUUID } from 'node:crypto'
import type {
  TelemetryConsent,
  TelemetryRecent,
  TelemetryRow,
  TelemetryStatus,
  TelemetryTrackOptions,
} from '../preload/types'

export const CONSENT_VERSION = 2 // 2: one mandatory research data agreement (usage + content together)
export const FLUSH_INTERVAL_MS = 15_000
export const FLUSH_AT = 50
export const MAX_BATCH = 200
export const QUEUE_CAP = 5_000
export const RECENT_CAP = 100
/** Server accepts occurred_at within the last 30 days; keep an hour of margin. */
export const MAX_AGE_MS = 30 * 86_400_000 - 3_600_000
const MAX_BACKOFF_MS = 10 * 60_000
const METADATA_MAX_BYTES = 16_000
const CONVERSATION_TEXT_MAX = 12_000
const STRING_MAX = 500
export const EVENT_TYPE_RE = /^[a-z][a-z0-9_.:-]{1,79}$/

interface StoredConsent {
  version: number
  usage: boolean
  content: boolean
  decidedAt: string
  /** Hash of the account email the decision belongs to. */
  acct: string
}
export interface StoredState {
  installId: string
  consent?: StoredConsent
  sent: number
  lastSentAt?: string
}
interface QueueEntry {
  acct: string
  row: TelemetryRow
}

export interface TelemetryAuth {
  supabaseUrl: string
  supabaseKey: string
  accessToken: string
  userId: string
}

export interface TelemetryStorage {
  readState(): StoredState | null
  writeState(s: StoredState): void
  /** JSONL, one QueueEntry per line. */
  readQueue(): string
  appendQueue(lines: string): void
  writeQueue(content: string): void
  readRecent(): TelemetryRecent[]
  writeRecent(r: TelemetryRecent[]): void
}

export interface TelemetryDeps {
  fetch: typeof fetch
  storage: TelemetryStorage
  /** Email of the signed-in account, or null when signed out (no network). */
  accountEmail(): string | null
  /** Fresh credentials for PostgREST; null when signed out. May throw when offline. */
  auth(): Promise<TelemetryAuth | null>
  appVersion: string
  platform: string
  now?(): number
}

// ---- sanitizer ------------------------------------------------------------------------
export interface SanitizeContext {
  /** Absolute dir of the event's project, so paths inside it become project-relative. */
  projectDir?: string
  /** Account email, always removed even if it would not match the generic pattern. */
  email?: string | null
  /** Conversation content consent: allows `text` in conversation.* events. */
  content: boolean
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
const SECRET_RES = [
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI / OpenRouter / Anthropic style keys
  /\bhsk_[A-Za-z0-9_-]{8,}/g, // HumanStudy desktop keys
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  /\b(?:ghp|gho|github_pat|xox[abp])_[A-Za-z0-9_]{12,}/g,
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{40,}\b/g, // long opaque tokens
]
// An absolute path starts a string or follows whitespace/quote/bracket/=, so URLs (https://x/y) survive.
const ABS_PATH_RE = /(^|[\s"'`(=[<,])((?:~?\/|[A-Za-z]:\\)[^\s"'`)\]>,]+)/g
const FORBIDDEN_KEYS = /^(password|passwd|secret|api[_-]?key|apikey|key|token|access_?token|refresh_?token|authorization|cookie|e-?mail|file_?contents?)$/i
const CONTENT_KEYS = /^(text|content|message|prompt|body|reply)$/i

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function scrubString(input: string, ctx: Pick<SanitizeContext, 'projectDir' | 'email'>): string {
  let s = input
  if (ctx.email) s = s.replace(new RegExp(escapeRe(ctx.email), 'gi'), '[email]')
  s = s.replace(EMAIL_RE, '[email]')
  for (const re of SECRET_RES) s = s.replace(re, '[secret]')
  if (ctx.projectDir) {
    const dir = ctx.projectDir.replace(/[\\/]+$/, '')
    s = s.replace(new RegExp(escapeRe(dir) + '[\\\\/]', 'g'), '').replace(new RegExp(escapeRe(dir), 'g'), '.')
  }
  s = s.replace(ABS_PATH_RE, (_m, pre: string) => `${pre}[path]`)
  return s
}

function cleanValue(v: unknown, ctx: SanitizeContext, allowText: boolean, depth: number): unknown {
  if (v === null || typeof v === 'boolean') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') return scrubString(v, ctx).slice(0, STRING_MAX)
  if (depth >= 4) return undefined
  if (Array.isArray(v))
    return v
      .slice(0, 50)
      .map((x) => cleanValue(x, ctx, false, depth + 1))
      .filter((x) => x !== undefined)
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 50)) {
      if (FORBIDDEN_KEYS.test(k)) continue
      if (CONTENT_KEYS.test(k)) {
        if (!allowText || depth > 0 || typeof val !== 'string') continue
        out[k] = scrubString(val, ctx).slice(0, CONVERSATION_TEXT_MAX)
        continue
      }
      const c = cleanValue(val, ctx, false, depth + 1)
      if (c !== undefined) out[k.slice(0, 64)] = c
    }
    return out
  }
  return undefined
}

export interface RowBase {
  installId: string
  sessionId: string
  appVersion: string
  platform: string
  now: number
}

/** Builds the exact row that is sent, or null when the event is not allowed. */
export function sanitizeEvent(
  type: string,
  opts: TelemetryTrackOptions & { projectId?: string | null },
  ctx: SanitizeContext,
  base: RowBase
): TelemetryRow | null {
  if (typeof type !== 'string' || !EVENT_TYPE_RE.test(type)) return null
  const conversation = type.startsWith('conversation.')
  if (conversation && !ctx.content) return null
  const target = typeof opts.target === 'string' && opts.target ? scrubString(opts.target, ctx).slice(0, 160) : null
  const d = opts.durationMs
  const duration = typeof d === 'number' && Number.isFinite(d) ? Math.min(Math.max(0, Math.round(d)), 2_147_483_647) : null
  let metadata = (cleanValue(opts.metadata ?? {}, ctx, conversation, 0) ?? {}) as Record<string, unknown>
  if (typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {}
  if (Buffer.byteLength(JSON.stringify(metadata)) > METADATA_MAX_BYTES) {
    if (typeof metadata.text === 'string') {
      const over = Buffer.byteLength(JSON.stringify(metadata)) - METADATA_MAX_BYTES
      metadata = { ...metadata, text: metadata.text.slice(0, Math.max(0, metadata.text.length - over * 2 - 64)), truncated: true }
    }
    if (Buffer.byteLength(JSON.stringify(metadata)) > METADATA_MAX_BYTES) metadata = { truncated: true }
  }
  const pid = typeof opts.projectId === 'string' && opts.projectId.length >= 8 && opts.projectId.length <= 80 ? opts.projectId : null
  const platform = ['darwin', 'win32', 'linux'].includes(base.platform) ? base.platform : 'linux'
  return {
    id: randomUUID(),
    install_id: base.installId,
    session_id: base.sessionId,
    project_id: pid,
    event_type: type,
    occurred_at: new Date(base.now).toISOString(),
    target,
    duration_ms: duration,
    metadata,
    app_version: base.appVersion.slice(0, 40),
    platform: platform as TelemetryRow['platform'],
    consent_version: CONSENT_VERSION,
  }
}

export const accountHash = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 24)

// ---- telemetry ------------------------------------------------------------------------
export function createTelemetry(deps: TelemetryDeps) {
  const now = (): number => (deps.now ? deps.now() : Date.now())
  const st = deps.storage
  const state: StoredState = st.readState() ?? { installId: randomUUID(), sent: 0 }
  if (!state.installId || state.installId.length < 8) state.installId = randomUUID()
  if (typeof state.sent !== 'number') state.sent = 0
  st.writeState(state)
  const sessionId = randomUUID()
  let queue: QueueEntry[] = parseQueue(st.readQueue())
  let recent: TelemetryRecent[] = st.readRecent().slice(-RECENT_CAP)
  let failures = 0
  let nextAttemptAt = 0
  let lastError: string | undefined
  let inflight: Promise<void> | null = null

  function parseQueue(text: string): QueueEntry[] {
    const out: QueueEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as QueueEntry
        if (e && typeof e.acct === 'string' && e.row && typeof e.row.id === 'string') out.push(e)
      } catch {
        /* a torn last line from a crash */
      }
    }
    return out
  }
  const saveQueue = (): void => st.writeQueue(queue.map((e) => JSON.stringify(e)).join('\n') + (queue.length ? '\n' : ''))
  const saveState = (): void => st.writeState(state)
  const saveRecent = (): void => st.writeRecent(recent)

  /** Drops events the server would reject as too old and enforces the cap (oldest first). */
  function prune(): void {
    const before = queue.length
    const cutoff = now() - MAX_AGE_MS
    queue = queue.filter((e) => Date.parse(e.row.occurred_at) >= cutoff)
    if (queue.length > QUEUE_CAP) queue = queue.slice(queue.length - QUEUE_CAP)
    if (queue.length !== before) saveQueue()
  }

  prune()

  const currentAcct = (): string | null => {
    const email = deps.accountEmail()
    return email ? accountHash(email) : null
  }
  /** The consent that applies to the signed-in account at the current version, if any. */
  function consent(): StoredConsent | null {
    const acct = currentAcct()
    const c = state.consent
    if (!acct || !c || c.acct !== acct || c.version !== CONSENT_VERSION) return null
    return c
  }

  function status(): TelemetryStatus {
    const acct = currentAcct()
    const c = consent()
    return {
      consentVersion: CONSENT_VERSION,
      signedIn: Boolean(acct),
      decided: Boolean(c),
      usage: Boolean(c?.usage),
      content: Boolean(c?.usage && c?.content),
      decidedAt: c?.decidedAt,
      sent: state.sent,
      pending: acct ? queue.filter((e) => e.acct === acct).length : 0,
      lastSentAt: state.lastSentAt,
      lastError,
    }
  }

  function enqueue(acct: string, row: TelemetryRow): void {
    const entry = { acct, row }
    queue.push(entry)
    st.appendQueue(JSON.stringify(entry) + '\n')
    recent.push({ row, status: 'pending' })
    if (recent.length > RECENT_CAP) recent = recent.slice(-RECENT_CAP)
    saveRecent()
    if (queue.length > QUEUE_CAP) prune()
    if (queue.filter((e) => e.acct === acct).length >= FLUSH_AT) void flush()
  }

  function build(type: string, opts: TelemetryTrackOptions, ctx: { projectDir?: string }, content: boolean): TelemetryRow | null {
    return sanitizeEvent(
      type,
      opts,
      { projectDir: ctx.projectDir, email: deps.accountEmail(), content },
      { installId: state.installId, sessionId, appVersion: deps.appVersion, platform: deps.platform, now: now() }
    )
  }

  /** Queues an event when consent allows it; returns the row that will be sent, or null. */
  function track(type: string, opts: TelemetryTrackOptions = {}, ctx: { projectDir?: string } = {}): TelemetryRow | null {
    const acct = currentAcct()
    const c = consent()
    if (!acct || !c?.usage) return null
    if (type.startsWith('conversation.') && !c.content) return null
    const row = build(type, opts, ctx, c.content)
    if (row) enqueue(acct, row)
    return row
  }

  function removeIds(ids: Set<string>, mark: TelemetryRecent['status']): void {
    queue = queue.filter((e) => !ids.has(e.row.id))
    recent = recent.map((r) => (ids.has(r.row.id) && r.status === 'pending' ? { ...r, status: mark } : r))
  }

  function fail(message: string): void {
    failures++
    lastError = message
    nextAttemptAt = now() + Math.min(FLUSH_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
  }

  async function doFlush(force: boolean): Promise<void> {
    prune()
    const acct = currentAcct()
    if (!acct) return
    if (!force && now() < nextAttemptAt) return
    if (!queue.some((e) => e.acct === acct)) return
    let auth: TelemetryAuth | null
    try {
      auth = await deps.auth()
    } catch (e) {
      fail((e as Error).message || 'offline')
      return
    }
    if (!auth) return
    for (;;) {
      const batch = queue.filter((e) => e.acct === acct).slice(0, MAX_BATCH)
      if (!batch.length) break
      const ids = new Set(batch.map((e) => e.row.id))
      let res: Response
      try {
        res = await deps.fetch(`${auth.supabaseUrl}/rest/v1/desktop_events`, {
          method: 'POST',
          headers: {
            apikey: auth.supabaseKey,
            authorization: `Bearer ${auth.accessToken}`,
            'content-type': 'application/json',
            prefer: 'resolution=ignore-duplicates,return=minimal',
          },
          body: JSON.stringify(batch.map((e) => e.row)),
          signal: AbortSignal.timeout(20_000),
        })
      } catch (e) {
        fail((e as Error).message || 'network error')
        break
      }
      if (res.ok) {
        removeIds(ids, 'sent')
        state.sent += ids.size
        state.lastSentAt = new Date(now()).toISOString()
        failures = 0
        nextAttemptAt = 0
        lastError = undefined
      } else if (res.status >= 400 && res.status < 500 && ![401, 403, 408, 429].includes(res.status)) {
        // The server rejected the rows themselves; retrying would block the queue forever.
        removeIds(ids, 'dropped')
        lastError = `server rejected ${ids.size} event(s) (${res.status})`
      } else {
        fail(`server returned ${res.status}`)
        break
      }
    }
    saveQueue()
    saveState()
    saveRecent()
  }

  function flush(opts: { force?: boolean } = {}): Promise<void> {
    if (inflight) return inflight
    inflight = doFlush(Boolean(opts.force)).finally(() => {
      inflight = null
    })
    return inflight
  }

  async function setConsent(next: TelemetryConsent): Promise<TelemetryStatus> {
    const email = deps.accountEmail()
    if (!email) throw new Error('Sign in to your HumanStudy Hub account first.')
    const acct = accountHash(email)
    const usage = Boolean(next.usage)
    const content = usage && Boolean(next.content)
    const prev = consent()
    if (inflight) await inflight.catch(() => undefined)
    state.consent = { version: CONSENT_VERSION, usage, content, decidedAt: new Date(now()).toISOString(), acct }
    saveState()
    // Not `content`: that key is reserved for message text and stripped by the sanitizer.
    const meta = { usageEvents: usage, conversationContent: content, consentVersion: CONSENT_VERSION }
    if (prev?.usage && !usage) {
      // Withdrawal: discard what was not sent yet, record the withdrawal, send it, then stop.
      queue = queue.filter((e) => e.acct !== acct)
      recent = recent.map((r) => (r.status === 'pending' ? { ...r, status: 'dropped' } : r))
      saveQueue()
      const row = build('consent.withdrawn', { metadata: meta }, {}, false)
      if (row) enqueue(acct, row)
      await flush({ force: true })
    } else if (usage && !prev?.usage) {
      track('consent.granted', { metadata: meta })
    } else if (usage && prev && prev.content !== content) {
      if (!content) {
        const drop = new Set(queue.filter((e) => e.acct === acct && e.row.event_type.startsWith('conversation.')).map((e) => e.row.id))
        removeIds(drop, 'dropped')
        saveQueue()
        saveRecent()
      }
      track('consent.changed', { metadata: meta })
    }
    return status()
  }

  /** DELETE every desktop_events row the user owns, then clear what is kept locally. */
  async function deleteMyData(): Promise<TelemetryStatus> {
    const acct = currentAcct()
    if (!acct) throw new Error('Sign in to your HumanStudy Hub account first.')
    if (inflight) await inflight.catch(() => undefined)
    const auth = await deps.auth()
    if (!auth) throw new Error('Your session has ended. Sign in again.')
    if (!auth.userId) throw new Error('Could not identify your account. Sign in again.')
    const res = await deps.fetch(`${auth.supabaseUrl}/rest/v1/desktop_events?owner_id=eq.${encodeURIComponent(auth.userId)}`, {
      method: 'DELETE',
      headers: { apikey: auth.supabaseKey, authorization: `Bearer ${auth.accessToken}`, prefer: 'return=minimal' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`HumanStudy Hub could not delete your data (${res.status}). Try again later.`)
    queue = queue.filter((e) => e.acct !== acct)
    recent = []
    state.sent = 0
    state.lastSentAt = undefined
    saveQueue()
    saveRecent()
    saveState()
    return status()
  }

  return {
    status,
    track,
    flush,
    setConsent,
    deleteMyData,
    recent: (): TelemetryRecent[] => recent.slice().reverse(),
    /** Timer hook: flushes when the backoff allows. */
    tick: (): Promise<void> => flush(),
    sessionId,
    /** Sanitized row without queueing; for tests and previews. */
    preview: (type: string, opts: TelemetryTrackOptions = {}, ctx: { projectDir?: string } = {}) =>
      build(type, opts, ctx, Boolean(consent()?.content)),
  }
}

export type Telemetry = ReturnType<typeof createTelemetry>
