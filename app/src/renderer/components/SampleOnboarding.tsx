import { useEffect, useRef, useState } from 'react'
import { validateHumanProgram } from '../../shared/human-program'

/** Identify the bundled sample by its stable document identity, never a user-editable project name. */
export function walkthroughSample(input: unknown) {
  try { const program = validateHumanProgram(input); return program.id === 'mazzarella2018politeness-research' ? program : null } catch { return null }
}

export type SampleGuideAction = 'overview' | 'source' | 'participant' | 'trial'
const steps: { action: SampleGuideAction; title: string; hint: string; button: string }[] = [
  { action: 'overview', title: 'Find the research question', hint: 'Start with what the paper asks, predicts and finds.', button: 'Show the overview' },
  { action: 'source', title: 'Check it against the paper', hint: 'Open a cited passage beside the study. The source stays one click away.', button: 'Compare with the source' },
  { action: 'participant', title: 'Step into the experiment', hint: 'Explore the participant view. Try its conditions and pages; these are examples, not results.', button: 'Explore participant view' },
  { action: 'trial', title: 'Make it your own', hint: 'Put a small trial request in the chat. Review it before sending; nothing runs automatically.', button: 'Draft a trial request' },
]

/** A non-modal tour of the real editable sample. Progress means a view was opened, not scientific validation. */
export function SampleOnboarding({ onClose, onAction }: { onClose(): void; onAction(action: SampleGuideAction): void }) {
  const [step, setStep] = useState(0)
  const finish = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (step === steps.length) finish.current?.focus() }, [step])
  useEffect(() => {
    const keys = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[aria-modal="true"]')) onClose() }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [onClose])
  const current = steps[step]
  return <section className="sample-onboarding" aria-label="Sample walkthrough">
    <div className="sample-guide-progress" aria-label={`${Math.min(step + 1, 4)} of 4 steps`}>
      {steps.map((item, index) => <span key={item.action} className={index < step ? 'done' : index === step ? 'current' : ''} aria-hidden="true" />)}
    </div>
    <div className="sample-guide-copy" aria-live="polite">
      <strong>{current?.title ?? 'Your turn'}</strong>
      <p>{current?.hint ?? 'The request is ready in chat. Edit it, send it when you want, or keep exploring the paper.'}</p>
    </div>
    <div className="sample-guide-actions">
      {current && <button className="primary" onClick={() => { onAction(current.action); setStep(value => value + 1) }}>{current.button}</button>}
      <button ref={finish} className="ghost" onClick={onClose}>{current ? 'Skip guide' : 'Finish guide'}</button>
    </div>
  </section>
}
