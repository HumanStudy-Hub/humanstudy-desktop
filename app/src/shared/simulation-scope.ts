import type { HumanProgram } from './human-program'
import { isPlaceholderText } from './program-view'
const REQUIRED = ['steps', 'roles', 'conditions', 'outcomes', 'limits']
/** An assessment is not permission to run. All five boundaries must be explicit and settled. */
export function simulationScope(program: HumanProgram, studyId: string) {
  const nodes = program.nodes.filter(n => n.kind === 'simulation' && (!n.studyIds.length || n.studyIds.includes(studyId)))
  const fields = nodes.flatMap(n => n.fields)
  const meaningful = (value: unknown) => typeof value === 'string' ? !isPlaceholderText(value) : Array.isArray(value) ? value.length > 0 : value !== null && typeof value === 'object' && Object.keys(value).length > 0
  const missing = REQUIRED.filter(id => !fields.some(f => f.id === id && meaningful(f.value) && !['missing', 'decision', 'check'].includes(f.state)))
  const blocking = program.issues.filter(i => i.severity === 'blocking' && (!i.studyId || i.studyId === studyId))
  return { ready: missing.length === 0 && blocking.length === 0, missing, blocking, fields }
}
/** Run intents open the review; ordinary questions about simulation remain normal chat. */
export function requestsSimulation(text: string) {
  if (/\b(?:do not|don't|never|cannot|can't)\b.{0,30}\b(?:simulate|replay|run|simulation)\b|(?:不要|不能|先别|不需要).{0,12}(?:模拟|simulation)/i.test(text)) return false
  return /(?:^|\n)\s*(?:(?:please|can you|could you|let's|i want to)\s+)*(?:simulate|replay)\b|\b(?:run|start|launch|perform)\b.{0,60}\b(?:simulation|study|experiment|pilot)\b|(?:开始|运行|执行|跑|做|帮我|我想).{0,12}(?:模拟|simulation)|(?:模拟一下|跑一下实验)/i.test(text)
}
