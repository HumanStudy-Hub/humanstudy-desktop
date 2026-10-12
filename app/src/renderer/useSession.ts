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
  send(text: string): void
  abort(): void
}

let nextId = 1

export function useSession(projectDir: string | null): Session {
  const [id, setId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)
  const idRef = useRef<string | null>(null)

  useEffect(() => {
    setId(null)
    idRef.current = null
    setMessages([])
    setBusy(false)
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
          setBusy(false)
          setStatus('')
          return
        }
        setMessages((ms) => appendEvent(ms, e))
        if (e.type === 'error') setBusy(false)
      }),
    [],
  )

  const send = useCallback((text: string) => {
    const sid = idRef.current
    if (!sid || !text.trim()) return
    setMessages((ms) => [...ms, { id: nextId++, role: 'user', parts: [{ kind: 'text', text }] }])
    setBusy(true)
    setStatus('Thinking…')
    window.humanstudy.kernel.send(sid, text).catch((e: unknown) => {
      setMessages((ms) => appendEvent(ms, { sessionId: sid, type: 'error', text: String(e) }))
      setBusy(false)
    })
  }, [])

  const abort = useCallback(() => {
    if (idRef.current) void window.humanstudy.kernel.abort(idRef.current)
    setBusy(false)
    setStatus('')
  }, [])

  return { id, messages, busy, status, error, send, abort }
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
