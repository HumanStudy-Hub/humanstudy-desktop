export interface QuestionInfo {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiple?: boolean
  custom?: boolean
}
export interface KernelQuestion {
  id: string
  questions: QuestionInfo[]
  answers?: string[][]
  resolved?: 'answered' | 'rejected'
}
export type QuestionPart = KernelQuestion & { kind: 'question'; expired?: boolean }

export function validateAnswers(question: KernelQuestion, answers: string[][]): void {
  if (!question.questions.length || !Array.isArray(answers) || answers.length !== question.questions.length) throw new Error('Answer every question before continuing.')
  question.questions.forEach((q, i) => {
    const values = answers[i]
    if (!Array.isArray(values) || !values.length || values.some(v => typeof v !== 'string' || !v.trim()) || (!q.multiple && values.length !== 1)) throw new Error('Choose an answer for each question.')
    if (q.custom === false && values.some(v => !q.options.some(o => o.label === v))) throw new Error('Choose one of the available options.')
  })
}

/** Answers can arrive after a later message; update the original card, never create a second one. */
export function updateQuestion<M extends { parts: { kind: string; id?: string | number }[] }>(messages: M[], question: KernelQuestion): M[] | null {
  const index = messages.findIndex(m => m.parts.some(p => p.kind === 'question' && p.id === question.id))
  if (index < 0) return null
  return messages.map((m, i) => i !== index ? m : { ...m, parts: m.parts.map(p => {
    if (p.kind !== 'question' || p.id !== question.id) return p
    const old = p as unknown as QuestionPart
    return { ...old, ...question, questions: question.questions.length ? question.questions : old.questions, kind: 'question', expired: false }
  }) })
}
