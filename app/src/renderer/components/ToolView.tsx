// The agent's tool calls in plain language. A run of consecutive tool calls collapses into one
// "Worked for 40 s · 7 steps" line; it expands to one sentence per step, and each sentence expands
// to the raw command / input / output for experts.
import { useState } from 'react'
import type { Part } from '../useSession'
import { DiffBlock, isDiff } from './Permission'
import { displayPath } from '../../shared/display-path'
import { classifyTool, toolSentence } from '../toolSentence'
import { resultTitle } from '../results'
import { t } from '../i18n'

type ToolPart = Extract<Part, { kind: 'tool' }>

const firstLine = (s: string) => s.split('\n')[0].slice(0, 160)

/** The file a diff touches: `+++ b/path`, else `--- a/path`, else the first line. */
export function diffFile(detail: string): string {
  const lines = detail.split('\n')
  const hit = lines.find((l) => l.startsWith('+++ ') && !l.includes('/dev/null')) ?? lines.find((l) => l.startsWith('--- ') && !l.includes('/dev/null'))
  if (hit) return hit.slice(4).replace(/^[ab]\//, '').split('\t')[0].trim()
  return firstLine(detail)
}

/** {min, sec} of a duration; seconds are never shown as 0 for a real step. */
export function durationParts(ms: number): { min: number; sec: number } {
  const total = Math.max(1, Math.round(ms / 1000))
  return { min: Math.floor(total / 60), sec: total % 60 }
}
export function durationText(ms: number): string {
  const { min, sec } = durationParts(ms)
  return min ? (sec ? t('dur.min_sec', { min, sec }) : t('dur.min', { min })) : t('dur.sec', { sec })
}
const stepsText = (n: number) => t(n === 1 ? 'tool.step_one' : 'tool.step_other', { n })

const running = (p: ToolPart) => p.state === 'pending' || p.state === 'running'

/** One run of consecutive tool calls. `live` is true while the agent is still working on it. */
export function ToolGroup({ parts, live, onOpenStudy, projectDir, home }: { parts: ToolPart[]; live: boolean; onOpenStudy?(): void; projectDir?: string; home?: string }) {
  const [open, setOpen] = useState(false)
  const first = parts[0]
  const last = parts[parts.length - 1]
  const elapsed = first.at && last.endedAt ? last.endedAt - first.at : 0
  const active = live || parts.some(running)
  const current = [...parts].reverse().find(running) ?? last
  const sentence = (p: ToolPart) => {
    const s = toolSentence(classifyTool(p, projectDir), (rel) => resultTitle(rel))
    return t(s.key, s.vars)
  }
  const head = active ? (
    <>
      <span className="tool-spin" aria-hidden />
      <span className="tool-head-main">{sentence(current)}</span>
      <span className="tool-head-meta">{stepsText(parts.length)}</span>
    </>
  ) : (
    <>
      <span className="tool-dot" aria-hidden />
      <span className="tool-head-main">{elapsed >= 1000 ? t('tool.worked_for', { time: durationText(elapsed) }) : t('tool.worked')}</span>
      <span className="tool-head-meta">{stepsText(parts.length)}</span>
    </>
  )
  return (
    <div className={`tool-group${open ? ' open' : ''}${active ? ' active' : ''}`}>
      <button className="tool-group-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {head}
        <span className="tool-caret" aria-hidden>▸</span>
      </button>
      {open && (
        <ul className="tool-steps">
          {parts.map((p, i) => (
            <li key={i}>
              <ToolStep part={p} onOpenStudy={onOpenStudy} projectDir={projectDir} home={home} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** One step: the plain sentence; expands to the raw command and its input / output. */
function ToolStep({ part, onOpenStudy, projectDir, home }: { part: ToolPart; onOpenStudy?(): void; projectDir?: string; home?: string }) {
  const detail = part.detail
  const diff = isDiff(detail)
  const action = classifyTool(part, projectDir)
  const s = toolSentence(action, (rel) => resultTitle(rel))
  const failed = part.state === 'error'
  const counts = diff && detail ? countLines(detail) : null
  const rawFile = diff && detail ? diffFile(detail) : null
  const rawLine = rawFile ? displayPath(rawFile, projectDir, home) : detail ? firstLine(detail) : ''
  const hasRaw = Boolean(detail || part.input !== undefined || part.output)
  return (
    <details className={`tool-step${failed ? ' failed' : ''}`} open={diff || undefined}>
      <summary>
        <span className={`tool-dot${failed ? ' bad' : ''}`} aria-hidden />
        <span className="tool-sentence">{t(s.key, s.vars)}</span>
        {s.muted && <span className="tool-muted">{s.muted}</span>}
        {failed && <span className="tool-muted">{t('tool.failed')}</span>}
        {counts && (
          <span className="diff-count">
            <span className="add">+{counts.add}</span> <span className="del">−{counts.del}</span>
          </span>
        )}
        {action.type === 'write-study' && onOpenStudy && (
          <button
            className="link tool-link"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              onOpenStudy()
            }}
          >
            {t('tool.show_in_study')}
          </button>
        )}
      </summary>
      {hasRaw && (
        <div className="tool-raw">
          <div className="tool-raw-head">
            <span className="tool-name">{part.tool}</span>
            {rawLine && <span className="tool-file" title={rawLine}>{rawLine}</span>}
          </div>
          {diff && detail ? <DiffBlock text={detail} /> : null}
          {!diff && part.input !== undefined && <pre>{pretty(part.input)}</pre>}
          {!diff && part.input === undefined && detail && <pre>{detail}</pre>}
          {part.output && <pre className="tool-output">{part.output.slice(0, 4000)}</pre>}
        </div>
      )}
    </details>
  )
}

function pretty(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

function countLines(text: string) {
  let add = 0
  let del = 0
  for (const l of text.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++
    else if (l.startsWith('-') && !l.startsWith('---')) del++
  }
  return { add, del }
}
