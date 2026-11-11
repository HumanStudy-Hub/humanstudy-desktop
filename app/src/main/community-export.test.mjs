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
  writeFileSync(join(root,'sources/material.txt'),'CHANGED AFTER LICENCE RECORD')
  const changed=spawnSync('python3',[script,'--output','exports/changed.zip'],{cwd:root,encoding:'utf8'})
  assert.equal(changed.status,1)
  assert.match(changed.stderr,/no longer match sources\/SOURCE[.]json/)
  writeFileSync(join(root,'protocol.json'),'{}')
  const paired=spawnSync('python3',[script,'--output','exports/paired.zip'],{cwd:root,encoding:'utf8'})
  assert.equal(paired.status,1)
  assert.match(paired.stderr,/verified public protocol projection/)
 }finally{rmSync(root,{recursive:true,force:true})}
})
