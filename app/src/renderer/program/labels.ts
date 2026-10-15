// Human-readable names for program item ids (nodes, and `flow:<stepId>` for steps), used by the
// selection chips and the context line sent to the agent. Works on the raw program.json object.
export interface SelectedItem {
  id: string
  title: string
}

type Loose = { nodes?: { id?: string; title?: string }[]; steps?: { id?: string; title?: string }[] }

export function itemTitle(program: unknown, id: string): string {
  const p = (program ?? {}) as Loose
  if (id.startsWith('flow:')) {
    const step = p.steps?.find((s) => s.id === id.slice(5))
    return step?.title ?? id
  }
  return p.nodes?.find((n) => n.id === id)?.title ?? id
}

export function labelItems(program: unknown, ids: string[]): SelectedItem[] {
  return ids.map((id) => ({ id, title: itemTitle(program, id) }))
}

/** The context block that precedes a message about selected items. */
export function selectionContext(items: SelectedItem[]): string {
  if (!items.length) return ''
  return `[Selected study items]\n${items.map((i) => `- ${i.id} — ${i.title}`).join('\n')}\n\n`
}

/** Display names for node kinds, including the kinds the Study document added. */
export const KIND_LABELS: Record<string, string> = {
  overview: 'Overview',
  finding: 'Findings and contributions',
  limitation: 'Validity, limitations and replication',
  simulation: 'Can it be simulated?',
}

/** Display names for the field ids the Study document expects (used when a field carries no label). */
export const FIELD_LABELS: Record<string, string> = {
  // 01 overview
  'method-type': 'Method type', summary: 'Summary',
  // 04 participants
  setting: 'Setting', roles: 'Participant types and roles', recruitment: 'Recruitment', eligibility: 'Eligibility',
  'n-recruited': 'N recruited', 'n-completed': 'N completed', 'n-analysed': 'N analysed', characteristics: 'Characteristics',
  'unit-of-analysis': 'Unit of analysis', compensation: 'Pay and incentives', attrition: 'Attrition and exclusions',
  // 05 design
  control: 'Control', assignment: 'Assignment', order: 'Order and counterbalancing', blinding: 'Blinding', 'manipulation-check': 'Manipulation check',
  // 07 variables
  scale: 'Scale', scoring: 'Scoring', timing: 'Timing', definition: 'Definition', 'observation-unit': 'Observation unit',
  // 08 analysis
  aim: 'Aim and comparison', inputs: 'Data included and exclusions', method: 'Statistical method', criterion: 'Decision criterion', coding: 'Qualitative coding', robustness: 'Robustness checks',
  // 09 results
  descriptives: 'Descriptives', effect: 'Effect size and direction', uncertainty: 'Uncertainty', test: 'Test statistics', heterogeneity: 'Subgroup differences', themes: 'Qualitative themes',
  // 10 findings
  answer: 'Answer to the question', support: 'Hypothesis support', 'mechanism-tested': 'Mechanism, tested', 'mechanism-proposed': 'Mechanism, speculated',
  contribution: 'Contribution', 'design-principles': 'Design principles',
  // 11 limitations
  validity: 'Credibility of the inference', scope: 'Generalisability', limitations: 'Limitations', replications: 'Replications reported by the paper', openness: 'Materials, data, code, preregistration',
  // 12 simulation
  steps: 'Steps AI participants can perform', outcomes: 'Outcomes that can be measured', limits: 'What cannot be simulated', conditions: 'Conditions',
}

export const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind
export const fieldLabel = (id: string, label?: string): string => label?.trim() || FIELD_LABELS[id] || id
