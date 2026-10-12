// Conversation threads, stored per project in <project>/.humanstudy/threads/<threadId>.json.
//
// Electron-free (the kernel is injected as a `ThreadHost`) so it is unit-tested with the mock kernel:
// src/main/threads.test.mjs. src/main/threads.ts wires it to IPC.
//
// The main process, not the renderer, records the conversation: user messages come from
// `kernel:send`, assistant messages from kernel events. `appendEvent` is the same part-merging as the
// renderer's useSession.ts, plus permission parts and merging of a tool's pending/running/completed
// events into one part.
import { mkdir, readFile, readdir, rename as fsRename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  KernelEvent,
  Thread,
  ThreadMessage,
  ThreadPart,
  ThreadSummary,
  ThreadUsage,
} from '../preload/types'

export const DEFAULT_TITLE = 'New thread'
const TITLE_MAX = 60
const CONTEXT_CHARS = 16_000

export interface ThreadHost {
  /** Name of the kernel that would run a new session ("opencode" | "mock"). */
  kernelName(): string
  start(dir: string): Promise<string>
  /** Session id when the kernel still has the session, else null. */
  resume(dir: string, kernelSessionId: string): Promise<string | null>
}

/** What the research-data layer sees: every part once it is final, and per-message usage. */
export type Capture =
  | {
      kind: 'part'
      dir: string
      threadId: string
      messageId: string
      role: 'user' | 'assistant'
      index: number
      part: ThreadPart
      at: string
      /** Permission parts only: the turn ended while the request was still unanswered. */
      unresolved?: boolean
    }
  | { kind: 'usage'; dir: string; threadId: string; messageId?: string; usage: { input: number; output: number; reasoning?: number; cost?: number } }

export interface ThreadsOptions {
  /** Called for every final part and usage; must never throw into the transcript (errors are swallowed). */
  onCapture?: (c: Capture) => void
  now?: () => string
  newId?: (prefix: string) => string
  /** Delay before streamed text is written to disk (default 500 ms; done/error flush at once). */
  saveDelayMs?: number
}

// ---- pure helpers -----------------------------------------------------------------------

const defaultNewId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/** First user message -> thread title: whitespace collapsed, at most 60 characters. */
export function autoTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX - 1).trimEnd() + '…' : t || DEFAULT_TITLE
}

/**
 * Fold one kernel event into a message list (returns a new list; inputs are not mutated).
 * text: appended to the trailing text part. tool: one part per tool step - a following event of the
 * same tool right after it (pending -> running -> completed) updates that part instead of adding one.
 * permission: one part per request id; the `resolved` follow-up fills it in. error: its own part.
 * status/done/usage/title do not touch the transcript.
 */
export function appendEvent(
  ms: ThreadMessage[],
  e: KernelEvent,
  now: () => string = () => new Date().toISOString(),
  newId: (prefix: string) => string = defaultNewId
): ThreadMessage[] {
  if (e.type !== 'text' && e.type !== 'tool' && e.type !== 'error' && e.type !== 'permission') return ms
  const last = ms[ms.length - 1]
  const fresh = !last || last.role !== 'assistant'
  const msg: ThreadMessage = fresh
    ? { id: newId('m'), role: 'assistant', parts: [], at: now() }
    : { ...last, parts: [...last.parts] }
  const parts = msg.parts
  const tail = parts[parts.length - 1]

  if (e.type === 'text') {
    if (tail?.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: tail.text + (e.text ?? '') }
    else parts.push({ kind: 'text', text: e.text ?? '' })
  } else if (e.type === 'tool') {
    const name = e.tool ?? 'tool'
    const detail = e.detail && e.detail !== '{}' ? e.detail : undefined
    // A permission card may sit between the tool's pending and running events; look past it.
    let at = parts.length - 1
    while (at >= 0 && parts[at].kind === 'permission') at--
    const open = parts[at]
    if (open?.kind === 'tool' && open.tool === name && (open.state === 'pending' || open.state === 'running')) {
      const tail = open
      parts[at] = withIO({ kind: 'tool', tool: name, detail: detail ?? tail.detail, state: e.text }, e.input ?? tail.input, e.output ?? tail.output)
    } else {
      parts.push(withIO({ kind: 'tool', tool: name, detail: detail ?? undefined, state: e.text }, e.input, e.output))
    }
  } else if (e.type === 'error') {
    parts.push({ kind: 'error', text: e.text ?? e.detail ?? 'Unknown error' })
  } else {
    const perm = e.permission
    if (!perm) return ms
    const own = parts.findIndex((p) => p.kind === 'permission' && p.id === perm.id)
    if (own >= 0) {
      const p = parts[own] as Extract<ThreadPart, { kind: 'permission' }>
      if (!perm.resolved || p.resolved) return ms
      parts[own] = { ...p, resolved: perm.resolved }
      return fresh ? [...ms, msg] : replaceLast(ms, msg)
    }
    // The follow-up can arrive after the next message started: look a few messages back.
    for (let i = ms.length - 1; i >= 0 && i >= ms.length - 4; i--) {
      const j = ms[i].parts.findIndex((p) => p.kind === 'permission' && p.id === perm.id)
      if (j < 0) continue
      const p = ms[i].parts[j] as Extract<ThreadPart, { kind: 'permission' }>
      if (!perm.resolved || p.resolved) return ms
      const np = [...ms[i].parts]
      np[j] = { ...p, resolved: perm.resolved }
      return ms.map((m, k) => (k === i ? { ...m, parts: np } : m))
    }
    // Unknown id: a bare "resolved" follow-up for a request we never saw has nothing to update.
    if (!perm.type && perm.resolved) return ms
    const part: ThreadPart = {
      kind: 'permission',
      id: perm.id,
      type: perm.type,
      title: perm.title,
      patterns: perm.patterns,
      ...(perm.resolved ? { resolved: perm.resolved } : {}),
    }
    parts.push(part)
  }
  return fresh ? [...ms, msg] : replaceLast(ms, msg)
}

/** Adds the full tool input/output to a tool part when present (the research transcript needs them). */
function withIO(part: Extract<ThreadPart, { kind: 'tool' }>, input: unknown, output: string | undefined): ThreadPart {
  if (input !== undefined) part.input = input
  if (output !== undefined) part.output = output
  return part
}

function replaceLast(ms: ThreadMessage[], msg: ThreadMessage): ThreadMessage[] {
  return [...ms.slice(0, -1), msg]
}

export function addUsage(total: ThreadUsage, u: { input: number; output: number; cost?: number }): ThreadUsage {
  return {
    input: total.input + (u.input || 0),
    output: total.output + (u.output || 0),
    cost: total.cost + (u.cost || 0),
  }
}

/** Plain-text transcript of earlier messages, newest kept when it has to be cut. */
export function transcript(ms: ThreadMessage[], maxChars = CONTEXT_CHARS): string {
  const lines: string[] = []
  for (const m of ms) {
    const who = m.role === 'user' ? 'User' : 'Assistant'
    const body = m.parts
      .map((p) => {
        if (p.kind === 'text') return p.text.trim()
        if (p.kind === 'tool') return `[${p.tool}${p.detail ? ': ' + p.detail.slice(0, 120) : ''}]`
        if (p.kind === 'permission') return `[asked permission for ${p.type}${p.resolved ? ', answered ' + p.resolved : ''}]`
        return ''
      })
      .filter(Boolean)
      .join('\n')
    if (body) lines.push(`${who}: ${body}`)
  }
  let out = lines.join('\n\n')
  if (out.length > maxChars) out = '[earlier messages omitted]\n\n' + out.slice(out.length - maxChars)
  return out
}

/** First prompt of a session that replaces a lost one: prior transcript as context, then the new message. */
export function contextPrompt(prior: ThreadMessage[], text: string): string {
  const t = transcript(prior)
  if (!t) return text
  return (
    'This conversation continues an earlier one in this project whose agent session is no longer ' +
    'available. The transcript so far is between the markers; use it as context and do not repeat ' +
    'work that is already done.\n\n<transcript>\n' +
    t +
    '\n</transcript>\n\nThe user\'s new message:\n\n' +
    text
  )
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

export const threadsDir = (project: string): string => join(project, '.humanstudy', 'threads')

function normalize(raw: unknown, id: string): Thread {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)
  const u = (o.usage && typeof o.usage === 'object' ? o.usage : {}) as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const created = str(o.createdAt, new Date(0).toISOString())
  const t: Thread = {
    id,
    title: str(o.title, DEFAULT_TITLE),
    createdAt: created,
    updatedAt: str(o.updatedAt, created),
    kernel: str(o.kernel, ''),
    kernelSessionId: str(o.kernelSessionId, ''),
    messages: Array.isArray(o.messages) ? (o.messages as ThreadMessage[]) : [],
    usage: { input: num(u.input), output: num(u.output), cost: num(u.cost) },
  }
  if (o.resumedWithContext === true) t.resumedWithContext = true
  if (o.titleSource === 'auto' || o.titleSource === 'kernel' || o.titleSource === 'user') t.titleSource = o.titleSource
  return t
}

// ---- manager ----------------------------------------------------------------------------

interface Bound {
  dir: string
  thread: Thread
}

export class ThreadManager {
  private live = new Map<string, Thread>() // dir\0id -> in-memory copy of threads in use
  private bySession = new Map<string, Bound>()
  private needsContext = new Set<string>() // kernel session ids whose next prompt carries the transcript
  private timers = new Map<string, NodeJS.Timeout>()
  private writes = new Map<string, Promise<void>>()
  private now: () => string
  private newId: (prefix: string) => string
  private saveDelay: number
  private onCapture?: (c: Capture) => void
  private captured = new Set<string>()

  constructor(
    private host: ThreadHost,
    private notify: (e: { dir: string; id: string }) => void,
    opts: ThreadsOptions = {}
  ) {
    this.now = opts.now ?? ((): string => new Date().toISOString())
    this.newId = opts.newId ?? defaultNewId
    this.saveDelay = opts.saveDelayMs ?? 500
    this.onCapture = opts.onCapture
  }

  // ---- public API (IPC) ----

  async list(dir: string): Promise<ThreadSummary[]> {
    const folder = threadsDir(dir)
    let names: string[] = []
    try {
      names = await readdir(folder)
    } catch {
      /* no threads yet */
    }
    const out: ThreadSummary[] = []
    for (const n of names) {
      if (!n.endsWith('.json')) continue
      const id = n.slice(0, -5)
      if (!ID_RE.test(id)) continue
      const t = await this.load(dir, id).catch(() => null)
      if (!t || t.messages.length === 0) continue
      out.push({
        id,
        title: t.title,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        messageCount: t.messages.length,
        usage: t.usage,
      })
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
  }

  async get(dir: string, id: string): Promise<Thread> {
    return clone(await this.load(dir, id))
  }

  async create(dir: string): Promise<Thread> {
    const sid = await this.host.start(dir)
    const at = this.now()
    const t: Thread = {
      id: this.newId('thr'),
      title: DEFAULT_TITLE,
      createdAt: at,
      updatedAt: at,
      kernel: this.host.kernelName(),
      kernelSessionId: sid,
      messages: [],
      usage: { input: 0, output: 0, cost: 0 },
    }
    this.bind(dir, t)
    return clone(t) // saved with its first message
  }

  /** For callers that start a kernel session themselves (kernel:startSession): track it as a thread. */
  adopt(dir: string, kernelSessionId: string): Thread {
    const at = this.now()
    const t: Thread = {
      id: this.newId('thr'),
      title: DEFAULT_TITLE,
      createdAt: at,
      updatedAt: at,
      kernel: this.host.kernelName(),
      kernelSessionId,
      messages: [],
      usage: { input: 0, output: 0, cost: 0 },
    }
    this.bind(dir, t)
    return clone(t)
  }

  async resume(dir: string, id: string): Promise<Thread> {
    const t = await this.load(dir, id)
    let sid: string | null = null
    if (t.kernelSessionId) sid = await this.host.resume(dir, t.kernelSessionId).catch(() => null)
    if (!sid) {
      sid = await this.host.start(dir)
      if (t.messages.length > 0) {
        t.resumedWithContext = true
        this.needsContext.add(sid)
      }
    }
    this.bySession.delete(t.kernelSessionId)
    t.kernelSessionId = sid
    t.kernel = this.host.kernelName()
    this.bind(dir, t)
    if (t.messages.length > 0) void this.write(keyOf(dir, t.id), dir, t)
    return clone(t)
  }

  async rename(dir: string, id: string, title: string): Promise<void> {
    const t = await this.load(dir, id)
    const next = title.replace(/\s+/g, ' ').trim().slice(0, 120)
    if (!next) throw new Error('title is empty')
    t.title = next
    t.titleSource = 'user'
    this.persist(dir, t, true)
  }

  async delete(dir: string, id: string): Promise<void> {
    if (!ID_RE.test(id)) throw new Error('bad thread id')
    const key = keyOf(dir, id)
    const t = this.live.get(key)
    if (t) this.bySession.delete(t.kernelSessionId)
    this.live.delete(key)
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    await (this.writes.get(key) ?? Promise.resolve())
    await unlink(join(threadsDir(dir), id + '.json')).catch(() => undefined)
    this.notify({ dir, id })
  }

  // ---- fed by the main process ----

  /** Record the user's message; returns the text to actually send to the kernel. */
  beforeSend(sessionId: string, text: string): string {
    const b = this.bySession.get(sessionId)
    if (!b) return text
    const t = b.thread
    const prior = t.messages
    let prompt = text
    if (this.needsContext.delete(sessionId)) prompt = contextPrompt(prior, text)
    const at = this.now()
    const user: ThreadMessage = { id: this.newId('m'), role: 'user', parts: [{ kind: 'text', text }], at }
    t.messages = [...prior, user]
    this.emitCapture({ kind: 'part', dir: b.dir, threadId: t.id, messageId: user.id, role: 'user', index: 0, part: user.parts[0], at })
    this.captured.add(`${t.id}:${user.id}:0`)
    if (!t.titleSource && t.title === DEFAULT_TITLE) {
      t.title = autoTitle(text)
      t.titleSource = 'auto'
    }
    this.persist(b.dir, t, true)
    return prompt
  }

  onEvent(e: KernelEvent): void {
    const b = this.bySession.get(e.sessionId)
    if (!b) return
    this.apply(e, b)
    if (!this.onCapture) return
    if (e.type === 'usage' && e.usage) {
      const last = b.thread.messages[b.thread.messages.length - 1]
      this.emitCapture({ kind: 'usage', dir: b.dir, threadId: b.thread.id, messageId: last?.role === 'assistant' ? last.id : undefined, usage: e.usage })
    } else if (['text', 'tool', 'error', 'permission', 'done'].includes(e.type) || (e.type === 'status' && e.text === 'aborted')) {
      this.capture(b, e.type === 'done' || e.type === 'status')
    }
  }

  private emitCapture(c: Capture): void {
    try {
      this.onCapture?.(c)
    } catch {
      /* research data must never break the transcript */
    }
  }

  /** Emits each part of the recent assistant messages once it is final (see Capture). */
  private capture(b: Bound, endOfTurn: boolean): void {
    const t = b.thread
    const ms = t.messages
    for (let mi = Math.max(0, ms.length - 4); mi < ms.length; mi++) {
      const m = ms[mi]
      if (m.role !== 'assistant') continue
      const settled = endOfTurn || mi < ms.length - 1
      m.parts.forEach((p, i) => {
        const final =
          p.kind === 'error' ||
          settled ||
          (p.kind === 'text' && i < m.parts.length - 1) ||
          (p.kind === 'tool' && (p.state === 'completed' || p.state === 'error')) ||
          (p.kind === 'permission' && Boolean(p.resolved))
        if (!final) return
        const key = `${t.id}:${m.id}:${i}` + (p.kind === 'permission' ? (p.resolved ? ':r' : ':u') : '')
        if (this.captured.has(key)) return
        this.captured.add(key)
        if (p.kind === 'text' && !p.text.trim()) return
        this.emitCapture({
          kind: 'part', dir: b.dir, threadId: t.id, messageId: m.id, role: 'assistant', index: i, part: p, at: m.at,
          ...(p.kind === 'permission' && !p.resolved ? { unresolved: true } : {}),
        })
      })
    }
  }

  private apply(e: KernelEvent, b: Bound): void {
    const t = b.thread
    if (e.type === 'title') {
      const title = (e.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
      if (!title || t.titleSource === 'user') return
      t.title = title
      t.titleSource = 'kernel'
      return this.persist(b.dir, t, true)
    }
    if (e.type === 'usage') {
      if (!e.usage) return
      t.usage = addUsage(t.usage, e.usage)
      return this.persist(b.dir, t, false)
    }
    if (e.type === 'done') return this.persist(b.dir, t, true)
    const next = appendEvent(t.messages, e, this.now, this.newId)
    if (next === t.messages) return
    t.messages = next
    this.persist(b.dir, t, e.type !== 'text')
  }

  /** Write everything pending (before quit). */
  async flush(): Promise<void> {
    for (const [key, timer] of this.timers) {
      clearTimeout(timer)
      this.timers.delete(key)
      const t = this.live.get(key)
      if (t) await this.write(key, dirOf(key), t)
    }
    await Promise.all([...this.writes.values()])
  }

  // ---- internals ----

  private bind(dir: string, t: Thread): void {
    // Parts that already exist were captured (or deliberately not) in an earlier run.
    t.messages.forEach((m) =>
      m.parts.forEach((p, i) => this.captured.add(`${t.id}:${m.id}:${i}` + (p.kind === 'permission' ? (p.resolved ? ':r' : ':u') : '')))
    )
    this.live.set(keyOf(dir, t.id), t)
    this.bySession.set(t.kernelSessionId, { dir, thread: t })
  }

  private async load(dir: string, id: string): Promise<Thread> {
    if (!ID_RE.test(id)) throw new Error('bad thread id')
    const live = this.live.get(keyOf(dir, id))
    if (live) return live
    const raw = JSON.parse(await readFile(join(threadsDir(dir), id + '.json'), 'utf8')) as unknown
    return normalize(raw, id)
  }

  /** Update `updatedAt`, write now or after a short delay, tell the renderer. Empty threads stay in memory. */
  private persist(dir: string, t: Thread, immediately: boolean): void {
    t.updatedAt = this.now()
    this.live.set(keyOf(dir, t.id), t)
    const key = keyOf(dir, t.id)
    if (t.messages.length === 0) return
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    if (immediately) void this.write(key, dir, t)
    else {
      const timer = setTimeout(() => {
        this.timers.delete(key)
        void this.write(key, dir, t)
      }, this.saveDelay)
      timer.unref?.()
      this.timers.set(key, timer)
    }
  }

  private write(key: string, dir: string, t: Thread): Promise<void> {
    const prev = this.writes.get(key) ?? Promise.resolve()
    const next = prev
      .then(async () => {
        const folder = threadsDir(dir)
        await mkdir(folder, { recursive: true })
        const file = join(folder, t.id + '.json')
        const tmp = file + '.tmp'
        await writeFile(tmp, JSON.stringify(t, null, 2), 'utf8')
        await fsRename(tmp, file)
        this.notify({ dir, id: t.id })
      })
      .catch((err) => console.error('threads: could not save', err))
    this.writes.set(key, next)
    return next
  }
}

const keyOf = (dir: string, id: string): string => `${dir}\0${id}`
const dirOf = (key: string): string => key.slice(0, key.indexOf('\0'))
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
