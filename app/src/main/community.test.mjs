import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdtemp,readFile,rm,mkdir} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
const here=dirname(fileURLToPath(import.meta.url)),temp=await mkdtemp(join(tmpdir(),'community-index-'))
await build({entryPoints:[join(here,'community.ts')],bundle:true,platform:'node',format:'esm',outfile:join(temp,'community.mjs'),logLevel:'error'})
await build({entryPoints:[join(here,'../shared/research-search.ts')],bundle:true,platform:'node',format:'esm',outfile:join(temp,'search.mjs'),logLevel:'error'})
const lib=await import(pathToFileURL(join(temp,'community.mjs'))),{matchesResearch}=await import(pathToFileURL(join(temp,'search.mjs')))
const id='paper_'+'a'.repeat(24),commit='c'.repeat(40)
const content=Buffer.from('{"schemaVersion":2,"id":"test"}')
const fileHash=createHash('sha256').update(content).digest('hex')
const revision=createHash('sha256').update(JSON.stringify([{path:'program.json',sha256:fileHash}])).digest('hex')
const paper={id,title:'Decision framing',authors:['Researcher'],year:2026,description:'',aliases:['doi:10.1234/test'],conceptIds:['phenomenon:framing'],currentRevision:revision,
 assetRoot:`community/doi_10.1234_test/revisions/${revision}`,assetFiles:[{path:'program.json',bytes:content.length,sha256:createHash('sha256').update(content).digest('hex')}],resources:[]}
const catalog={schemaVersion:1,papers:[paper],taxonomy:{concepts:[{id:'phenomenon:framing',label:'Framing effect',aliases:['框架效应'],status:'reviewed'}]}}
const previous=globalThis.fetch
process.on('exit',()=>{globalThis.fetch=previous})

test('community index retains searchable aliases and forks exact verified files with their baseline',async()=>{
 const calls=[];let created=0
 globalThis.fetch=async input=>{
  const url=String(input);calls.push(url)
  if(url.endsWith('research_index.json'))return new Response(JSON.stringify(catalog))
  if(url.includes('/commits/main'))return new Response(commit)
  if(url.includes('/commits?'))return new Response('[]')
  if(url.includes(`/${commit}/${paper.assetRoot}/program.json`))return new Response(content)
  throw Error('Unexpected mutable or unpinned download: '+url)
 }
 lib.setCommunityCacheDir(join(temp,'cache'))
 const studies=await lib.communityStudies()
 assert.equal(studies.length,1);assert.ok(matchesResearch(studies[0],'框架效应'))
 const project=await lib.forkCommunityStudy(id,async()=>{created++;const dir=join(temp,'project');await mkdir(dir);return dir})
 assert.equal(created,1);assert.equal((await readFile(join(project,'program.json'))).toString(),content.toString())
 const metadata=JSON.parse(await readFile(join(project,'sources/study.json'),'utf8'))
 assert.equal(metadata.baseRevision,revision);assert.equal(metadata.commit,commit)
 assert.ok(!calls.some(url=>url.includes(`/main/${paper.assetRoot}`)))
})
test('a tampered immutable file fails before a local project is created',async()=>{
 globalThis.fetch=async input=>String(input).includes(`/${commit}/`)?new Response('tampered'):new Response('[]')
 let created=false
 await assert.rejects(lib.forkCommunityStudy(id,async()=>{created=true;return '/not-used'}),/verification failed/)
 assert.equal(created,false)
 await rm(temp,{recursive:true,force:true})
})
