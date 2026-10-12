import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import type { Part, Session } from '../useSession'
import type { AccountStatus } from '../../preload/types'
import { selectionContext, type SelectedItem } from '../program/labels'
import type { SettingsSection } from './SettingsDialog'

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
}

export function Chat({ ref, session, selected, onClearSelection, account, onSettings }: Props) {
  const [draft, setDraft] = useState('')
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

  const submit = () => {
    const text = draft.trim()
    if (!text || session.busy || !session.id) return
    session.send(selectionContext(selected) + text)
    setDraft('')
  }

  return (
    <section className="chat">
      <div className="messages" ref={scroller}>
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
              <PartView key={i} part={p} />
            ))}
          </div>
        ))}
        {session.error && <div className="part error">Agent unavailable: {session.error}</div>}
        {session.status && (
          <div className="status">
            <span className="pulse" /> {session.status}
          </div>
        )}
      </div>

      {account?.modelAccess === 'none' && (
        <div className="signin-card" role="note">
          <strong>{account.signedIn ? 'Enter a promo code to use the agent' : 'Sign in to use the agent'}</strong>
          <p className="muted small">
            {account.signedIn
              ? 'Hosted models unlock with the promo code you received. You can also add your own OpenRouter key, or keep your existing opencode setup.'
              : 'Hosted models need a HumanStudy Hub account and a promo code. You can also add your own OpenRouter key, or keep your existing opencode setup.'}
          </p>
          <div className="signin-actions">
            <button className="primary" onClick={() => onSettings('account')}>
              {account.signedIn ? 'Enter code' : 'Sign in'}
            </button>
            <button className="ghost" onClick={() => onSettings('models')}>
              Add a key
            </button>
          </div>
        </div>
      )}
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
        <textarea
          ref={input}
          rows={3}
          value={draft}
          placeholder={session.id ? 'Message the agent…' : 'Starting agent…'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="composer-row">
          <span className="muted small">Enter to send · Shift+Enter for newline</span>
          {session.busy ? (
            <button className="stop" onClick={session.abort}>Stop</button>
          ) : (
            <button className="primary" disabled={!draft.trim() || !session.id} onClick={submit}>
              Send
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

function PartView({ part }: { part: Part }) {
  if (part.kind === 'text') return <div className="part text">{part.text}</div>
  if (part.kind === 'error') return <div className="part error">{part.text}</div>
  return (
    <details className="part tool">
      <summary>
        <span className="tool-dot" />
        <span className="tool-name">{part.tool}</span>
        {part.detail && <span className="tool-detail">{firstLine(part.detail)}</span>}
      </summary>
      {part.detail && <pre>{part.detail}</pre>}
    </details>
  )
}

const firstLine = (s: string) => s.split('\n')[0].slice(0, 120)
