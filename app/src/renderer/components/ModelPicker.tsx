import { useEffect, useRef, useState } from 'react'
import type { AccountStatus } from '../../preload/types'

export const KNOWN_MODELS = [
  'anthropic/claude-sonnet-5.5',
  'anthropic/claude-haiku-5.5',
  'deepseek/deepseek-v4.1-flash',
]

/** "anthropic/claude-sonnet-5.5" -> "Sonnet 5.5"; unknown ids are shown as they are. */
export function shortModelName(id: string): string {
  switch (id) {
    case 'anthropic/claude-sonnet-5.5':
      return 'Sonnet 5.5'
    case 'anthropic/claude-haiku-5.5':
      return 'Haiku 5.5'
    case 'deepseek/deepseek-v4.1-flash':
      return 'DeepSeek V4.1 Flash'
    default:
      return id
  }
}

const HINT = 'Sonnet for building studies, Haiku for quick questions, DeepSeek cheapest'

interface Props {
  model: string
  account: AccountStatus | null
  onChange(model: string): void
  onOther(): void
}

export function ModelPicker({ model, account, onChange, onOther }: Props) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const base = account?.modelAccess === 'hosted' && account.models?.length ? account.models : KNOWN_MODELS
  const options = base.includes(model) ? base : [model, ...base]

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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
  }, [open])

  return (
    <div className="model-picker" ref={root}>
      <button
        type="button"
        className="model-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${model}\n${HINT}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="model-name">{shortModelName(model)}</span>
        <svg viewBox="0 0 10 6" width="9" height="6" aria-hidden>
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="model-menu" role="listbox" aria-label="Model">
          {options.map((id) => (
            <button
              key={id}
              type="button"
              role="option"
              aria-selected={id === model}
              className={id === model ? 'on' : ''}
              onClick={() => {
                setOpen(false)
                if (id !== model) onChange(id)
              }}
            >
              <span>{shortModelName(id)}</span>
              {id === model && <span aria-hidden>✓</span>}
            </button>
          ))}
          <button
            type="button"
            className="other"
            onClick={() => {
              setOpen(false)
              onOther()
            }}
          >
            Other…
          </button>
          <p className="model-hint small muted">{HINT}</p>
        </div>
      )}
    </div>
  )
}
