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
const unique=(ids:string[],where:string)=>{if(new Set(ids).size!==ids.length)throw new Error(`${where}: duplicate ID`);};
export function validateHumanProgram(value:unknown):HumanProgram {
 const serialized=JSON.stringify(value);
 if(!serialized||new TextEncoder().encode(serialized).byteLength>500_000)throw new Error('Human Program exceeds 500 KB; reference large materials as resources');
 const json=JSON.parse(serialized); // Reject NaN/Infinity and undefined by validating the input, not a sanitized clone.
 if(JSON.stringify(json)!==serialized)throw new Error('Invalid JSON');
 function finite(v:unknown,depth=0):void{if(depth>64)throw new Error('Human Program is too deeply nested');if(typeof v==='number'&&!Number.isFinite(v)||v===undefined||typeof v==='function'||typeof v==='bigint')throw new Error('Invalid JSON value');if(v&&typeof v==='object')Object.values(v).forEach(x=>finite(x,depth+1));}
 finite(value);check(value,schema,'program');
 const p=value as HumanProgram;
 for(const [key,items] of Object.entries({studies:p.studies,nodes:p.nodes,steps:p.steps,relations:p.relations,evidence:p.evidence,issues:p.issues}))unique(items.map(i=>i.id),key);
 if(p.relations.length+p.steps.reduce((n,s)=>n+s.next.length+s.children.length,0)>1200)throw new Error("Human Program exceeds 1200 display connections");
 const nodes=new Map(p.nodes.map(n=>[n.id,n])),studies=new Set(p.studies.map(s=>s.id)),steps=new Map(p.steps.map(s=>[s.id,s])),evidence=new Set(p.evidence.map(e=>e.id));
 const refs=(ids:string[],known:ReadonlySet<string>|ReadonlyMap<string,unknown>,where:string)=>{unique(ids,where);for(const id of ids)if(!known.has(id))throw new Error(`${where}: unknown reference ${id}`);};
 const field=(f:ProgramField,where:string)=>{refs(f.evidenceIds,evidence,where);refs(f.studyIds??[],studies,where);if(f.origin==='derived'&&!f.derivation?.trim())throw new Error(`${where}: derived value requires derivation`);};
 for(const n of p.nodes){if(n.id.startsWith('flow:'))throw new Error('Node ID prefix flow: is reserved');refs(n.studyIds,studies,n.id);refs(n.evidenceIds,evidence,n.id);unique(n.fields.map(f=>f.id),n.id);n.fields.forEach(f=>field(f,`${n.id}.${f.id}`));}
 for(const s of p.steps){refs([s.studyId],studies,s.id);for(const ids of [s.actorIds,s.inputIds,s.outputIds,s.visibleIds])refs(ids,nodes,s.id);refs(s.children,steps,s.id);refs(s.next.map(e=>e.to),steps,s.id);refs(s.evidenceIds,evidence,s.id);if(s.rule)field(s.rule,s.id);for(const id of [...s.children,...s.next.map(e=>e.to)])if(steps.get(id)!.studyId!==s.studyId)throw new Error(`${s.id}: cross-study flow edge`);}
 // Nesting is containment, not execution order; repetition lives in explicit repeat nodes.
 const done=new Set<string>();
 const visit=(id:string,active:Set<string>)=>{if(active.has(id))throw new Error('Procedure containment cycle');if(done.has(id))return;for(const child of steps.get(id)!.children)visit(child,new Set([...active,id]));done.add(id);};
 p.steps.forEach(s=>visit(s.id,new Set()));
 const finished=new Set<string>(),byStudy=new Map(p.studies.map(s=>[s.id,s]));
 const studyVisit=(id:string,active:Set<string>)=>{if(active.has(id))throw new Error('Study dependency cycle');if(finished.has(id))return;const deps=byStudy.get(id)!.dependsOn??[];refs(deps,studies,id);for(const dep of deps)studyVisit(dep,new Set([...active,id]));finished.add(id);};
 p.studies.forEach(s=>studyVisit(s.id,new Set()));
 // Condition membership is explicit: it names condition nodes that apply in the same study.
 const conditions=(ids:string[]|undefined,scope:string[],where:string)=>{refs(ids??[],nodes,where);for(const id of ids??[]){const c=nodes.get(id)!;if(c.kind!=='condition')throw new Error(`${where}: ${id} is not a condition`);if(c.studyIds.length&&scope.length&&!scope.some(st=>c.studyIds.includes(st)))throw new Error(`${where}: condition ${id} belongs to another study`);}};
 for(const n of p.nodes)conditions(n.conditionIds,n.studyIds,n.id);
 for(const s of p.steps)conditions(s.conditionIds,[s.studyId],s.id);
 for(const r of p.relations)refs([r.from,...(r.to===r.from?[]:[r.to])],nodes,r.id);
 for(const e of p.evidence){if(!e.sourceId&&!e.path&&!e.url)throw new Error(`${e.id}: source reference is required`);if(e.locator.start!==undefined&&e.locator.end!==undefined&&e.locator.end<e.locator.start)throw new Error(`${e.id}: reversed source range`);}
 for(const i of p.issues){refs(i.evidenceIds,evidence,i.id);if(i.studyId)refs([i.studyId],studies,i.id);if(i.nodeId)refs([i.nodeId],nodes,i.id);if(i.stepId)refs([i.stepId],steps,i.id);if(i.fieldId&&(!i.nodeId||!nodes.get(i.nodeId)?.fields.some(f=>f.id===i.fieldId)))throw new Error(`${i.id}: unknown field reference`);}
 for(const n of p.nodes)for(const f of n.fields)if(['missing','decision'].includes(f.state)&&!p.issues.some(i=>i.nodeId===n.id&&(!i.fieldId||i.fieldId===f.id)))throw new Error(`${n.id}.${f.id}: unresolved field requires a review issue`);
 for(const s of p.steps)if(s.rule&&['missing','decision'].includes(s.rule.state)&&!p.issues.some(i=>i.stepId===s.id))throw new Error(`${s.id}: unresolved rule requires a review issue`);
 return structuredClone(p);
}
export function programJson(value:unknown):string {
 const sort=(v:unknown):unknown=>Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,item])=>[k,sort(item)])):v;
 return JSON.stringify(sort(value));
}
export const programText=(v:unknown)=>typeof v==='string'?v:v===undefined?'':JSON.stringify(v,null,2);
export const programKinds=['background','hypothesis','design','participants','material','procedure','record','variable','analysis','result','overview','finding','limitation','simulation'] as const;
