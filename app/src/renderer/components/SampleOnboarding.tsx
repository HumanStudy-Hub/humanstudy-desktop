import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { validateHumanProgram } from '../../shared/human-program'

/** Identify the bundled sample by its stable document identity, never a user-editable project name. */
export function walkthroughSample(input: unknown) {
  try { const program = validateHumanProgram(input); return program.id === 'mazzarella2018politeness-research' ? program : null } catch { return null }
}

export type SampleGuideAction = 'overview' | 'source' | 'participant' | 'trial' | 'setup'
const steps: { action: SampleGuideAction; title: string; hint: string; button: string }[] = [
  { action: 'overview', title: 'Find the research question', hint: 'Start with what the paper asks, predicts and finds.', button: 'Show the overview' },
  { action: 'source', title: 'Check it against the paper', hint: 'Open a cited passage beside the study. The source stays one click away.', button: 'Compare with the source' },
  { action: 'participant', title: 'Read the original passage', hint: 'Compare the highlighted passage with the study. Next, try the participant view.', button: 'Explore participant view' },
  { action: 'trial', title: 'Try a condition', hint: 'Change a condition or move through the screens. When ready, draft a trial request in chat; nothing runs automatically.', button: 'Draft a trial request' },
]

/** A non-modal tour of the real editable sample. Progress means a view was opened, not scientific validation. */
export function SampleOnboarding({ onClose, onAction, agentReady }: { agentReady: boolean; onClose(): void; onAction(action: SampleGuideAction): void }) {
  const [step, setStep] = useState(0)
  const finish = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    card.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    const panel = card.current
    return () => { if (opener?.isConnected && (document.activeElement === document.body || panel?.contains(document.activeElement))) opener.focus({ preventScroll: true }) }
  }, [])
  const [spot, setSpot] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [position, setPosition] = useState({ left: 16, top: 80 })
  // Observe layout, not a timer: scrolling, panel resizing and async source loading
  // can all move the real control underneath this non-modal coach mark.
  useEffect(() => {
    let frame = 0
    let revealed = false
    let target: HTMLElement | null = null
    let previousDescription: string | null = null
    const selector = step === 0 ? '.research-overview-topic' : step === 1 ? '.research-cite' : step === 2
      ? '.wb-paper:not([hidden]) .source-body' : step === 3
      ? '.research-preview[open] iframe' : '.composer, .agreement-lock, .signin-card'
    const restore = () => {
      if (!target) return
      if (previousDescription === null) target.removeAttribute('aria-describedby')
      else target.setAttribute('aria-describedby', previousDescription)
    }
    const clipped = (el: HTMLElement) => {
      const bounds = el.getBoundingClientRect()
      let { left, top, right, bottom } = bounds
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), rect = parent.getBoundingClientRect()
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, rect.left); right = Math.min(right, rect.right) }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, rect.top); bottom = Math.min(bottom, rect.bottom) }
      }
      left = Math.max(8, left); top = Math.max(8, top)
      right = Math.min(innerWidth - 8, right); bottom = Math.min(innerHeight - 8, bottom)
      return el.getClientRects().length && right > left && bottom > top
        ? { left: Math.max(8, left - 6), top: Math.max(8, top - 6), width: Math.min(innerWidth - 8, right + 6) - Math.max(8, left - 6), height: Math.min(innerHeight - 8, bottom + 6) - Math.max(8, top - 6) } : null
    }
    const measure = () => {
      frame = 0
      if (step < 2 && !revealed) {
        const cite = document.querySelector<HTMLElement>(step === 0 ? '.research-overview-topic' : '.research-cite')
        if (cite) revealed = true
        for (let parent = cite?.parentElement; parent; parent = parent.parentElement) {
          if (parent instanceof HTMLDetailsElement) parent.open = true
        }
        cite?.scrollIntoView({ block: 'center', behavior: 'instant' })
      }
      const found = [...document.querySelectorAll<HTMLElement>(selector)].find(el => clipped(el)) ?? null
      if (found !== target) {
        restore()
        if (target) { resize.unobserve(target); if (target.parentElement) resize.unobserve(target.parentElement) }
        target = found
        previousDescription = target?.getAttribute('aria-describedby') ?? null
        if (target) {
          target.setAttribute('aria-describedby', [previousDescription, 'sample-guide-description'].filter(Boolean).join(' '))
          resize.observe(target)
          if (target.parentElement) resize.observe(target.parentElement)
        }
      }
      const next = target ? clipped(target) : null
      const left = next?.left ?? 0, top = next?.top ?? 0, right = left + (next?.width ?? 0), bottom = top + (next?.height ?? 0)
      setSpot(old => JSON.stringify(old) === JSON.stringify(next) ? old : next)
      const width = card.current?.offsetWidth ?? 320, height = card.current?.offsetHeight ?? 200
      let x = 16, y = next && next.top > innerHeight / 2 ? 16 : Math.max(16, innerHeight - height - 16)
      if (next) {
        if (right + width + 28 <= innerWidth) { x = right + 16; y = top }
        else if (left - width - 16 >= 12) { x = left - width - 16; y = top }
        else if (bottom + height + 28 <= innerHeight) { x = left; y = bottom + 16 }
        else if (top - height - 16 >= 12) { x = left; y = top - height - 16 }
      }
      const pos = { left: Math.max(12, Math.min(x, innerWidth - width - 12)), top: Math.max(12, Math.min(y, innerHeight - height - 12)) }
      setPosition(old => old.left === pos.left && old.top === pos.top ? old : pos)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const observer = new MutationObserver(records => {
      if (records.some(record => !(record.target instanceof Element && record.target.closest('.sample-guide-layer')))) schedule()
    })
    observer.observe(document.getElementById('root') ?? document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'open', 'hidden'] })
    const resize = new ResizeObserver(schedule)
    if (card.current) resize.observe(card.current)
    resize.observe(document.documentElement)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    // A real source click progresses the tour without dispatching the action twice.
    const click = (event: MouseEvent) => {
      const el = event.target as Element
      if (step === 1 && el.closest?.('.research-cite')) setStep(2)
    }
    document.addEventListener('click', click)
    schedule()
    return () => { cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); restore(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true); document.removeEventListener('click', click) }
  }, [step, agentReady])
  useEffect(() => { if (step === steps.length) finish.current?.focus() }, [step])
  useEffect(() => {
    const keys = (event: KeyboardEvent) => { if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('[aria-modal="true"]')) return; const target = event.target as HTMLElement; if (target?.closest?.('input, textarea, [contenteditable="true"]')) return; onClose() }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [onClose])
  const current = step === 3 && !agentReady
    ? { action: 'setup' as const, title: 'Try a condition', hint: 'Change a condition or move through the screens. You can explore without an account, then set up the agent when ready.', button: 'See agent setup' }
    : steps[step]
  return createPortal(<div className="sample-guide-layer">
    {spot ? <div className="sample-guide-spotlight" aria-hidden="true" style={spot} /> : <div className="sample-guide-shade" aria-hidden="true" />}
    <section ref={card} className="sample-onboarding" aria-label="Sample walkthrough" style={position}>
    <div className="sample-guide-heading"><span className="sample-guide-count">{Math.min(step + 1, 4)} / 4</span>
    <div className="sample-guide-progress" aria-label={`${Math.min(step + 1, 4)} of 4 steps`}>
      {steps.map((item, index) => <span key={item.action} className={index < step ? 'done' : index === step ? 'current' : ''} aria-hidden="true" />)}
    </div>
    </div>
    <div id="sample-guide-description" className="sample-guide-copy" aria-live="polite">
      <strong>{current?.title ?? 'Your turn'}</strong>
      <p>{current?.hint ?? (agentReady ? 'Continue in chat. Review your draft before sending, or keep exploring the paper.' : 'Agent setup is shown on the left. No request was drafted or sent. You can finish setup or keep exploring the paper.')}</p>
    </div>
    <div className="sample-guide-actions">
      {current && <button className="primary" onClick={() => { onAction(current.action); setStep(value => value + 1) }}>{current.button}</button>}
      <button ref={finish} className="ghost" onClick={onClose}>{current ? 'Skip guide' : 'Finish guide'}</button>
    </div>
  </section></div>, document.body)
}
