import { NATIVE_TURNS, NATIVE_SESSION_MUTATIONS, type NativeRequest } from '../shared/native'
import { createTextBatcher } from './text-batcher'
import { updateQuestion, type QuestionPart } from '../shared/question'
import { useCallback, useEffect, useRef, useState } from 'react'
import { claimAction, lap, track } from './telemetry'
import type { ActionRef, KernelEvent, KernelUsage, PermissionReply, Thread, ThreadMessage, ThreadSummary, WorkspaceContext } from '../preload/types'

export interface PermissionPart {
  automatic?: boolean
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
  | { kind: 'reasoning'; text: string }
  | { kind: 'native'; type: string; data: unknown }
  | { kind: 'tool'; tool: string; detail?: string; state?: string; input?: unknown; output?: string; at?: number; endedAt?: number }
  | { kind: 'error'; text: string }
  | QuestionPart
  | PermissionPart

export interface SessionUsage {
  input: number
  output: number
  reasoning: number
  cost: number
}

export interface Message {
  nativeId?: string
  workspace?: WorkspaceContext
  id: number
  role: 'user' | 'assistant'
  parts: Part[]
  /** ms since the epoch the message started and its last event arrived; only live turns have an end. */
  at?: number
  endedAt?: number
}

export interface Session {
  id: string | null
  /** Sends `prompt` when the project has a pending paper build that this conversation could claim. */
  startPaperBuild(prompt: string): Promise<void>
  messages: Message[]
  busy: boolean
  status: string
  error: string | null
  /** Messages waiting for the current turn to finish; sent in order after `done`. */
  queue: QueuedMessage[]
  send(text: string, workspace?: WorkspaceContext, action?: ActionRef): void
  /** Adds a message to the queue (sent automatically after the running turn). */
  enqueue(text: string, workspace?: WorkspaceContext): void
  editQueued(id: number, text: string): void
  removeQueued(id: number): void
  /** Aborts the running turn, then sends the message. */
  interruptAndSend(text: string, workspace?: WorkspaceContext): void
  abort(): void
  /** Answer a pending permission card. */
  reply(permissionId: string, response: PermissionReply): void
  /** True while a permission card waits for an answer. */
  waitingForPermission: boolean
  waitingForQuestion: boolean
  answerQuestion(id: string, answers: string[][]): Promise<void>
  rejectQuestion(id: string): Promise<void>
  threadId: string | null
  threads: ThreadSummary[]
  usage: SessionUsage
  /** The kernel session was lost; the stored transcript is sent as context with the next message. */
  resumedWithContext: boolean
  native(request: NativeRequest): Promise<unknown>
  adoptThread(thread: Thread): void
  newThread(force?: boolean): void
  openThread(id: string): void
  renameThread(id: string, title: string): void
  deleteThread(id: string): void
}

export interface QueuedMessage {
  id: number
  text: string
  workspace?: WorkspaceContext
  /** The operation that queued it; the eventual send links to it. */
  action?: ActionRef
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
  const textBatch = useRef<ReturnType<typeof createTextBatcher> | null>(null)
  const messagesRef = useRef<Message[]>([])
  messagesRef.current = messages
  const idRef = useRef<string | null>(null)
  const threadRef = useRef<string | null>(null)
  const dirRef = useRef<string | null>(null)
  dirRef.current = projectDir
  const busyRef = useRef(false)
  const questionEpoch = useRef(0)
  const queueRef = useRef<QueuedMessage[]>([])
  const sendRef = useRef<(text: string, workspace?: WorkspaceContext, action?: ActionRef) => void>(() => undefined)
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
    textBatch.current?.cancel()
    idRef.current = t.kernelSessionId
    threadRef.current = t.id
    setId(t.kernelSessionId)
    setThreadId(t.id)
    setMessages(t.messages.map(fromStored))
    setUsage({ input: t.usage.input, output: t.usage.output, reasoning: 0, cost: t.usage.cost })
    setResumed(Boolean(t.resumedWithContext))
    setQueueBoth(() => [])
    setBusyBoth(false)
    setError(t.nativeSelectionWarning??null)
    setStatus('')
    const sid = t.kernelSessionId
    const epoch = ++questionEpoch.current
    void window.humanstudy.kernel.questions(sid).then(requests => {
      if (idRef.current !== sid || questionEpoch.current !== epoch) return
      setMessages(ms => requests.reduce((next, question) => appendEvent(next, { sessionId: sid, type: 'question', question }), ms))
      if (requests.length) setBusyBoth(true)
    }).catch((e: unknown) => {
      if (idRef.current === sid && questionEpoch.current === epoch) setError(`Could not restore agent questions: ${String(e)}`)
    })
  }, [])
  const native = useCallback(async (request: NativeRequest) => {
    const sid=idRef.current
    const action=claimAction('agent.native.'+request.operation)
    if(!sid)throw Error('Open a conversation first.')
    if(NATIVE_SESSION_MUTATIONS.has(request.operation)&&busyRef.current)throw Error('Stop the current response before changing this session.')
    if(NATIVE_TURNS.has(request.operation)){
      textBatch.current?.flush();setError(null);setBusyBoth(true)
      if(request.operation!=='compact'){
        const text=request.operation==='shell'?'!'+String(request.input?.command??''):'/'+String(request.input?.command??'')+' '+String(request.input?.arguments??'')
        setMessages(ms=>[...ms,{id:nextId++,role:'user',parts:[{kind:'text',text}],at:Date.now()}])
      }
    }
    try {
      const result=await window.humanstudy.kernel.native(sid,request,action)
      if(idRef.current===sid && result && typeof result==='object' && 'kernelSessionId' in result)activate(result as Thread)
      return result
    } catch(error){
      if(idRef.current===sid){setError(String(error));if(NATIVE_TURNS.has(request.operation))setBusyBoth(false)}
      throw error
    }
  },[activate])
  /** Start the project's pending paper build in this conversation (importing the paper authorized it).
   *  The main process claims it first, so a build is never sent twice. */
  const startPaperBuild = useCallback(async (prompt: string) => {
    const dir = dirRef.current, sid = idRef.current
    if (!dir || !sid || busyRef.current) return
    const action = claimAction('paper.build')
    if (!(await window.humanstudy.project.startBuild(dir, sid, action))) return
    if (dirRef.current !== dir || idRef.current !== sid || busyRef.current) return void window.humanstudy.project.releaseBuild(dir, sid)
    sendRef.current(prompt, undefined, action)
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
    textBatch.current?.cancel()
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

  useEffect(() => {
    const batch = createTextBatcher((e: KernelEvent) => {
      if (e.sessionId !== idRef.current) return
      if(e.type==='identity'){
        setMessages(ms=>{const user=[...ms].reverse().find(m=>m.role==='user');return user?ms.map(m=>m===user?{...m,nativeId:e.detail}:m):ms});return
      }
      if (e.type === 'status') {
        if (['busy','compacting','recovering','reconnecting'].includes(e.text??'')) setBusyBoth(true)
        return setStatus(e.text ?? e.detail ?? '')
      }
      if (e.type === 'question') {
        questionEpoch.current++
        if (!e.question?.resolved) setBusyBoth(true)
      }
      if (e.type === 'done') {
        questionEpoch.current++
        // A turn that was stopped by hand has already cleared busy; its queue waits for the user.
        const wasRunning = busyRef.current && e.detail !== 'shutdown'
        setBusyBoth(false)
        setStatus('')
        setMessages((ms) => expirePermissions(ms))
        const next = queueRef.current[0]
        if (wasRunning && next) {
          setQueueBoth((q) => q.slice(1))
          sendRef.current(next.text, next.workspace, next.action)
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
      if (e.type === 'error') {
        questionEpoch.current++
        setBusyBoth(false)
        setMessages(expirePermissions)
      }
    })
    textBatch.current = batch
    const off = window.humanstudy.kernel.onEvent(e => {
      if (e.sessionId === idRef.current) batch.push(e)
    })
    return () => { off(); batch.cancel(); if (textBatch.current === batch) textBatch.current = null }
  }, [refreshThreads])

  const send = useCallback((text: string, workspace?: WorkspaceContext, action?: ActionRef) => {
    textBatch.current?.flush()
    const sid = idRef.current
    if (!sid || !text.trim()) return
    const ref = action ?? claimAction('composer.send')
    setMessages((ms) => [...ms, { id: nextId++, role: 'user', parts: [{ kind: 'text', text }], at: Date.now() }])
    setBusyBoth(true)
    setStatus('Thinking…')
    window.humanstudy.kernel.send(sid, text, workspace, ref).catch((e: unknown) => {
      setMessages((ms) => appendEvent(ms, { sessionId: sid, type: 'error', text: String(e) }))
      setBusyBoth(false)
    })
  }, [])
  sendRef.current = send

  const abort = useCallback(() => {
    textBatch.current?.flush()
    busyRef.current = false
    const sid = idRef.current
    const ref = claimAction('agent.stop')
    if (sid) void window.humanstudy.kernel.abort(sid, ref).catch((e: unknown) => {
      if (idRef.current === sid) setError(`Could not stop the agent: ${String(e)}`)
    })
    questionEpoch.current++
    setMessages(expirePermissions)
    setBusy(false)
    setStatus('')
  }, [])

  const enqueue = useCallback((text: string, workspace?: WorkspaceContext) => {
    if (!text.trim()) return
    // Queuing is the researcher's operation now; the send happens when the running turn ends.
    const action = claimAction('message.queue', true)
    setQueueBoth((q) => [...q, { id: nextId++, text, action, ...(workspace ? { workspace: structuredClone(workspace) } : {}) }])
  }, [])
  const editQueued = useCallback((qid: number, text: string) => {
    setQueueBoth((q) => q.map((m) => (m.id === qid ? { ...m, text } : m)))
  }, [])
  const removeQueued = useCallback((qid: number) => {
    setQueueBoth((q) => q.filter((m) => m.id !== qid))
  }, [])
  const interruptAndSend = useCallback(
    (text: string, workspace?: WorkspaceContext) => {
      const sid = idRef.current
      if (!sid) return
      busyRef.current = false
      // One operation: it stops the running turn and sends the new message.
      const action = claimAction('composer.interrupt')
      // Wait for the abort to be acknowledged so its `done` cannot end the new turn.
      void window.humanstudy.kernel
        .abort(sid, action)
        .catch(() => undefined)
        .then(() => sendRef.current(text, workspace, action))
    },
    [],
  )

  const reply = useCallback((permissionId: string, response: PermissionReply) => {
    const sid = idRef.current
    if (!sid) return
    const asked = messagesRef.current.flatMap((m) => m.parts).find((x) => x.kind === 'permission' && x.id === permissionId)
    track('permission.reply', { target: asked?.kind === 'permission' ? asked.type : undefined, metadata: { type: asked?.kind === 'permission' ? asked.type : null, reply: response } })
    const action = claimAction('permission.reply')
    // Collapse the card at once; the follow-up event with `resolved` is idempotent.
    setMessages((ms) => resolvePermission(ms, permissionId, response))
    window.humanstudy.kernel.reply(sid, permissionId, response, action).catch((e: unknown) => {
      setMessages((ms) => appendEvent(ms, { sessionId: sid, type: 'error', text: `Could not answer the permission request: ${String(e)}` }))
    })
  }, [])

  const answerQuestion = useCallback(async (questionId: string, answers: string[][]) => {
    const sid = idRef.current
    if (!sid) throw new Error('No active conversation.')
    const action = claimAction('question.reply')
    await window.humanstudy.kernel.answerQuestion(sid, questionId, answers, action)
    if (idRef.current !== sid) return
    questionEpoch.current++
    setMessages(ms => appendEvent(ms, { sessionId: sid, type: 'question', question: { id: questionId, questions: [], answers, resolved: 'answered' } }))
    track('question.reply', { metadata: { question_id: questionId, count: answers.length } }, action)
  }, [])
  const rejectQuestion = useCallback(async (questionId: string) => {
    const sid = idRef.current
    if (!sid) throw new Error('No active conversation.')
    // A deliberate dismissal stops this turn; its queued messages wait for the user.
    const action = claimAction('question.reject')
    const wasBusy = busyRef.current
    busyRef.current = false
    try { await window.humanstudy.kernel.rejectQuestion(sid, questionId, action) }
    catch (e) {
      if (idRef.current === sid) busyRef.current = wasBusy
      throw e
    }
    if (idRef.current !== sid) return
    questionEpoch.current++
    setBusyBoth(false)
    setStatus('')
    setMessages(ms => appendEvent(ms, { sessionId: sid, type: 'question', question: { id: questionId, questions: [], resolved: 'rejected' } }))
    track('question.reject', { metadata: { question_id: questionId } }, action)
  }, [])

  const newThread = useCallback((force = false) => {
    const dir = dirRef.current
    if (!dir) return
    // An empty conversation is already a new thread.
    if (!force && !messages.length && idRef.current) return
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

  const waitingForQuestion = messages.some(m => m.parts.some(p => p.kind === 'question' && !p.resolved && !p.expired))

  return {
    id, startPaperBuild, messages, busy, status, error, queue, send, enqueue, editQueued, removeQueued, interruptAndSend, abort,
    reply, waitingForPermission, answerQuestion, rejectQuestion, waitingForQuestion, threadId, threads, usage, resumedWithContext: resumed, native, adoptThread: activate, newThread, openThread, renameThread, deleteThread,
  }
}
const ZERO: SessionUsage = { input: 0, output: 0, reasoning: 0, cost: 0 }

function fromStored(m: ThreadMessage): Message {
  return {
    id: nextId++,
    nativeId:m.nativeId,
    workspace:m.workspace,
    role: m.role,
    parts: m.parts.map((p): Part =>
      p.kind === 'question' ? { ...p, expired: !p.resolved } : p.kind === 'permission' ? { kind: 'permission', automatic: p.automatic, id: p.id, type: p.type, title: p.title, resolved: p.resolved, expired: !p.resolved } : p,
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
const expirePermissions = (ms: Message[]): Message[] => ms.map(m => ({ ...m, parts: m.parts.map(p =>
  (p.kind === 'permission' || p.kind === 'question') && !p.resolved ? { ...p, expired: true } : p
) }))

function appendEvent(ms: Message[], e: KernelEvent): Message[] {
  if (e.type === 'question') {
    if (!e.question) return ms
    const updated = updateQuestion(ms, e.question)
    if (updated) return updated
    if (!e.question.questions.length && e.question.resolved) return ms
  }
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
    while (at >= 0 && (msg.parts[at].kind === 'permission' || msg.parts[at].kind === 'question')) at--
    const open = msg.parts[at]
    const detail = e.detail && e.detail !== '{}' ? e.detail : undefined // '{}' = input not streamed yet
    if (open?.kind === 'tool' && open.tool === (e.tool ?? 'tool') && (open.state === 'pending' || open.state === 'running'))
      msg.parts[at] = { ...open, detail: detail ?? open.detail, state: e.text, input: e.input ?? open.input, output: e.output ?? open.output, endedAt: Date.now() }
    else msg.parts.push({ kind: 'tool', tool: e.tool ?? 'tool', detail, state: e.text, input: e.input, output: e.output, at: Date.now(), endedAt: Date.now() })
  } else if (e.type === 'question' && e.question) {
    msg.parts.push({ kind: 'question', ...e.question })
  } else if (e.type === 'permission' && e.permission) {
    const pe = e.permission
    if (!pe.type && pe.resolved && !ms.some(m => m.parts.some(p => p.kind === 'permission' && p.id === pe.id))) return ms
    const at = msg.parts.findIndex((x) => x.kind === 'permission' && x.id === pe.id)
    const prev = at >= 0 ? (msg.parts[at] as PermissionPart) : null
    // The follow-up (possibly twice) only adds `resolved`; keep what the first event told us.
    const merged: PermissionPart = {
      kind: 'permission',
      automatic: pe.automatic ?? prev?.automatic,
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
