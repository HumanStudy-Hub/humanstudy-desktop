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
/** Paths to material that must never leave this computer: the researcher's private copies (sources/private/, e.g. a
 *  copy of a paper dropped in to fill in a published study's wording) and the app-storage folder of restored wording
 *  (…/original-text/…, a folder: `.humanstudy/original-text.json`, a status without wording, is not one). Matched
 *  on the text URL-decoded and with `./` segments removed; a command that names both `sources` and `private`, or
 *  globs or searches under sources/, counts too (the agent may build the path in pieces). */
export const PRIVATE_MATERIAL = /(?:^|[^A-Za-z0-9_-])sources[\\/]+private(?:[\\/]|\b)|[\\/]original-text[\\/]/i
export const REDACTED_PRIVATE = '[redacted: private material]'

function decoded(s: string): string {
  let out = s
  for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(out); if (d === out) break; out = d } catch { break } }
  return out.replace(/(^|[\\/])(?:\.[\\/])+/g, '$1')
}
/** True when a tool call's text names private material by path (see PRIVATE_MATERIAL). */
export function namesPrivatePath(text: string, globs = true): boolean {
  const t = decoded(text)
  if (PRIVATE_MATERIAL.test(t)) return true
  if (/\bsources\b/i.test(t) && /private/i.test(t)) return true
  return globs && (/\bsources[\\/]+[^\s'"]*[*?[{]/i.test(t) || /\b(?:find|grep|egrep|rg|ag)\b[^\n|;&]*(?:^|[\s'"=/])sources(?:[\\/]*)(?=[\s'"]|$)/i.test(t))
}

// ---- content index: 40-character runs of private text, by hash ------------------------------------------------
/** The run length that counts as a quote of private material: 40 letters in a row, after dropping case, digits,
 *  spaces, punctuation and markup (the skeleton). pack/runtime/lib/hs_original_text.py writes the same hashes. */
export const PRIVATE_RUN = 40
/** A part longer than this is not scanned: while any private material is indexed, it is redacted as a whole. */
export const SCAN_LIMIT = 300_000
const M = 0x5bd1e995
/** The skeleton of a text: NFKC, lower case, letters only (any script, CJK included), as code points. Digits are
 *  left out, so re-numbered items (1. → Q1: → (a) 3), a 1-5 column or page numbers never break a run. */
export function skeleton(text: string): number[] {
  const out: number[] = []
  for (const ch of text.normalize('NFKC').toLowerCase()) if (/\p{L}/u.test(ch)) out.push(ch.codePointAt(0)!)
  return out
}
/** Version of the index format (skeleton and hashes); the helper writes `<name>.v<INDEX_FORMAT>.bin`, and older
 *  files are dropped so they are rebuilt. */
export const INDEX_FORMAT = 2
/** A line's enumerator, bullet or heading (`1.`, `Q1:`, `S1.`, `A1)`, `(a)`, `i.`, `(ii)`, `Question 1:`,
 *  `Statement 2:`, `Item 3:`, `### Q1`, `第1题：`, `- `, a read tool's `12| `), which inserts letters (q, item, a, ii, 第题)
 *  between items: removed in one of the checked forms, and on the helper's side too (hs_original_text.py, same text). */
export const ENUMERATOR = /^\s*(?:\d+\|\s?)?(?:#{1,6}\s*)?(?:\*\*)?(?:[-*•·]\s+|\(?(?:[a-z]{1,2}|item|no\.?|question|statement)?\s*\d+[a-z]?\s*(?:[.):：]|(?=\s*$))\s*|\(?(?:[ivx]{1,5}|[a-z])\s*[.)]\s+|第\s*\d+\s*[题问項项条]\s*[:：.、]?\s*)?(?:\*\*)?/i
/** The same enumerators in the middle of a line (`Q1: … Q2: …`, `(a) … (b) …`, `第1题…第2题`). */
export const INLINE_ENUMERATOR = /(?:^|(?<=[\s,;]))(?:\((?:[ivx]{1,5}|[a-z]|\d+)\)|(?:q|question|statement|item|s|a)\s*\d+[a-z]?\s*[:.)]|第\s*\d+\s*[题问項项条]\s*[:：.、]?)/gi
/** A text with every line's leading enumerator and every inline enumerator removed (the second checked form). */
export function stripEnumerators(text: string): string {
  return text.split(/\r?\n/).map((l) => l.replace(ENUMERATOR, '').replace(INLINE_ENUMERATOR, ' ')).join('\n')
}
/** Hash of one window of skeleton code points: two independent 32-bit hashes. */
export function windowPair(cps: number[], start: number, n = PRIVATE_RUN): [number, number] {
  let a = 0x811c9dc5, b = 0x9747b28c
  for (let i = start; i < start + n; i++) {
    a = Math.imul(a ^ cps[i], 0x01000193) >>> 0
    b = Math.imul(b ^ cps[i], M) >>> 0
    b = (b ^ (b >>> 15)) >>> 0
  }
  return [a, b]
}
export function windowHash(cps: number[], start: number, n = PRIVATE_RUN): string {
  const [a, b] = windowPair(cps, start, n)
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}
/** A compact set of window hashes: sorted (a, b) uint32 pairs in one typed array, searched by bisection. */
export interface PrivateIndex { size: number; has(a: number, b: number): boolean }
export const EMPTY_INDEX: PrivateIndex = { size: 0, has: () => false }
/** The index from files of big-endian (a, b) uint32 pairs in any order (8 bytes per hash): each sorted, then merged. */
export function privateIndexFrom(buffers: Uint8Array[]): PrivateIndex {
  return mergePrivateIndex(buffers.map((buf) => {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const pairs: [number, number][] = []
    for (let i = 0; i + 8 <= buf.length; i += 8) pairs.push([v.getUint32(i), v.getUint32(i + 4)])
    pairs.sort((x, y) => x[0] - y[0] || x[1] - y[1])
    const out = new Uint8Array(pairs.length * 8)
    const w = new DataView(out.buffer)
    pairs.forEach(([x, y], i) => { w.setUint32(i * 8, x); w.setUint32(i * 8 + 4, y) })
    return out
  }))
}
/** The index from files that are each already sorted (the helper writes them sorted): merged pairwise in linear
 *  time, duplicates dropped, never re-sorted. */
export function mergePrivateIndex(buffers: Uint8Array[]): PrivateIndex {
  const toPairs = (buf: Uint8Array): Uint32Array => {
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    const out = new Uint32Array(Math.floor(buf.length / 8) * 2)
    for (let i = 0; i < out.length; i++) out[i] = v.getUint32(i * 4)
    return out
  }
  const merge = (x: Uint32Array, y: Uint32Array): Uint32Array => {
    const out = new Uint32Array(x.length + y.length)
    let i = 0, j = 0, k = 0
    const push = (a: number, b: number) => { if (k >= 2 && out[k - 2] === a && out[k - 1] === b) return; out[k++] = a; out[k++] = b }
    while (i < x.length || j < y.length) {
      if (j >= y.length || (i < x.length && (x[i] < y[j] || (x[i] === y[j] && x[i + 1] <= y[j + 1])))) { push(x[i], x[i + 1]); i += 2 }
      else { push(y[j], y[j + 1]); j += 2 }
    }
    return out.subarray(0, k)
  }
  let lists = buffers.map(toPairs)
  if (!lists.length) return EMPTY_INDEX
  while (lists.length > 1) {
    const next: Uint32Array[] = []
    for (let i = 0; i < lists.length; i += 2) next.push(i + 1 < lists.length ? merge(lists[i], lists[i + 1]) : merge(lists[i], new Uint32Array(0)))
    lists = next
  }
  return sortedIndex(merge(lists[0], new Uint32Array(0)))
}
function sortedIndex(pairs: Uint32Array): PrivateIndex {
  const n = pairs.length / 2
  return {
    size: n,
    has(a, b) {
      let lo = 0, hi = n - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, x = pairs[2 * mid], y = pairs[2 * mid + 1]
        if (x === a && y === b) return true
        if (x < a || (x === a && y < b)) lo = mid + 1; else hi = mid - 1
      }
      return false
    },
  }
}
/** The index of some texts (tests, and the app's own fallbacks). */
export function privateIndexOf(texts: string[]): PrivateIndex {
  const out: number[] = []
  for (const raw of texts) {
    const stripped = stripEnumerators(raw)
    for (const t of stripped === raw ? [raw] : [raw, stripped]) { const cps = skeleton(t); for (let i = 0; i + PRIVATE_RUN <= cps.length; i++) out.push(...windowPair(cps, i)) }
  }
  const buf = new Uint8Array(out.length * 4)
  const v = new DataView(buf.buffer)
  out.forEach((x, i) => v.setUint32(i * 4, x))
  return privateIndexFrom([buf])
}
/** True when `text` holds a run of PRIVATE_RUN skeleton characters found in the index. With `strict` (a project that
 *  is published or has sources/private/), a text longer than SCAN_LIMIT counts as private while anything is indexed
 *  (it is not scanned, and never sent in part); elsewhere it is scanned whole. */
export function containsPrivateRun(text: string, index: PrivateIndex, strict = true): boolean {
  if (!index.size || !text) return false
  if (text.length > SCAN_LIMIT && strict) return true
  const cps = skeleton(text)
  for (let i = 0; i + PRIVATE_RUN <= cps.length; i++) { const [a, b] = windowPair(cps, i); if (index.has(a, b)) return true }
  return false
}

/** The forms of one string that are checked: as it is; with escape sequences (`\\n`, `\\t`, `\\u00e9`, …, as in a
 *  string holding JSON or a heredoc) turned into spaces; and with a read tool's line-number prefixes (`12| `) removed
 *  from every line. JSON escaping of the whole event is never involved: each string value is checked raw. */
export function checkedForms(text: string): string[] {
  const unescaped = text.replace(/\\+u[0-9a-fA-F]{4}/g, ' ').replace(/\\+[nr]/g, '\n').replace(/\\+[tbf"]/g, ' ')
  const out = [text]
  if (unescaped !== text) out.push(unescaped)
  for (const t of [...out]) {
    const stripped = stripEnumerators(t)
    if (stripped !== t) out.push(stripped)
  }
  return out
}
/** True when any string inside `value` (each checked raw, in its checkedForms) names a private path or quotes a run of
 *  indexed private text. `scoped`: the project is published or has sources/private/ (also globs and pieces count, and
 *  an oversized string counts as private while anything is indexed). */
/** Every string inside `value`, raw. */
function strings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (typeof value === 'string') out.push(value)
  else if (value && typeof value === 'object' && depth <= 50) for (const x of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) strings(x, out, depth + 1)
  return out
}
const holdsPath = (v: unknown, globs: boolean): boolean => strings(v).some((s) => checkedForms(s).some((f) => namesPrivatePath(f, globs)))
const holdsContent = (v: unknown, index: PrivateIndex): boolean => strings(v).some((s) => checkedForms(s).some((f) => containsPrivateRun(f, index)))
export function holdsPrivate(value: unknown, index: PrivateIndex, scoped: boolean): boolean {
  const seen = (s: string): boolean => checkedForms(s).some((f) =>
    (scoped ? namesPrivatePath(f, true) : PRIVATE_MATERIAL.test(decoded(f))) || containsPrivateRun(f, index, scoped))
  const walk = (v: unknown, depth: number): boolean => {
    if (typeof v === 'string') return seen(v)
    if (depth > 50 || !v || typeof v !== 'object') return false
    return (Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)).some((x) => walk(x, depth + 1))
  }
  return walk(value, 0)
}

/** An agent transcript part with private material blanked. A tool call whose input or title names a private path,
 *  or any of whose fields quotes private text (index), loses input, output and title; a text part that quotes it
 *  loses its text; a raw (native) or reasoning part that names or quotes it is dropped. `globs`: also count globs and
 *  searches under sources/ (only where the project has a sources/private/ folder). */
export function redactPrivatePart<T extends { kind: string }>(part: T, index: PrivateIndex = EMPTY_INDEX, globs = true): T {
  const quotes = (v: unknown): boolean => v !== undefined && holdsContent(v, index)
  const names = (v: unknown): boolean => v !== undefined && holdsPath(v, globs)
  const q = part as T & { input?: unknown; output?: unknown; detail?: unknown; text?: unknown }
  if (part.kind === 'tool' && (names(q.input) || names(q.detail) || quotes(q.input) || quotes(q.output) || quotes(q.detail)))
    return { ...part, input: REDACTED_PRIVATE, output: REDACTED_PRIVATE, detail: REDACTED_PRIVATE, redacted: 'private-material' }
  if (part.kind === 'text' && quotes(q.text)) return { ...part, text: REDACTED_PRIVATE, redacted: 'private-material' }
  if ((part.kind === 'native' || part.kind === 'reasoning') && (names(part) || quotes(part)))
    return { kind: part.kind, redacted: 'private-material' } as unknown as T
  if (part.kind !== 'tool' && part.kind !== 'text' && quotes(part)) return { kind: part.kind, redacted: 'private-material' } as unknown as T
  return part
}

/** Whether research capture may collect a project file. Never: run outputs (artifacts/simulations/, runs/) of a
 *  published study (its AI participants' replies can quote the restored wording); a text file that quotes private
 *  material; and, while any private material is indexed, a file that cannot be read as text (it cannot be checked). */
export function mayCollectFile(o: { rel: string; text?: string; published: boolean; index: PrivateIndex; hasPrivate?: boolean }): boolean {
  const rel = o.rel.split('\\').join('/')
  const strict = o.published || Boolean(o.hasPrivate)
  if (o.published && /^(?:artifacts\/simulations|runs)(?:\/|$)/.test(rel)) return false
  // an ordinary project (not published, no sources/private/) keeps collecting its PDFs and figures
  if (o.text === undefined) return !strict || o.index.size === 0
  return !containsPrivateRun(o.text, o.index, strict)
}

/** Keys of a research event that hold structure, never content: kept when the event is redacted. */
const CAPTURE_KEEP = new Set(['event_type', 'id', 'thread_id', 'project_id', 'action_id', 'caused_by', 'tool_call_id', 'message_id',
  'target', 'view', 'artifact_version', 'status', 'state', 'via', 'trigger', 'action_link', 'model', 'kind', 'duration_ms',
  'native_id_reported', 'native_message_id', 'native_part_id', 'parent_action_id', 'occurred_at', 'part', 'role'])

/** THE capture boundary for private material: every research event and every telemetry metadata object passes here
 *  before it is stored, put in a blob or sent. An event that names a private path (sources/private/, the restored-
 *  wording cache; in a published or private-folder project also paths built in pieces, globs and searches under
 *  sources/) or quotes a 40-character run of indexed private text keeps only its structural fields; every other
 *  string becomes REDACTED_PRIVATE. `scoped`: the project is published or has sources/private/. */
export function redactCapture<T>(value: T, index: PrivateIndex, scoped: boolean): T {
  if (!holdsPrivate(value, index, scoped)) return value
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') return key !== undefined && CAPTURE_KEEP.has(key) && !namesPrivatePath(v, scoped) && v.length < 200 ? v : REDACTED_PRIVATE
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]))
    return v
  }
  const out = walk(value) as Record<string, unknown>
  if (out && typeof out === 'object' && !Array.isArray(out)) {
    const meta = out.metadata && typeof out.metadata === 'object' ? out.metadata as Record<string, unknown> : {}
    out.metadata = { ...meta, redacted: 'private-material' }
  }
  return out as T
}

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
