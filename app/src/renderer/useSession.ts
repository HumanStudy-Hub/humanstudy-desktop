import { useCallback, useEffect, useRef, useState } from 'react'
import { lap, track } from './telemetry'
import type { KernelEvent, KernelUsage, PermissionReply, Thread, ThreadMessage, ThreadSummary } from '../preload/types'

export interface PermissionPart {
  kind: 'permission'
  id: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  /** Absent while the agent is waiting for an answer. */
  resolved?: PermissionReply
  /** The turn ended (or the thread was reopened) before an answer: the request is gone. */
  expired?: boolean
}
export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; detail?: string; state?: string; input?: unknown; output?: string; at?: number; endedAt?: number }
  | { kind: 'error'; text: string }
  | PermissionPart

export interface SessionUsage {
  input: number
  output: number
  reasoning: number
  cost: number
}

export interface Message {
  id: number
  role: 'user' | 'assistant'
  parts: Part[]
  /** ms since the epoch the message started and its last event arrived; only live turns have an end. */
  at?: number
  endedAt?: number
}

export interface Session {
  id: string | null
  messages: Message[]
  busy: boolean
  status: string
  error: string | null
  /** Messages waiting for the current turn to finish; sent in order after `done`. */
  queue: QueuedMessage[]
  send(text: string): void
  /** Adds a message to the queue (sent automatically after the running turn). */
  enqueue(text: string): void
  editQueued(id: number, text: string): void
  removeQueued(id: number): void
  /** Aborts the running turn, then sends the message. */
  interruptAndSend(text: string): void
  abort(): void
  /** Answer a pending permission card. */
  reply(permissionId: string, response: PermissionReply): void
  /** True while a permission card waits for an answer. */
  waitingForPermission: boolean
  threadId: string | null
  threads: ThreadSummary[]
  usage: SessionUsage
  /** The kernel session was lost; the stored transcript is sent as context with the next message. */
  resumedWithContext: boolean
  newThread(): void
  openThread(id: string): void
  renameThread(id: string, title: string): void
  deleteThread(id: string): void
}

export interface QueuedMessage {
  id: number
  text: string
}

let nextId = 1

/** `enabled` is false until the user has hosted model access and the research agreement; no kernel session starts before. */
export function useSession(projectDir: string | null, enabled = true): Session {
  const [id, setId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [usage, setUsage] = useState<SessionUsage>(ZERO)
  const [resumed, setResumed] = useState(false)
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages
  const idRef = useRef<string | null>(null)
  const threadRef = useRef<string | null>(null)
  const dirRef = useRef<string | null>(null)
  dirRef.current = projectDir
  const busyRef = useRef(false)
  const queueRef = useRef<QueuedMessage[]>([])
  const sendRef = useRef<(text: string) => void>(() => undefined)
  const setBusyBoth = (v: boolean) => {
    busyRef.current = v
    setBusy(v)
  }
  const setQueueBoth = (fn: (q: QueuedMessage[]) => QueuedMessage[]) => {
    queueRef.current = fn(queueRef.current)
    setQueue(queueRef.current)
  }

  /** Make `t` (with a live kernel session) the open conversation. */
  const activate = useCallback((t: Thread) => {
    idRef.current = t.kernelSessionId
    threadRef.current = t.id
    setId(t.kernelSessionId)
    setThreadId(t.id)
    setMessages(t.messages.map(fromStored))
    setUsage({ input: t.usage.input, output: t.usage.output, reasoning: 0, cost: t.usage.cost })
    setResumed(Boolean(t.resumedWithContext))
    setQueueBoth(() => [])
    setBusyBoth(false)
    setError(null)
    setStatus('')
  }, [])
  const refreshThreads = useCallback(async () => {
    const dir = dirRef.current
    if (!dir) return
    const list = await window.humanstudy.threads.list(dir).catch(() => [] as ThreadSummary[])
    if (dirRef.current !== dir) return
    setThreads(list)
    // The stored total is authoritative; live usage events only fill the gap until it lands.
    const cur = list.find((x) => x.id === threadRef.current)
    if (cur) setUsage((u) => ({ ...u, input: cur.usage.input, output: cur.usage.output, cost: cur.usage.cost }))
  }, [])

  useEffect(() => {
    setQueueBoth(() => [])
    setId(null)
    setThreadId(null)
    setThreads([])
    idRef.current = null
    threadRef.current = null
    setMessages([])
    setUsage(ZERO)
    setResumed(false)
    setBusyBoth(false)
    setError(null)
    if (!projectDir || !enabled) return
    let live = true
    setStatus('Starting agent…')
    ;(async () => {
      const { threads: api } = window.humanstudy
      const list = await api.list(projectDir).catch(() => [] as ThreadSummary[])
      const t = list[0] ? await api.resume(projectDir, list[0].id) : await api.create(projectDir)
      if (!live) return
      setThreads(list)
      activate(t)
    })().catch((e: unknown) => live && (setStatus(''), setError(String(e))))
    return () => {
      live = false
    }
  }, [projectDir, enabled, activate])

  useEffect(
    () =>
      window.humanstudy.threads.onChanged((e) => {
        if (e.dir === dirRef.current) void refreshThreads()
      }),
    [refreshThreads],
  )

  useEffect(
    () =>
      window.humanstudy.kernel.onEvent((e: KernelEvent) => {
        if (e.sessionId !== idRef.current) return
        if (e.type === 'status') return setStatus(e.text ?? e.detail ?? '')
        if (e.type === 'done') {
          // A turn that was stopped by hand has already cleared busy; its queue waits for the user.
          const wasRunning = busyRef.current
          setBusyBoth(false)
          setStatus('')
          setMessages((ms) => expirePermissions(ms))
          const next = queueRef.current[0]
          if (wasRunning && next) {
            setQueueBoth((q) => q.slice(1))
            sendRef.current(next.text)
          }
          return
        }
        if (e.type === 'usage') {
          const u: KernelUsage | undefined = e.usage
          if (u)
            setUsage((p) => ({ input: p.input + u.input, output: p.output + u.output, reasoning: p.reasoning + (u.reasoning ?? 0), cost: p.cost + (u.cost ?? 0) }))
          return
        }
        if (e.type === 'title') return void refreshThreads()
        setMessages((ms) => appendEvent(ms, e))
        if (e.type === 'error') setBusyBoth(false)
      }),
    [refreshThreads],
  )

  const send = useCallback((text: string) => {
    const sid = idRef.current
    if (!sid || !text.trim()) return
    setMessages((ms) => [...ms, { id: nextId++, role: 'user', parts: [{ kind: 'text', text }], at: Date.now() }])
    setBusyBoth(true)
    setStatus('Thinking…')
    window.humanstudy.kernel.send(sid, text).catch((e: unknown) => {
      setMessages((ms) => appendEvent(ms, { sessionId: sid, type: 'error', text: String(e) }))
      setBusyBoth(false)
    })
  }, [])
  sendRef.current = send

  const abort = useCallback(() => {
    busyRef.current = false
    if (idRef.current) void window.humanstudy.kernel.abort(idRef.current)
    setBusy(false)
    setStatus('')
  }, [])

  const enqueue = useCallback((text: string) => {
    if (!text.trim()) return
    setQueueBoth((q) => [...q, { id: nextId++, text }])
  }, [])
  const editQueued = useCallback((qid: number, text: string) => {
    setQueueBoth((q) => q.map((m) => (m.id === qid ? { ...m, text } : m)))
  }, [])
  const removeQueued = useCallback((qid: number) => {
    setQueueBoth((q) => q.filter((m) => m.id !== qid))
  }, [])
  const interruptAndSend = useCallback(
    (text: string) => {
      const sid = idRef.current
      if (!sid) return
      busyRef.current = false
      // Wait for the abort to be acknowledged so its `done` cannot end the new turn.
      void window.humanstudy.kernel
        .abort(sid)
        .catch(() => undefined)
        .then(() => sendRef.current(text))
    },
    [],
  )

  const reply = useCallback((permissionId: string, response: PermissionReply) => {
    const sid = idRef.current
    if (!sid) return
    const asked = messagesRef.current.flatMap((m) => m.parts).find((x) => x.kind === 'permission' && x.id === permissionId)
    track('permission.reply', { target: asked?.kind === 'permission' ? asked.type : undefined, metadata: { type: asked?.kind === 'permission' ? asked.type : null, reply: response } })
    // Collapse the card at once; the follow-up event with `resolved` is idempotent.
    setMessages((ms) => resolvePermission(ms, permissionId, response))
    window.humanstudy.kernel.reply(sid, permissionId, response).catch((e: unknown) => {
      setMessages((ms) => appendEvent(ms, { sessionId: sid, type: 'error', text: `Could not answer the permission request: ${String(e)}` }))
    })
  }, [])

  const newThread = useCallback(() => {
    const dir = dirRef.current
    if (!dir) return
    // An empty conversation is already a new thread.
    if (!messages.length && idRef.current) return
    track('thread.switch', { target: 'new', durationMs: lap('thread'), metadata: { from: threadRef.current ? 'thread' : null } })
    window.humanstudy.threads.create(dir).then((t) => dirRef.current === dir && activate(t)).catch((e: unknown) => setError(String(e)))
  }, [messages.length, activate])
  const openThread = useCallback(
    (tid: string) => {
      const dir = dirRef.current
      if (!dir || tid === threadRef.current) return
      track('thread.switch', { target: 'existing', durationMs: lap('thread'), metadata: { messages: messagesRef.current.length } })
      window.humanstudy.threads.resume(dir, tid).then((t) => dirRef.current === dir && activate(t)).catch((e: unknown) => setError(String(e)))
    },
    [activate],
  )
  const renameThread = useCallback((tid: string, title: string) => {
    const dir = dirRef.current
    if (dir && title.trim()) void window.humanstudy.threads.rename(dir, tid, title.trim())
  }, [])
  const deleteThread = useCallback(
    (tid: string) => {
      const dir = dirRef.current
      if (!dir) return
      void window.humanstudy.threads.delete(dir, tid).then(async () => {
        if (tid !== threadRef.current) return
        const rest = (await window.humanstudy.threads.list(dir)).filter((x) => x.id !== tid)
        const t = rest[0] ? await window.humanstudy.threads.resume(dir, rest[0].id) : await window.humanstudy.threads.create(dir)
        if (dirRef.current === dir) activate(t)
      })
    },
    [activate],
  )

  const waitingForPermission = messages.some((m) => m.parts.some((p) => p.kind === 'permission' && !p.resolved && !p.expired))

  return {
    id, messages, busy, status, error, queue, send, enqueue, editQueued, removeQueued, interruptAndSend, abort,
    reply, waitingForPermission, threadId, threads, usage, resumedWithContext: resumed, newThread, openThread, renameThread, deleteThread,
  }
}
const ZERO: SessionUsage = { input: 0, output: 0, reasoning: 0, cost: 0 }

function fromStored(m: ThreadMessage): Message {
  return {
    id: nextId++,
    role: m.role,
    parts: m.parts.map((p): Part =>
      p.kind === 'permission' ? { kind: 'permission', id: p.id, type: p.type, title: p.title, resolved: p.resolved, expired: !p.resolved } : p,
    ),
    at: Date.parse(m.at) || undefined,
  }
}

function mapPermission(ms: Message[], id: string, fn: (p: PermissionPart) => PermissionPart): Message[] {
  return ms.map((m) =>
    m.parts.some((p) => p.kind === 'permission' && p.id === id)
      ? { ...m, parts: m.parts.map((p) => (p.kind === 'permission' && p.id === id ? fn(p) : p)) }
      : m,
  )
}
const resolvePermission = (ms: Message[], id: string, resolved: PermissionReply) => mapPermission(ms, id, (p) => ({ ...p, resolved: p.resolved ?? resolved }))
const expirePermissions = (ms: Message[]): Message[] =>
  ms.some((m) => m.parts.some((p) => p.kind === 'permission' && !p.resolved && !p.expired))
    ? ms.map((m) => ({ ...m, parts: m.parts.map((p) => (p.kind === 'permission' && !p.resolved ? { ...p, expired: true } : p)) }))
    : ms

function appendEvent(ms: Message[], e: KernelEvent): Message[] {
  const last = ms[ms.length - 1]
  const msg: Message =
    last && last.role === 'assistant'
      ? { ...last, parts: [...last.parts], endedAt: Date.now() }
      : { id: nextId++, role: 'assistant', parts: [], at: Date.now(), endedAt: Date.now() }
  const tail = msg.parts[msg.parts.length - 1]
  if (e.type === 'text') {
    if (tail?.kind === 'text') msg.parts[msg.parts.length - 1] = { kind: 'text', text: tail.text + (e.text ?? '') }
    else msg.parts.push({ kind: 'text', text: e.text ?? '' })
  } else if (e.type === 'tool') {
    // A tool call reports running -> completed; update the open part instead of listing it twice.
    // A permission card may sit between the tool's pending and running events; look past it.
    let at = msg.parts.length - 1
    while (at >= 0 && msg.parts[at].kind === 'permission') at--
    const open = msg.parts[at]
    const detail = e.detail && e.detail !== '{}' ? e.detail : undefined // '{}' = input not streamed yet
    if (open?.kind === 'tool' && open.tool === (e.tool ?? 'tool') && (open.state === 'pending' || open.state === 'running'))
      msg.parts[at] = { ...open, detail: detail ?? open.detail, state: e.text, input: e.input ?? open.input, output: e.output ?? open.output, endedAt: Date.now() }
    else msg.parts.push({ kind: 'tool', tool: e.tool ?? 'tool', detail, state: e.text, input: e.input, output: e.output, at: Date.now(), endedAt: Date.now() })
  } else if (e.type === 'permission' && e.permission) {
    const pe = e.permission
    const at = msg.parts.findIndex((x) => x.kind === 'permission' && x.id === pe.id)
    const prev = at >= 0 ? (msg.parts[at] as PermissionPart) : null
    // The follow-up (possibly twice) only adds `resolved`; keep what the first event told us.
    const merged: PermissionPart = {
      kind: 'permission',
      id: pe.id,
      type: prev?.type || pe.type,
      title: pe.title ?? prev?.title,
      metadata: pe.metadata ?? prev?.metadata,
      resolved: pe.resolved ?? prev?.resolved,
    }
    if (at >= 0) msg.parts[at] = merged
    else msg.parts.push(merged)
  } else if (e.type === 'error') {
    msg.parts.push({ kind: 'error', text: e.text ?? e.detail ?? 'Unknown error' })
  }
  return msg === last ? ms : last && last.role === 'assistant' ? [...ms.slice(0, -1), msg] : [...ms, msg]
}
