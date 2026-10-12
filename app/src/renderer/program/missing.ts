// Which fields still need the researcher. Mirrors the web builder (PipelineStudio): a field is open when
// the agent labelled it `missing` / `decision`, or when its value is a placeholder such as `[填写]`.
// Pure: no React, no i18n, so it is unit-tested directly.
import type { HumanProgram, ProgramField } from '../../shared/human-program';
import { resolveSection, SECTIONS, type Section } from './sections';

export type Need = 'missing' | 'decision';

const WHOLE = /^\s*(\[填写\]|\[missing\]|missing|tbd|unknown|not available|n\/a)?\s*$/i;
const MARKER = /\[(填写|missing)\]/i;

/** True when a text carries no real content: empty, a bare placeholder word, or contains a marker. */
export function isPlaceholderText(raw: string): boolean {
  return WHOLE.test(raw) || MARKER.test(raw);
}

/** `decision`, `missing`, or null when the field is settled. A placeholder value counts as missing. */
export function fieldNeed(f: Pick<ProgramField, 'state' | 'value'>): Need | null {
  if (f.state === 'decision') return 'decision';
  if (f.state === 'missing') return 'missing';
  if (typeof f.value === 'string' && isPlaceholderText(f.value)) return 'missing';
  return null;
}

/** Unique open fields of one section (study-level sections: for one study), keyed node:field or step:rule. */
export function sectionNeeds(program: HumanProgram, section: Section, studyId: string): string[] {
  const r = resolveSection(program, section, studyId);
  const keys = new Set<string>();
  const add = (nodeId: string, f: ProgramField) => { if (fieldNeed(f)) keys.add(`${nodeId}:${f.id}`); };
  for (const e of [...r.items.flatMap(i => i.entries), ...r.leftovers]) if (e.field && e.nodeId) add(e.nodeId, e.field);
  for (const n of r.blocks) for (const f of n.fields) add(n.id, f);
  if (section.id === 'procedure') for (const st of program.steps) if ((!studyId || st.studyId === studyId) && st.rule && fieldNeed(st.rule)) keys.add(`flow:${st.id}:${st.rule.id}`);
  return [...keys];
}

export type AmberCounts = { bySection: Record<string, number>; total: number; first: string | null };
/** Per-section counts, the total across all sections, and the first section (document order) with open items. */
export function amberCounts(program: HumanProgram, studyId: string): AmberCounts {
  const bySection: Record<string, number> = {};
  let total = 0, first: string | null = null;
  for (const sec of SECTIONS) {
    const n = sectionNeeds(program, sec, studyId).length;
    if (n) { bySection[sec.id] = n; total += n; first ??= sec.id; }
  }
  return { bySection, total, first };
}
