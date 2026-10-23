// Ported from humanstudy-hub-web lib/studio/human-program.ts (web-only projectHumanProgram / importLegacyModel dropped).
import * as contract from './human-program.schema.json';
/** Paper source metadata (standalone stand-in for the web app's StudySchema['source']). */
export type ProgramSource = { title: string; authors: string; filename: string; venue?: string; doi?: string; version?: string };

export type JsonValue = null | boolean | number | string | JsonValue[] | {[key:string]:JsonValue};
export type ProgramField = {id:string;label:string;value:JsonValue;origin:'verbatim'|'reported'|'derived'|'researcher'|'implementation'|'unknown';state:'confirmed'|'check'|'decision'|'missing';evidenceIds:string[];derivation?:string;studyIds?:string[];extensions?:Record<string,JsonValue>};
export type ProgramNode = {id:string;kind:string;title:string;summary?:string;description?:string;studyIds:string[];fields:ProgramField[];evidenceIds:string[];conditionIds?:string[];extensions?:Record<string,JsonValue>};
export type ProgramStep = {id:string;studyId:string;kind:'action'|'sequence'|'repeat'|'branch'|'parallel'|'interaction'|'custom';title:string;actorIds:string[];inputIds:string[];outputIds:string[];visibleIds:string[];children:string[];next:{to:string;when?:string}[];rule?:ProgramField;evidenceIds:string[];conditionIds?:string[];extensions?:Record<string,JsonValue>};
export type ProgramEvidence = {id:string;verification?:"verified"|"unverified";sourceId?:string;path?:string;url?:string;locator:{page?:number;pointer?:string;start?:number;end?:number;sheet?:string;cell?:string;region?:string};quote?:string};
export type HumanProgram = {schemaVersion:2;id:string;title:string;intent:'reconstruct'|'codesign';source:ProgramSource;studies:{id:string;title:string;type:'empirical'|'analysis'|'unspecified';description?:string;dependsOn?:string[]}[];nodes:ProgramNode[];steps:ProgramStep[];relations:{id:string;from:string;to:string;type:string;label?:string}[];evidence:ProgramEvidence[];issues:{id:string;title:string;severity:'blocking'|'decision'|'check';reason:string;impact:string;suggestedAction:string;studyId?:string;nodeId?:string;fieldId?:string;stepId?:string;evidenceIds:string[]}[];extensions?:Record<string,JsonValue>};

type Rule = { $ref?:string; const?:unknown; enum?:unknown[]; type?:string; minLength?:number; maxLength?:number; pattern?:string; minimum?:number; maximum?:number; maxItems?:number; items?:Rule; properties?:Record<string,Rule>;required?:string[];additionalProperties?:boolean };
const schema=((contract as unknown as {default?:unknown}).default??contract) as Rule&{$defs:Record<string,Rule>};
export const humanProgramContract=schema;
function check(value:unknown,rule:Rule,path:string,depth=0):void {
 const fail=(reason:string):never=>{throw new Error(`${path}: ${reason}`);};
 if(depth>64)fail('structure is too deeply nested');
 if(rule.$ref)return check(value,schema.$defs[rule.$ref.split('/').at(-1)!],path,depth+1);
 if('const' in rule&&value!==rule.const)fail('unsupported schema version');
 if(rule.enum&&!rule.enum.includes(value))fail('invalid choice');
 if(rule.type==='string'){
  if(typeof value!=='string')fail('must be a string');
  const s=value as string,length=[...s].length;if(length<(rule.minLength??0)||length>(rule.maxLength??Infinity)||rule.pattern&&!new RegExp(rule.pattern).test(s))fail('invalid string');
 }
 if(rule.type==='integer'&&(typeof value!=='number'||!Number.isInteger(value)||value<(rule.minimum??-Infinity)||value>(rule.maximum??Infinity)))fail('invalid integer');
 if(rule.type==='array'){
  if(!Array.isArray(value)||value.length>(rule.maxItems??Infinity))fail('invalid array');
  (value as unknown[]).forEach((v,i)=>check(v,rule.items??{},`${path}[${i}]`,depth+1));
 }
 if(rule.type==='object'){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('must be an object');
  const obj=value as Record<string,unknown>;
  for(const key of rule.required??[])if(!(key in obj))fail(`missing ${key}`);
  for(const [key,v] of Object.entries(obj)){
   if(rule.additionalProperties===false&&!Object.hasOwn(rule.properties??{},key))fail(`unknown field ${key}; use extensions`);
   if(rule.properties?.[key])check(v,rule.properties[key],`${path}.${key}`,depth+1);
  }
 }
}
/** One broken rule. `repair` (when set) fixes the unambiguous cases on the program that was inspected. */
export type ProgramProblem = { message: string; hint?: string; repair?: () => void };
const describe = (p: ProgramProblem) => (p.hint ? `${p.message} (${p.hint})` : p.message);

/** Semantic rules after the schema check: the single source of truth for strict and tolerant loading. check_program.py mirrors it. */
export function collectProblems(p: HumanProgram): ProgramProblem[] {
 const out: ProgramProblem[] = [];
 const add = (message: string, hint?: string, repair?: () => void) => { out.push({ message, hint, repair }); };
 const dropper = (arr: string[]) => (bad: ReadonlySet<string>) => { const seen = new Set<string>(); arr.splice(0, arr.length, ...arr.filter(id => !bad.has(id) && !seen.has(id) && !!seen.add(id))); };
 const tables = { studies: p.studies, nodes: p.nodes, steps: p.steps, relations: p.relations, evidence: p.evidence, issues: p.issues } as Record<string, { id: string }[]>;
 for (const [key, items] of Object.entries(tables)) {
  if (new Set(items.map(i => i.id)).size !== items.length) add(`${key}: duplicate ID`, `give every entry in ${key} its own id`, () => { const seen = new Set<string>(); items.splice(0, items.length, ...items.filter(i => !seen.has(i.id) && !!seen.add(i.id))); });
 }
 const nodes = new Map(p.nodes.map(n => [n.id, n])), studies = new Set(p.studies.map(s => s.id)), steps = new Map(p.steps.map(s => [s.id, s])), evidence = new Set(p.evidence.map(e => e.id));
 const refs = (ids: string[], known: ReadonlySet<string> | ReadonlyMap<string, unknown>, where: string, drop?: (bad: ReadonlySet<string>) => void, hintFor?: (id: string) => string | undefined) => {
  if (new Set(ids).size !== ids.length) add(`${where}: duplicate ID`, 'list each id once', drop && (() => drop(new Set())));
  for (const id of new Set(ids)) if (!known.has(id)) add(`${where}: unknown reference ${id}`, hintFor?.(id) ?? 'the id does not exist; remove it or add the missing entry', drop && (() => drop(new Set([id]))));
 };
 const field = (f: ProgramField, where: string) => { refs(f.evidenceIds, evidence, where, dropper(f.evidenceIds)); if (f.studyIds) refs(f.studyIds, studies, where, dropper(f.studyIds)); if (f.origin === 'derived' && !f.derivation?.trim()) add(`${where}: derived value requires derivation`, 'fill derivation or change origin to reported'); };
 for (const n of p.nodes) { if (n.id.startsWith('flow:')) add('Node ID prefix flow: is reserved', `rename node ${n.id}`); refs(n.studyIds, studies, n.id, dropper(n.studyIds)); refs(n.evidenceIds, evidence, n.id, dropper(n.evidenceIds)); if (new Set(n.fields.map(f => f.id)).size !== n.fields.length) add(`${n.id}: duplicate ID`, 'give every field its own id', () => { const seen = new Set<string>(); n.fields.splice(0, n.fields.length, ...n.fields.filter(f => !seen.has(f.id) && !!seen.add(f.id))); }); n.fields.forEach(f => field(f, `${n.id}.${f.id}`)); }
 const edgeStudy = (s: ProgramStep, id: string) => steps.get(id)?.studyId;
 for (const s of p.steps) {
  if (!studies.has(s.studyId)) add(`${s.id}: unknown reference ${s.studyId}`, 'studyId must name an entry of studies', () => { if (p.studies[0]) s.studyId = p.studies[0].id; });
  for (const ids of [s.actorIds, s.inputIds, s.outputIds, s.visibleIds]) refs(ids, nodes, s.id, dropper(ids), id => steps.has(id) ? `${id} is a step, but this list holds node ids` : undefined);
  refs(s.children, steps, s.id, dropper(s.children));
  const to = s.next.map(e => e.to);
  refs(to, steps, s.id, bad => { const seen = new Set<string>(); s.next.splice(0, s.next.length, ...s.next.filter(e => !bad.has(e.to) && steps.has(e.to) && !seen.has(e.to) && !!seen.add(e.to))); });
  refs(s.evidenceIds, evidence, s.id, dropper(s.evidenceIds)); if (s.rule) field(s.rule, s.id);
  for (const id of s.children) if (steps.has(id) && edgeStudy(s, id) !== s.studyId) add(`${s.id}: cross-study flow edge`, `${id} belongs to another study`, () => dropper(s.children)(new Set([id])));
  for (const id of to) if (steps.has(id) && edgeStudy(s, id) !== s.studyId) add(`${s.id}: cross-study flow edge`, `${id} belongs to another study`, () => s.next.splice(0, s.next.length, ...s.next.filter(e => e.to !== id)));
 }
 // Nesting is containment, not execution order; repetition lives in explicit repeat nodes.
 const done = new Set<string>();
 const visit = (id: string, active: Set<string>) => { if (done.has(id) || !steps.has(id)) return; for (const child of steps.get(id)!.children) { if (active.has(child) || child === id) add('Procedure containment cycle', `step ${id} contains ${child}, which already contains it`, () => dropper(steps.get(id)!.children)(new Set([child]))); else visit(child, new Set([...active, id])); } done.add(id); };
 p.steps.forEach(s => visit(s.id, new Set()));
 const finished = new Set<string>(), byStudy = new Map(p.studies.map(s => [s.id, s]));
 const studyVisit = (id: string, active: Set<string>) => { if (finished.has(id) || !byStudy.has(id)) return; const deps = byStudy.get(id)!.dependsOn ?? []; refs(deps, studies, id, byStudy.get(id)!.dependsOn && dropper(byStudy.get(id)!.dependsOn!)); for (const dep of deps) { if (active.has(dep) || dep === id) add('Study dependency cycle', `${id} depends on ${dep}, which already depends on it`, () => dropper(byStudy.get(id)!.dependsOn!)(new Set([dep]))); else studyVisit(dep, new Set([...active, id])); } finished.add(id); };
 p.studies.forEach(s => studyVisit(s.id, new Set()));
 // Condition membership is explicit: it names condition nodes that apply in the same study.
 const conditions = (ids: string[] | undefined, scope: string[], where: string) => {
  if (!ids) return; refs(ids, nodes, where, dropper(ids));
  for (const id of ids) { const c = nodes.get(id); if (!c) continue; const drop = () => dropper(ids)(new Set([id]));
   if (c.kind !== 'condition') add(`${where}: ${id} is not a condition`, 'conditionIds may only name nodes with kind "condition"', drop);
   else if (c.studyIds.length && scope.length && !scope.some(st => c.studyIds.includes(st))) add(`${where}: condition ${id} belongs to another study`, 'use a condition of the same study', drop); }
 };
 for (const n of p.nodes) conditions(n.conditionIds, n.studyIds, n.id);
 for (const s of p.steps) conditions(s.conditionIds, [s.studyId], s.id);
 for (const r of p.relations) { const ends = [r.from, ...(r.to === r.from ? [] : [r.to])]; if (ends.some(e => !nodes.has(e))) for (const e of ends) if (!nodes.has(e)) add(`${r.id}: unknown reference ${e}`, 'relations connect node ids', () => p.relations.splice(0, p.relations.length, ...p.relations.filter(x => x !== r))); }
 for (const e of p.evidence) { if (!e.sourceId && !e.path && !e.url) add(`${e.id}: source reference is required`, 'set sourceId, path or url'); if (e.locator.start !== undefined && e.locator.end !== undefined && e.locator.end < e.locator.start) add(`${e.id}: reversed source range`, 'start must not exceed end'); }
 for (const i of p.issues) {
  refs(i.evidenceIds, evidence, i.id, dropper(i.evidenceIds));
  if (i.studyId) refs([i.studyId], studies, i.id, () => { delete i.studyId; });
  if (i.nodeId && !nodes.has(i.nodeId)) {
   const bad = i.nodeId;
   add(`${i.id}: unknown reference ${bad}`, steps.has(bad) ? `nodeId ${bad} is a step; use stepId` : studies.has(bad) ? `nodeId ${bad} is a study; use studyId` : 'nodeId must be a node id', () => { if (steps.has(bad) && !i.stepId) i.stepId = bad; else if (studies.has(bad) && !i.studyId) i.studyId = bad; delete i.nodeId; delete i.fieldId; });
  }
  if (i.stepId) refs([i.stepId], steps, i.id, () => { delete i.stepId; }, id => nodes.has(id) ? `stepId ${id} is a node; use nodeId` : undefined);
  if (i.fieldId && (!i.nodeId || !nodes.get(i.nodeId)?.fields.some(f => f.id === i.fieldId))) add(`${i.id}: unknown field reference`, 'fieldId needs a nodeId whose fields include it', () => { delete i.fieldId; });
 }
 const synth = (base: string, item: Omit<HumanProgram['issues'][number], 'id' | 'severity' | 'evidenceIds'>) => () => { let id = base, k = 2; while (p.issues.some(i => i.id === id)) id = `${base}-${k++}`; p.issues.push({ id, severity: 'check', evidenceIds: [], ...item }); };
 for (const n of p.nodes) for (const f of n.fields) if (['missing', 'decision'].includes(f.state) && !p.issues.some(i => i.nodeId === n.id && (!i.fieldId || i.fieldId === f.id))) add(`${n.id}.${f.id}: unresolved field requires a review issue`, 'add an issue with nodeId and fieldId', synth(`auto-${n.id}-${f.id}`, { title: `Review: ${f.label}`, reason: `"${f.label}" is ${f.state === 'missing' ? 'missing from the source' : 'an open decision'}.`, impact: 'The replay cannot rely on this value until a researcher resolves it.', suggestedAction: 'Supply or confirm the value.', nodeId: n.id, fieldId: f.id }));
 for (const s of p.steps) if (s.rule && ['missing', 'decision'].includes(s.rule.state) && !p.issues.some(i => i.stepId === s.id)) add(`${s.id}: unresolved rule requires a review issue`, 'add an issue with stepId', synth(`auto-${s.id}-rule`, { title: `Review: ${s.title}`, reason: `The rule of "${s.title}" is ${s.rule.state === 'missing' ? 'missing from the source' : 'an open decision'}.`, impact: 'The replay cannot run this step faithfully until a researcher resolves the rule.', suggestedAction: 'Supply or confirm the rule.', stepId: s.id }));
 return out;
}
function prepare(value: unknown): HumanProgram {
 const serialized=JSON.stringify(value);
 if(!serialized)throw new Error('Human Program is empty');
 const json=JSON.parse(serialized); // Reject NaN/Infinity and undefined by validating the input, not a sanitized clone.
 if(JSON.stringify(json)!==serialized)throw new Error('Invalid JSON');
 function finite(v:unknown,depth=0):void{if(depth>64)throw new Error('Human Program is too deeply nested');if(typeof v==='number'&&!Number.isFinite(v)||v===undefined||typeof v==='function'||typeof v==='bigint')throw new Error('Invalid JSON value');if(v&&typeof v==='object')Object.values(v).forEach(x=>finite(x,depth+1));}
 finite(value);check(value,schema,'program');
 return value as HumanProgram;
}
/** Strict: throws on the first problem. For agent-side checks and before the app writes a program. */
export function validateHumanProgram(value:unknown):HumanProgram {
 const p=prepare(value),first=collectProblems(p)[0];
 if(first)throw new Error(first.message);
 return structuredClone(p);
}
/** Tolerant: repairs what is unambiguous, sets the rest aside and reports each as a plain-English problem. Throws only when the file is not a Human Program at all. */
export function readHumanProgram(value:unknown):{program:HumanProgram;problems:string[]} {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('program.json must be a JSON object');
 const version=(value as {schemaVersion?:unknown}).schemaVersion;
 if(version!==2)throw new Error(`unsupported schemaVersion ${JSON.stringify(version)}; expected 2`);
 const program=structuredClone(prepare(value)),problems:string[]=[],earlier=new Set<string>();
 for(let pass=0;pass<8;pass++){
  const found=collectProblems(program);
  for(const f of found)if(!earlier.has(f.message))problems.push(describe(f));
  found.forEach(f=>earlier.add(f.message));
  const fixable=found.filter(f=>f.repair);
  if(!fixable.length)break;
  fixable.forEach(f=>f.repair!());
 }
 return {program,problems};
}
export function programJson(value:unknown):string {
 const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,item])=>[k,sort(item)])):v;
 return JSON.stringify(sort(value));
}
export const programText=(v:unknown)=>typeof v==='string'?v:v===undefined?'':JSON.stringify(v,null,2);
export const programKinds=['background','hypothesis','design','participants','material','procedure','record','variable','analysis','result','overview','finding','limitation','simulation'] as const;
