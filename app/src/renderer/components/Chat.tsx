import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import type { Part, Session } from '../useSession'
import type { AccountStatus, PermissionReply, ProjectEntry } from '../../preload/types'
import { selectionContext, type SelectedItem } from '../program/labels'
import type { SettingsSection } from './SettingsDialog'
import { Markdown, copyText } from './Markdown'
import { ModelPicker, shortModelName } from './ModelPicker'
import { PermissionCard } from './Permission'
import { ToolView } from './ToolView'
import { KernelBar } from './KernelBar'
import { compact, money } from '../format'
import type { KernelInstallStatus } from '../../preload/types'

export interface ChatHandle {
  ask(id: string, fieldId?: string, draft?: string): void
  /** Replace the draft and focus the composer. */
  prefill(text: string): void
  focus(): void
}

interface Props {
  ref?: Ref<ChatHandle>
  session: Session
  selected: SelectedItem[]
  onClearSelection(): void
  account: AccountStatus | null
  onSettings(section: SettingsSection): void
  /** 'needed': signed in but the research data agreement is not accepted, so the agent is locked. */
  agreement: 'accepted' | 'needed'
  onReview(): void
  projectDir: string
  tree: ProjectEntry[]
  model: string
  busyEnter: 'queue' | 'interrupt'
  onModel(model: string): void
  kernel: { status: KernelInstallStatus | null; retry(): void }
  /** Open program.json's Study tab in the workbench. */
  onOpenStudy(): void
}

/** Subsequence match on the path; names score higher than folders, prefixes higher still. */
export function fuzzyScore(query: string, rel: string): number {
  const q = query.toLowerCase()
  const path = rel.toLowerCase()
  if (!q) return 1
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (name.startsWith(q)) return 1000 - name.length
  if (name.includes(q)) return 800 - name.length
  if (path.includes(q)) return 500 - path.length
  let at = 0
  for (const ch of q) {
    at = path.indexOf(ch, at)
    if (at < 0) return 0
    at++
  }
  return 100 - path.length
}
const flatFiles = (tree: ProjectEntry[]): ProjectEntry[] =>
  tree.flatMap((e) => (e.kind === 'dir' ? flatFiles(e.children ?? []) : [e]))

const MENTION = /(^|\s)@([^\s@]*)$/

export function Chat({ ref, session, selected, onClearSelection, account, onSettings, agreement, onReview, projectDir, tree, model, busyEnter, onModel, kernel, onOpenStudy }: Props) {
  const [draft, setDraft] = useState('')
  const [home, setHome] = useState<string>()
  useEffect(() => {
    window.humanstudy.app.info().then((i) => setHome(i.home)).catch(() => undefined)
  }, [])
  const [attached, setAttached] = useState<{ rel: string; name: string }[]>([])
  const [attachError, setAttachError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [caret, setCaret] = useState(0)
  const [pick, setPick] = useState(0)
  const [mentionOff, setMentionOff] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const focus = () => requestAnimationFrame(() => input.current?.focus())

  useImperativeHandle(ref, () => ({
    ask(id, fieldId, text) {
      const target = fieldId ? `${id} › ${fieldId}` : id
      setDraft(`About ${target}: ${text ?? ''}`)
      focus()
    },
    prefill(text) {
      setDraft(text)
      focus()
    },
    focus,
  }))

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session.messages, session.status])

  const files = useMemo(() => flatFiles(tree), [tree])
  const mention = useMemo(() => {
    if (mentionOff) return null
    const m = MENTION.exec(draft.slice(0, caret))
    if (!m) return null
    const query = m[2]
    const hits = files
      .map((f) => ({ f, score: fuzzyScore(query, f.rel) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score || a.f.rel.localeCompare(b.f.rel))
      .slice(0, 8)
      .map((h) => h.f)
    return { start: caret - query.length - 1, query, hits }
  }, [draft, caret, files, mentionOff])
  const insertMention = (f: ProjectEntry) => {
    if (!mention) return
    const next = draft.slice(0, mention.start) + '@' + f.rel + ' ' + draft.slice(caret)
    const pos = mention.start + f.rel.length + 2
    setDraft(next)
    setCaret(pos)
    setPick(0)
    requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.setSelectionRange(pos, pos)
    })
  }

  const attach = async (list: File[]) => {
    if (!list.length) return
    setAttachError('')
    try {
      const paths = list.map((f) => window.humanstudy.files.pathOf(f)).filter(Boolean)
      const copies = await window.humanstudy.project.importFiles(projectDir, paths)
      const base = projectDir.replace(/\\/g, '/').replace(/\/$/, '') + '/'
      setAttached((a) => [
        ...a,
        ...copies.map((c) => {
          const full = c.path.replace(/\\/g, '/')
          return { name: c.name, rel: full.startsWith(base) ? full.slice(base.length) : c.name }
        }),
      ])
      focus()
    } catch (e) {
      setAttachError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '') : 'Could not attach the files.')
    }
  }

  const compose = () => {
    const text = draft.trim()
    if (!text && !attached.length) return null
    const prefix = attached.length ? `[Attached: ${attached.map((a) => a.rel).join(', ')}]\n` : ''
    return selectionContext(selected) + prefix + text
  }
  const submit = () => {
    const full = compose()
    if (!full || !session.id) return
    if (session.busy) {
      if (busyEnter === 'interrupt') session.interruptAndSend(full)
      else session.enqueue(full)
    } else session.send(full)
    setDraft('')
    setAttached([])
  }
  const canSend = (draft.trim().length > 0 || attached.length > 0) && Boolean(session.id)
  const settingUp = kernel.status != null && kernel.status.state !== 'ready'
  const statusLine = session.waitingForPermission ? 'Waiting for your permission' : session.status
  const u = session.usage
  const lastAssistant = session.messages.length ? session.messages[session.messages.length - 1].id : -1

  return (
    <section
      className={`chat${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        if (!dragging) setDragging(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return
        e.preventDefault()
        setDragging(false)
        void attach(Array.from(e.dataTransfer.files))
      }}
    >
      {dragging && <div className="drop-hint">Drop to add to the project (PDF, data, images)</div>}
      <KernelBar kernel={kernel} />
      <div className="messages" ref={scroller}>
        {session.resumedWithContext && session.messages.length > 0 && (
          <p className="resumed-note small muted">Resumed; the agent will be reminded of the earlier conversation on your next message.</p>
        )}
        {session.messages.length === 0 && (
          <div className="empty">
            <p className="muted">Ask the agent to build, check or refine this study.</p>
            {['Build the Human Program from paper.pdf', 'What is still missing from the protocol?', 'Export a preregistration draft'].map((s) => (
              <button key={s} className="suggestion" disabled={!session.id} onClick={() => session.send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {session.messages.map((m) => (
          <div key={m.id} className={`msg ${m.role}`}>
            {m.parts.map((p, i) => (
              <PartView key={i} part={p} role={m.role} onReply={session.reply} onOpenStudy={onOpenStudy} projectDir={projectDir} home={home} />
            ))}
            {m.role === 'assistant' && !(session.busy && m.id === lastAssistant) && <CopyMessage message={m.parts} />}
          </div>
        ))}
        {session.error && <div className="part error">Agent unavailable: {session.error}</div>}
        {statusLine && (
          <div className="status">
            <span className="pulse" /> {statusLine}
          </div>
        )}
      </div>

      {account?.modelAccess === 'none' && (
        <div className="signin-card" role="note">
          <strong>{account.signedIn ? 'Enter your invitation code to use the agent' : 'Sign in to use the agent'}</strong>
          <p className="muted small">
            {account.signedIn
              ? 'Your invitation code unlocks the agent during the beta.'
              : 'Your HumanStudy Hub account and invitation code unlock it.'}
          </p>
          <div className="signin-actions">
            <button className="primary" onClick={() => onSettings('account')}>
              {account.signedIn ? 'Enter code' : 'Sign in'}
            </button>
          </div>
        </div>
      )}
      {account?.modelAccess !== 'none' && agreement === 'needed' && (
        <div className="agreement-lock" role="note">
          <span>Agree to the research data agreement to use the agent</span>
          <span aria-hidden> · </span>
          <button className="link" onClick={onReview}>Review</button>
        </div>
      )}
      {account?.modelAccess === 'none' || agreement === 'needed' ? null : (
      <div className="composer">
        {selected.length > 0 && (
          <div className="chips">
            {selected.map((s) => (
              <span key={s.id} className="chip" title={s.id}>
                {s.title}
              </span>
            ))}
            <button className="link" onClick={onClearSelection}>clear</button>
          </div>
        )}
        {attached.length > 0 && (
          <div className="chips attachments">
            {attached.map((a, i) => (
              <span key={a.rel + i} className="chip file" title={a.rel}>
                <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden>
                  <path d="M3 1.5h4l2 2v7H3z" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
                </svg>
                {a.rel}
                <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttached((l) => l.filter((_, j) => j !== i))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachError && <p className="attach-error small">{attachError}</p>}
        {mention && mention.hits.length > 0 && (
          <div className="mention-menu" role="listbox" aria-label="Project files">
            {mention.hits.map((f, i) => (
              <button
                key={f.rel}
                type="button"
                role="option"
                aria-selected={i === pick}
                className={i === pick ? 'on' : ''}
                onMouseDown={(e) => {
                  e.preventDefault()
                  insertMention(f)
                }}
              >
                <span className="mention-name">{f.name}</span>
                <span className="mention-path muted">{f.rel}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          rows={3}
          value={draft}
          placeholder={session.id ? 'Message the agent…  (@ to mention a file)' : settingUp ? 'Setting up…' : 'Starting agent…'}
          onChange={(e) => {
            setDraft(e.target.value)
            setCaret(e.target.selectionStart)
            setPick(0)
            setMentionOff(false)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const pasted = Array.from(e.clipboardData.files)
            if (pasted.length) {
              e.preventDefault()
              void attach(pasted)
            }
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (mention && mention.hits.length > 0) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const n = mention.hits.length
                setPick((p) => (p + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                insertMention(mention.hits[Math.min(pick, mention.hits.length - 1)])
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setMentionOff(true)
                return
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-row">
          <div className="composer-tools">
            <ModelPicker model={model} account={account} onChange={onModel} onOther={() => onSettings('models')} />
            <button type="button" className="ghost icon attach-btn" aria-label="Attach files" title="Attach files" disabled={!session.id} onClick={() => fileInput.current?.click()}>
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                <path d="M11.5 5.5l-5 5a1.4 1.4 0 002 2l5-5a2.8 2.8 0 00-4-4l-5 5a4.2 4.2 0 006 6l4-4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              </svg>
            </button>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void attach(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
          </div>
          <span className="muted small composer-hint">
            {session.busy ? (busyEnter === 'queue' ? 'Enter queues' : 'Enter interrupts') : 'Enter to send'}
          </span>
          {session.busy && !canSend ? (
            <button className="stop" onClick={session.abort}>Stop</button>
          ) : (
            <button className="primary" disabled={!canSend} onClick={submit}>
              {session.busy ? (busyEnter === 'queue' ? 'Queue' : 'Interrupt') : 'Send'}
            </button>
          )}
        </div>
      </div>
      )}
      {u.input + u.output > 0 && (
        <div
          className="usage-line small muted"
          title={`Input ${u.input.toLocaleString()} tokens\nOutput ${u.output.toLocaleString()} tokens\nReasoning ${u.reasoning.toLocaleString()} tokens${u.cost > 0 ? `\nCost ${money(u.cost)}` : ''}`}
        >
          {shortModelName(model)} · {compact(u.input)} in · {compact(u.output)} out{u.cost > 0 ? ` · ${money(u.cost)} this thread` : ''}
        </div>
      )}
      {session.queue.length > 0 && (
        <div className="queue" aria-label="Queued messages">
          <div className="queue-head small muted">
            Queued · sent when the agent finishes
            {session.busy && (
              <button className="link" onClick={session.abort}>
                stop
              </button>
            )}
          </div>
          {session.queue.map((q) => (
            <QueuedItem key={q.id} text={q.text} onEdit={(t) => session.editQueued(q.id, t)} onRemove={() => session.removeQueued(q.id)} />
          ))}
        </div>
      )}
    </section>
  )
}

function QueuedItem({ text, onEdit, onRemove }: { text: string; onEdit(t: string): void; onRemove(): void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(text)
  const done = () => {
    setEditing(false)
    if (value.trim()) onEdit(value.trim())
    else onRemove()
  }
  return (
    <div className="queue-item">
      {editing ? (
        <textarea
          autoFocus
          rows={2}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={done}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              done()
            }
            if (e.key === 'Escape') {
              e.stopPropagation()
              setValue(text)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="queue-text" title={text}>{text}</span>
      )}
      {!editing && (
        <>
          <button className="link" onClick={() => { setValue(text); setEditing(true) }}>edit</button>
          <button className="link" aria-label="Remove from queue" onClick={onRemove}>remove</button>
        </>
      )}
    </div>
  )
}

function CopyMessage({ message }: { message: Part[] }) {
  const [done, setDone] = useState(false)
  const text = message.flatMap((p) => (p.kind === 'text' ? [p.text] : [])).join('\n\n').trim()
  if (!text) return null
  return (
    <button
      className="copy-msg"
      onClick={() => {
        void copyText(text)
        setDone(true)
        window.setTimeout(() => setDone(false), 1400)
      }}
    >
      {done ? 'Copied' : 'Copy'}
    </button>
  )
}

function PartView({
  part,
  role,
  onReply,
  onOpenStudy,
  projectDir,
  home,
}: {
  part: Part
  role: 'user' | 'assistant'
  onReply(id: string, response: PermissionReply): void
  onOpenStudy(): void
  projectDir: string
  home?: string
}) {
  if (part.kind === 'text') {
    return role === 'assistant' ? (
      <div className="part text md-part">
        <Markdown text={part.text} />
      </div>
    ) : (
      <div className="part text">{part.text}</div>
    )
  }
  if (part.kind === 'error') return <div className="part error">{part.text}</div>
  if (part.kind === 'permission') return <PermissionCard part={part} onReply={onReply} />
  return <ToolView part={part} onOpenStudy={onOpenStudy} projectDir={projectDir} home={home} />
}
