// Completion is extraction coverage, not scientific correctness or simulation readiness. Missing
// source information is a valid outcome when represented by a missing field and a targeted issue.
import type { HumanProgram, ProgramNode } from './human-program'
import policy from './build-coverage.json'

const meaningful = (v: unknown): boolean => typeof v === 'string' ? v.trim().length > 0 : Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && (typeof v !== 'object' || Object.keys(v).length > 0)
export function buildCoverageProblems(program: HumanProgram): string[] {
  const problems: string[] = []
  if (!program.studies.length) problems.push('Identify the studies before completing the build.')
  if (!program.evidence.length) problems.push('Add the source evidence before completing the build.')
  const content = (n: ProgramNode, studyId: string): boolean => {
    if (meaningful(n.summary) || meaningful(n.description)) return true
    return n.fields.some((f) => (!f.studyIds?.length || f.studyIds.includes(studyId)) &&
      (f.state === 'missing'
        ? program.issues.some((i) => i.nodeId === n.id && (!i.fieldId || i.fieldId === f.id) && (!i.studyId || i.studyId === studyId))
        : meaningful(f.value)))
  }
  for (const study of program.studies) {
    const nodes = program.nodes.filter((n) => !n.studyIds.length || n.studyIds.includes(study.id))
    // Shared paper-level nodes alone cannot account for a newly identified study.
    if (!nodes.some((n) => n.studyIds.includes(study.id) && content(n, study.id)) && !program.steps.some((s) => s.studyId === study.id))
      problems.push(`${study.id}: no study-specific extraction or explicit missing information.`)
    const areas = study.type === 'analysis' ? policy.analysis : policy.empirical
    for (const [area, kinds] of Object.entries(areas)) {
      if (area === 'procedure' && program.steps.some((s) => s.studyId === study.id)) continue
      if (!nodes.some((n) => kinds.includes(n.kind) && content(n, study.id)))
        problems.push(`${study.id}: ${area} has not been extracted or explicitly marked missing.`)
    }
  }
  return problems
}
