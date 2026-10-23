import type { HumanProgram } from './human-program'
import { isPlaceholderText } from './program-view'
const REQUIRED = ['steps', 'roles', 'conditions', 'outcomes', 'limits']
const inStudy = (ids: string[] | undefined, studyId: string) => !ids?.length || ids.includes(studyId)
/** An assessment is not permission to run. All five boundaries must be stated, none may be an open
 *  gap or decision, and no blocking issue may remain. A field the agent marked "check" counts as
 *  stated: the Simulation tab shows it, and pressing Run is the researcher's confirmation of it. */
export function simulationScope(program: HumanProgram, studyId: string) {
  const nodes = program.nodes.filter(n => n.kind === 'simulation' && inStudy(n.studyIds, studyId))
  const fields = nodes.flatMap(n => n.fields)
  const meaningful = (value: unknown) => typeof value === 'string' ? !isPlaceholderText(value) : Array.isArray(value) ? value.length > 0 : value !== null && typeof value === 'object' && Object.keys(value).length > 0
  const missing = REQUIRED.filter(id => !fields.some(f => f.id === id && meaningful(f.value) && !['missing', 'decision'].includes(f.state)))
  const blocking = program.issues.filter(i => i.severity === 'blocking' && (!i.studyId || i.studyId === studyId))
  return { ready: missing.length === 0 && blocking.length === 0, missing, blocking, fields }
}
/** What cannot be simulated, in the agent's words (section 12 `limits`), plus the open decisions of
 *  this study the run will have to settle (the agent uses the paper's reported design or asks). */
export function simulationLimits(program: HumanProgram, studyId: string): { text: string[]; decisions: { id: string; title: string }[] } {
  const fields = program.nodes.filter(n => n.kind === 'simulation' && inStudy(n.studyIds, studyId)).flatMap(n => n.fields).filter(f => f.id === 'limits')
  const text = fields.flatMap(f => Array.isArray(f.value) ? f.value.map(v => typeof v === 'string' ? v : JSON.stringify(v)) : typeof f.value === 'string' && !isPlaceholderText(f.value) ? [f.value] : [])
    .map(s => s.trim()).filter(Boolean)
  const decisions = program.issues.filter(i => i.severity === 'decision' && (!i.studyId || i.studyId === studyId)).map(i => ({ id: i.id, title: i.title }))
  return { text, decisions }
}
/** The chat shows an approval as what the researcher confirmed, not as its machine-readable header. */
export function approvalRequest(text: string): string | null {
  if (!text.startsWith('[Simulation scope approved]')) return null
  const lines = text.split('\n')
  return lines.slice(2).join('\n').trim()
}
