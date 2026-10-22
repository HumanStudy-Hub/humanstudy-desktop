/**
 * HumanStudy research-data contract, machine-readable half of docs/research-data-contract.md.
 *
 * VENDOR VERBATIM. This file is copied unchanged into humanstudy-desktop (main process and the
 * headless OpenCode worker) and used by the web collector. It must stay dependency-free: no Next,
 * no Node or browser APIs, no imports. Change it here first, bump CONTRACT_VERSION, then re-vendor.
 *
 * The database (supabase/migrations/20261022120000_research_data_contract_v1.sql) enforces the
 * structural rules again; this file adds the event catalog and per-type requirements.
 */

export const CONTRACT_VERSION = '1.0.0'

// ---- enumerations ---------------------------------------------------------------------------

export const SURFACES = ['desktop', 'web', 'headless'] as const
export type Surface = (typeof SURFACES)[number]

export const PLATFORMS = ['darwin', 'win32', 'linux', 'browser'] as const
export type Platform = (typeof PLATFORMS)[number]

/** The seven agreed data types (issue #27) plus `session` for lifecycle and delivery records. */
export const DATA_TYPES = [
  'session',
  'interaction', //        clicks, keyboard shortcuts, controls
  'navigation', //         views/tabs, source pages, dwell, settled scrolling
  'selection_layout', //   final selections, annotations, panel adjustments
  'conversation', //       user/assistant messages, questions and answers, edits/retries, partial output
  'agent_execution', //    turns, tool calls, permissions, usage, errors
  'knowledge_artifact', // Human Program versions, artifact versions, human edits
  'source_input', //       original imported PDFs/resources
] as const
export type DataType = (typeof DATA_TYPES)[number]

// ---- limits ---------------------------------------------------------------------------------

export const LIMITS = {
  /** Text up to this many UTF-8 bytes may sit inline in metadata; longer text goes to content. */
  inlineTextBytes: 8_192,
  /** Server limit for the serialized metadata object. */
  metadataBytes: 16_384,
  /** Raw bytes per part when content is split; parts are compressed separately. */
  partBytes: 4 * 1024 * 1024,
  /** Server limit per stored object (bucket file_size_limit). */
  storedObjectBytes: 8 * 1024 * 1024,
  contentRefsPerEvent: 64,
  targetChars: 160,
  /** Server rejects occurred_at further than this in the future. */
  futureSkewMs: 10 * 60_000,
  /** Events per insert request. */
  batchSize: 200,
} as const

export const CONTENT_BUCKET = 'research-content'
export const MANIFEST_FORMAT = 'humanstudy-content-parts-v1'

// ---- rows -----------------------------------------------------------------------------------

/** Reference from an event to stored content. sha256 is over the original uncompressed bytes. */
export interface ContentRef {
  /** What the content is to this event: text, input, output, program, file, source, metadata... */
  role: string
  sha256: string
  /** Original (uncompressed) size in bytes. */
  bytes: number
  mime?: string
}

/**
 * One event, exactly as inserted into public.research_events (snake_case = column names).
 * owner_id and received_at are set by the server.
 */
export interface ResearchEvent {
  id: string
  contract_version: string
  surface: Surface
  install_id: string
  research_session_id: string
  client_seq: number
  data_type: DataType
  event_type: string
  occurred_at: string
  project_id?: string | null
  view?: string | null
  target?: string | null
  action_id?: string | null
  caused_by?: string | null
  thread_id?: string | null
  message_id?: string | null
  tool_call_id?: string | null
  source_id?: string | null
  artifact_id?: string | null
  artifact_version?: number | null
  duration_ms?: number | null
  metadata: Record<string, unknown>
  content_refs: ContentRef[]
  app_version: string
  collector_version: string
  consent_version: number
  platform?: Platform | null
}

/** One row of public.research_content; the object lives at contentObjectPath(owner, sha256). */
export interface ResearchContentRow {
  sha256: string
  kind: 'whole' | 'part' | 'manifest'
  bytes: number
  stored_bytes: number
  mime?: string | null
  encoding: 'gzip' | 'identity'
  /** Manifest only: part sha256s in order. */
  parts?: string[] | null
  surface: Surface
}

/** Body of a manifest object (stored gzip-compressed JSON). */
export interface ContentManifest {
  format: typeof MANIFEST_FORMAT
  encoding: 'bytes' | 'utf8'
  bytes: number
  sha256: string
  mime?: string
  parts: Array<{ sha256: string; bytes: number }>
}

/** Local delivery state a collector keeps per event; only `delivered` counts as uploaded. */
export type DeliveryState =
  | 'captured' //        persisted locally, nothing confirmed
  | 'event_stored' //    row confirmed, some referenced content not yet confirmed
  | 'delivered' //       row and every referenced content object confirmed
  | 'rejected' //        server refused the row (4xx other than auth); quarantined and reported

export const contentObjectPath = (ownerId: string, sha256: string): string => `${ownerId}/${sha256}`

/** Byte ranges [start, end) of the parts a content of `byteLength` bytes is split into. */
export function partRanges(byteLength: number, partBytes: number = LIMITS.partBytes): Array<[number, number]> {
  if (byteLength <= partBytes) return [[0, byteLength]]
  const out: Array<[number, number]> = []
  for (let start = 0; start < byteLength; start += partBytes) out.push([start, Math.min(byteLength, start + partBytes)])
  return out
}

// ---- event catalog --------------------------------------------------------------------------

/** How an action.invoke was triggered. The action name (target) is the same for every route. */
export const ACTION_VIA = ['pointer', 'keyboard', 'shortcut', 'menu', 'touch', 'system'] as const
export type ActionVia = (typeof ACTION_VIA)[number]

type Field =
  | 'project_id' | 'view' | 'target' | 'action_id' | 'caused_by' | 'thread_id' | 'message_id'
  | 'tool_call_id' | 'source_id' | 'artifact_id' | 'artifact_version' | 'duration_ms'

export interface EventSpec {
  dataType: DataType
  /** A primary event starts an action chain: action_id must equal its own id. */
  primary?: boolean
  /** Columns that must be non-null. */
  requires?: Field[]
  /** metadata keys that must be present. */
  metadata?: string[]
  /** content_refs roles this event must carry unless the value is inline under the same key. */
  content?: string[]
}

/**
 * Every event type a v1 collector may emit. Adding a type is a minor version bump; changing the
 * meaning of an existing one is a major bump.
 */
export const EVENTS: Record<string, EventSpec> = {
  // session
  'session.start': { dataType: 'session', metadata: ['collection_mode'] },
  'session.end': { dataType: 'session', metadata: ['captured_through_seq', 'reason'] },
  'delivery.checkpoint': { dataType: 'session', metadata: ['captured_through_seq', 'pending_events', 'pending_content'] },
  'delivery.rejected': { dataType: 'session', metadata: ['rejected_event_id', 'rejected_seq', 'status'] },
  'consent.change': { dataType: 'session', metadata: ['state', 'usage', 'content'] },

  // interaction: one per user operation, whatever the input route
  'action.invoke': { dataType: 'interaction', primary: true, requires: ['target', 'view', 'action_id'], metadata: ['via'] },

  // navigation
  'view.dwell': { dataType: 'navigation', requires: ['target', 'duration_ms'] },
  'app.foreground': { dataType: 'navigation', requires: ['duration_ms'] },
  'source.page_dwell': { dataType: 'navigation', requires: ['source_id', 'duration_ms'], metadata: ['page'] },
  'scroll.settle': { dataType: 'navigation', requires: ['view'], metadata: ['position', 'direction', 'distance'] },

  // selection, annotation, layout
  'selection.commit': { dataType: 'selection_layout', requires: ['view'], metadata: ['kind'] },
  'annotation.commit': { dataType: 'selection_layout', metadata: ['annotation_id', 'op', 'anchor'] },
  'layout.commit': { dataType: 'selection_layout', requires: ['target'], metadata: ['state'] },

  // conversation
  'conversation.message': {
    dataType: 'conversation',
    requires: ['thread_id', 'message_id'],
    metadata: ['role', 'part', 'part_kind', 'status'],
    content: ['text'],
  },
  'conversation.question': {
    dataType: 'conversation',
    requires: ['thread_id', 'message_id'],
    metadata: ['question_id', 'status'],
    content: ['questions'],
  },
  'conversation.error': { dataType: 'conversation', requires: ['thread_id'], metadata: ['status'], content: ['text'] },

  // agent execution
  'agent.runtime': { dataType: 'agent_execution', metadata: ['state'] },
  'agent.recovery': { dataType: 'agent_execution', requires: ['thread_id'], metadata: ['reason'] },
  'agent.turn_start': { dataType: 'agent_execution', requires: ['thread_id'], metadata: ['model'] },
  'agent.turn_end': { dataType: 'agent_execution', requires: ['thread_id', 'duration_ms'], metadata: ['status'] },
  'agent.usage': { dataType: 'agent_execution', requires: ['thread_id', 'message_id'], metadata: ['model'] },
  'tool.start': { dataType: 'agent_execution', requires: ['thread_id', 'tool_call_id', 'target'], content: ['input'] },
  'tool.end': { dataType: 'agent_execution', requires: ['thread_id', 'tool_call_id', 'target'], metadata: ['status'], content: ['output'] },
  'permission.request': { dataType: 'agent_execution', requires: ['thread_id', 'target'], metadata: ['permission_id'] },
  'permission.decision': { dataType: 'agent_execution', requires: ['thread_id', 'target'], metadata: ['permission_id', 'reply', 'automatic'] },

  // research knowledge and artifacts
  'program.version': {
    dataType: 'knowledge_artifact',
    requires: ['artifact_id', 'artifact_version'],
    metadata: ['by'],
    content: ['program'],
  },
  'artifact.version': {
    dataType: 'knowledge_artifact',
    requires: ['artifact_id', 'artifact_version'],
    metadata: ['by'],
    content: ['file'],
  },

  // original research inputs
  'source.import': { dataType: 'source_input', requires: ['source_id'], metadata: ['provenance'], content: ['source'] },
}

// ---- prohibitions and sanitization --------------------------------------------------------

/** Continuous streams the contract forbids, whatever a client names them. Mirrors the DB check. */
export const PROHIBITED_EVENT_RE =
  /(mouse_?move|pointer_?move|pointer\.move|mouse\.move|trajectory|keystroke|key_?press|key_?down|rrweb|dom_snapshot|screen_record)/

export const isProhibitedEventType = (type: string): boolean => PROHIBITED_EVENT_RE.test(type)

/** metadata keys that are dropped whatever their value. */
export const FORBIDDEN_KEYS =
  /^(password|passwd|secret|api[_-]?key|apikey|key|token|access_?token|refresh_?token|authorization|cookie|e-?mail)$/i

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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The shared sanitizer (same rules as desktop telemetry-core scrubString). Removes the account
 * email, any email address, key/token-shaped strings (a 64-hex sha256 is kept), makes paths inside
 * `projectDir` project-relative and replaces every other absolute path with [path].
 */
export function scrubResearchString(input: string, ctx: { projectDir?: string; email?: string | null } = {}): string {
  let s = input
  if (ctx.email) s = s.replace(new RegExp(escapeRe(ctx.email), 'gi'), '[email]')
  s = s.replace(EMAIL_RE, '[email]')
  for (const re of SECRET_RES) s = s.replace(re, (value) => (/^[a-f0-9]{64}$/i.test(value) ? value : '[secret]'))
  if (ctx.projectDir) {
    const dir = ctx.projectDir.replace(/[\\/]+$/, '')
    s = s.replace(new RegExp(escapeRe(dir) + '[\\\\/]', 'g'), '').replace(new RegExp(escapeRe(dir), 'g'), '.')
  }
  return s.replace(ABS_PATH_RE, (_m, pre: string) => `${pre}[path]`)
}

/** Deep-scrubs strings and drops FORBIDDEN_KEYS. Use on metadata and on text before hashing. */
export function scrubResearchValue(value: unknown, ctx: { projectDir?: string; email?: string | null } = {}): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return scrubResearchString(value, ctx)
  if (Array.isArray(value)) return value.map((v) => scrubResearchValue(v, ctx)).filter((v) => v !== undefined)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.test(k)) continue
      const clean = scrubResearchValue(v, ctx)
      if (clean !== undefined) out[k] = clean
    }
    return out
  }
  return undefined
}

// ---- validation -----------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA256_RE = /^[0-9a-f]{64}$/
const EVENT_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$/
const ROLE_RE = /^[a-z][a-z0-9_.-]{0,39}$/
const MIME_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/
const REF_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/
const VIEW_RE = /^[A-Za-z0-9_.:/#-]{1,160}$/
const PROJECT_RE = /^[A-Za-z0-9_.:-]{8,80}$/
const INSTALL_RE = /^[A-Za-z0-9_-]{8,80}$/

const utf8Length = (s: string): number => {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++ }
    else n += 3
  }
  return n
}

export function validateContentRef(ref: unknown): string[] {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return ['content ref must be an object']
  const r = ref as Partial<ContentRef>
  const errors: string[] = []
  if (typeof r.role !== 'string' || !ROLE_RE.test(r.role)) errors.push('content ref role invalid')
  if (typeof r.sha256 !== 'string' || !SHA256_RE.test(r.sha256)) errors.push('content ref sha256 must be 64 lowercase hex')
  if (typeof r.bytes !== 'number' || !Number.isSafeInteger(r.bytes) || r.bytes < 0) errors.push('content ref bytes invalid')
  if (r.mime !== undefined && (typeof r.mime !== 'string' || !MIME_RE.test(r.mime))) errors.push('content ref mime invalid')
  return errors
}

/**
 * Checks one event against the contract. Returns a list of problems; empty means valid.
 * `now` lets callers test the future-skew rule; offline events of any age are valid.
 */
export function validateResearchEvent(input: unknown, now: number = Date.now()): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ['event must be an object']
  const e = input as Partial<ResearchEvent> & Record<string, unknown>
  const errors: string[] = []
  const need = (ok: boolean, message: string): void => {
    if (!ok) errors.push(message)
  }
  const optional = (key: string, re: RegExp): void => {
    const v = e[key]
    if (v !== undefined && v !== null) need(typeof v === 'string' && re.test(v), `${key} invalid`)
  }

  need(typeof e.id === 'string' && UUID_RE.test(e.id), 'id must be a uuid')
  need(typeof e.contract_version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(e.contract_version), 'contract_version invalid')
  need((SURFACES as readonly string[]).includes(e.surface as string), 'surface invalid')
  need(typeof e.install_id === 'string' && INSTALL_RE.test(e.install_id), 'install_id invalid')
  need(typeof e.research_session_id === 'string' && UUID_RE.test(e.research_session_id), 'research_session_id must be a uuid')
  need(typeof e.client_seq === 'number' && Number.isSafeInteger(e.client_seq) && e.client_seq >= 1, 'client_seq must be a positive integer')
  need((DATA_TYPES as readonly string[]).includes(e.data_type as string), 'data_type invalid')
  const type = typeof e.event_type === 'string' ? e.event_type : ''
  need(EVENT_TYPE_RE.test(type) && type.length <= 80, 'event_type invalid')
  need(!isProhibitedEventType(type), 'event_type is a prohibited continuous stream')
  const at = typeof e.occurred_at === 'string' ? Date.parse(e.occurred_at) : NaN
  need(Number.isFinite(at), 'occurred_at invalid')
  need(!(at > now + LIMITS.futureSkewMs), 'occurred_at is in the future')
  optional('project_id', PROJECT_RE)
  optional('view', VIEW_RE)
  optional('action_id', UUID_RE)
  optional('caused_by', UUID_RE)
  optional('thread_id', REF_ID_RE)
  optional('message_id', REF_ID_RE)
  optional('tool_call_id', REF_ID_RE)
  optional('source_id', SHA256_RE)
  if (e.target !== undefined && e.target !== null)
    need(typeof e.target === 'string' && e.target.length >= 1 && e.target.length <= LIMITS.targetChars, 'target invalid')
  if (e.artifact_id !== undefined && e.artifact_id !== null)
    need(typeof e.artifact_id === 'string' && e.artifact_id.length >= 1 && e.artifact_id.length <= 200, 'artifact_id invalid')
  if (e.artifact_version !== undefined && e.artifact_version !== null) {
    need(Number.isSafeInteger(e.artifact_version) && (e.artifact_version as number) > 0, 'artifact_version invalid')
    need(typeof e.artifact_id === 'string', 'artifact_version needs artifact_id')
  }
  if (e.duration_ms !== undefined && e.duration_ms !== null)
    need(Number.isSafeInteger(e.duration_ms) && (e.duration_ms as number) >= 0 && (e.duration_ms as number) <= 86_400_000, 'duration_ms invalid')
  const metadata = e.metadata
  const metaOk = !!metadata && typeof metadata === 'object' && !Array.isArray(metadata)
  need(metaOk, 'metadata must be an object')
  if (metaOk) need(utf8Length(JSON.stringify(metadata)) <= LIMITS.metadataBytes, 'metadata too large; move content to content_refs')
  const refs = e.content_refs
  need(Array.isArray(refs) && refs.length <= LIMITS.contentRefsPerEvent, 'content_refs must be an array of at most 64')
  if (Array.isArray(refs)) for (const r of refs) errors.push(...validateContentRef(r))
  need(typeof e.app_version === 'string' && e.app_version.length >= 1 && e.app_version.length <= 40, 'app_version invalid')
  need(typeof e.collector_version === 'string' && e.collector_version.length >= 1 && e.collector_version.length <= 60, 'collector_version invalid')
  need(Number.isSafeInteger(e.consent_version) && (e.consent_version as number) > 0, 'consent_version invalid')
  if (e.platform !== undefined && e.platform !== null) need((PLATFORMS as readonly string[]).includes(e.platform), 'platform invalid')

  const spec = EVENTS[type]
  if (!spec) {
    errors.push(`event_type ${type || '(empty)'} is not in contract ${CONTRACT_VERSION}`)
    return errors
  }
  need(e.data_type === spec.dataType, `${type} belongs to data_type ${spec.dataType}`)
  if (spec.primary) need(e.action_id === e.id, `${type} is a primary action: action_id must equal id`)
  for (const field of spec.requires ?? []) need(e[field] !== undefined && e[field] !== null, `${type} requires ${field}`)
  if (metaOk) {
    const m = metadata as Record<string, unknown>
    for (const key of spec.metadata ?? []) need(key in m, `${type} requires metadata.${key}`)
    if (type === 'action.invoke') need((ACTION_VIA as readonly string[]).includes(m.via as string), 'action.invoke metadata.via invalid')
    const roles = new Set(Array.isArray(refs) ? refs.map((r) => (r as ContentRef)?.role) : [])
    for (const role of spec.content ?? []) {
      // Inline is allowed for short text; otherwise the role must be referenced. A tool that
      // produced no output, or a message part without text, records `<role>_absent: true`.
      const inline = typeof m[role] === 'string' && utf8Length(m[role] as string) <= LIMITS.inlineTextBytes
      need(inline || roles.has(role) || m[`${role}_absent`] === true, `${type} needs ${role} inline (<= 8 KiB) or as a content ref`)
    }
  }
  for (const [key, value] of Object.entries(metaOk ? (metadata as Record<string, unknown>) : {})) {
    if (FORBIDDEN_KEYS.test(key)) errors.push(`metadata.${key} is a forbidden key`)
    if (typeof value === 'string' && utf8Length(value) > LIMITS.inlineTextBytes) errors.push(`metadata.${key} exceeds the inline limit; use a content ref`)
  }
  return errors
}
