// The study model as data: what the Study view draws for each of the 12 sections (cards, the
// procedure flow, conditions, materials, the studies of the paper) and the review questions (the
// agent's issues plus every amber field). Pure: no React, so it is unit-tested directly.
// Layout follows the web build-preview study model (app/build-preview/study-model.tsx, model-review.ts).
import type { HumanProgram, ProgramField, ProgramNode } from '../../shared/human-program';
import { fieldText, itemSources, sourceRefs, studyConditions, studyFlow, type FlowItem, type SourceRef } from '../../shared/program-view';
import { amberItems, fieldNeed, type Need } from './missing';
import { claimedKinds, resolveSection, SECTIONS, type Entry, type Section } from './sections';
import { fieldLabel } from './labels';
import { t } from '../i18n';

export type Card = {
  key: string;
  /** Node id, or `flow:<stepId>`; absent for paper metadata. */
  entity?: string;
  fieldId?: string;
  field?: ProgramField;
  node?: ProgramNode;
  kicker?: string;
  /** The section item the card belongs to (named on the card when a section mixes items). */
  item?: string;
  title: string;
  text: string;
  refs: SourceRef[];
  need: Need | null;
  /** A short value shown as a fact tile rather than a card. */
  fact?: boolean;
  tone?: number;
  verbatim?: boolean;
};
export type StudyCard = { id: string; title: string; type: string; text: string; meta: string[]; refs: SourceRef[] };
export type Stage = {
  section: Section;
  /** 01: the paper itself, shown as the heading of the model. */
  paper?: { title: string; meta: string[] };
  cards: Card[];
  facts: Card[];
  conditions: Card[];
  materials: Card[];
  flow: FlowItem[];
  /** 06 without steps: the procedure is not mapped (or the unit only analyses data). */
  flowState?: 'unmapped' | 'analysis';
  studies: StudyCard[];
  /** Item labels with nothing recorded yet. */
  notRecorded: string[];
  empty: boolean;
};

const FACT_MAX = 42;
const flat = (text: string) => text.replace(/\s+/g, ' ').trim();

function fieldCard(program: HumanProgram, entry: Entry, multiField: boolean): Card {
  const f = entry.field!, text = f.value === null ? '' : fieldText(f.value), need = fieldNeed(f);
  // "Node · Field" labels name the node first; on a card the node is the title. The field is named
  // only where an item gathers several fields (recruitment and eligibility), never as a bare echo.
  const cut = entry.label.lastIndexOf(' · ');
  const title = cut > 0 ? entry.label.slice(0, cut) : entry.label;
  const kicker = cut > 0 && multiField ? entry.label.slice(cut + 3) : undefined;
  return { key: entry.key, entity: entry.nodeId, fieldId: f.id, field: f, node: entry.node, kicker, title, text, need,
    refs: sourceRefs(program, f.evidenceIds), fact: !need && flat(text).length <= FACT_MAX && !text.includes('\n') };
}
function nodeCard(program: HumanProgram, n: ProgramNode, extra: Partial<Card> = {}): Card {
  // A field that only classifies the node (result kind: reported) says nothing on a card.
  const fields = n.fields.filter(f => (f.value !== null && f.value !== '' || fieldNeed(f)) && !/^(result-)?kind$/.test(f.id));
  const text = n.description?.trim() || fields.map(f => fields.length > 1 ? `${fieldLabel(f.id, f.label)}: ${flat(fieldText(f.value))}` : fieldText(f.value)).join('\n');
  const need = fields.map(fieldNeed).find(Boolean) ?? null;
  return { key: n.id, entity: n.id, node: n, title: n.title, text, need, refs: itemSources(program, n.id), ...extra };
}

export function stage(program: HumanProgram, section: Section, studyId: string): Stage {
  const r = resolveSection(program, section, studyId);
  const out: Stage = { section, cards: [], facts: [], conditions: [], materials: [], flow: [], studies: [], notRecorded: [], empty: false };
  const conditions = studyConditions(program, studyId);
  const push = (c: Card) => (c.fact ? out.facts : out.cards).push(c);
  const paper: string[] = [];
  for (const ri of r.items) {
    const { item } = ri;
    // Name the field only where one node gives this item several (recruitment and eligibility).
    const multiField = (e: Entry) => ri.entries.filter(x => x.nodeId === e.nodeId).length > 1;
    if (item.sourceKey) {
      const text = ri.entries[0]?.text;
      if (item.sourceKey === 'title') { if (text) out.paper = { title: text, meta: paper }; }
      else if (text) paper.push(item.sourceKey === 'doi' ? `DOI ${text}` : text);
      else out.notRecorded.push(item.label);
      continue;
    }
    if (item.derived) continue;
    if (item.special === 'steps') {
      out.flow = studyFlow(program, studyId);
      if (!out.flow.length) out.flowState = program.studies.find(st => st.id === studyId)?.type === 'analysis' ? 'analysis' : 'unmapped';
      continue;
    }
    if (item.special === 'conditions') {
      const nodes = ri.entries.filter(e => e.node?.kind === 'condition').map(e => e.node!);
      if (nodes.length) { out.conditions = nodes.map(n => nodeCard(program, n, { tone: conditions.findIndex(c => c.id === n.id) })); continue; }
    }
    if (item.special === 'materials') {
      out.materials = ri.entries.filter(e => e.node).map(e => nodeCard(program, e.node!, { verbatim: e.node!.fields.some(f => f.origin === 'verbatim'), kicker: e.node!.conditionIds?.length ? conditions.filter(c => e.node!.conditionIds!.includes(c.id)).map(c => c.label).join(', ') : undefined, tone: conditions.findIndex(c => e.node!.conditionIds?.includes(c.id)) }));
      if (!out.materials.length) out.notRecorded.push(item.label);
      continue;
    }
    if (!ri.present) { out.notRecorded.push(item.label); continue; }
    for (const e of ri.entries) {
      if (e.field && e.nodeId) push({ ...fieldCard(program, e, multiField(e)), item: item.label });
      else if (e.node && !e.text) push(nodeCard(program, e.node));
      else push({ key: e.key, entity: e.node?.id, node: e.node, title: e.label, text: e.text, need: null, refs: e.node ? itemSources(program, e.node.id) : [] });
    }
  }
  if (section.id === 'map') out.studies = program.studies.map(st => {
    const tests = program.nodes.filter(n => n.kind === 'hypothesis' && (!n.studyIds.length || n.studyIds.includes(st.id)));
    const meta = [st.dependsOn?.length ? t('doc.builds_on', { x: st.dependsOn.map(id => program.studies.find(s => s.id === id)?.title ?? id).join(', ') }) : '', tests.length ? t('doc.tests', { x: tests.map(n => n.title).join('; ') }) : ''].filter(Boolean);
    const scoped = program.nodes.filter(n => n.studyIds.includes(st.id));
    return { id: st.id, title: st.title, type: st.type, text: st.description?.trim() ?? '', meta, refs: scoped.flatMap(n => itemSources(program, n.id)).slice(0, 1) };
  });
  for (const e of r.leftovers) e.field && e.nodeId ? push(fieldCard(program, e, true)) : push({ key: e.key, entity: e.node?.id, node: e.node, title: e.label, text: e.text, need: null, refs: e.node ? itemSources(program, e.node.id) : [] });
  // Cards of several items side by side: name the item where the title does not already.
  if (new Set(out.cards.map(c => c.item)).size > 1) for (const c of out.cards) if (c.item && !c.kicker && c.title !== c.item) c.kicker = c.item;
  // Results: each node is shown whole; the items only document what such a node holds.
  if (section.blocks && r.blocks.length) { out.notRecorded = []; out.facts = []; out.cards = r.blocks.map(n => nodeCard(program, n)); }
  out.empty = !out.paper && !out.cards.length && !out.facts.length && !out.conditions.length && !out.materials.length && !out.flow.length && !out.studies.length && !out.flowState;
  return out;
}

/** Nodes no section claims ("Other details"). */
export function otherCards(program: HumanProgram, studyId: string): Card[] {
  const claimed = claimedKinds();
  return program.nodes.filter(n => !claimed.has(n.kind) && (!studyId || !n.studyIds.length || n.studyIds.includes(studyId))).map(n => nodeCard(program, n));
}

/* ---- review questions (web: model-review.ts modelIssues + prioritizeReviewIssues) ---- */

export type ReviewIssue = {
  id: string; title: string; severity: 'blocking' | 'decision' | 'check';
  reason: string; impact: string; suggestedAction: string;
  entity?: string; fieldId?: string; source?: SourceRef; quote?: string;
  /** A field the researcher fills in directly (amber), rather than an issue the agent raised. */
  amber?: boolean;
};
const RANK = { blocking: 0, decision: 1, check: 2 };

/** The agent's issues for this study and every amber field no issue already covers, most urgent first. */
export function reviewIssues(program: HumanProgram, studyId: string, sections: Section[] = SECTIONS): ReviewIssue[] {
  const issues: ReviewIssue[] = program.issues.filter(i => !studyId || !i.studyId || i.studyId === studyId).map(i => {
    const entity = i.nodeId ?? (i.stepId ? `flow:${i.stepId}` : undefined);
    const source = sourceRefs(program, i.evidenceIds)[0] ?? (entity ? itemSources(program, entity)[0] : undefined);
    return { id: i.id, title: i.title, severity: i.severity, reason: i.reason, impact: i.impact, suggestedAction: i.suggestedAction, entity, fieldId: i.fieldId, source, quote: source?.quote };
  });
  const titleOf = (entity: string) => entity.startsWith('flow:') ? program.steps.find(s => s.id === entity.slice(5))?.title ?? entity : program.nodes.find(n => n.id === entity)?.title ?? entity;
  const fieldOf = (entity: string, fieldId: string) => entity.startsWith('flow:') ? program.steps.find(s => s.id === entity.slice(5))?.rule : program.nodes.find(n => n.id === entity)?.fields.find(f => f.id === fieldId);
  for (const a of amberItems(program, studyId, sections)) {
    if (issues.some(i => i.entity === a.entity && (!i.fieldId || i.fieldId === a.fieldId))) continue;
    const f = fieldOf(a.entity, a.fieldId), need = f ? fieldNeed(f) : 'missing';
    const source = (f ? sourceRefs(program, f.evidenceIds)[0] : undefined) ?? itemSources(program, a.entity)[0];
    issues.push({ id: `amber:${a.key}`, title: `${fieldLabel(a.fieldId, f?.label)} · ${titleOf(a.entity)}`, severity: need === 'decision' ? 'decision' : 'check', amber: true,
      reason: need === 'decision' ? t('doc.needs_input') : t('doc.missing_label'), impact: '', suggestedAction: '', entity: a.entity, fieldId: a.fieldId, source, quote: source?.quote });
  }
  return issues.map((i, n) => ({ i, n })).sort((a, b) => RANK[a.i.severity] - RANK[b.i.severity] || a.n - b.n).map(x => x.i);
}
