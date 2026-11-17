// The three share layers (owner decision 2026-11-16), exercised through the one community exporter:
// 1 study overview (program.json, always), 2 runnable experiment (Validated or checks passed), 3 my results (ticked).
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {unzipSync,strFromU8} from 'fflate'

const script=join(dirname(fileURLToPath(import.meta.url)),'../../../pack/skills/export/community.py')
const engine=join(dirname(script),'../../runtime/hsenv')
const hash=data=>createHash('sha256').update(data).digest('hex')
const canonical=raw=>{
 const r=spawnSync('python3',['-c','import json,sys;sys.path.insert(0,sys.argv[1]);from hsenv.schema_check import canonical_sha256;print(canonical_sha256(json.loads(sys.argv[2])))',engine,raw],{encoding:'utf8'})
 assert.equal(r.status,0,r.stderr);return r.stdout.trim()
}

// Wording from a source without an open licence (CC-BY-ND), and pieces of it a leak could carry. The content rule
// is the project-wide one (check_materials): any run of 8 words, or a whole short line of 4+ words. Shorter phrases
// are ordinary language and are not treated as a copy.
const RESTRICTED='Please hand the sealed envelope to the observer standing beside the red gate before you begin.'
const WORDS=RESTRICTED.replace(/[.]$/,'').split(' ')
const FRAGMENTS=WORDS.slice(0,WORDS.length-7).map((_,i)=>WORDS.slice(i,i+8).join(' '))
const OPEN='Would you choose the brighter lamp?'

function ownStudy(){
 const root=mkdtempSync(join(tmpdir(),'share-layers-'))
 const write=(rel,bytes)=>{const path=join(root,rel);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes)}
 const protocol={schema_version:'1',id:'lamp',meta:{citation:'Example (2026)',title:'Lamp study',licence:{survey:'CC0-1.0'},sample:{n:1},
  sources:{survey:{file:'sources/open/survey.txt'},restricted:{file:'sources/handout.txt',distribution:{tier:'link',url:'https://example.org/materials'}}}},
  arms:[{id:'main',runnable:true,n_paper:1,cite:{label:'reported',source:'survey',page:1}}],
  stages:{q:{content:[{id:'prompt',text:OPEN,cite:{label:'verbatim',source:'survey',page:1}},
   {id:'handout',text:RESTRICTED,cite:{label:'verbatim',source:'restricted',page:1}}]}},
  flow:{stage:'q'},units:{},exclusions:[],analysis:{targets:[],effects:[],unsupported:[]},keyed:{answers:{}}}
 const raw=JSON.stringify(protocol)
 const study={schema_version:'1',id:'lamp',title:'Lamp study',authors:['A. Example'],year:2026,version:'1.0.0',quality:'high_fidelity',
  licence:{paper:'CC0-1.0',materials:'CC0-1.0'},protocol:{path:'protocol.json',sha256:canonical(raw),schema_version:'1'}}
 const program={schemaVersion:2,id:'lamp',title:'Lamp study',intent:'reconstruct',
  source:{title:'Lamp study',authors:'A. Example',year:2026,filename:'sources/open/survey.txt'},
  studies:[{id:'main',title:'Lamp preference',type:'empirical'}],
  nodes:[{id:'materials',kind:'materials',title:'Materials',fields:[
   {id:'handout',label:'Handout',value:RESTRICTED,origin:'verbatim',state:'confirmed',evidenceIds:['held-instructions']},
   {id:'design',label:'Design',value:'One choice between two lamps.',origin:'derived',state:'confirmed',evidenceIds:[]}]}],
  steps:[],relations:[],
  evidence:[{id:'held-instructions',path:'sources/handout.txt',sourceSha256:hash(RESTRICTED),url:'https://example.org/materials',locator:{page:1},quote:RESTRICTED,verification:'verified'}],
  issues:[],extensions:{scholarly:{profile:'scholarly-v1',protocol:{path:'protocol.json',id:'lamp',sha256:hash(raw)}}}}
 write('protocol.json',raw);write('study.json',JSON.stringify(study));write('program.json',JSON.stringify(program))
 write('sources/open/survey.txt',OPEN);write('sources/handout.txt',RESTRICTED)
 write('sources/SOURCE.json',JSON.stringify({files:[
  {path:'sources/open/survey.txt',sha256:hash(OPEN),license:'CC0-1.0',attribution:'A. Example',url:'https://example.org/survey'},
  {path:'sources/handout.txt',sha256:hash(RESTRICTED),license:'CC-BY-ND-4.0',attribution:'A. Example',url:'https://example.org/materials'}]}))
 write('artifacts/simulations/run-1/results.html','<h1>AI trial results</h1><p>Lamp choice: 62% brighter.</p>')
 write('artifacts/simulations/run-1/records.jsonl','{"session":1,"answer":"brighter"}\n')
 write('artifacts/report.md','# Analysis\nThe AI participants preferred the brighter lamp.')
 write('artifacts/leaky-notes.md','Screen two said: '+RESTRICTED)
 return {root,raw,write}
}
const run=(root,args)=>spawnSync('python3',[script,...args],{cwd:root,encoding:'utf8'})
const zipOf=(root,rel)=>unzipSync(readFileSync(join(root,rel)))
const assertNoRestricted=(files,label)=>{
 for(const [name,data] of Object.entries(files)){
  const text=Buffer.from(data).toString('utf8')
  for(const piece of [RESTRICTED,...FRAGMENTS]) assert.ok(!text.includes(piece),`${label}: ${name} carries restricted wording "${piece}"`)
  // JSON escapes or a different encoding of the same words must not slip through either.
  assert.ok(!text.toLowerCase().replace(/\\u[0-9a-f]{4}|[^a-z]/g,'').includes('sealedenvelopetotheobserverstandingbeside'),`${label}: ${name} encodes restricted wording`)
 }
}

test('layer plan: overview always, experiment refused until checks pass, results listed but unticked',()=>{
 const {root,raw}=ownStudy()
 try{
  const plan=JSON.parse(run(root,['--plan']).stdout)
  assert.equal(plan.overview.available,true)
  assert.deepEqual(plan.overview.files,['CONTRIBUTION.json','program.json'])
  assert.equal(plan.experiment.available,false)
  assert.equal(plan.experiment.code,'not-validated')
  assert.match(plan.experiment.reason,/Validated or its checks pass/)
  const ids=plan.results.map(r=>r.id).sort()
  assert.deepEqual(ids,['artifacts/leaky-notes.md','artifacts/report.md','artifacts/simulations/run-1'])
  const trial=plan.results.find(r=>r.id==='artifacts/simulations/run-1')
  assert.equal(trial.kind,'trial')
  assert.deepEqual(trial.files,['artifacts/simulations/run-1/results.html'],'raw run records never become a shareable result')
  assert.ok(!trial.blocked)
  assert.match(plan.results.find(r=>r.id==='artifacts/leaky-notes.md').blocked,/restricted source/)
  const checked=JSON.parse(run(root,['--plan','--checks-passed',hash(raw)]).stdout)
  assert.equal(checked.experiment.available,true)
  assert.equal(checked.experiment.validated,'checks')
  assert.deepEqual(checked.experiment.files,['CONTRIBUTION.json','program.json','protocol.json','study.json'])
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('layer 1 file list holds only the overview; restricted wording is withheld by content and marked Get from source',()=>{
 const {root}=ownStudy()
 try{
  const out=run(root,['--layer','overview','--output','exports/overview.zip'])
  assert.equal(out.status,0,out.stderr)
  const files=zipOf(root,'exports/overview.zip')
  assert.deepEqual(Object.keys(files).sort(),['CONTRIBUTION.json','program.json'])
  assertNoRestricted(files,'layer 1')
  const program=JSON.parse(strFromU8(files['program.json']))
  const field=program.nodes[0].fields.find(f=>f.id==='handout')
  assert.equal(field.value,null)
  assert.deepEqual(field.extensions.getFromSource.sources,[{url:'https://example.org/materials',sha256:hash(RESTRICTED)}])
  assert.equal(program.nodes[0].fields.find(f=>f.id==='design').value,'One choice between two lamps.')
  assert.equal(program.evidence[0].quote,undefined)
  assert.equal(program.evidence[0].url,'https://example.org/materials')
  const meta=JSON.parse(strFromU8(files['CONTRIBUTION.json']))
  assert.deepEqual(meta.layers,{overview:true,experiment:false,results:[]})
  assert.deepEqual(meta.getFromSource,[{url:'https://example.org/materials',sha256:hash(RESTRICTED),evidenceIds:['held-instructions'],fieldIds:['materials/handout']}])
  // --program-only is the same layer.
  assert.equal(run(root,['--program-only','--output','exports/legacy.zip']).status,0)
  assert.deepEqual(Object.keys(zipOf(root,'exports/legacy.zip')).sort(),['CONTRIBUTION.json','program.json'])
  // The saved project is never changed by a share.
  assert.equal(JSON.parse(readFileSync(join(root,'program.json'),'utf8')).nodes[0].fields[0].value,RESTRICTED)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('layer 2 is refused for an unvalidated study and ships restricted materials only as Get from source',()=>{
 const {root,raw}=ownStudy()
 try{
  const refused=run(root,['--layer','experiment','--output','exports/x.zip'])
  assert.equal(refused.status,1)
  assert.match(refused.stderr,/Validated or its checks pass/)
  assert.ok(!existsSync(join(root,'exports/x.zip')))
  const stale=run(root,['--layer','experiment','--checks-passed','0'.repeat(64),'--output','exports/x.zip'])
  assert.equal(stale.status,1,'checks of another protocol version do not count')
  const out=run(root,['--layer','experiment','--checks-passed',hash(raw),'--output','exports/experiment.zip'])
  assert.equal(out.status,0,out.stderr)
  const files=zipOf(root,'exports/experiment.zip')
  assert.deepEqual(Object.keys(files).sort(),['CONTRIBUTION.json','program.json','protocol.json','study.json'])
  assertNoRestricted(files,'layer 2')
  const protocol=JSON.parse(strFromU8(files['protocol.json']))
  const held=Object.values(protocol.distribution.held)
  assert.equal(held.length,1)
  assert.equal(held[0].text_sha256.length,64)
  assert.equal(protocol.meta.sources.restricted.distribution.tier,'link')
  assert.equal(protocol.meta.sources.restricted.distribution.url,'https://example.org/materials')
  assert.equal(protocol.stages.q.content[0].text,OPEN,'openly licensed wording ships as it is')
  const program=JSON.parse(strFromU8(files['program.json']))
  assert.equal(program.extensions.scholarly.protocol.sha256,hash(files['protocol.json']))
  assert.equal(program.extensions.communityExport.scope,'experiment')
  const meta=JSON.parse(strFromU8(files['CONTRIBUTION.json']))
  assert.equal(meta.kind,'protocol')
  assert.deepEqual(meta.layers,{overview:true,experiment:true,results:[]})
  assert.ok(meta.getFromSource.some(s=>s.source==='restricted'&&s.url==='https://example.org/materials'&&s.heldItems===1))
  assert.ok(JSON.parse(out.stdout).omitted.some(o=>o.path==='sources/open/survey.txt'))
  assert.equal(readFileSync(join(root,'protocol.json'),'utf8'),raw)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('layer 3 is off by default; only ticked results ship, and a result with restricted wording is refused',()=>{
 const {root,raw}=ownStudy()
 try{
  for(const args of [['--layer','overview'],['--layer','experiment','--checks-passed',hash(raw)]]){
   const name=`exports/${args[1]}-default.zip`
   assert.equal(run(root,[...args,'--output',name]).status,0)
   assert.ok(!Object.keys(zipOf(root,name)).some(p=>p.startsWith('artifacts/')),'no results unless ticked')
  }
  const ticked=run(root,['--layer','overview','--results','artifacts/report.md','--results','artifacts/simulations/run-1','--output','exports/with-results.zip'])
  assert.equal(ticked.status,0,ticked.stderr)
  const files=zipOf(root,'exports/with-results.zip')
  assert.deepEqual(Object.keys(files).sort(),['CONTRIBUTION.json','artifacts/report.md','artifacts/simulations/run-1/results.html','program.json'])
  assertNoRestricted(files,'layer 3')
  assert.deepEqual(JSON.parse(strFromU8(files['CONTRIBUTION.json'])).layers.results,['artifacts/report.md','artifacts/simulations/run-1'])
  const leak=run(root,['--layer','overview','--results','artifacts/leaky-notes.md','--output','exports/leak.zip'])
  assert.equal(leak.status,1)
  assert.match(leak.stderr,/leaky-notes[.]md contains wording from a restricted source/)
  assert.ok(!existsSync(join(root,'exports/leak.zip')))
  const raw_=run(root,['--layer','overview','--results','artifacts/simulations/run-1/records.jsonl','--output','exports/raw.zip'])
  assert.equal(raw_.status,1,'raw run records are not a result item')
  assert.equal(run(root,['--results','artifacts/report.md','--output','exports/nolayer.zip']).status,1)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('a Validated library copy shares its runnable experiment without local checks; an edited copy cannot',()=>{
 const {root,write}=ownStudy()
 try{
  // An unchanged library release: its protocol is already the public projection with held wording.
  const published={...JSON.parse(readFileSync(join(root,'protocol.json'),'utf8'))}
  published.stages.q.content[1].text='░'.repeat(RESTRICTED.length)
  published.distribution={format:'hsenv-projection/1',strict:true,placeholder:'░',attribution:[],
   held:{h1:{source:'restricted',path:'/stages/q/content/1/text',text_sha256:hash(RESTRICTED),locator:{format:'text',parts:[]}}}}
  const praw=JSON.stringify(published),sraw=readFileSync(join(root,'study.json'))
  write('protocol.json',praw)
  const program=JSON.parse(readFileSync(join(root,'program.json'),'utf8'))
  program.extensions.scholarly.protocol.sha256=hash(praw)
  write('program.json',JSON.stringify(program))
  const assetFiles=[{path:'protocol.json',sha256:hash(praw),bytes:praw.length},{path:'study.json',sha256:hash(sraw),bytes:sraw.length},
   {path:'sources/open/survey.txt',sha256:hash(OPEN),bytes:OPEN.length}]
  const context={id:'paper_'+'a'.repeat(24),currentRevision:'r'.repeat(64),assetFiles,hasReviewedProtocol:true,
   publication:{kind:'maintainer-reviewed-protocol',revision:'r'.repeat(64)}}
  write('.humanstudy/community.json',JSON.stringify(context))
  // The project's own community.json is informational: without the app's library confirmation it is not Validated.
  const unconfirmed=JSON.parse(run(root,['--plan']).stdout)
  assert.equal(unconfirmed.experiment.available,false)
  assert.equal(unconfirmed.experiment.code,'not-validated')
  assert.equal(run(root,['--layer','experiment','--library-validated','0'.repeat(64),'--output','exports/forged.zip']).status,1)
  const plan=JSON.parse(run(root,['--plan','--library-validated',hash(praw)]).stdout)
  assert.equal(plan.experiment.available,true,JSON.stringify(plan.experiment))
  assert.equal(plan.experiment.validated,'library')
  const out=run(root,['--layer','experiment','--library-validated',hash(praw),'--output','exports/validated.zip'])
  assert.equal(out.status,0,out.stderr)
  const files=zipOf(root,'exports/validated.zip')
  assert.deepEqual(Object.keys(files).sort(),['CONTRIBUTION.json','program.json','protocol.json','sources/open/survey.txt','study.json'])
  assert.equal(strFromU8(files['protocol.json']),praw,'the Validated protocol ships byte for byte')
  assertNoRestricted(files,'validated layer 2')
  // A ticked result on a study with held wording is refused until the restored wording can be checked.
  const plan2=JSON.parse(run(root,['--plan']).stdout)
  assert.match(plan2.results.find(r=>r.id==='artifacts/report.md').blocked,/cannot be checked/)
  const heldFile=join(root,'..',`held-${Date.now()}.json`)
  writeFileSync(heldFile,JSON.stringify({h1:RESTRICTED}))
  try{
   const plan3=JSON.parse(run(root,['--plan','--held-texts',heldFile]).stdout)
   assert.ok(!plan3.results.find(r=>r.id==='artifacts/report.md').blocked)
   assert.match(plan3.results.find(r=>r.id==='artifacts/leaky-notes.md').blocked,/restricted|held/)
  }finally{rmSync(heldFile,{force:true})}
  // Edited after download: no longer the Validated version, and local checks cannot re-certify a projection.
  write('protocol.json',praw.replace('Lamp study','Lamp study (edited)'))
  const edited=JSON.parse(run(root,['--plan','--library-validated',hash(praw),'--checks-passed',hash(praw.replace('Lamp study','Lamp study (edited)'))]).stdout)
  assert.equal(edited.experiment.available,false)
  assert.equal(edited.experiment.code,'changed-published')
 }finally{rmSync(root,{recursive:true,force:true})}
})

// ---- the main-process side (share-layers.ts): the app's own exporter copy, confined, fail-closed parsing -------------
import {build} from 'esbuild'
import {readdirSync,statSync} from 'node:fs'
import {pathToFileURL} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url))
const bundleDir=mkdtempSync(join(tmpdir(),'share-layers-ts-'))
await build({entryPoints:[join(here,'share-layers.ts')],bundle:true,platform:'node',format:'esm',outfile:join(bundleDir,'share.mjs'),logLevel:'error'})
const S=await import(pathToFileURL(join(bundleDir,'share.mjs')))
process.on('exit',()=>rmSync(bundleDir,{recursive:true,force:true}))
const pack=join(here,'../../../pack')
function trustedFiles(){
 const out=[['skills/export/community.py',readFileSync(join(pack,'skills/export/community.py'),'utf8')]]
 for(const f of readdirSync(join(pack,'skills/build')))if(f.endsWith('.py'))out.push(['skills/build/'+f,readFileSync(join(pack,'skills/build',f),'utf8')])
 const walk=(dir,rel)=>{for(const f of readdirSync(dir)){const p=join(dir,f);if(f==='__pycache__'||f.endsWith('.pyc'))continue
  if(statSync(p).isDirectory())walk(p,rel+f+'/');else out.push(['hsenv/'+rel+f,readFileSync(p,'utf8')])}}
 walk(join(pack,'runtime/hsenv'),'')
 return out
}
const python=spawnSync(process.env.HUMANSTUDY_TEST_PYTHON||'python3',['-c','import sys;print(sys.executable)'],{encoding:'utf8'}).stdout.trim()

test('the plan is parsed fail-closed and only shareable result ids reach the exporter',()=>{
 const p=S.sharePreviewOf({overview:{available:true,files:['program.json'],withheld:2,getFromSource:[{}]},experiment:{available:'yes',code:'weird'},
  results:[{id:'artifacts/a.md',kind:'material',files:['artifacts/a.md'],bytes:3},{id:'artifacts/b.md',blocked:'leak'},{id:'../x'}]})
 assert.deepEqual(p.overview,{available:true,files:['program.json'],withheld:2,getFromSource:1})
 assert.equal(p.experiment.available,false);assert.equal(p.experiment.code,'blocked')
 assert.deepEqual(p.results.map(r=>r.id),['artifacts/a.md','artifacts/b.md'])
 assert.deepEqual(S.selectedResults(['artifacts/a.md','artifacts/b.md','artifacts/zzz',7],p),['artifacts/a.md'],'blocked and unknown items are dropped')
 assert.deepEqual(S.selectedResults(undefined,p),[])
 const none=S.runtimeMissing();assert.equal(none.overview.available,false);assert.equal(none.experiment.code,'runtime')
 assert.equal(S.exporterMessage('Restricted source wording appears in program.json.\n'),'Restricted source wording appears in program.json.')
 assert.doesNotMatch(S.exporterMessage('Traceback (most recent call last):\n  File "x"\nKeyError: \'source\''),/source'/,'an unexpected failure is never shown raw')
 assert.match(S.shareFileName('My: study','experiment',new Date('2026-11-16T00:00:00Z')),/^My- study-experiment-2026-11-16[.]zip$/)
})

test('held texts are read from the restored copy at each held pointer, and checks count only for unchanged bytes',async()=>{
 const projection={distribution:{held:{h1:{path:'/stages/q/content/0/text'},h2:{path:'/data/img',kind:'image'}}}}
 const restored={stages:{q:{content:[{text:RESTRICTED}]}}}
 assert.deepEqual(S.heldTextsOf(JSON.stringify(projection),JSON.stringify(restored)),{h1:RESTRICTED})
 assert.deepEqual(S.heldTextsOf('not json','{}'),{})
 const {root,raw,write}=ownStudy()
 try{
  assert.equal(await S.passedProtocolSha(root,async()=>[]),hash(raw))
  assert.equal(await S.passedProtocolSha(root,async()=>[{check:'verbatim'}]),null)
  assert.equal(await S.passedProtocolSha(root,async()=>{write('protocol.json',raw+' ');return []}),null,'a protocol written during the checks is not the one that passed')
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('Validated is confirmed from the library catalog, not from the project record',async()=>{
 const {root,raw,write}=ownStudy()
 try{
  write('.humanstudy/community.json',JSON.stringify({id:'paper_x',hasReviewedProtocol:true}))
  const entry={id:'paper_x',assetFiles:[{path:'protocol.json',sha256:hash(raw)}]}
  assert.equal(await S.confirmedLibrarySha(root,async()=>[entry],()=>true),hash(raw))
  assert.equal(await S.confirmedLibrarySha(root,async()=>[entry],()=>false),null,'the catalog says it is not Validated')
  assert.equal(await S.confirmedLibrarySha(root,async()=>[{...entry,assetFiles:[{path:'protocol.json',sha256:'0'.repeat(64)}]}],()=>true),null,'changed protocol')
  assert.equal(await S.confirmedLibrarySha(root,async()=>{throw new Error('offline')},()=>true),null)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('the app runs its own exporter copy confined: plan, layer 2 after checks, ticked results, refusals as plain text',{skip:!python&&'no python'},async()=>{
 const {root,raw}=ownStudy()
 const out=mkdtempSync(join(tmpdir(),'share-out-'))
 try{
  const rt={python,files:trustedFiles(),bin:''}
  assert.deepEqual(await S.sharePlan({...rt,python:null},root),S.runtimeMissing())
  const plan=await S.sharePlan(rt,root)
  assert.equal(plan.overview.available,true);assert.equal(plan.experiment.code,'not-validated')
  await assert.rejects(S.shareExport(rt,root,'experiment',[],join(out,'x.zip')),/Validated or its checks pass/)
  const checked={...rt,checksPassed:hash(raw)}
  assert.equal((await S.sharePlan(checked,root)).experiment.validated,'checks')
  const target=join(out,'share.zip')
  const r=await S.shareExport(checked,root,'experiment',['artifacts/report.md'],target)
  assert.deepEqual(r.files,['CONTRIBUTION.json','artifacts/report.md','program.json','protocol.json','study.json'])
  const files=unzipSync(readFileSync(target))
  assert.deepEqual(Object.keys(files).sort(),r.files)
  assertNoRestricted(files,'app share')
  assert.ok(!existsSync(join(root,'exports')),'no copy of the share is ever written into the project')
 }finally{rmSync(root,{recursive:true,force:true});rmSync(out,{recursive:true,force:true})}
})


test('a forged library record cannot open layer 2, and results are checked by content in every format',()=>{
 const {root,raw,write}=ownStudy()
 try{
  const sraw=readFileSync(join(root,'study.json'))
  write('.humanstudy/community.json',JSON.stringify({id:'paper_'+'b'.repeat(24),currentRevision:'r'.repeat(64),hasReviewedProtocol:true,
   publication:{kind:'maintainer-reviewed-protocol',revision:'r'.repeat(64)},
   assetFiles:[{path:'protocol.json',sha256:hash(raw)},{path:'study.json',sha256:hash(sraw)}]}))
  for(const extra of [[],['--library-validated',hash(raw)]]){
   const plan=JSON.parse(run(root,['--plan',...extra]).stdout)
   assert.equal(plan.experiment.available,false,'an own protocol (not a published projection) is never the library route')
   assert.equal(run(root,['--layer','experiment',...extra,'--output',`exports/forged-${extra.length}.zip`]).status,1)
  }
  // Disguised copies: HTML entities, invisible characters, an office document, a notebook, an unknown binary.
  write('artifacts/entities.html','<p>'+RESTRICTED.split(' ').join('&amp;#32;')+'</p>')
  write('artifacts/invisible.md',RESTRICTED.split(' ').join(' \u200b'))
  write('artifacts/notebook.ipynb',JSON.stringify({cells:[{cell_type:'markdown',source:[RESTRICTED]}]}))
  write('artifacts/blob.bin',Buffer.from([0,159,146,150,0,1,2,3]))
  const docx=spawnSync('python3',['-c',`import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w')
z.writestr('[Content_Types].xml','<Types/>')
z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>'+sys.argv[2]+'</w:t></w:r></w:p></w:body></w:document>')
z.close()`,join(root,'artifacts/handout.docx'),RESTRICTED],{encoding:'utf8'})
  assert.equal(docx.status,0,docx.stderr)
  const plan=JSON.parse(run(root,['--plan']).stdout)
  for(const id of ['artifacts/entities.html','artifacts/invisible.md','artifacts/notebook.ipynb','artifacts/handout.docx','artifacts/blob.bin']){
   const item=plan.results.find(r=>r.id===id)
   assert.ok(item?.blocked,`${id} must be blocked: ${JSON.stringify(item)}`)
   assert.equal(run(root,['--layer','overview','--results',id,'--output',`exports/${id.split('/').pop()}.zip`]).status,1,id)
  }
  assert.ok(!plan.results.find(r=>r.id==='artifacts/report.md').blocked)
 }finally{rmSync(root,{recursive:true,force:true})}
})
