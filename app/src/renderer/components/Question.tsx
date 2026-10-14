import { useState } from 'react'
import { validateAnswers, type QuestionPart } from '../../shared/question'
import { t } from '../i18n'

/** The native agent's questions stay in its conversation. No default is submitted implicitly. */
export function QuestionCard({ part, onAnswer, onReject }: {
  part: QuestionPart
  onAnswer(id: string, answers: string[][]): Promise<void>
  onReject(id: string): Promise<void>
}) {
  const [step, setStep] = useState(0)
  const [selected, setSelected] = useState<string[][]>(() => part.questions.map(() => []))
  const [custom, setCustom] = useState<string[]>(() => part.questions.map(() => ''))
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  if (part.resolved || part.expired) return (
    <div className="agent-question settled" role="status">
      {part.questions.map((q, i) => <div key={i}>
        <div>{q.question}</div>
        <strong>{part.resolved === 'answered' ? part.answers?.[i]?.join(', ') : t(part.expired ? 'question.expired' : 'question.skipped')}</strong>
      </div>)}
    </div>
  )
  const q = part.questions[step]
  const answers = selected.map((values, i) => custom[i]?.trim() ? [...values, custom[i].trim()] : values)
  const ready = Boolean(answers[step]?.length)
  const finish = async (reject = false) => {
    if (sending) return
    setError('')
    setSending(true)
    try {
      if (reject) await onReject(part.id)
      else { validateAnswers(part, answers); await onAnswer(part.id, answers) }
    } catch (e) { setError(String(e)) }
    finally { setSending(false) }
  }
  if (!q) return <div className="agent-question">
    <div>{t('question.empty')}</div>
    {error && <div className="part error" role="alert">{error}</div>}
    <button className="ghost" disabled={sending} onClick={() => void finish(true)}>{t('question.skip')}</button>
  </div>
  const next = () => {
    if (!ready || sending) return
    setError('')
    if (step < part.questions.length - 1) setStep(step + 1)
    else void finish()
  }
  return (
    <form className="agent-question" aria-label={q.question} onSubmit={e => { e.preventDefault(); next() }}
      onKeyDown={e => { if (!e.nativeEvent.isComposing && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.stopPropagation(); next() } }}>
      {part.questions.length > 1 && <div className="question-progress">{step + 1} / {part.questions.length}</div>}
      <fieldset disabled={sending}>
        <legend>{q.question}</legend>
        {q.options.map((option, i) => <label className="question-option" key={`${step}:${i}`}>
          <input type={q.multiple ? 'checkbox' : 'radio'} name={`question-${part.id}-${step}`} checked={selected[step].includes(option.label)}
            onChange={() => {
              setSelected(old => old.map((v, n) => n !== step ? v : q.multiple
                ? v.includes(option.label) ? v.filter(x => x !== option.label) : [...v, option.label]
                : [option.label]))
              if (!q.multiple) setCustom(old => old.map((v, n) => n === step ? '' : v))
            }} />
          <span><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</span>
        </label>)}
        {q.custom !== false && <label className="question-custom">{t('question.other')}
          <textarea rows={2} value={custom[step]} onChange={e => {
            setCustom(old => old.map((v, n) => n === step ? e.target.value : v))
            if (!q.multiple && e.target.value.trim()) setSelected(old => old.map((v, n) => n === step ? [] : v))
          }} />
        </label>}
      </fieldset>
      {error && <div className="part error" role="alert">{error}</div>}
      <div className="question-actions">
        {step > 0 && <button type="button" className="ghost" disabled={sending} onClick={() => setStep(step - 1)}>{t('question.back')}</button>}
        <button type="submit" className="primary" disabled={!ready || sending}>{t(sending ? 'question.sending' : step < part.questions.length - 1 ? 'question.next' : 'question.continue')}</button>
        <button type="button" className="ghost" disabled={sending} onClick={() => void finish(true)}>{t('question.skip')}</button>
      </div>
    </form>
  )
}
