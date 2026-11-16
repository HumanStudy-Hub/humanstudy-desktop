import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { guideReplyReceived, newUserIndex, rearm, type GuideWait, type GuidePrompt } from '../sample-guide-flow'
import type { Session } from '../useSession'
import { validateHumanProgram } from '../../shared/human-program'

/** Identify the bundled sample by its stable document identity, never a user-editable project name. */
export function walkthroughSample(input: unknown) {
  try { const program = validateHumanProgram(input); return program.id === 'mazzarella2018politeness-research' ? program : null } catch { return null }
}

export type SampleGuideAction = 'overview' | 'source' | 'participant' | 'setup' | GuidePrompt
const steps: { action: SampleGuideAction; title: string; hint: string; button: string }[] = [
  { action: 'overview', title: 'Understand the paper', hint: 'Can politeness change how we interpret a reply? Explore what this paper asks, predicts and finds.', button: 'Read the finding' },
  { action: 'source', title: 'Check the evidence', hint: 'Does the paper support this account? Compare a claim with the original passage.', button: 'Check the original passage' },
  { action: 'participant', title: 'Experience the experiment', hint: 'See the scenario and question participants received. Try answering, then switch conditions to discover what changes.', button: 'Try the participant task' },
  { action: 'replicate', title: 'Try to replicate it', hint: 'After exploring the conditions, ask what you would need to reproduce this study—and which materials are still missing.', button: 'Prepare my first question' },
  { action: 'question', title: 'Discuss the research', hint: 'You can question the design, not just read it. Ask why this experiment tests the hypothesis and what else might explain the finding.', button: 'Ask about the design' },
  { action: 'ai', title: 'Choose your next step', hint: 'Use the paper as a starting point for your own research. Choose a direction to draft your next message.', button: 'Prepare an AI trial' },
]
const choices: { action: GuidePrompt; label: string }[] = [
  { action: 'ai', label: 'Prepare an AI trial' },
  { action: 'variation', label: 'Explore a variation' },
  { action: 'materials', label: 'Prepare research materials' },
]

/** A non-modal tour of the real editable sample. Progress means a view was opened, not scientific validation. */
export function SampleOnboarding({ onClose, onAction, agentReady, conversation, suspended = false }: { suspended?: boolean; conversation?: Pick<Session, 'messages' | 'threadId' | 'busy' | 'error'> & { stopping?: boolean }; agentReady: boolean; onClose(): void; onAction(action: SampleGuideAction): void }) {
  const [step, setStep] = useState(0)
  const [waiting, setWaiting] = useState<GuideWait | null>(null)
  const threadChanged = Boolean(waiting && waiting.thread !== null && conversation && waiting.thread !== conversation.threadId)
  useEffect(() => {
    if (!waiting || !conversation) return
    // A first message creates the thread: bind the wait to it.
    if (waiting.thread === null && conversation.threadId && newUserIndex(conversation.messages, waiting) >= 0) {
      setWaiting({ ...waiting, thread: conversation.threadId })
      return
    }
    // Stop, or a rejected/unanswered question or permission, is not a finished reply: wait for the next message.
    if (conversation.stopping && newUserIndex(conversation.messages, waiting) >= 0) {
      setWaiting(rearm(conversation.messages, conversation.threadId ?? null, true))
      return
    }
    if (guideReplyReceived(conversation.messages, waiting, conversation.threadId, conversation.busy, conversation.error)) {
      setWaiting(null)
      setStep(value => value + 1)
    }
  }, [waiting, conversation?.messages, conversation?.threadId, conversation?.busy, conversation?.error, conversation?.stopping])
  const act = (action: SampleGuideAction) => {
    if (action === 'setup') { onAction(action); return }
    if (step >= 3) {
      setWaiting(rearm(conversation?.messages ?? [], conversation?.threadId ?? null))
    } else setStep(value => value + 1)
    onAction(action)
  }
  const finish = useRef<HTMLButtonElement>(null)
  const card = useRef<HTMLElement>(null)
  const mounted = useRef(false)
  useEffect(() => {
    if (suspended) return
    const opener = document.activeElement as HTMLElement | null
    // Focus the card once; after Settings/consent closes, only move focus to a primary action (never to Skip).
    const target = mounted.current ? card.current?.querySelector<HTMLButtonElement>('button.primary:not([disabled])') : card.current?.querySelector<HTMLButtonElement>('button')
    mounted.current = true
    target?.focus({ preventScroll: true })
    const panel = card.current
    return () => { if (opener?.isConnected && (document.activeElement === document.body || panel?.contains(document.activeElement))) opener.focus({ preventScroll: true }) }
  }, [suspended])
  const [spot, setSpot] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [position, setPosition] = useState({ left: 16, top: 80 })
  // Observe layout, not a timer: scrolling, panel resizing and async source loading
  // can all move the real control underneath this non-modal coach mark.
  useEffect(() => {
    if (suspended) return
    let frame = 0
    let revealed = false
    let target: HTMLElement | null = null
    let previousDescription: string | null = null
    const selector = step === 0 ? '.research-overview-topic' : step === 1 ? '.research-cite' : step === 2
      ? '.wb-paper:not([hidden]) .source-body' : step === 3 && !waiting
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
  }, [step, agentReady, waiting, suspended])
  useEffect(() => { if (step === steps.length) finish.current?.focus() }, [step])
  useEffect(() => {
    const keys = (event: KeyboardEvent) => { if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || document.querySelector('[aria-modal="true"]')) return; const target = event.target as HTMLElement; if (target?.closest?.('input, textarea, [contenteditable="true"]')) return; onClose() }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [onClose])
  const current = step >= 3 && step < steps.length && !agentReady
    ? { action: 'setup' as const, title: steps[step].title, hint: 'You can explore the paper without an account. Set up the agent to ask your own questions. No message is sent and no experiment runs automatically.', button: 'See agent setup' }
    : steps[step]
  return createPortal(<div className="sample-guide-layer" hidden={suspended}>
    {spot ? <div className="sample-guide-spotlight" aria-hidden="true" style={spot} /> : <div className="sample-guide-shade" aria-hidden="true" />}
    <section ref={card} className="sample-onboarding" aria-label="Sample walkthrough" style={position}>
    <div className="sample-guide-heading"><span className="sample-guide-count">{Math.min(step + 1, steps.length)} / {steps.length}</span>
    <div className="sample-guide-progress" aria-label={`${Math.min(step + 1, steps.length)} of ${steps.length} steps`}>
      {steps.map((item, index) => <span key={item.action} className={index < step ? 'done' : index === step ? 'current' : ''} aria-hidden="true" />)}
    </div>
    </div>
    <div id="sample-guide-description" className="sample-guide-copy" aria-live="polite">
      <strong>{waiting ? 'Continue in the chat' : current?.title ?? 'Keep exploring'}</strong>
      <p>{waiting
        ? threadChanged ? 'You switched conversations. Return to the previous chat, or continue the guide here.'
          : waiting.interrupted && !conversation?.busy ? 'The reply was stopped before it finished. Send your question again when ready; the guide continues after a complete reply.'
          : conversation?.error ? 'The agent could not finish. Retry in chat, or skip the guide; your research is still here.'
          : conversation?.busy ? 'The agent is working on your question. Review its reply before choosing what to do next.'
          : 'Your question is in the chat draft. Edit it as you like and send it when ready. The guide continues after a reply; nothing runs automatically.'
        : current?.hint ?? 'You have practiced checking evidence, asking questions and planning your next research step. Continue in chat; review any proposed experiment before approving a run.'}</p>
    </div>
    <div className="sample-guide-actions">
      {threadChanged && <button className="primary" onClick={() => setWaiting(rearm(conversation?.messages ?? [], conversation?.threadId ?? null))}>Continue here</button>}
      {!waiting && current && (step === 5 && agentReady
        ? choices.map(choice => <button key={choice.action} className="primary" disabled={Boolean(conversation?.busy)} onClick={() => act(choice.action)}>{choice.label}</button>)
        : <button className="primary" disabled={step >= 3 && Boolean(conversation?.busy)} onClick={() => act(current.action)}>{current.button}</button>)}
      <button ref={finish} className="ghost" onClick={onClose}>{current ? 'Skip guide' : 'Finish guide'}</button>
    </div>
  </section></div>, document.body)
}
