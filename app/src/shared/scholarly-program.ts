import { validateHumanProgram, type HumanProgram } from './human-program'
import coverage from './build-coverage.json'

/** A scholarly view of a protocol, not a second definition of its executable flow. */
export const SCHOLARLY_PROFILE = 'scholarly-v1'
export const scholarlyKinds = coverage.scholarly
export type ScholarlyProfile = { profile: typeof SCHOLARLY_PROFILE; protocol: { path: 'protocol.json'; id: string; sha256: string }; studyArms?: Record<string, string[]> }

export function scholarlyProfile(p: HumanProgram | null): ScholarlyProfile | null {
  const x = p?.extensions?.scholarly as unknown as ScholarlyProfile | undefined
  return x?.profile === SCHOLARLY_PROFILE ? x : null
}

/** A paper's experiment can cover several engine arms; do not turn conditions into studies. */
export function scholarlyArmIds(p: HumanProgram, studyId: string): string[] {
  const mapped = scholarlyProfile(p)?.studyArms?.[studyId]
  return Array.isArray(mapped) ? mapped.filter(id => typeof id === 'string') : [studyId]
}

/** Structural completeness only. Source fidelity still requires reading the original evidence. */
export function scholarlyProblems(value: unknown, protocol: any, hash: string): string[] {
  let p: HumanProgram
  try { p = validateHumanProgram(value) } catch (e) { return [String(e)] }
  const profile = scholarlyProfile(p), out: string[] = []
  if (!profile) return ['Declare the scholarly-v1 profile.']
  if (profile.protocol?.path !== 'protocol.json' || profile.protocol.id !== protocol?.id || profile.protocol.sha256 !== hash)
    out.push('The research document needs to be checked against the current experiment version.')
  if (p.steps.length) out.push('The scholarly profile references the protocol; it must not duplicate executable steps.')
  const arms = new Set((Array.isArray(protocol?.arms) ? protocol.arms : []).map((a: any) => a.id))
  const covered = new Set(p.studies.flatMap(s => scholarlyArmIds(p, s.id)))
  for (const id of arms) if (!covered.has(id as string)) out.push(`Research coverage is missing experiment scope ${id}.`)
  for (const [study, ids] of Object.entries(profile.studyArms ?? {})) {
    if (!p.studies.some(s => s.id === study) || !Array.isArray(ids) || ids.some(id => !arms.has(id))) out.push(`${study}: experiment scope references do not resolve.`)
  }
  const evidence = new Set(p.evidence.filter(e => (e.path || e.sourceId || e.url) && (e.locator.page || e.locator.pointer) && e.quote?.trim()).map(e => e.id))
  for (const kind of scholarlyKinds) if (!p.nodes.some(n => n.kind === kind && n.fields.length)) out.push(`Research coverage is missing ${kind}.`)
  const effects = new Set(['effects', 'effects_means', 'targets', 'blocked_arm_effects', 'blocked_arm_targets']
    .flatMap(key => protocol?.analysis?.[key] ?? []).map((e: any) => e.id))
  const resultStudies = new Set<string>()
  for (const n of p.nodes) {
    const refs = n.extensions?.effectRefs ?? []
    if (!Array.isArray(refs)) out.push(`${n.id}: result references must be a list.`)
    else for (const id of refs) if (!effects.has(id)) out.push(`${n.id}: result reference ${id} does not exist.`)
    for (const f of n.fields) {
      const gap = f.extensions?.gapReason
      if (n.kind === 'result' && (f.state === 'missing' || ['reported', 'verbatim'].includes(f.origin))) {
        for (const studyId of f.studyIds ?? n.studyIds) {
          if (!n.studyIds.length || n.studyIds.includes(studyId)) resultStudies.add(studyId)
        }
      }
      if (f.state !== 'missing' && (f.value === null || typeof f.value === 'string' && !f.value.trim())) out.push(`${n.id}.${f.id}: provide supported content or an explicit source gap.`)
      if (gap === 'not_extracted') out.push(`${n.id}.${f.id}: extraction is not finished.`)
      if (f.state === 'missing') {
        if (!['not_reported', 'source_unavailable'].includes(String(gap))) out.push(`${n.id}.${f.id}: explain the missing source information.`)
        if (gap === 'not_reported' && !f.evidenceIds.some(id => evidence.has(id))) out.push(`${n.id}.${f.id}: cite what was checked before declaring this unreported.`)
      } else if (!f.evidenceIds.some(id => evidence.has(id))) out.push(`${n.id}.${f.id}: include original-source evidence.`)
      if (f.origin === 'derived' && !f.derivation?.trim()) out.push(`${n.id}.${f.id}: explain the interpretation.`)
    }
  }
  for (const study of p.studies) {
    if (!resultStudies.has(study.id)) out.push(`${study.id}: include an original human result or document why it is unavailable.`)
  }
  return out
}

export function prepareExperimentPrompt(study: { id: string; title: string }, arms: string[] = [study.id]): string {
  return `I want to run ${study.title} (${study.id}${arms.length ? `; experiment scopes ${arms.join(', ')}` : ''}). Prepare only this experiment's supported scope from the original sources; reuse a current validated scope instead of rebuilding it. Preserve the other experiments and my edits. Check the exact materials, procedure and analysis; ask me a specific question or request a material only when it is needed. If original wording or rules are unavailable, explain the gap and propose a separate modified version for my confirmation; do not silently fill it in. Show the participant preview and supported outcomes. Do not start model calls until I approve the simulation scope and cost.`
}
