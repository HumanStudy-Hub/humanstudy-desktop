// The Study document's sections, as data. The collaborator may reorder, rename or regroup these;
// ProgramDocument renders whatever this list says. Source: docs/design/study-document.md.
import type { HumanProgram, ProgramField, ProgramNode } from '../../shared/human-program';
import { fieldText } from '../../shared/program-view';
import { fieldLabel } from './labels';
import { tOr } from '../i18n';

export type SectionItem = {
  id: string;
  label: string;
  /** Node kinds that feed this item. */
  kinds: string[];
  /** Field ids on those nodes that feed it (several ids are aliases). Absent: every field of the node. */
  fieldIds?: string[];
  /** Variable items: nodes whose `role` field matches (regular expression source, case-insensitive). */
  role?: string;
  /** Value comes from the program's `source` object. */
  sourceKey?: 'title' | 'authors' | 'venue' | 'doi' | 'version';
  /** Value is derived from the studies list / hypotheses rather than a node field. */
  derived?: 'study-aim' | 'study-relations' | 'study-tests';
  /** Rendered in a dedicated way: condition chips, the step list, the materials list. */
  special?: 'conditions' | 'steps' | 'materials';
};
export type Section = {
  id: string;
  number: string;
  title: string;
  /** Shown as a tooltip only. */
  titleZh: string;
  /** Paper-level sections appear once; study-level sections repeat per study. */
  level: 'paper' | 'study';
  openByDefault: boolean;
  items: SectionItem[];
  /** Result nodes are shown whole; the items only document what they hold. */
  blocks?: boolean;
  /** Content is the agent's assessment (origin `implementation`), never a paper fact. */
  assessment?: boolean;
};

const IV = '^(iv|independent|manipulat|predictor|treatment|factor)';
const DV = '^(dv|dependent|outcome|response|measure)';
const OTHER = '(moderator|mediator|covariate|control|confound|other)';

export const SECTIONS: Section[] = [
  { id: 'overview', number: '01', title: 'Paper overview', titleZh: '论文概览', level: 'paper', openByDefault: true, items: [
    { id: 'title', label: 'Title', kinds: [], sourceKey: 'title' },
    { id: 'authors', label: 'Authors', kinds: [], sourceKey: 'authors' },
    { id: 'venue', label: 'Venue', kinds: [], sourceKey: 'venue' },
    { id: 'doi', label: 'DOI', kinds: [], sourceKey: 'doi' },
    { id: 'version', label: 'Version read', kinds: [], sourceKey: 'version' },
    { id: 'method-type', label: 'Method type', kinds: ['overview'], fieldIds: ['method-type'] },
    { id: 'summary', label: 'Summary', kinds: ['overview'], fieldIds: ['summary'] },
  ] },
  { id: 'question', number: '02', title: 'Research questions & hypotheses', titleZh: '研究问题与假设', level: 'paper', openByDefault: false, items: [
    { id: 'question', label: 'Research question', kinds: ['background'], fieldIds: ['question'] },
    { id: 'gap', label: 'Background and gap', kinds: ['background'], fieldIds: ['gap'] },
    { id: 'theory', label: 'Theory and key concepts', kinds: ['background'], fieldIds: ['theory', 'concepts'] },
    { id: 'hypotheses', label: 'Hypotheses', kinds: ['hypothesis'], fieldIds: ['statement', 'hypothesis'] },
    { id: 'scope', label: 'Scope conditions', kinds: ['hypothesis'], fieldIds: ['scope'] },
  ] },
  { id: 'map', number: '03', title: 'Study map', titleZh: '研究地图', level: 'paper', openByDefault: true, items: [
    { id: 'aim', label: 'Aim', kinds: [], derived: 'study-aim' },
    { id: 'relations', label: 'Relations', kinds: [], derived: 'study-relations' },
    { id: 'tests', label: 'Tests', kinds: [], derived: 'study-tests' },
  ] },
  { id: 'participants', number: '04', title: 'Participants & context', titleZh: '被试与情境', level: 'study', openByDefault: false, items: [
    { id: 'setting', label: 'Setting', kinds: ['participants'], fieldIds: ['setting'] },
    { id: 'roles', label: 'Participant types and roles', kinds: ['participants'], fieldIds: ['roles'] },
    { id: 'recruitment', label: 'Recruitment and eligibility', kinds: ['participants'], fieldIds: ['recruitment', 'eligibility'] },
    { id: 'n', label: 'N recruited / completed / analysed', kinds: ['participants'], fieldIds: ['n-recruited', 'n-completed', 'n-analysed'] },
    { id: 'characteristics', label: 'Characteristics', kinds: ['participants'], fieldIds: ['characteristics'] },
    { id: 'unit', label: 'Unit of analysis', kinds: ['participants'], fieldIds: ['unit-of-analysis'] },
    { id: 'compensation', label: 'Pay and incentives', kinds: ['participants'], fieldIds: ['compensation'] },
    { id: 'attrition', label: 'Attrition and exclusions', kinds: ['participants'], fieldIds: ['attrition'] },
  ] },
  { id: 'design', number: '05', title: 'Design & conditions', titleZh: '设计与条件', level: 'study', openByDefault: false, items: [
    { id: 'type', label: 'Design type', kinds: ['design'], fieldIds: ['type'] },
    { id: 'conditions', label: 'Conditions', kinds: ['condition', 'design'], fieldIds: ['conditions'], special: 'conditions' },
    { id: 'control', label: 'Control', kinds: ['design'], fieldIds: ['control'] },
    { id: 'assignment', label: 'Assignment', kinds: ['design'], fieldIds: ['assignment'] },
    { id: 'order', label: 'Order and counterbalancing', kinds: ['design'], fieldIds: ['order'] },
    { id: 'blinding', label: 'Blinding', kinds: ['design'], fieldIds: ['blinding'] },
    { id: 'manipulation-check', label: 'Manipulation checks', kinds: ['design'], fieldIds: ['manipulation-check'] },
  ] },
  { id: 'procedure', number: '06', title: 'Task, procedure & materials', titleZh: '任务、流程与材料', level: 'study', openByDefault: true, items: [
    { id: 'task', label: 'Task and goal', kinds: ['procedure'], fieldIds: ['task', 'goal'] },
    { id: 'steps', label: 'Procedure steps and timing', kinds: ['procedure'], special: 'steps' },
    { id: 'materials', label: 'Instructions and stimuli', kinds: ['material'], special: 'materials' },
    { id: 'actions', label: 'Available actions and visible information', kinds: ['procedure'], fieldIds: ['actions', 'visible'] },
    { id: 'feedback', label: 'Feedback and payoff rules', kinds: ['procedure'], fieldIds: ['feedback', 'payoff'] },
    { id: 'stopping', label: 'Stopping rule', kinds: ['procedure'], fieldIds: ['stopping'] },
  ] },
  { id: 'variables', number: '07', title: 'Variables & measures', titleZh: '变量与测量', level: 'study', openByDefault: false, items: [
    { id: 'constructs', label: 'Constructs and operationalisation', kinds: ['variable'], fieldIds: ['definition'] },
    { id: 'iv', label: 'Independent variables', kinds: ['variable'], role: IV },
    { id: 'dv', label: 'Dependent variables', kinds: ['variable'], role: DV },
    { id: 'other', label: 'Other variables', kinds: ['variable'], role: OTHER },
    { id: 'scale', label: 'Scales and scoring', kinds: ['variable'], fieldIds: ['scale', 'scoring'] },
    { id: 'timing', label: 'Timing and record unit', kinds: ['variable', 'record'], fieldIds: ['timing', 'observation-unit', 'columns'] },
  ] },
  { id: 'analysis', number: '08', title: 'Analysis', titleZh: '分析', level: 'study', openByDefault: false, items: [
    { id: 'aim', label: 'Aim and comparison', kinds: ['analysis'], fieldIds: ['aim'] },
    { id: 'inputs', label: 'Data included and exclusions', kinds: ['analysis'], fieldIds: ['inputs'] },
    { id: 'method', label: 'Statistical method', kinds: ['analysis'], fieldIds: ['method'] },
    { id: 'criterion', label: 'Decision criterion', kinds: ['analysis'], fieldIds: ['criterion'] },
    { id: 'coding', label: 'Qualitative coding', kinds: ['analysis'], fieldIds: ['coding'] },
    { id: 'robustness', label: 'Robustness checks', kinds: ['analysis'], fieldIds: ['robustness'] },
  ] },
  { id: 'results', number: '09', title: 'Results', titleZh: '结果', level: 'study', openByDefault: false, blocks: true, items: [
    { id: 'descriptives', label: 'Per-condition descriptives', kinds: ['result'], fieldIds: ['descriptives'] },
    { id: 'effect', label: 'Effect size and direction', kinds: ['result'], fieldIds: ['effect'] },
    { id: 'uncertainty', label: 'Uncertainty', kinds: ['result'], fieldIds: ['uncertainty'] },
    { id: 'test', label: 'Test statistics', kinds: ['result'], fieldIds: ['test'] },
    { id: 'heterogeneity', label: 'Subgroup and condition differences', kinds: ['result'], fieldIds: ['heterogeneity'] },
    { id: 'themes', label: 'Qualitative themes', kinds: ['result'], fieldIds: ['themes'] },
  ] },
  { id: 'findings', number: '10', title: 'Findings & contributions', titleZh: '发现与贡献', level: 'paper', openByDefault: false, items: [
    { id: 'answer', label: 'Answer to the question', kinds: ['finding'], fieldIds: ['answer'] },
    { id: 'support', label: 'Hypothesis support', kinds: ['finding'], fieldIds: ['support'] },
    { id: 'mechanism-tested', label: 'Mechanism, tested', kinds: ['finding'], fieldIds: ['mechanism-tested'] },
    { id: 'mechanism-proposed', label: 'Mechanism, speculated', kinds: ['finding'], fieldIds: ['mechanism-proposed'] },
    { id: 'contribution', label: 'Theoretical and practical contribution', kinds: ['finding'], fieldIds: ['contribution'] },
    { id: 'design-principles', label: 'Design principles', kinds: ['finding'], fieldIds: ['design-principles'] },
  ] },
  { id: 'validity', number: '11', title: 'Validity, limitations & replication', titleZh: '效度、局限与复现', level: 'paper', openByDefault: false, items: [
    { id: 'validity', label: 'Credibility of the inference', kinds: ['limitation'], fieldIds: ['validity'] },
    { id: 'scope', label: 'Generalisability', kinds: ['limitation'], fieldIds: ['scope'] },
    { id: 'limitations', label: 'Limitations', kinds: ['limitation'], fieldIds: ['limitations'] },
    { id: 'replications', label: 'Replications reported by the paper', kinds: ['limitation'], fieldIds: ['replications'] },
    { id: 'openness', label: 'Materials, data, code, preregistration', kinds: ['limitation'], fieldIds: ['openness'] },
  ] },
  { id: 'simulation', number: '12', title: 'Simulation scope', titleZh: '模拟范围', level: 'paper', openByDefault: true, assessment: true, items: [
    { id: 'steps', label: 'Steps an agent can perform', kinds: ['simulation'], fieldIds: ['steps'] },
    { id: 'roles', label: 'Roles that can be simulated', kinds: ['simulation'], fieldIds: ['roles'] },
    { id: 'conditions', label: 'Conditions that can be expressed', kinds: ['simulation'], fieldIds: ['conditions'] },
    { id: 'outcomes', label: 'Outcomes that are observable', kinds: ['simulation'], fieldIds: ['outcomes'] },
    { id: 'limits', label: 'Limits', kinds: ['simulation'], fieldIds: ['limits'] },
  ] },
];

// Translation only: the English text stays in the data above; in Chinese the headings and item
// labels come from the zh-CN dictionary (keys sec.<id> and item.<section>.<item>).
for (const sec of SECTIONS) {
  const enTitle = sec.title;
  Object.defineProperty(sec, 'title', { get: () => tOr(`sec.${sec.id}`, enTitle), enumerable: true });
  for (const item of sec.items) {
    const en = item.label;
    Object.defineProperty(item, 'label', { get: () => tOr(`item.${sec.id}.${item.id}`, en), enumerable: true });
  }
}


export type Entry = {
  key: string;
  nodeId?: string;
  field?: ProgramField;
  label: string;
  text: string;
  /** Node whose citations back a line that has no field of its own. */
  node?: ProgramNode;
};
export type ResolvedItem = { item: SectionItem; entries: Entry[]; present: boolean };
export type ResolvedSection = { section: Section; items: ResolvedItem[]; leftovers: Entry[]; blocks: ProgramNode[]; present: boolean };

/** Every node kind a section claims. The rest fall into "Other details". */
export const claimedKinds = (sections: Section[] = SECTIONS): Set<string> => new Set(sections.flatMap(sec => sec.items.flatMap(i => i.kinds)));

const shown = (f: ProgramField) => (f.value !== null && f.value !== '') || f.state === 'missing' || f.state === 'decision';

/** What the program states for each item of a section (study-level sections: for one study). */
export function resolveSection(program: HumanProgram, section: Section, studyId: string): ResolvedSection {
  const inScope = (n: ProgramNode) => section.level === 'paper' || !studyId || !n.studyIds.length || n.studyIds.includes(studyId);
  const kinds = new Set(section.items.flatMap(i => i.kinds));
  const nodes = program.nodes.filter(n => kinds.has(n.kind) && inScope(n));
  const consumed = new Set<string>(), consumedNodes = new Set<string>();
  const fieldEntry = (n: ProgramNode, f: ProgramField, label: string): Entry => ({ key: `${n.id}:${f.id}`, nodeId: n.id, field: f, label, text: fieldText(f.value), node: n });
  const studies = section.level === 'paper' ? program.studies : program.studies.filter(st => !studyId || st.id === studyId);
  const titleOf = (id: string) => program.studies.find(st => st.id === id)?.title ?? id;

  // One node feeding an item: the item's own name. Several (variables, studies): say which.
  const labelFor = (item: SectionItem, mine: ProgramNode[], n: ProgramNode, f: ProgramField) => {
    const base = item.fieldIds!.length > 1 ? fieldLabel(f.id, f.label) : item.label;
    return mine.filter(m => m.fields.some(x => item.fieldIds!.includes(x.id) && shown(x))).length > 1 ? `${n.title} · ${base}` : base;
  };
  const items = section.items.map<ResolvedItem>(item => {
    let entries: Entry[] = [];
    const mine = nodes.filter(n => item.kinds.includes(n.kind));
    if (item.sourceKey) {
      const text = String(program.source[item.sourceKey] ?? '').trim();
      if (text) entries = [{ key: `source:${item.sourceKey}`, label: item.label, text }];
    } else if (item.derived === 'study-aim') {
      entries = studies.filter(st => st.description?.trim()).map(st => ({ key: `aim:${st.id}`, label: st.title, text: st.description!.trim() }));
    } else if (item.derived === 'study-relations') {
      entries = studies.filter(st => st.dependsOn?.length).map(st => ({ key: `rel:${st.id}`, label: st.title, text: `builds on ${st.dependsOn!.map(titleOf).join(', ')}` }));
    } else if (item.derived === 'study-tests') {
      const tested = (stId: string) => program.nodes.filter(n => n.kind === 'hypothesis' && (!n.studyIds.length || n.studyIds.includes(stId)));
      entries = studies.map(st => ({ st, h: tested(st.id) })).filter(x => x.h.length).map(({ st, h }) => ({ key: `tests:${st.id}`, label: st.title, text: `tests ${h.map(n => n.title).join('; ')}`, nodeId: h[0].id, node: h[0] }));
    } else if (item.special === 'conditions') {
      const conds = mine.filter(n => n.kind === 'condition');
      if (conds.length) { conds.forEach(n => consumedNodes.add(n.id)); entries = conds.map(n => ({ key: n.id, nodeId: n.id, label: n.title, text: n.title, node: n })); mine.filter(n => n.kind === 'design').forEach(n => n.fields.filter(f => item.fieldIds!.includes(f.id)).forEach(f => consumed.add(`${n.id}:${f.id}`))); }
      else entries = mine.flatMap(n => n.fields.filter(f => item.fieldIds!.includes(f.id) && shown(f)).map(f => (consumed.add(`${n.id}:${f.id}`), fieldEntry(n, f, labelFor(item, mine, n, f)))));
    } else if (item.special === 'materials') {
      mine.forEach(n => consumedNodes.add(n.id));
      entries = mine.map(n => ({ key: n.id, nodeId: n.id, label: n.title, text: n.title, node: n }));
    } else if (item.special === 'steps') {
      entries = [];
    } else if (item.role) {
      const re = new RegExp(item.role, 'i');
      entries = mine.flatMap(n => {
        const role = n.fields.find(f => f.id === 'role');
        if (!role || role.value === null || !re.test(fieldText(role.value))) return [];
        const type = n.fields.find(f => f.id === 'type' && f.value !== null);
        consumed.add(`${n.id}:role`);
        if (type) consumed.add(`${n.id}:type`);
        return [type ? { ...fieldEntry(n, type, n.title) } : { key: n.id, nodeId: n.id, label: n.title, text: '', node: n }];
      });
    } else if (item.fieldIds) {
      entries = mine.flatMap(n => n.fields.filter(f => item.fieldIds!.includes(f.id) && shown(f)).map(f => (consumed.add(`${n.id}:${f.id}`), fieldEntry(n, f, labelFor(item, mine, n, f)))));
    } else {
      mine.forEach(n => consumedNodes.add(n.id));
      entries = mine.flatMap(n => {
        const fs = n.fields.filter(shown);
        return fs.length ? fs.map(f => fieldEntry(n, f, fs.length > 1 ? `${n.title} · ${f.label}` : n.title)) : n.description ? [{ key: n.id, nodeId: n.id, label: n.title, text: n.description, node: n }] : [];
      });
    }
    const present = item.special === 'steps' ? program.steps.some(st => st.studyId === studyId || !studyId) : entries.length > 0;
    return { item, entries, present };
  });

  const blocks = section.blocks ? nodes : [];
  const leftovers: Entry[] = section.blocks ? [] : nodes.filter(n => !consumedNodes.has(n.id)).flatMap(n => {
    const fs = n.fields.filter(f => !consumed.has(`${n.id}:${f.id}`) && shown(f));
    if (fs.length) return fs.map(f => fieldEntry(n, f, `${n.title} · ${f.label}`));
    return !n.fields.some(f => consumed.has(`${n.id}:${f.id}`)) && n.description ? [{ key: n.id, nodeId: n.id, label: n.title, text: n.description, node: n }] : [];
  });
  return { section, items, leftovers, blocks, present: items.some(i => i.present) || leftovers.length > 0 || blocks.length > 0 };
}

/** The same verdict as the at-a-glance strip: derived from blocking issues and unresolved fields. */
export function readiness(program: HumanProgram, studyId?: string): { tone: 'no' | 'mostly' | 'yes'; text: string } {
  const issues = program.issues.filter(i => !studyId || !i.studyId || i.studyId === studyId);
  const nodes = program.nodes.filter(n => !studyId || !n.studyIds.length || n.studyIds.includes(studyId));
  const steps = program.steps.filter(st => !studyId || st.studyId === studyId);
  const blocking = issues.filter(i => i.severity === 'blocking').length;
  const unresolved = [...nodes.flatMap(n => n.fields), ...steps.flatMap(st => st.rule ? [st.rule] : [])].filter(f => f.state === 'missing' || f.state === 'decision').length;
  if (blocking) return { tone: 'no', text: `No · ${blocking} blocking ${blocking === 1 ? 'gap' : 'gaps'}` };
  if (unresolved) return { tone: 'mostly', text: `Mostly · ${unresolved} ${unresolved === 1 ? 'item' : 'items'} to confirm` };
  return { tone: 'yes', text: 'Yes, as far as the program states' };
}
