// Ported from humanstudy-hub-web lib/studio/program-view.ts.
import type { HumanProgram, JsonValue, ProgramNode, ProgramStep } from './human-program';
import { programText } from './human-program';

/** Display structure derived from a Human Program. Nothing here is a scientific claim: every
 * arrow comes from an explicit `next` edge, every condition from explicit `conditionIds`, and
 * every displayed value from a field. Inference is only ever offered as a suggestion to confirm. */

export type Condition = { id:string; label:string; tone:number; stepIds:string[]; nodeIds:string[] };
export type FlowItem = {
 step:ProgramStep;
 children:FlowItem[];
 /** Branch and parallel children run side by side; other containers stack them. */
 columns:boolean;
 /** An explicit `next` edge (or, after columns, an edge from one of them) leads here from the item above. */
 linked:boolean;
 /** Explicit edges that do not lead to the item directly below: joins further on and loops back. */
 jumps:{to:string;title:string;back:boolean;when?:string}[];
};
export type SourceRef = { sourceId?:string; page?:number; file?:string; quote:string; verified:boolean };
export type PresentationPlan = { open:string[]; collapsed:string[] };

const isRecord=(v:unknown):v is Record<string,JsonValue>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const inStudy=(n:{studyIds:string[]},studyId:string)=>!n.studyIds.length||n.studyIds.includes(studyId);
/** Placeholder text is an unresolved gap even if a producer marked the field confirmed. */
export function isPlaceholderText(raw:string):boolean {
 return /^\s*(\[填写\]|\[missing\]|missing|tbd|unknown|not available|n\/a)?\s*$/i.test(raw)||/\[(填写|missing)\]/i.test(raw);
}

/** Conditions are nodes of kind `condition`. Steps and nodes join one through `conditionIds`;
 * sharing an id across phases is what states that two steps run in the same condition. */
export function studyConditions(program:HumanProgram,studyId:string):Condition[] {
 return program.nodes.filter(n=>n.kind==='condition'&&inStudy(n,studyId)).map((c,tone)=>({id:c.id,label:c.title,tone,
  stepIds:program.steps.filter(s=>s.studyId===studyId&&s.conditionIds?.includes(c.id)).map(s=>s.id),
  nodeIds:program.nodes.filter(n=>n.conditionIds?.includes(c.id)&&inStudy(n,studyId)).map(n=>n.id)}));
}

/** When no conditions are stated, possible ones the agent should confirm. Never used to draw or group anything. */
export function conditionSuggestion(program:HumanProgram,studyId:string):{labels:string[];basis:string}|null {
 if(studyConditions(program,studyId).length)return null;
 const steps=new Map(program.steps.map(s=>[s.id,s]));
 const branch=program.steps.find(s=>s.studyId===studyId&&s.kind==='branch'&&s.children.length>=2);
 if(branch){const labels=branch.children.map(id=>steps.get(id)?.title??id).map(t=>{const i=t.indexOf(':');return i>0&&i<=40?t.slice(0,i).trim():t;});return {labels,basis:`the alternatives of “${branch.title}”`};}
 for(const n of program.nodes.filter(n=>inStudy(n,studyId)&&(n.kind==='design'||n.kind==='variable')))for(const f of n.fields){
  const labels=Array.isArray(f.value)?f.value.filter((v):v is string=>typeof v==='string'):[];
  if(labels.length>=2&&labels.length<=8&&/condition|arm|treatment|level/i.test(`${f.id} ${f.label}`))return {labels,basis:`${n.title} · ${f.label}`};
 }
 return null;
}

/** Steps in display order. Order among siblings follows explicit `next` edges (stable by array
 * order where none exist); an arrow is drawn only where such an edge exists. */
export function studyFlow(program:HumanProgram,studyId:string):FlowItem[] {
 const steps=program.steps.filter(s=>s.studyId===studyId),byId=new Map(steps.map(s=>[s.id,s]));
 const nested=new Set(steps.flatMap(s=>s.children));
 // A container leads wherever its contents lead: a branch's alternatives continue to the step after it.
 const exits=(step:ProgramStep,seen=new Set<string>()):string[]=>seen.has(step.id)?[]:(seen.add(step.id),[...step.next.map(e=>e.to),...step.children.flatMap(id=>byId.has(id)?exits(byId.get(id)!,seen):[])]);
 const order=(list:ProgramStep[])=>{
  const ids=new Set(list.map(s=>s.id)),indegree=new Map(list.map(s=>[s.id,0]));
  const targets=new Map(list.map(s=>[s.id,[...new Set(exits(s))].filter(to=>ids.has(to)&&to!==s.id)]));
  for(const s of list)for(const to of targets.get(s.id)!)indegree.set(to,indegree.get(to)!+1);
  const out:ProgramStep[]=[],seen=new Set<string>();
  while(out.length<list.length){
   // Cycles leave no zero-indegree step; the earliest remaining one breaks them.
   const next=list.find(s=>!seen.has(s.id)&&indegree.get(s.id)===0)??list.find(s=>!seen.has(s.id))!;
   seen.add(next.id);out.push(next);
   for(const to of targets.get(next.id)!)if(!seen.has(to))indegree.set(to,indegree.get(to)!-1);
  }
  return out;
 };
 const ends=(item:FlowItem):ProgramStep[]=>item.columns?item.children.flatMap(ends):[item.step];
 const build=(list:ProgramStep[],path:Set<string>):FlowItem[]=>{
  const sorted=order(list),position=new Map(sorted.map((s,i)=>[s.id,i]));
  const items:FlowItem[]=sorted.map(step=>({step,columns:step.kind==='branch'||step.kind==='parallel',linked:false,jumps:[],
   children:build(step.children.filter(id=>!path.has(id)).map(id=>byId.get(id)).filter((x):x is ProgramStep=>Boolean(x)),new Set([...path,step.id]))}));
  items.forEach((item,i)=>{
   const prev=items[i-1];
   item.linked=Boolean(prev&&ends(prev).some(s=>s.next.some(e=>e.to===item.step.id)));
   item.jumps=item.step.next.filter(e=>e.to!==items[i+1]?.step.id&&byId.has(e.to)).map(e=>({to:e.to,title:byId.get(e.to)!.title,back:(position.get(e.to)??Infinity)<=i,...(e.when?{when:e.when}:{})}));
  });
  // A column's step continues to whatever follows the branch; that edge is the join, not a jump.
  items.forEach((item,i)=>{if(item.columns)for(const end of item.children)end.jumps=end.jumps.filter(j=>j.to!==items[i+1]?.step.id);});
  return items;
 };
 return build(steps.filter(s=>!nested.has(s.id)),new Set());
}

export function flatFlow(items:FlowItem[]):FlowItem[] { return items.flatMap(item=>[item,...flatFlow(item.children)]); }
/** Actors in order of first appearance; two or more means the flow is drawn as swimlanes. */
export function flowActors(program:HumanProgram,items:FlowItem[]):ProgramNode[] {
 return [...new Set(flatFlow(items).flatMap(i=>i.step.actorIds))].map(id=>program.nodes.find(n=>n.id===id)).filter((n):n is ProgramNode=>Boolean(n));
}

/** Source locations for evidence ids, verified first. */
export function sourceRefs(program:HumanProgram,ids:string[]):SourceRef[] {
 return ids.map(id=>program.evidence.find(e=>e.id===id)).filter((e):e is HumanProgram['evidence'][number]=>Boolean(e&&(e.sourceId||e.path)))
  .map(e=>({...(e.sourceId?{sourceId:e.sourceId}:{}),...(e.locator.page&&e.locator.page<=10000?{page:e.locator.page}:{}),...(e.path?{file:e.path}:{}),quote:e.quote??'',verified:e.verification==='verified'}))
  .sort((a,b)=>Number(b.verified)-Number(a.verified));
}
const entityEvidence=(program:HumanProgram,id:string)=>{
 const step=id.startsWith('flow:')?program.steps.find(s=>`flow:${s.id}`===id):undefined,node=step?undefined:program.nodes.find(n=>n.id===id);
 return [...new Set([...(step?.evidenceIds??node?.evidenceIds??[]),...(step?.rule?.evidenceIds??[]),...(node?.fields??[]).flatMap(f=>f.evidenceIds)])];
};
/** Where a program item (node id, or `flow:` step id) is stated in the sources. */
export function itemSources(program:HumanProgram,id:string):SourceRef[] { return sourceRefs(program,entityEvidence(program,id)); }

const words=(text:string)=>text.toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]+/gu)??[];
/** Program items whose evidence quotes the selected passage: same source and page, and a run of
 * shared words long enough to be the same sentence rather than a common phrase. */
export function supportedBy(program:HumanProgram,selection:{sourceId?:string;page:number;text:string}):string[] {
 return passageSupport(program,selection).same;
}

/** Items citing the selected passage, split by source. Two documents can share a sentence, so with
 * `source` (the file the passage was selected in) and `resolve` (an evidence's file or sourceId to the
 * same kind of key, null when it names no file in the project) only evidence from that file counts as
 * `same`; matching evidence from any other file is `other`, labelled with the file it cites. */
export function passageSupport(program:HumanProgram,selection:{sourceId?:string;page:number;text:string;source?:string|null},
 resolve?:(ref:{file?:string;sourceId?:string})=>string|null):{same:string[];other:{id:string;file:string}[]} {
 const picked=words(selection.text);if(picked.length<3)return {same:[],other:[]};
 const hits=new Map<string,{same:boolean}|null>();
 const hit=(id:string)=>{
  if(hits.has(id))return hits.get(id)!;
  const e=program.evidence.find(e=>e.id===id),quote=words(e?.quote??'');
  let out:{same:boolean}|null=null;
  if(e&&quote.length&&e.locator.page===selection.page&&sharedRun(quote,picked)>=Math.min(6,quote.length,picked.length)){
   const ref={...(e.path?{file:e.path}:{}),...(e.sourceId?{sourceId:e.sourceId}:{})};
   const same=resolve&&selection.source?resolve(ref)===selection.source:(!selection.sourceId||!e.sourceId||e.sourceId===selection.sourceId);
   out={same};
  }
  hits.set(id,out);return out;
 };
 const label=(evidenceIds:string[])=>{const e=evidenceIds.map(id=>hits.get(id)?program.evidence.find(x=>x.id===id):undefined).find(Boolean);return e?.path??e?.sourceId??'';};
 const same:string[]=[],other:{id:string;file:string}[]=[];
 const items:[string,string[]][]=[...program.steps.map(s=>[`flow:${s.id}`,entityEvidence(program,`flow:${s.id}`)] as [string,string[]]),...program.nodes.map(n=>[n.id,entityEvidence(program,n.id)] as [string,string[]])];
 for(const [id,evidenceIds] of items){
  const found=evidenceIds.map(hit);
  if(found.some(h=>h?.same))same.push(id);
  else if(found.some(Boolean))other.push({id,file:label(evidenceIds.filter(x=>hits.get(x)))});
 }
 return {same,other};
}
function sharedRun(a:string[],b:string[]):number {
 let best=0;const prev=new Uint16Array(b.length+1),cur=new Uint16Array(b.length+1);
 for(let i=1;i<=a.length;i++){for(let j=1;j<=b.length;j++){cur[j]=a[i-1]===b[j-1]?prev[j-1]+1:0;if(cur[j]>best)best=cur[j];}prev.set(cur);cur.fill(0);}
 return best;
}

/** The agent's presentation plan: which steps open first and which containers start folded.
 * It arranges the program; it never states order, conditions or any other scientific relation. */
export function presentationPlan(program:HumanProgram):PresentationPlan {
 const raw=program.extensions?.presentation,ids=new Set(program.steps.map(s=>s.id));
 const list=(v:JsonValue|undefined)=>Array.isArray(v)?v.filter((x):x is string=>typeof x==='string'&&ids.has(x)):[];
 return isRecord(raw)?{open:list(raw.open),collapsed:list(raw.collapsed)}:{open:[],collapsed:[]};
}

/** Word-level diff against a reference text, marking the words that are not shared.
 * Long texts fall back to whole lines. When most of a text differs nothing is marked:
 * highlighting everything carries no information. */
export function wordDiff(text:string,reference:string):{text:string;changed:boolean}[] {
 const tokens=(v:string)=>v.match(/\s+|[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu)??[],lines=(v:string)=>v.match(/[^\n]*\n|[^\n]+$/g)??[];
 let a=tokens(text),b=tokens(reference);
 if(a.length*b.length>250_000){a=lines(text);b=lines(reference);}
 if(a.length*b.length>250_000)return [{text,changed:false}];
 const lcs=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)lcs[i][j]=a[i]===b[j]?lcs[i+1][j+1]+1:Math.max(lcs[i+1][j],lcs[i][j+1]);
 const out:{text:string;changed:boolean}[]=[];let i=0,j=0;
 // Whitespace is never marked, so a highlight hugs the changed words.
 const push=(t:string,changed:boolean)=>{const mark=changed&&Boolean(t.trim()),last=out.at(-1);if(last&&last.changed===mark)last.text+=t;else out.push({text:t,changed:mark});};
 while(i<a.length){if(j<b.length&&a[i]===b[j]){push(a[i],false);i++;j++;}else if(j<b.length&&lcs[i][j+1]>=lcs[i+1][j])j++;else{push(a[i],true);i++;}}
 const count=(v:string)=>v.split(/\s+/).filter(Boolean).length,marked=out.filter(p=>p.changed).reduce((n,p)=>n+count(p.text),0);
 if(marked/Math.max(1,count(text))>0.6)return [{text,changed:false}];
 return out;
}

/** A field value as readable text: transcribed questions as a question with its options, lists one item
 * per line, and records as `key: value` lines, so a diff marks words rather than punctuation. */
export function fieldText(v:JsonValue,indent=''):string {
 if(isRecord(v)&&typeof v.question==='string')return `${indent}${v.question}${Array.isArray(v.options)&&v.options.length?` [${v.options.map(o=>programText(o)).join(' / ')}]`:''}`;
 if(Array.isArray(v))return v.map(item=>fieldText(item,indent)).join('\n');
 if(isRecord(v))return Object.entries(v).map(([k,item])=>item!==null&&typeof item==='object'?`${indent}${k.replace(/_/g,' ')}:\n${fieldText(item,indent+'  ')}`:`${indent}${k.replace(/_/g,' ')}: ${programText(item)}`).join('\n');
 return `${indent}${programText(v)}`;
}
