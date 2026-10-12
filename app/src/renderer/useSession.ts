import { useCallback, useEffect, useRef, useState } from 'react'
import type { KernelEvent } from '../preload/types'

export type Part =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; detail?: string }
  | { kind: 'error'; text: string }

export interface Message {
  id: number
  role: 'user' | 'assistant'
  parts: Part[]
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
}

export interface QueuedMessage {
  id: number
  text: string
}

let nextId = 1

export function useSession(projectDir: string | null): Session {
  const [id, setId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const idRef = useRef<string | null>(null)
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

  useEffect(() => {
    setQueueBoth(() => [])
    setId(null)
    idRef.current = null
    setMessages([])
    setBusyBoth(false)
    setError(null)
    if (!projectDir) return
    let live = true
    setStatus('Starting agent…')
    window.humanstudy.kernel
      .startSession(projectDir)
      .then((sid) => {
        if (!live) return
        idRef.current = sid
        setId(sid)
        setStatus('')
      })
      .catch((e: unknown) => live && setError(String(e)))
    return () => {
      live = false
    }
  }, [projectDir])

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
          const next = queueRef.current[0]
          if (wasRunning && next) {
            setQueueBoth((q) => q.slice(1))
            sendRef.current(next.text)
          }
          return
        }
        setMessages((ms) => appendEvent(ms, e))
        if (e.type === 'error') setBusyBoth(false)
      }),
    [],
  )

  const send = useCallback((text: string) => {
    const sid = idRef.current
    if (!sid || !text.trim()) return
    setMessages((ms) => [...ms, { id: nextId++, role: 'user', parts: [{ kind: 'text', text }] }])
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

  return { id, messages, busy, status, error, queue, send, enqueue, editQueued, removeQueued, interruptAndSend, abort }
}

function appendEvent(ms: Message[], e: KernelEvent): Message[] {
  const last = ms[ms.length - 1]
  const msg: Message =
    last && last.role === 'assistant'
      ? { ...last, parts: [...last.parts] }
      : { id: nextId++, role: 'assistant', parts: [] }
  const tail = msg.parts[msg.parts.length - 1]
  if (e.type === 'text') {
    if (tail?.kind === 'text') msg.parts[msg.parts.length - 1] = { kind: 'text', text: tail.text + (e.text ?? '') }
    else msg.parts.push({ kind: 'text', text: e.text ?? '' })
  } else if (e.type === 'tool') {
    msg.parts.push({ kind: 'tool', tool: e.tool ?? 'tool', detail: e.detail ?? e.text })
  } else if (e.type === 'error') {
    msg.parts.push({ kind: 'error', text: e.text ?? e.detail ?? 'Unknown error' })
  }
  return msg === last ? ms : last && last.role === 'assistant' ? [...ms.slice(0, -1), msg] : [...ms, msg]
}
