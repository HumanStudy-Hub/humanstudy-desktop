// Thread switcher in the agent pane header: history list, New thread, rename, delete.
import { useEffect, useRef, useState } from 'react'
import type { Session } from '../useSession'
import { compact, relativeTime } from '../format'

export function ThreadMenu({ session }: { session: Session }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [confirming, setConfirming] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing) {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc, true)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc, true)
    }
  }, [open, editing])

  const finish = (save: boolean) => {
    if (editing && save) session.renameThread(editing, title)
    setEditing(null)
  }
  const click = useRef<number>(0)
  return (
    <div className="threads" ref={root}>
      <button className="ghost thread-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)} title="Thread history">
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
          <circle cx="3.5" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="12.5" cy="8" r="1.1" />
        </svg>
        History
      </button>
      <button className="ghost thread-new" onClick={session.newThread} title="New thread (⌘⇧T)" aria-label="New thread" disabled={!session.id}>
        +
      </button>
      {open && (
        <div className="thread-pop" role="menu" aria-label="Threads">
          <button className="thread-item new" role="menuitem" onClick={() => { setOpen(false); session.newThread() }}>
            <span>New thread</span>
            <kbd>⌘⇧T</kbd>
          </button>
          {session.threads.length === 0 && <p className="muted small thread-empty">Past conversations with the agent appear here.</p>}
          {session.threads.map((t) => (
            <div key={t.id} className={`thread-item ${t.id === session.threadId ? 'on' : ''}`} role="menuitem">
              {editing === t.id ? (
                <input
                  autoFocus
                  className="thread-rename"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => finish(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') finish(true)
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      finish(false)
                    }
                  }}
                />
              ) : (
                <button
                  className="thread-main"
                  title="Double-click to rename"
                  onClick={(e) => {
                    window.clearTimeout(click.current)
                    if (e.detail >= 2) {
                      setEditing(t.id)
                      setTitle(t.title)
                      return
                    }
                    // Wait out a possible double-click (rename) before switching.
                    click.current = window.setTimeout(() => { setOpen(false); session.openThread(t.id) }, 220)
                  }}
                >
                  <span className="thread-title">{t.title}</span>
                  <span className="thread-meta muted">
                    {relativeTime(t.updatedAt)} · {compact(t.usage.input + t.usage.output)} tokens
                  </span>
                </button>
              )}
              {confirming === t.id ? (
                <span className="thread-confirm">
                  <button className="link danger" onClick={() => { setConfirming(null); session.deleteThread(t.id) }}>Delete</button>
                  <button className="link" onClick={() => setConfirming(null)}>Keep</button>
                </span>
              ) : (
                <button className="ghost icon thread-del" aria-label={`Delete ${t.title}`} title="Delete thread" onClick={() => setConfirming(t.id)}>
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
