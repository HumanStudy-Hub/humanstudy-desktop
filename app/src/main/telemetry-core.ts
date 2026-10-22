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
//   (project paths become project-relative). Large payloads use blob references.
import { createHash, randomUUID } from 'node:crypto'
import type {
  TelemetryConsent,
  TelemetryRecent,
  TelemetryRow,
  TelemetryStatus,
  TelemetryTrackOptions,
} from '../preload/types'

export const CONSENT_VERSION = 3 // 3: explicitly includes private uploads of imported sources
export const FLUSH_INTERVAL_MS = 15_000
export const FLUSH_AT = 50
export const MAX_BATCH = 200
export const QUEUE_CAP = 5_000
export const RECENT_CAP = 100
/** Server accepts occurred_at within the last 30 days; keep an hour of margin. */
export const MAX_AGE_MS = 30 * 86_400_000 - 3_600_000
const MAX_BACKOFF_MS = 10 * 60_000

/**
 * Events whose payload is the researcher's own work (messages, tool calls, program versions,
 * written files). They need conversation-content consent on top of usage events.
 */
export const isContentEvent = (type: string): boolean =>
  type.startsWith('conversation.') || type === 'project.program_version' || type === 'project.file_written'

/** Long string keys content events may carry (tool input/output JSON); scrubbed like text without shortening content. */
const LONG_KEYS = /^(input|output|detail)$/

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
  for (const re of SECRET_RES) s = s.replace(re, value => /^[a-f0-9]{64}$/i.test(value) ? value : '[secret]')
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
  if (typeof v === 'string') return scrubString(v, ctx)
  if (Array.isArray(v))
    return v
      .map((x) => cleanValue(x, ctx, false, depth + 1))
      .filter((x) => x !== undefined)
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.test(k)) continue
      if (allowText && depth === 0 && LONG_KEYS.test(k) && typeof val === 'string') {
        out[k] = scrubString(val, ctx)
        continue
      }
      if (CONTENT_KEYS.test(k)) {
        if (!allowText || depth > 0 || typeof val !== 'string') continue
        out[k] = scrubString(val, ctx)
        continue
      }
      const c = cleanValue(val, ctx, false, depth + 1)
      if (c !== undefined) out[k] = c
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
  // Research uses discrete interactions, never a continuous movement/input stream.
  if (/(?:^|[_.:-])(?:mousemove|pointermove|mouse_move|pointer_move|trajectory|keystroke)(?:$|[_.:-])/.test(type) || /^(?:mouse|pointer)\.move(?:$|\.)/.test(type)) return null
  const conversation = isContentEvent(type)
  if (conversation && !ctx.content) return null
  const target = typeof opts.target === 'string' && opts.target ? scrubString(opts.target, ctx).slice(0, 160) : null
  const d = opts.durationMs
  const duration = typeof d === 'number' && Number.isFinite(d) ? Math.min(Math.max(0, Math.round(d)), 2_147_483_647) : null
  let metadata = (cleanValue(opts.metadata ?? {}, ctx, conversation, 0) ?? {}) as Record<string, unknown>
  if (typeof metadata !== 'object' || Array.isArray(metadata)) metadata = {}

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

// ---- program versions ------------------------------------------------------------------
export interface IdDiff {
  added: string[]
  removed: string[]
  changed: string[]
}
export interface ProgramDiff {
  /** Per top-level array of {id} objects (nodes, steps, studies, ...): ids that differ. Empty sections are left out. */
  sections: Record<string, IdDiff>
  /** Top-level keys that are not id lists and changed (title, version, ...). */
  keys: string[]
  /** Total number of ids/keys that differ. */
  total: number
}
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x
  )
}
const isIdList = (v: unknown): v is Array<{ id: string }> =>
  Array.isArray(v) && v.length > 0 && v.every((x) => x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string')

/** Which nodes/steps (by id) were added, removed or edited between two program.json documents. */
export function programDiff(prev: unknown, next: unknown): ProgramDiff {
  const a = (prev && typeof prev === 'object' ? prev : {}) as Record<string, unknown>
  const b = (next && typeof next === 'object' ? next : {}) as Record<string, unknown>
  const sections: Record<string, IdDiff> = {}
  const keys: string[] = []
  let total = 0
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k]
    const y = b[k]
    if (canon(x) === canon(y)) continue
    if ((isIdList(x) || x === undefined) && (isIdList(y) || y === undefined) && (x !== undefined || y !== undefined)) {
      const xm = new Map((x ?? []).map((o) => [o.id, canon(o)]))
      const ym = new Map((y ?? []).map((o) => [o.id, canon(o)]))
      const d: IdDiff = {
        added: [...ym.keys()].filter((id) => !xm.has(id)),
        removed: [...xm.keys()].filter((id) => !ym.has(id)),
        changed: [...ym.keys()].filter((id) => xm.has(id) && xm.get(id) !== ym.get(id)),
      }
      const n = d.added.length + d.removed.length + d.changed.length
      if (n) {
        total += n
        sections[k] = { added: d.added, removed: d.removed, changed: d.changed }
      }
    } else {
      keys.push(k)
      total++
    }
  }
  return { sections, keys, total }
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
    if (isContentEvent(type) && !c.content) return null
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
    const deferred = new Set<string>()
    for (;;) {
      const batch = queue.filter((e) => e.acct === acct && !deferred.has(e.row.id)).slice(0, MAX_BATCH)
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
      } else if (res.status === 403 && batch.some(e => Date.parse(e.row.occurred_at) < now() - MAX_AGE_MS)) {
        // A server still using the 30-day policy must not hold up recent records.
        // Old records remain queued and are attempted again on a later flush.
        for (const e of batch) if (Date.parse(e.row.occurred_at) < now() - MAX_AGE_MS) deferred.add(e.row.id)
      } else {
        fail(`server returned ${res.status}`)
        break
      }
    }
    if (deferred.size) fail(`${deferred.size} old offline event(s) retained locally; the server still rejected their timestamps`)
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
        const drop = new Set(queue.filter((e) => e.acct === acct && isContentEvent(e.row.event_type)).map((e) => e.row.id))
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
