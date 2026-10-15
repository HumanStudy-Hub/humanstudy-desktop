import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'protocol-review-'))
await build({ stdin: { contents: `
  import { createElement } from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import Document, { viewStudies } from './program/StudyModel';
  export { quoteRects, findQuote } from '../shared/source-anchor';
  export { reviewIssues, stage } from './program/model';
  export { amberItems } from './program/missing';
  export { viewStudies };
  export { sourceTarget } from '../shared/source-target';
  export { sourceRefs } from '../shared/program-view';
  export { simulationScope, requestsSimulation } from '../shared/simulation-scope';
  export { withWorkspaceContext, sourceFocus } from '../shared/workspace-context';
  export { sectionNeeds } from './program/missing';
  export { SECTIONS } from './program/sections';
  export const render = (program, studyId, view) => renderToStaticMarkup(createElement(Document, {program, studyId, view, selectedIds:[], onPick:()=>{}, onSource:()=>{}, onAsk:()=>{}}));
`, resolveDir: here, loader: 'tsx' }, bundle: true, platform: 'node', format: 'esm', banner: {js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}, jsx: 'automatic', loader: { '.css': 'empty' }, outfile: join(out, 'review.mjs'), logLevel: 'error' })
const R = await import(pathToFileURL(join(out, 'review.mjs')).href)
const workspace = { project:'A paper', activeTab:'paper',openTabs:['study','paper'],study:{id:'s2',title:'Study 2',type:'empirical'},source:{file:'sources/appendix.pdf',page:7,quote:'Original source passage'} }
assert.equal(R.withWorkspaceContext('Hello'), 'Hello')
const approvedPrompt=R.withWorkspaceContext('[Simulation scope approved]\nRun',workspace)
assert.ok(approvedPrompt.startsWith('[Simulation scope approved]'))
assert.ok(approvedPrompt.includes('"file":"sources/appendix.pdf"') && approvedPrompt.includes('"page":7'))
const view = R.sourceFocus({path:'/p/sources/appendix.pdf',rel:'sources/appendix.pdf',name:'appendix.pdf'}, {page:2,quote:'Cited words',nodeId:'condition2'}, {path:'/p/sources/appendix.pdf',page:7})
assert.equal(view.page,7)
assert.equal(view.quote,undefined)
assert.equal(view.citation.page,2)
assert.equal(view.citation.quote,'Cited words')
assert.equal(R.sourceFocus({path:'/p/paper.pdf',name:'paper.pdf'}, {page:4}, {path:'/p/old.pdf',page:99}).page,4)
const sample = JSON.parse(readFileSync(join(here, '../shared/sample-program.json'), 'utf8'))
const analysis = { id: 'analysis2', title: 'Follow-up analysis', type: 'analysis' }
const program = { ...sample, studies: [...sample.studies, analysis], nodes: [...sample.nodes, { id:'finding2', kind:'result', title:'Analysis-only result', studyIds:[analysis.id], fields:[{id:'effect',label:'Estimated effect',value:'The original follow-up finding',origin:'reported',state:'confirmed',evidenceIds:[]}],evidenceIds:[] }] }
assert.ok(R.viewStudies(program).some(st => st.id === analysis.id))
const html = R.render(program, analysis.id, 'study')
assert.ok(html.includes('The original follow-up finding'), 'analysis results must remain readable without procedure steps')
for (const n of ['01','02','03','04','05','06','07','08','09','10','11','12']) assert.ok(html.includes(`>${n}</span>`), `section ${n} is shown as a stage`)
assert.ok(R.render(program, analysis.id, 'simulation').includes('data-section="simulation"'))

const paper = { path:'/p/paper.pdf', name:'paper.pdf', ext:'pdf', url:'hsfile://paper' }
const attachment = { path:'/p/sources/appendix.pdf', rel:'sources/appendix.pdf', name:'appendix.pdf', ext:'pdf', kind:'file', url:'hsfile://appendix' }
const project = { program:sample, pdf:paper, tree:[attachment] }
assert.equal(R.sourceTarget(project, {file:attachment.rel, sourceId:'supplement'}), attachment)
assert.equal(R.sourceTarget(project, {sourceId:'paper'}), paper)
assert.equal(R.sourceTarget(project, {file:'missing.pdf'}), null, 'unknown sources must not be substituted with the paper')
const quote = 'source text '.repeat(1000)
const refs = R.sourceRefs({...sample, evidence:[{id:'extra', sourceId:'supplement',path:attachment.rel,locator:{page:3},quote,verification:'verified'}]}, ['extra'])
assert.equal(refs[0].file, attachment.rel)
assert.equal(refs[0].quote, quote)

const fields = ['steps','roles','conditions','outcomes','limits'].map(id=>({id,label:id,value:`Explicit ${id}`,origin:'implementation',state:'confirmed',evidenceIds:[]}))
const scoped = {...sample,issues:[],nodes:[{id:'scope',kind:'simulation',title:'Scope',studyIds:[sample.studies[0].id],fields,evidenceIds:[]}]}
assert.equal(R.simulationScope(scoped,sample.studies[0].id).ready,true)
assert.equal(R.simulationScope(scoped,'another-study').ready,false)
assert.equal(R.simulationScope({...scoped,nodes:[{...scoped.nodes[0],fields:fields.slice(0,4)}]},sample.studies[0].id).ready,false)
assert.equal(R.simulationScope({...scoped,nodes:[{...scoped.nodes[0],fields:fields.map(f=>f.id==='limits'?{...f,value:'TBD'}:f)}]},sample.studies[0].id).ready,false)
assert.equal(R.simulationScope({...scoped,issues:[{severity:'blocking',studyId:sample.studies[0].id}]},sample.studies[0].id).ready,false)
assert.equal(R.requestsSimulation('Please run a simulation'),true)
assert.equal(R.requestsSimulation('开始模拟实验'),true)
assert.equal(R.requestsSimulation('Explain the simulation limits'),false)
assert.equal(R.requestsSimulation('What can we simulate?'),false)
assert.equal(R.requestsSimulation("Don't run a simulation yet"),false)
assert.equal(R.requestsSimulation('不要模拟'),false)

const material = {...scoped.nodes[0],id:'material',kind:'material',fields:[{...fields[0],id:'instructions',value:null,state:'missing'}]}
const p2={...sample,nodes:[material],steps:[]}
assert.deepEqual(R.sectionNeeds(p2,R.SECTIONS.find(s=>s.id==='procedure'),sample.studies[0].id),['material:instructions'])

// Quote boxes: whitespace, punctuation and line-break hyphens do not hide a quote; nothing is invented.
const words = 'If susceptibility to anchoring is associated with low confi- dence, the correlation between'.split(' ').map((w,i)=>({t:w,x:i*5,y:10,w:4,h:2}))
assert.ok(R.quoteRects(words,'associated with low confidence, the correlation').length===1, 'hyphenated quote boxed as one line')
assert.deepEqual(R.quoteRects(words,'a sentence that is not on this page at all'),[])
const two=[{page:1,words:[{t:'nothing',x:0,y:0,w:1,h:1}]},{page:2,words}]
assert.equal(R.findQuote(two,'susceptibility to anchoring is associated',1).page,2, 'a quote on another page is found there')
assert.equal(R.findQuote(two,'not here at all, anywhere',1),null)

// Review questions: the agent's issues first by severity, then every amber field not already covered.
const amberProgram={...sample,nodes:[material,...sample.nodes],issues:[{id:'i1',title:'Check',severity:'check',reason:'r',impact:'',suggestedAction:'',evidenceIds:[]},{id:'i2',title:'Block',severity:'blocking',reason:'r',impact:'',suggestedAction:'',evidenceIds:[]}]}
const qs=R.reviewIssues(amberProgram,sample.studies[0].id,R.SECTIONS)
assert.equal(qs[0].id,'i2')
assert.ok(qs.some(q=>q.amber&&q.entity==='material'&&q.fieldId==='instructions'), 'amber field listed as a question to fill')
assert.deepEqual(R.amberItems(amberProgram,sample.studies[0].id,R.SECTIONS).map(a=>[a.entity,a.fieldId]).filter(([e])=>e==='material'),[['material','instructions']])
const st=R.stage(sample,R.SECTIONS.find(s=>s.id==='procedure'),sample.studies[0].id)
assert.ok(st.flow.length>0, 'procedure drawn as a flow')
rmSync(out,{recursive:true,force:true})
console.log('protocol, source routing, scope review and full quote regressions passed')
