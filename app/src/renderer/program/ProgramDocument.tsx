import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { fieldLabel } from './labels';
import type { HumanProgram, ProgramField, ProgramNode } from '../../shared/human-program';
import { conditionSuggestion, fieldText, itemSources, sourceRefs, studyConditions, studyFlow, wordDiff, type Condition, type FlowItem, type SourceRef } from '../../shared/program-view';
import s from './ProgramDocument.module.css';
import { SECTIONS, claimedKinds, readiness, resolveSection, type Entry, type ResolvedItem, type Section } from './sections';
import { track } from '../telemetry';

export type { SourceRef };
type Props = {
 program:HumanProgram; studyId:string; selectedIds:string[];
 /** Items cited by the passage currently selected in the source. */
 highlightIds?:ReadonlySet<string>; changedIds?:ReadonlySet<string>;
 issuesFor:(id:string)=>string[]; onPick:(id:string,extend:boolean)=>void; onIssue:(issueId:string)=>void;
 onSource:(id:string,source:SourceRef)=>void;
 /** Discuss a program item, optionally one of its fields, with the agent; draft prefills the message. */
 onAsk:(id:string,fieldId?:string,draft?:string)=>void;
 /** Open the chat with a free draft (section questions). */
 onPrefill?:(draft:string)=>void;
 /** Human edit of a field's text (double-click). Absent: fields are read-only. */
 onEdit?:(id:string,fieldId:string,text:string)=>void;
 /** Remembers which sections are open; sections.ts says which start open. */
 storageKey?:string;
};

/** Studies that have a procedure. Analysis-only studies have nothing to read. */
export function viewStudies(program:HumanProgram){ return program.studies.filter(st=>program.steps.some(step=>step.studyId===st.id)); }

/** The Human Program as a document to read: a methods-style protocol in which every sentence is a
 * program field and ends with its citation. Headings are the only text the view adds. A step bar
 * at the top gives the flow at a glance; selecting text sends it to the agent to discuss or change. */
/** Public props: issuesFor and onIssue are optional. By default open questions come from
 * program.issues (matched on nodeId or stepId) and clicking one does nothing. */
export type ProgramDocumentProps = Omit<Props,'issuesFor'|'onIssue'> & Partial<Pick<Props,'issuesFor'|'onIssue'>>;
export function defaultIssuesFor(program:HumanProgram){ return (id:string)=>program.issues.filter(i=>i.nodeId===id||i.stepId===id).map(i=>i.id); }
const noop=()=>{};

export default function ProgramDocument(input:ProgramDocumentProps){
 const props:Props={...input,issuesFor:input.issuesFor??defaultIssuesFor(input.program),onIssue:input.onIssue??noop};
 const {program,studyId}=props;
 const scoped=(kinds:string[])=>program.nodes.filter(n=>kinds.includes(n.kind)&&(!studyId||!n.studyIds.length||n.studyIds.includes(studyId)));
 const conditions=studyConditions(program,studyId),suggestion=conditionSuggestion(program,studyId);
 const items=studyFlow(program,studyId);
 const claimed=claimedKinds();
 const article=useRef<HTMLElement>(null);
 const [ask,setAsk]=useState<{id:string;fieldId?:string;quote:string;top:number}|null>(null);
 function captureSelection(){
  const sel=window.getSelection(),root=article.current;
  if(!sel||sel.isCollapsed||!root||!root.contains(sel.anchorNode)){setAsk(null);return;}
  const el=(sel.anchorNode instanceof Element?sel.anchorNode:sel.anchorNode?.parentElement)?.closest<HTMLElement>('[data-model-id]');
  if(!el){setAsk(null);return;}
  const box=sel.getRangeAt(0).getBoundingClientRect(),base=root.getBoundingClientRect();
  setAsk({id:el.dataset.modelId!,fieldId:el.closest<HTMLElement>('[data-field-id]')?.dataset.fieldId,quote:sel.toString().trim().slice(0,2000),top:box.bottom-base.top+root.scrollTop+6});
 }
 const ctx:Ctx={...props,conditions};
 const studyTitle=program.studies.find(st=>st.id===studyId)?.title??program.title;
 const [openSections,setOpenSections]=useSectionState(props.storageKey);
 const nodes=(list:ProgramNode[])=>list.length?list.map(n=><NodeBlock key={n.id} node={n} ctx={ctx}/>):null;
 const subject=(sec:Section)=>sec.level==='paper'?program.title:studyTitle;
 const askAbout=(sec:Section,what:string)=>props.onPrefill?.(`About the ${what.toLowerCase()} of ${subject(sec)}: `);

 function renderItem(sec:Section,r:ResolvedItem):ReactNode{
  const {item}=r;
  const notStated=<p key={item.id} className={s.notStated} data-item={item.id}><span className={s.label}>{item.label}. </span><em>not stated</em>{props.onPrefill&&<button onClick={()=>askAbout(sec,item.label)} title={`Ask the agent about ${item.label.toLowerCase()}`}>Ask ↗</button>}</p>;
  if(item.special==='steps')return <Fragment key={item.id}>
   {r.entries.map(e=><Entries key={e.key} entries={[e]} ctx={ctx}/>)}
   {items.length?<ol className={s.steps}>{items.map(it=><Step key={it.step.id} item={it} ctx={ctx}/>)}</ol>:<p className={s.missing}>The participant procedure has not been mapped yet. <button onClick={()=>props.onAsk(scoped(['design'])[0]?.id??program.nodes[0]?.id??'',undefined,'Map the documented participant procedure into explicit steps and next connections. Preserve unknown order and conditions as questions rather than inventing them.')}>Ask the agent to map it ↗</button></p>}
  </Fragment>;
  if(item.special==='conditions'){
   if(r.present&&r.entries.some(e=>e.node?.kind==='condition'))return <div key={item.id} className={s.conditions}>{conditions.map(c=><span key={c.id} data-tone={c.tone} data-model-id={c.id}><i/>{c.label}<Cite id={c.id} refs={itemSources(program,c.id)} ctx={ctx}/></span>)}</div>;
   if(suggestion)return <p key={item.id} className={s.suggestion}><b>Conditions are not stated.</b> Possibly {suggestion.labels.join(' / ')} (from {suggestion.basis}). <button onClick={()=>props.onAsk(scoped(['design'])[0]?.id??'',undefined,`The program does not state its experimental conditions. They may be ${suggestion.labels.join(', ')} (from ${suggestion.basis}). Check the paper, add a condition node for each, and set conditionIds on the steps and materials that belong to it. Mark anything the paper does not state as missing.`)}>Ask the agent to confirm ↗</button></p>;
  }
  if(!r.present)return notStated;
  if(item.special==='materials')return <ul key={item.id} className={s.measures}>{r.entries.map(e=><li key={e.key}><Term node={e.node!} ctx={ctx}/>{e.node!.conditionIds?.length?<span className={s.inline}> · {conditions.filter(c=>e.node!.conditionIds!.includes(c.id)).map(c=>c.label).join(', ')}</span>:null}<Issue ids={props.issuesFor(e.node!.id)} ctx={ctx}/></li>)}</ul>;
  return <Entries key={item.id} entries={r.entries} ctx={ctx} assessment={sec.assessment}/>;
 }

 const renderSection=(sec:Section)=>{
  const r=resolveSection(program,sec,studyId);
  const open=openSections[sec.id]??sec.openByDefault;
  const heading=`${sec.number} ${sec.title}`;
  const ready=sec.assessment?readiness(program,sec.level==='study'?studyId:undefined):null;
  return <details key={sec.id} id={sec.id==='procedure'?'procedure':`section-${sec.id}`} data-section={sec.id} open={open} onToggle={e=>{const next=(e.currentTarget as HTMLDetailsElement).open;if(next!==open){track('study.section_toggle',{target:sec.id,metadata:{open:next}});setOpenSections(sec.id,next);}}}>
   <summary><h2 title={sec.titleZh} data-empty={!r.present&&!ready}><span className={s.num}>{sec.number}</span>{sec.title}</h2>{props.onPrefill&&<button className={s.askSection} onClick={e=>{e.preventDefault();e.stopPropagation();askAbout(sec,sec.title);}} title={`Ask the agent about ${sec.title.toLowerCase()}`}>Ask ↗</button>}</summary>
   {ready&&<p className={s.readiness} data-verdict={ready.tone}><span className={s.label}>Readiness. </span>{ready.text}<em className={s.origin}> agent assessment</em></p>}
   {r.present?<>
    {!(sec.blocks&&r.blocks.length)&&r.items.map(ri=>renderItem(sec,ri))}
    {r.blocks.length>0&&nodes(r.blocks)}
    {r.leftovers.length>0&&<Entries entries={r.leftovers} ctx={ctx} assessment={sec.assessment}/>}
   </>:<p className={s.nothing}>Nothing stated{props.onPrefill&&<> · <button onClick={()=>askAbout(sec,sec.title)}>Ask ↗</button></>}</p>}
  </details>;
 };
 return <div className={s.doc}>
  <Glance program={program} studyId={studyId} items={items} conditions={conditions}/>
  {items.length>0&&<StepBar items={items} ctx={ctx}/>}
  <article ref={article} className={s.article} onMouseUp={()=>requestAnimationFrame(captureSelection)} onKeyUp={captureSelection}>
   {ask&&<button className={s.askBar} style={{top:ask.top}} onMouseDown={e=>e.preventDefault()} onClick={()=>{props.onAsk(ask.id,ask.fieldId,`“${ask.quote}”\n\n`);setAsk(null);window.getSelection()?.removeAllRanges();}}>Discuss or change this with the agent ↗</button>}
   {SECTIONS.map(renderSection)}
   {(()=>{const other=nodes(program.nodes.filter(n=>!claimed.has(n.kind)&&(!studyId||!n.studyIds.length||n.studyIds.includes(studyId))));return other&&<details open={openSections.other??false} onToggle={e=>setOpenSections('other',(e.currentTarget as HTMLDetailsElement).open)}><summary><h2>Other details</h2></summary>{other}</details>;})()}
  </article>
 </div>;
}

/** One line per entry: label, value (truncated to ~160 characters; click expands), citation, ✎. */
const CLAMP=160;
function Entries({entries,ctx,assessment}:{entries:Entry[];ctx:Ctx;assessment?:boolean}){
 return <>{entries.map(e=>e.field&&e.nodeId
  ?<Field key={e.key} id={e.nodeId} field={e.field} ctx={ctx} label={e.label} clamp={CLAMP} originLabel={assessment?'agent assessment':undefined}/>
  :<Plain key={e.key} entry={e} ctx={ctx} assessment={assessment}/>)}</>;
}
function Plain({entry,ctx,assessment}:{entry:Entry;ctx:Ctx;assessment?:boolean}){
 const [open,setOpen]=useState(false);
 const text=entry.text.replace(/\s+/g,' ').trim(),long=text.length>CLAMP;
 const toggle=()=>{if(long&&window.getSelection()?.isCollapsed!==false)setOpen(o=>!o);};
 const node=entry.node;
 return <p data-model-id={node?.id} className={`${s.field} ${s.line} ${node?mark(ctx,node.id):''} ${long?s.expandable:''}`} onClick={toggle}>
  {node&&!text?<button className={s.term} onClick={e=>{e.stopPropagation();ctx.onPick(node.id,e.shiftKey);}}>{entry.label}</button>:<><span className={s.label}>{entry.label}. </span>{long&&!open?`${text.slice(0,CLAMP).trimEnd()}…`:text}</>}
  {assessment&&<em className={s.origin}> agent assessment</em>}
  {node&&<Cite id={node.id} refs={itemSources(ctx.program,node.id)} ctx={ctx} quiet/>}
  {node&&<Issue ids={ctx.issuesFor(node.id)} ctx={ctx}/>}
  {node&&<button className={s.comment} title="Discuss or change this with the agent" aria-label={`Discuss ${entry.label}`} onClick={e=>{e.stopPropagation();ctx.onAsk(node.id);}}>✎</button>}
 </p>;
}

type Ctx = Props & { conditions:Condition[] };
const mark=(ctx:Ctx,id:string)=>[ctx.selectedIds.includes(id)?s.picked:'',ctx.highlightIds?.has(id)?s.cited:'',ctx.changedIds?.has(id)?s.changed:''].filter(Boolean).join(' ');

/** The flow at a glance: step titles in order, an arrow only where the program states the order. */
function StepBar({items,ctx}:{items:FlowItem[];ctx:Ctx}){
 const top=items.length===1&&items[0].children.length&&!items[0].columns?items[0].children:items;
 const go=(id:string)=>{ctx.onPick(`flow:${id}`,false);document.getElementById(`step-${id}`)?.scrollIntoView({block:'start',behavior:'smooth'});};
 return <nav className={s.stepBar} aria-label="Procedure at a glance">{top.map((item,i)=><Fragment key={item.step.id}>
  {i>0&&<span className={s.sep} aria-label={item.linked?'then':'order not stated'}>{item.linked?'→':'·'}</span>}
  <button className={mark(ctx,`flow:${item.step.id}`)} onClick={()=>go(item.step.id)} title={item.step.title}>{item.columns?'⑂ ':item.step.kind==='repeat'?'↻ ':''}{item.step.title}</button>
 </Fragment>)}</nav>;
}

function Step({item,ctx}:{item:FlowItem;ctx:Ctx}){
 const {step}=item,id=`flow:${step.id}`,program=ctx.program;
 const nodes=(ids:string[])=>ids.map(i=>program.nodes.find(n=>n.id===i)).filter((n):n is ProgramNode=>Boolean(n));
 const own=ctx.conditions.filter(c=>step.conditionIds?.includes(c.id));
 const seen=nodes(step.visibleIds),used=nodes(step.inputIds.filter(i=>!step.visibleIds.includes(i))),records=nodes(step.outputIds);
 const groups=ctx.conditions.map(c=>({c,nodes:seen.filter(n=>n.conditionIds?.includes(c.id))})).filter(g=>g.nodes.length);
 const split=groups.length>=2,shared=seen.filter(n=>!(split&&n.conditionIds?.some(c=>ctx.conditions.some(x=>x.id===c))));
 const altLabel=(child:FlowItem)=>ctx.conditions.filter(c=>child.step.conditionIds?.includes(c.id));
 return <li id={`step-${step.id}`} data-model-id={id} className={`${s.step} ${mark(ctx,id)}`}>
  <h3><button onClick={e=>ctx.onPick(id,e.shiftKey)}>{step.title}</button>{own.map(c=><em key={c.id} className={s.tag} data-tone={c.tone}><i/>{c.label}</em>)}<Cite id={id} refs={itemSources(program,id)} ctx={ctx}/><Issue ids={ctx.issuesFor(id)} ctx={ctx}/></h3>
  {step.rule&&<Field id={id} field={step.rule} ctx={ctx}/>}
  {shared.length>0&&<Materials label="Participants see" list={shared} ctx={ctx}/>}
  {split&&<div className={s.split}>{groups.map(({c,nodes:list},gi)=>{const other=groups[gi===0?1:0].nodes;return <div key={c.id} data-tone={c.tone} className={s.arm}><p className={s.armLabel}><i/>In {c.label}, participants see</p>{list.map(n=><MaterialText key={n.id} node={n} ctx={ctx} against={other}/>)}</div>;})}</div>}
  {used.length>0&&<p className={s.meta}>Uses {used.map((n,i)=><Fragment key={n.id}>{i>0&&', '}<Term node={n} ctx={ctx}/></Fragment>)}</p>}
  {records.length>0&&<p className={s.meta}>Records {records.map((n,i)=><Fragment key={n.id}>{i>0&&', '}<Term node={n} ctx={ctx}/></Fragment>)}</p>}
  {item.jumps.map(j=><p key={j.to} className={s.meta}>{j.back?'Then returns to':'Continues to'} <button className={s.term} onClick={()=>document.getElementById(`step-${j.to}`)?.scrollIntoView({block:'start',behavior:'smooth'})}>{j.title}</button>{j.when?` (${j.when})`:''}.</p>)}
  {item.children.length>0&&<>
   {item.columns?<p className={s.meta}>{step.kind==='branch'?'Depending on condition:':'At the same time:'}</p>:step.kind==='repeat'?<p className={s.meta}>Repeated{step.rule&&step.rule.value!==null?'':' (count not stated)'}:</p>:null}
   <ol className={item.columns?s.alternatives:s.steps}>{item.children.map(child=>{const cs=altLabel(child);return item.columns?<li key={child.step.id} data-tone={cs[0]?.tone} className={s.alternative}>{cs.length>0&&<p className={s.armLabel}><i/>{cs.map(c=>c.label).join(', ')}</p>}<ol className={s.steps}><Step item={child} ctx={ctx}/></ol></li>:<Step key={child.step.id} item={child} ctx={ctx}/>;})}</ol>
  </>}
 </li>;
}

/** Condition-specific material: its text, with words that differ from the other condition marked. */
function MaterialText({node,ctx,against}:{node:ProgramNode;ctx:Ctx;against:ProgramNode[]}){
 return <div data-model-id={node.id} className={mark(ctx,node.id)}>{node.fields.filter(f=>f.value!==null).map(f=>{const peer=against.flatMap(o=>o.fields).find(x=>x.id===f.id);return <Field key={f.id} id={node.id} field={f} ctx={ctx} against={peer&&fieldText(peer.value)} quote/>;})}</div>;
}
function Materials({label,list,ctx}:{label:string;list:ProgramNode[];ctx:Ctx}){
 return <div className={s.materials}><p className={s.meta}>{label} {list.map((n,i)=><Fragment key={n.id}>{i>0&&', '}<Term node={n} ctx={ctx}/></Fragment>)}</p>
  {list.filter(n=>n.fields.some(f=>f.origin==='verbatim'&&typeof f.value==='string')).map(n=><details key={n.id} data-model-id={n.id}><summary>Text of {n.title}</summary>{n.fields.filter(f=>f.origin==='verbatim').map(f=><Field key={f.id} id={n.id} field={f} ctx={ctx} quote/>)}</details>)}</div>;
}

function NodeBlock({node,ctx}:{node:ProgramNode;ctx:Ctx}){
 const fields=node.fields.filter(f=>f.value!==null||f.state==='missing'||f.state==='decision');
 return <div data-model-id={node.id} className={`${s.node} ${mark(ctx,node.id)}`}>
  <h3><button onClick={e=>ctx.onPick(node.id,e.shiftKey)}>{node.title}</button>{(node.evidenceIds.length>0||!fields.length)&&<Cite id={node.id} refs={sourceRefs(ctx.program,node.evidenceIds)} ctx={ctx}/>}<Issue ids={ctx.issuesFor(node.id)} ctx={ctx}/></h3>
  {node.description&&<p>{node.description}</p>}
  {fields.map(f=><Field key={f.id} id={node.id} field={f} ctx={ctx} labelled={fields.length>1}/>)}
 </div>;
}

const origins:Partial<Record<ProgramField['origin'],string>>={derived:'derived',researcher:'researcher decision',implementation:'implementation choice',unknown:'origin unknown'};
function Field({id,field,ctx,against,labelled=true,quote,label,clamp,originLabel}:{id:string;field:ProgramField;ctx:Ctx;against?:string;labelled?:boolean;quote?:boolean;label?:string;clamp?:number;originLabel?:string}){
 const text=field.value===null?'':fieldText(field.value),unresolved=field.state==='missing'||field.state==='decision';
 const editable=Boolean(ctx.onEdit)&&(field.value===null||typeof field.value==='string');
 const [editing,setEditing]=useState<string|null>(null);
 const [expanded,setExpanded]=useState(false);
 const flat=text.replace(/\s+/g,' ').trim(),long=Boolean(clamp)&&flat.length>clamp!;
 const box=useRef<HTMLTextAreaElement>(null);
 useEffect(()=>{if(editing!==null){const el=box.current;if(el){el.focus();el.style.height=`${el.scrollHeight}px`;}}},[editing]);
 const commit=()=>{if(editing===null)return;const next=editing.trim();setEditing(null);if(next!==text)ctx.onEdit!(id,field.id,next);};
 const body=unresolved&&!text?<span className={s.missingText}>Not specified</span>:against!==undefined&&text!==against?wordDiff(text,against).map((p,i)=>p.changed?<mark key={i}>{p.text}</mark>:<Fragment key={i}>{p.text}</Fragment>):long&&!expanded?`${flat.slice(0,clamp).trimEnd()}…`:text;
 if(editing!==null)return <p data-field-id={field.id} className={`${s.field} ${s.editing}`}>
  {labelled&&<span className={s.label}>{label??fieldLabel(field.id,field.label)}. </span>}
  <textarea ref={box} className={s.editor} value={editing} rows={1} aria-label={`Edit ${field.label}`}
   onChange={e=>{setEditing(e.target.value);e.target.style.height='auto';e.target.style.height=`${e.target.scrollHeight}px`;}}
   onBlur={commit}
   onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();setEditing(null);}else if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();commit();}}}/>
  <span className={s.editHint}>Enter saves · Shift+Enter newline · Esc cancels</span>
 </p>;
 return <p data-field-id={field.id} className={`${s.field} ${clamp?s.line:''} ${quote?s.quote:''} ${unresolved?s.unresolved:''} ${editable?s.editable:''} ${long?s.expandable:''}`} title={editable?'Double-click to edit':undefined} onClick={long?()=>{if(window.getSelection()?.isCollapsed!==false)setExpanded(x=>!x);}:undefined} onDoubleClick={editable?e=>{e.preventDefault();window.getSelection()?.removeAllRanges();setEditing(text);}:undefined}>
  {labelled&&<span className={s.label}>{label??fieldLabel(field.id,field.label)}. </span>}{body}
  {!(unresolved&&!text)&&(originLabel??origins[field.origin])&&<em className={s.origin}> {originLabel??origins[field.origin]}</em>}
  {(field.origin==='verbatim'||field.origin==='reported'||field.evidenceIds.length>0)&&<Cite id={id} refs={sourceRefs(ctx.program,field.evidenceIds)} ctx={ctx}/>}
  <button className={s.comment} title="Discuss or change this with the agent" aria-label={`Discuss ${label??field.label}`} onClick={()=>ctx.onAsk(id,field.id)}>✎</button>
 </p>;
}
function Term({node,ctx}:{node:ProgramNode;ctx:Ctx}){
 return <span className={mark(ctx,node.id)} data-model-id={node.id}><button className={s.term} onClick={e=>ctx.onPick(node.id,e.shiftKey)}>{node.title}</button><Cite id={node.id} refs={itemSources(ctx.program,node.id)} ctx={ctx} quiet/></span>;
}

/** The citation that ends each sentence. Without one the sentence says so, so it never reads as settled. */
function Cite({id,refs,ctx,quiet}:{id:string;refs:SourceRef[];ctx:Props;quiet?:boolean}){
 const ref=refs[0];
 if(!ref)return quiet?null:<span className={s.unsourced} title="No source is cited for this. Check it with the agent."> [no source]</span>;
 return <button className={`${s.cite} ${ref.verified?'':s.unverified}`} title={`${ref.verified?'Open the cited passage':'Cited passage, not yet matched on the page'}${ref.quote?`: “${ref.quote.slice(0,160)}${ref.quote.length>160?'…':''}”`:''}${ref.file?` (${ref.file})`:''}`} onClick={e=>{e.stopPropagation();ctx.onSource(id,ref);}}>[{ref.page?`p. ${ref.page}`:'file'}{ref.verified?'':'?'}]</button>;
}
function Issue({ids,ctx}:{ids:string[];ctx:Props}){
 if(!ids.length)return null;
 return <button className={s.issue} onClick={e=>{e.stopPropagation();ctx.onIssue(ids[0]);}} aria-label={`${ids.length} open ${ids.length===1?'question':'questions'}`} title="Open question">!{ids.length>1?` ${ids.length}`:''}</button>;
}


/* ---- at a glance, sections ---------------------------------------------------------- */

/** Open/closed state of the sections, remembered per project when a storage key is given. */
function useSectionState(key?:string):[Record<string,boolean>,(title:string,open:boolean)=>void]{
 const storage=key?`hs.sections:${key}`:null;
 const [state,setState]=useState<Record<string,boolean>>(()=>{if(!storage)return {};try{return JSON.parse(localStorage.getItem(storage)||'{}');}catch{return {};}});
 const set=(title:string,open:boolean)=>setState(prev=>{const next={...prev,[title]:open};if(storage){try{localStorage.setItem(storage,JSON.stringify(next));}catch{/* ignore */}}return next;});
 return [state,set];
}

/** The minimal frame of the study, derived only from the program: what it has and whether the
 * paper gave enough to reproduce it (from the agent's own issues). Details live in the sections. */
/** Sample size when a participants field states one, else the first short value, else "not stated". */
function participantsFact(list:ProgramNode[]):string{
 const fields=list.flatMap(n=>n.fields).filter(f=>f.value!==null&&f.value!==''&&f.state!=='missing');
 const sizeId=/^(n|n[-_]?total|sample[-_]?size|samplesize|total[-_]?n|participants)$/i,sizeLabel=/\bN\b|sample/i;
 const sizeOf=(f:ProgramField):string|null=>{
  const v=f.value as unknown;
  if(typeof v==='number')return `N = ${v}`;
  if(v&&typeof v==='object'&&!Array.isArray(v)){
   const o=v as Record<string,unknown>,own=o.n??o.N;
   if(typeof own==='number')return `N = ${own}`;
   const parts=Object.values(o).map(x=>x&&typeof x==='object'?((x as Record<string,unknown>).n??(x as Record<string,unknown>).N):x).filter((x):x is number=>typeof x==='number');
   if(parts.length===1)return `N = ${parts[0]}`;
   if(parts.length>1)return `N = ${parts.reduce((a,b)=>a+b,0)} (${parts.join(' + ')})`;
  }
  if(typeof v==='string'&&v.length<=40&&/\d/.test(v))return v.trim();
  return null;
 };
 for(const f of fields){if(sizeId.test(f.id)||sizeLabel.test(f.label)){const t=sizeOf(f);if(t)return t;}}
 for(const f of fields){if(typeof f.value==='number')return `N = ${f.value}`;}
 for(const f of fields){const t=fieldText(f.value).replace(/\s+/g,' ').trim();if(t&&t.length<=48&&!/^[^:]+:$/.test(t))return t;}
 return 'not stated';
}

function Glance({program,studyId,items,conditions}:{program:HumanProgram;studyId:string;items:FlowItem[];conditions:Condition[]}){
 const inStudy=(ids:string[])=>!studyId||!ids.length||ids.includes(studyId);
 const nodes=program.nodes.filter(n=>inStudy(n.studyIds));
 const steps=program.steps.filter(st=>!studyId||st.studyId===studyId);
 const participants=participantsFact(nodes.filter(n=>n.kind==='participants'));
 const issues=program.issues.filter(i=>!i.studyId||i.studyId===studyId);
 const blocking=issues.filter(i=>i.severity==='blocking').length,decision=issues.filter(i=>i.severity==='decision').length,check=issues.filter(i=>i.severity==='check').length;
 const verdict=readiness(program,studyId);
 const stepCount=steps.filter(st=>st.kind!=='sequence'||st.children.length===0).length||items.length;
 const facts:[string,string][]=[
  ['Studies',String(program.studies.filter(st=>st.type!=='analysis').length||program.studies.length)],
  ['Participants',participants],
  ['Conditions',conditions.length?String(conditions.length):'not stated'],
  ['Steps',String(stepCount)],
  ['Open issues',issues.length?[blocking&&`${blocking} blocking`,decision&&`${decision} decision`,check&&`${check} check`].filter(Boolean).join(' · '):'none'],
 ];
 return <dl className={s.glance} aria-label="At a glance">
  {facts.map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
  <div className={s.verdict} data-verdict={verdict.tone}><dt>Enough information to reproduce?</dt><dd>{verdict.text}</dd></div>
 </dl>;
}
