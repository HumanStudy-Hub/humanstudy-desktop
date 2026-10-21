import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {unzipSync,strFromU8} from 'fflate'
const script=join(dirname(fileURLToPath(import.meta.url)),'../../../pack/skills/export/community.py')
test('community export includes all research artifacts and the real baseline, excluding private state and PDFs by default',()=>{
 const root=mkdtempSync(join(tmpdir(),'community-export-'))
 try{
  for(const dir of ['sources','package/test','artifacts','exports','.humanstudy'])mkdirSync(join(root,dir),{recursive:true})
  writeFileSync(join(root,'program.json'),JSON.stringify({source:{title:'Paper',authors:['Author'],year:2026},nodes:[]}))
  writeFileSync(join(root,'sources/study.json'),JSON.stringify({id:'paper_'+'a'.repeat(24),baseRevision:'b'.repeat(64),year:2026}))
  writeFileSync(join(root,'sources/material.txt'),'FULL MATERIAL END')
  writeFileSync(join(root,'sources/paper.pdf'),'%PDF-test')
  writeFileSync(join(root,'artifacts/overview.html'),'<h1>Research artifact</h1>')
  writeFileSync(join(root,'package/test/.env'),'secret')
  writeFileSync(join(root,'.humanstudy/threads.json'),'private chat')
  const run=spawnSync('python3',[script,'--output','exports/community.zip'],{cwd:root,encoding:'utf8'})
  assert.equal(run.status,0,run.stderr)
  const files=unzipSync(readFileSync(join(root,'exports/community.zip')))
  assert.ok(files['program.json']&&files['sources/material.txt']&&files['artifacts/overview.html'])
  assert.ok(!Object.keys(files).some(p=>p.includes('.env')||p.includes('.humanstudy')||p.endsWith('.pdf')))
  assert.equal(strFromU8(files['sources/material.txt']),'FULL MATERIAL END')
  const metadata=JSON.parse(strFromU8(files['CONTRIBUTION.json']))
  assert.equal(metadata.baseRevision,'b'.repeat(64));assert.equal(metadata.paperId,'paper_'+'a'.repeat(24))
  assert.equal(spawnSync('python3',[script,'--output','exports/community.zip'],{cwd:root}).status,1,'existing exports are never overwritten')
 }finally{rmSync(root,{recursive:true,force:true})}
})
