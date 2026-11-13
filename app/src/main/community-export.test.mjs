import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {unzipSync,strFromU8} from 'fflate'
const script=join(dirname(fileURLToPath(import.meta.url)),'../../../pack/skills/export/community.py')
test('community export includes finished research artifacts and the real baseline, excluding private state and PDFs by default',()=>{
 const root=mkdtempSync(join(tmpdir(),'community-export-'))
 try{
  for(const dir of ['sources/open','sources/Researcher','package/test','artifacts/simulations/r1','exports','.humanstudy'])mkdirSync(join(root,dir),{recursive:true})
  writeFileSync(join(root,'program.json'),JSON.stringify({source:{title:'Paper',authors:['Author'],year:2026},nodes:[],evidence:[{path:'verbatim.txt'}]}))
  writeFileSync(join(root,'verbatim.txt'),'Complete legacy material END')
  writeFileSync(join(root,'sources/study.json'),JSON.stringify({id:'paper_'+'a'.repeat(24),baseRevision:'b'.repeat(64),year:2026}))
  writeFileSync(join(root,'sources/material.txt'),'FULL MATERIAL END')
  writeFileSync(join(root,'sources/paper.pdf'),'%PDF-test')
  writeFileSync(join(root,'sources/supplement.txt'),'UNLICENSED SUPPLEMENT')
  const digest = data => createHash('sha256').update(data).digest('hex')
  writeFileSync(join(root,'sources/SOURCE.json'),JSON.stringify({files:[
   {path:'sources/material.txt',license:'CC-BY-4.0',sha256:digest('FULL MATERIAL END')},
   {path:'sources/paper.pdf',license:'CC-BY-4.0'},
   {path:'verbatim.txt',license:'CC-BY-4.0'},
   {path:'sources/Researcher/never-disclose.txt',license:'researcher-supplied'}],
   materialsSearch:{question:'private provenance note that must stay local'}}))
  writeFileSync(join(root,'sources/open/unverified.txt'),'Unverified open-folder label')
  writeFileSync(join(root,'sources/Researcher/never-disclose.txt'),'A private note whose path and contents stay local.')
  writeFileSync(join(root,'artifacts/simulations/r1/results.html'),'<h1>Raw run outputs</h1>')
  writeFileSync(join(root,'artifacts/simulations/r1/report.md'),'Published aggregate summary')
  writeFileSync(join(root,'artifacts/raw-table.csv'),'participant_id,reaction_time,response\nP1,222,yes')
  writeFileSync(join(root,'artifacts/paper.pdf.annotations.json'),'Private researcher annotation')
  writeFileSync(join(root,'artifacts/overview.html'),'<h1>Research artifact</h1>')
  writeFileSync(join(root,'package/test/.env'),'secret')
  writeFileSync(join(root,'.humanstudy/threads.json'),'private chat')
  const run=spawnSync('python3',[script,'--output','exports/community.zip'],{cwd:root,encoding:'utf8'})
  assert.equal(run.status,0,run.stderr)
  const files=unzipSync(readFileSync(join(root,'exports/community.zip')))
  assert.ok(files['program.json']&&files['sources/material.txt']&&files['artifacts/overview.html'])
  assert.ok(!Object.keys(files).some(p=>p.includes('.env')||p.includes('.humanstudy')||p.endsWith('.pdf')))
  assert.equal(strFromU8(files['sources/material.txt']),'FULL MATERIAL END')
  assert.ok(!files['sources/supplement.txt'],'a supplement without a recorded open licence is not published')
  assert.equal(strFromU8(files['sources/attached/verbatim.txt']),'Complete legacy material END')
  const metadata=JSON.parse(strFromU8(files['CONTRIBUTION.json']))
  assert.equal(metadata.baseRevision,'b'.repeat(64));assert.equal(metadata.paperId,'paper_'+'a'.repeat(24))
  assert.equal(metadata.includesPdf,false)
  assert.deepEqual(metadata.files.map(entry=>entry.path),Object.keys(files).filter(p=>p!=='CONTRIBUTION.json').sort())
  for(const entry of metadata.files){
   assert.equal(entry.bytes,files[entry.path].length)
   assert.equal(entry.sha256,digest(files[entry.path]))
  }
  assert.ok(!Object.keys(files).some(p=>/Researcher|unverified|results[.]html|raw-table|annotations/i.test(p)))
  const review=JSON.parse(run.stdout)
  assert.deepEqual(review.publicFiles.sort(),Object.keys(files).sort())
  assert.ok(review.omitted.some(entry=>entry.path==='artifacts/raw-table.csv'))
  assert.ok(files['artifacts/simulations/r1/report.md'])
  assert.ok(!JSON.stringify(metadata).includes('never-disclose'))
  assert.ok(!strFromU8(files['sources/SOURCE.json']).includes('private provenance'))
  assert.equal(spawnSync('python3',[script,'--output','exports/with-paper.zip','--include-paper'],{cwd:root}).status,0)
  const withPaper=unzipSync(readFileSync(join(root,'exports/with-paper.zip')))
  assert.ok(withPaper['sources/paper.pdf']);assert.equal(JSON.parse(strFromU8(withPaper['CONTRIBUTION.json'])).includesPdf,true)
  assert.equal(spawnSync('python3',[script,'--output','exports/community.zip'],{cwd:root}).status,1,'existing exports are never overwritten')
  writeFileSync(join(root,'artifacts/private-token.md'),'Authorization: Bearer synthetic-not-a-real-token-123456789')
  const reportSecret=spawnSync('python3',[script,'--output','exports/report-secret.zip'],{cwd:root,encoding:'utf8'})
  assert.equal(reportSecret.status,1)
  assert.match(reportSecret.stderr,/Public export blocked/)
  rmSync(join(root,'artifacts/private-token.md'))
  const sensitiveName='sk-synthetic-not-a-real-secret-123456789.md'
  writeFileSync(join(root,'artifacts',sensitiveName),'Ordinary report')
  const namedSecret=spawnSync('python3',[script,'--output','exports/named-secret.zip'],{cwd:root,encoding:'utf8'})
  assert.equal(namedSecret.status,1)
  assert.match(namedSecret.stderr,/Public export blocked/)
  assert.ok(!namedSecret.stderr.includes(sensitiveName))
  rmSync(join(root,'artifacts',sensitiveName))
  writeFileSync(join(root,'sources/material.txt'),'CHANGED AFTER LICENCE RECORD')
  const changed=spawnSync('python3',[script,'--output','exports/changed.zip'],{cwd:root,encoding:'utf8'})
  assert.equal(changed.status,1)
  assert.match(changed.stderr,/no longer match sources\/SOURCE[.]json/)
  writeFileSync(join(root,'protocol.json'),'{}')
  const paired=spawnSync('python3',[script,'--output','exports/paired.zip'],{cwd:root,encoding:'utf8'})
  assert.equal(paired.status,1)
  assert.match(paired.stderr,/needs both protocol[.]json and study[.]json/)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('paired export projects hosted sources and binds both documents to the frozen public protocol',()=>{
 const root=mkdtempSync(join(tmpdir(),'community-pair-'))
 try{
  const write=(rel,bytes)=>{const path=join(root,rel);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,bytes)}
  const hash=data=>createHash('sha256').update(data).digest('hex')
  const source='Would you choose the brighter lamp?'
  const privateText='The private copy supplied to this project is intentionally kept outside public material.'
  const protocol={schema_version:'1',id:'lamp',meta:{citation:'Example (2026)',licence:{survey:'CC0-1.0'},sample:{n:1},sources:{survey:{file:'sources/open/survey.txt'}}},
   arms:[{id:'main',runnable:true,n_paper:1,cite:{label:'reported',source:'survey',page:1}},{id:'missing',runnable:false,n_paper:null,why:'Original instructions unavailable'}],
   stages:{q:{content:[{id:'prompt',text:source,cite:{label:'verbatim',source:'survey',page:1}}]}},flow:{stage:'q'},units:{},exclusions:[],analysis:{targets:[],effects:[],unsupported:[]},keyed:{answers:{}}}
  const raw=JSON.stringify(protocol)
  const rawHash=hash(raw)
  const engine=join(dirname(script),'../../runtime/hsenv')
  const canonical=spawnSync('python3',['-c','import json,sys;sys.path.insert(0,sys.argv[1]);from hsenv.schema_check import canonical_sha256;print(canonical_sha256(json.loads(sys.argv[2])))',engine,raw],{encoding:'utf8'})
  assert.equal(canonical.status,0,canonical.stderr)
  const study={schema_version:'1',id:'lamp',title:'Lamp study',authors:['A. Example'],year:2026,version:'1.2.3',quality:'high_fidelity',
   licence:{paper:'CC0-1.0',materials:'CC0-1.0'},protocol:{path:'protocol.json',sha256:canonical.stdout.trim(),schema_version:'1'}}
  const program={schemaVersion:2,id:'lamp',title:'Lamp study',intent:'reconstruct',
   source:{title:'Lamp study',authors:'A. Example',filename:'sources/open/survey.txt'},
   studies:[{id:'main',title:'Lamp preference',type:'empirical'}],nodes:[],steps:[],relations:[],evidence:[],
   issues:[{id:'missing',title:'Missing instructions',severity:'blocking',reason:'Original instructions unavailable',impact:'The missing arm cannot run.',suggestedAction:'Provide the original instructions.',evidenceIds:[]}],
   extensions:{scholarly:{profile:'scholarly-v1',protocol:{path:'protocol.json',id:'lamp',sha256:rawHash}}}}
  write('protocol.json',raw);write('study.json',JSON.stringify(study));write('program.json',JSON.stringify(program))
  write('sources/open/survey.txt',source)
  write('sources/private/never-disclose.txt',privateText)
  write('sources/SOURCE.json',JSON.stringify({files:[{path:'sources/open/survey.txt',sha256:hash(source),license:'CC0-1.0',attribution:'A. Example'}]}))
  write('artifacts/report.md','A finished public report.')
  write('artifacts/private-copy.md',privateText)
  write('artifacts/simulations/run/records.jsonl','private simulation records')
  const run=(name)=>spawnSync('python3',[script,'--output',`exports/${name}.zip`],{cwd:root,encoding:'utf8'})
  // Both public routes reject sensitive values embedded in ordinary prose, not just path keys.
  const unsafe = [
   '/Users/synthetic-person/private-notes.txt',
   'C:\\Users\\synthetic-person\\private-notes.txt',
   'Authorization: Bearer synthetic-not-a-real-token-123456789',
   'sk-synthetic-not-a-real-secret-123456789',
  ]
  for (const [index, value] of unsafe.entries()) {
   write('program.json', JSON.stringify({...program, notes:`Working note: ${value}`}))
   for (const programOnly of [false, true]) {
    const rel=`exports/blocked-${index}-${programOnly}.zip`
    const attempt=spawnSync('python3',[script,'--output',rel,...(programOnly?['--program-only']:[])],{cwd:root,encoding:'utf8'})
    assert.equal(attempt.status,1)
    assert.match(attempt.stderr,/Public export blocked/)
    assert.ok(!attempt.stderr.includes(value),'rejection does not disclose the sensitive value')
   }
  }
  const safeProgram={...program, notes:'Author: researcher@example.org; source https://example.org/Users/reference and doi:10.1234/example. SHA '+ 'a'.repeat(64)}
  write('program.json',JSON.stringify(safeProgram))
  const exported=run('pair')
  assert.equal(exported.status,0,exported.stderr)
  write('program.json',JSON.stringify(program))
  const zip=readFileSync(join(root,'exports/pair.zip'))
  const entries=unzipSync(zip)
  const json=name=>JSON.parse(strFromU8(entries[name]))
  const metadata=json('CONTRIBUTION.json')
  assert.equal(metadata.kind,'protocol')
  assert.equal(json('study.json').version,'1.2.3')
  assert.equal(json('study.json').quality,'draft')
  assert.equal(json('protocol.json').distribution.strict,true)
  assert.deepEqual(json('protocol.json').distribution.held,{})
  assert.equal(json('protocol.json').arms[1].why,protocol.arms[1].why)
  assert.deepEqual(json('program.json').issues,program.issues)
  assert.equal(json('program.json').extensions.scholarly.protocol.sha256,hash(entries['protocol.json']))
  assert.deepEqual(metadata.files.map(f=>f.path),['artifacts/report.md','program.json','protocol.json','sources/SOURCE.json','sources/open/survey.txt','study.json'])
  assert.ok(!JSON.stringify(metadata).includes('never-disclose'))
  assert.equal(readFileSync(join(root,'protocol.json'),'utf8'),raw)
  assert.deepEqual(JSON.parse(readFileSync(join(root,'study.json'),'utf8')),study)
  assert.deepEqual(JSON.parse(readFileSync(join(root,'program.json'),'utf8')),program)
  // A downloaded open-source projection carries a placeholder marker in metadata, not held text.
  const imported=join(root,'imported')
  for(const [name,data] of Object.entries(entries)){
   const file=join(imported,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,data)
  }
  const reexport=spawnSync('python3',[script,'--output','exports/reexport.zip'],{cwd:imported,encoding:'utf8'})
  assert.equal(reexport.status,0,reexport.stderr)
  const again=unzipSync(readFileSync(join(imported,'exports/reexport.zip')))
  assert.deepEqual(JSON.parse(strFromU8(again['protocol.json'])).distribution.held,{})
  for(const name of ['program.json','protocol.json','study.json'])assert.equal(readFileSync(join(imported,name),'utf8'),strFromU8(entries[name]))
  const concealed=json('protocol.json')
  concealed.stages.q.content[0].text+=' ░'
  writeFileSync(join(imported,'protocol.json'),JSON.stringify(concealed))
  const heldContent=spawnSync('python3',[script,'--output','exports/held.zip'],{cwd:imported,encoding:'utf8'})
  assert.match(heldContent.stderr,/held or locally restored wording/)
  if(process.env.HUMANSTUDY_TEST_PAIRED_ZIP) writeFileSync(process.env.HUMANSTUDY_TEST_PAIRED_ZIP,zip)
  write('program.json',JSON.stringify({...program,notes:privateText}))
  assert.match(run('leak').stderr,/Private materials appear in program[.]json/)
  write('program.json',JSON.stringify({...program,evidence:[{path:'sources/open/missing.txt'}]}))
  assert.match(run('missing-source').stderr,/missing from the licensed public files/)
  write('program.json',JSON.stringify(program))
  write('study.json',JSON.stringify({...study,title:'Another paper'}))
  assert.match(run('paper-mismatch').stderr,/different paper identities/)
  write('study.json',JSON.stringify(study))
  write('protocol.json',JSON.stringify({...protocol,distribution:{held:{h1:{}}}}))
  assert.match(run('held').stderr,/held or locally restored wording/)
  write('protocol.json',JSON.stringify({...protocol,meta:{...protocol.meta,citation:'Changed'}}))
  assert.match(run('stale').stderr,/does not bind/)

  const restricted='Please hand the sealed envelope to the observer beside the red gate.'
  const reference={id:'held-instructions',path:'sources/handout.txt',sourceSha256:hash(restricted),
   url:'https://example.org/materials',locator:{page:1},quote:restricted,verification:'verified'}
  write('sources/handout.txt',restricted)
  write('sources/SOURCE.json',JSON.stringify({files:[
   {path:'sources/open/survey.txt',sha256:hash(source),license:'CC0-1.0',attribution:'A. Example'},
   {path:'sources/handout.txt',sha256:hash(restricted),license:'CC-BY-ND-4.0',attribution:'A. Example'}]}))
  write('protocol.json',JSON.stringify({...protocol,meta:{...protocol.meta,sources:{...protocol.meta.sources,
   restricted:{file:'sources/handout.txt',distribution:{tier:'link',url:reference.url}}}}}))
  const localProgram={...program,evidence:[reference]}
  write('program.json',JSON.stringify(localProgram))
  const standalone=(name)=>spawnSync('python3',[script,'--program-only','--output',`exports/${name}.zip`],{cwd:root,encoding:'utf8'})
  const programOnly=standalone('program-only')
  assert.equal(programOnly.status,0,programOnly.stderr)
  const partial=unzipSync(readFileSync(join(root,'exports/program-only.zip')))
  assert.deepEqual(Object.keys(partial).sort(),['CONTRIBUTION.json','program.json'])
  const shared=JSON.parse(strFromU8(partial['program.json']))
  assert.equal(JSON.parse(strFromU8(partial['CONTRIBUTION.json'])).paper.year,2026)
  assert.equal(shared.extensions.scholarly.protocol,undefined)
  assert.deepEqual(shared.issues,program.issues)
  assert.deepEqual(shared.evidence,[{id:reference.id,path:reference.path,sourceSha256:reference.sourceSha256,
   url:reference.url,locator:reference.locator}])
  assert.deepEqual(shared.extensions.communityExport,{scope:'program-only',
   withheldEvidenceQuotes:{ids:[reference.id],reason:'redistribution-unverified'}})
  assert.equal(JSON.parse(strFromU8(partial['CONTRIBUTION.json'])).files[0].sha256,hash(partial['program.json']))
  assert.deepEqual(JSON.parse(programOnly.stdout).withheldEvidenceQuotes.ids,[reference.id])
  assert.deepEqual(JSON.parse(readFileSync(join(root,'program.json'),'utf8')),localProgram)
  if(process.env.HUMANSTUDY_TEST_PROGRAM_ZIP)writeFileSync(process.env.HUMANSTUDY_TEST_PROGRAM_ZIP,readFileSync(join(root,'exports/program-only.zip')))

  write('program.json',JSON.stringify({...localProgram,notes:restricted}))
  assert.match(standalone('restricted-copy').stderr,/Restricted source wording appears in program[.]json/)
  const held='Go forward.'
  write('protocol.json',JSON.stringify({...protocol,distribution:{held:{h1:{text_sha256:hash(held)}}}}))
  write('program.json',JSON.stringify({...localProgram,notes:held}))
  assert.match(standalone('held-copy').stderr,/Held source wording appears in program[.]json/)
  write('program.json',JSON.stringify(localProgram))
  write('study.json',JSON.stringify({...study,title:'Unrelated study'}))
  assert.match(standalone('missing-identity').stderr,/Add the paper title, first author and publication year/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
