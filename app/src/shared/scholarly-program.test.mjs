import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
const here=dirname(fileURLToPath(import.meta.url)),dir=mkdtempSync(join(tmpdir(),'scholarly-'))
await build({entryPoints:[join(here,'scholarly-program.ts')],bundle:true,platform:'node',format:'esm',outfile:join(dir,'profile.mjs'),logLevel:'error'})
await build({entryPoints:[join(here,'../main/scholarly-delivery.ts')],bundle:true,platform:'node',format:'esm',outfile:join(dir,'delivery.mjs'),logLevel:'error'})
const S=await import(pathToFileURL(join(dir,'profile.mjs'))),D=await import(pathToFileURL(join(dir,'delivery.mjs')))
const sample=join(here,'../../resources/protocol-sample'),raw=readFileSync(join(sample,'protocol.json'),'utf8'),protocol=JSON.parse(raw),program=JSON.parse(readFileSync(join(sample,'program.json'),'utf8'))
const hash=s=>createHash('sha256').update(s).digest('hex')
after(()=>rmSync(dir,{recursive:true,force:true}))
test('Mazzarella scholarly document covers both studies and pins the unchanged runnable protocol',()=>{
 assert.deepEqual(S.scholarlyProblems(program,protocol,hash(raw)),[])
 assert.deepEqual(program.studies.map(s=>s.id),['s1','s2']);assert.equal(program.steps.length,0)
 assert.ok(program.nodes.find(n=>n.kind==='hypothesis').fields[0].value.includes('assessment'))
 assert.ok(program.nodes.find(n=>n.kind==='finding').fields[0].value.includes('not establish'))
})
test('incomplete scholarly fields, unknown result references and an outdated protocol cannot pass',()=>{
 for (const change of [p=>p.nodes=p.nodes.filter(n=>n.kind!=='hypothesis'),p=>p.nodes[0].fields[0].evidenceIds=[],p=>p.nodes[0].fields[0].extensions={gapReason:'not_extracted'},p=>p.nodes.find(n=>n.kind==='result').extensions.effectRefs=['invented'],p=>p.studies.pop()]) {
  const p=structuredClone(program);change(p);assert.ok(S.scholarlyProblems(p,protocol,hash(raw)).length)
 }
 assert.ok(S.scholarlyProblems(program,protocol,'f'.repeat(64)).length)
})
test('one empirical study can map to several execution arms without calling them studies',()=>{
 const p=structuredClone(program)
 p.studies=[{id:'paper-exp',title:'One experiment with two scopes',type:'empirical'}]
 for(const n of p.nodes)n.studyIds=['paper-exp']
 p.extensions.scholarly.studyArms={'paper-exp':['s1','s2']}
 assert.deepEqual(S.scholarlyProblems(p,protocol,hash(raw)),[])
 assert.deepEqual(S.scholarlyArmIds(p,'paper-exp'),['s1','s2'])
 p.extensions.scholarly.studyArms['paper-exp'].push('nonexistent')
 assert.ok(S.scholarlyProblems(p,protocol,hash(raw)).length)
})
test('an experiment request specifies scope, material questions, separate variants and paid-run approval',()=>{
 const prompt=S.prepareExperimentPrompt({id:'e1',title:'Experiment 1'})
 for(const phrase of ['e1','only this experiment','ask me a specific','separate modified version','approve the simulation scope and cost'])assert.ok(prompt.includes(phrase),phrase)
})
test('paired delivery requires both program and a current preview; legacy imports stay readable',()=>{
 const project=join(dir,'project');mkdirSync(join(project,'artifacts'),{recursive:true})
 assert.deepEqual(D.scholarlyDeliveryProblems(project,raw),[])
 const p=structuredClone(protocol);p.meta.delivery='research-program-v1';const text=JSON.stringify(p),sha=hash(text)
 assert.ok(D.scholarlyDeliveryProblems(project,text).length)
 const research=structuredClone(program);research.extensions.scholarly.protocol.sha256=sha
 writeFileSync(join(project,'program.json'),JSON.stringify(research))
 writeFileSync(join(project,'artifacts/preview.html'),`<script id="hs-protocol" type="application/json">${JSON.stringify({id:p.id,sha256:sha})}</script>`)
 assert.deepEqual(D.scholarlyDeliveryProblems(project,text),[])
 writeFileSync(join(project,'artifacts/preview.html'),readFileSync(join(sample,'artifacts/preview.html')))
 assert.ok(D.scholarlyDeliveryProblems(project,text).length)
 research.nodes=research.nodes.filter(n=>n.kind!=='finding');writeFileSync(join(project,'program.json'),JSON.stringify(research))
 assert.ok(D.scholarlyDeliveryProblems(project,text).length)
})
