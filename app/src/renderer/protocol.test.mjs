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
  import Document, { viewStudies } from './program/ProgramDocument';
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
assert.ok(!html.includes('data-section="simulation"'), 'scope is separate from the study document')
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
rmSync(out,{recursive:true,force:true})
console.log('protocol, source routing, scope review and full quote regressions passed')
