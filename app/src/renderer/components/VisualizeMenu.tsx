import { useEffect, useRef, useState } from 'react'
import { track } from '../telemetry'

const TEMPLATES = [
  {
    label: 'Participant flow',
    hint: 'Stages and branches a participant moves through',
    file: 'participant-flow.html',
    prompt: 'a participant flow diagram: every stage a participant passes through, in order, with arrows only from next edges and branches only from condition nodes',
  },
  {
    label: 'Compare conditions',
    hint: 'Side-by-side view of each arm',
    file: 'compare-conditions.html',
    prompt: 'a side-by-side comparison of the experimental conditions, built only from condition nodes and conditionIds, showing what differs between arms',
  },
  {
    label: 'Participant screens',
    hint: 'What each participant actually sees',
    file: 'participant-screens.html',
    prompt: 'a mock-up of the screens a participant sees, in order, using verbatim instrument text and labelling missing items as missing',
  },
]

export function VisualizeMenu({ disabled, onSend }: { disabled: boolean; onSend(text: string): void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div className="menu" ref={ref}>
      <button className="ghost" disabled={disabled} onClick={() => setOpen(!open)}>
        Visualize ▾
      </button>
      {open && (
        <div className="menu-pop">
          {TEMPLATES.map((t) => (
            <button
              key={t.label}
              className="menu-item"
              onClick={() => {
                setOpen(false)
                track('visualize.template', { target: t.file })
                onSend(
                  `Use the visualize skill to create ${t.prompt}. Read program.json, cite evidence (page + quote) for every element, and write a self-contained HTML file to artifacts/${t.file}.`,
                )
              }}
            >
              <span>{t.label}</span>
              <span className="muted small">{t.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
