import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdtemp,readFile,rm,mkdir,readdir} from 'node:fs/promises'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
const here=dirname(fileURLToPath(import.meta.url)),temp=await mkdtemp(join(tmpdir(),'community-index-'))
await build({entryPoints:[join(here,'community.ts')],bundle:true,platform:'node',format:'esm',outfile:join(temp,'community.mjs'),logLevel:'error'})
await build({entryPoints:[join(here,'../shared/research-search.ts')],bundle:true,platform:'node',format:'esm',outfile:join(temp,'search.mjs'),logLevel:'error'})
const lib=await import(pathToFileURL(join(temp,'community.mjs'))),{matchesResearch,catalogSearchFields,researchAvailability}=await import(pathToFileURL(join(temp,'search.mjs')))
const id='paper_'+'a'.repeat(24),commit='c'.repeat(40)
const content=Buffer.from(JSON.stringify({schemaVersion:2,id:'test',source:{filename:'paper.pdf'},evidence:[{path:'materials/stimuli.txt'},{path:'effects.json'},{path:'Capabilities.json'}]}))
const publishedMetadata = {
 'capabilities.json': Buffer.from('{"run":{"status":"partial"}}'),
 'effects.json': Buffer.from('{"effects":[]}'),
}
const fixtureFiles = {
 'program.json': content,
 ...publishedMetadata,
 'sources/attached/materials/stimuli.txt': Buffer.from('Complete material END'),
 'sources/attached/paper.pdf': Buffer.from('%PDF-fixture'),
 'sources/attached/effects.json': Buffer.from('{"source":"effects"}'),
 'sources/attached/Capabilities.json': Buffer.from('{"source":"capabilities"}'),
 'sources/study.json': Buffer.from('{"participants":42}'),
}
const assetFiles=Object.entries(fixtureFiles).sort(([a],[b])=>a.localeCompare(b)).map(([path,raw])=>({path,sha256:createHash('sha256').update(raw).digest('hex'),bytes:raw.length}))
const revision=createHash('sha256').update(JSON.stringify(assetFiles.map(({path,sha256})=>({path,sha256})))).digest('hex')
const paper={id,title:'Decision framing',authors:['Original paper author'],year:2026,
 contributors:[{name:'Reconstruction contributor',affiliation:'University',orcid:'https://orcid.org/0000-0002-1825-0097'}],description:'',aliases:['doi:10.1234/test'],conceptIds:['phenomenon:framing'],currentRevision:revision,
 assetRoot:`community/doi_10.1234_test/revisions/${revision}`,assetFiles,resources:[]}
const catalog={schemaVersion:1,papers:[paper],taxonomy:{concepts:[{id:'phenomenon:framing',label:'Framing effect',aliases:['框架效应'],status:'reviewed'}]}}
const previous=globalThis.fetch
process.on('exit',()=>{globalThis.fetch=previous})

test('shared catalog topics distinguish an assignment from lexical matches and proposed labels',()=>{
 const concepts=[...catalog.taxonomy.concepts,{id:'phenomenon:risk',label:'Risk',aliases:['风险'],status:'proposed'}]
 const tagged={...paper,contributors:[],...catalogSearchFields(paper,concepts)}
 const untagged={...paper,title:'Framing effect in public goods games',conceptIds:[],...catalogSearchFields({...paper,title:'Framing effect in public goods games',conceptIds:[]},concepts)}
 const proposed={...paper,title:'Risk',...catalogSearchFields({...paper,conceptIds:['phenomenon:risk']},concepts)}
 assert.deepEqual(tagged.topics,[{id:'phenomenon:framing',label:'Framing effect'}])
 assert.ok(matchesResearch(tagged,'框架效应','phenomenon:framing'))
 assert.ok(matchesResearch(untagged,'框架效应'),'alias search also finds unclassified papers')
 assert.deepEqual(untagged.topics,[],'text matches must not manufacture a classification')
 assert.equal(matchesResearch(untagged,'','phenomenon:framing'),false)
 assert.deepEqual(proposed.topics,[]);assert.equal(matchesResearch(proposed,'风险'),false)
 assert.equal(researchAvailability(tagged),'User submitted')
 assert.equal(researchAvailability({...tagged,capabilities:{protocol:true}}),'User submitted')
 assert.equal(researchAvailability({...tagged,assetRoot:'studies/study_003'}),'Human Program available')
 assert.equal(researchAvailability({...untagged,currentRevision:null}),'Not yet extracted')
 assert.equal(researchAvailability({...untagged,currentRevision:null,legacyStudyId:'study_003'}),'Study materials')
})

test('community index retains searchable aliases and forks exact verified files with their baseline',async()=>{
 const calls=[];let created=0
 globalThis.fetch=async input=>{
  const url=String(input);calls.push(url)
  if(url.endsWith('research_index.json'))return new Response(JSON.stringify(catalog))
  if(url.includes('/commits/main'))return new Response(commit)
  if(url.includes('/commits?'))return new Response('[]')
  for(const [path,raw] of Object.entries(fixtureFiles))if(url.includes(`/${commit}/${paper.assetRoot}/${path}`))return new Response(raw)
  throw Error('Unexpected mutable or unpinned download: '+url)
 }
 lib.setCommunityCacheDir(join(temp,'cache'))
 const studies=await lib.communityStudies()
 assert.equal(studies.length,1);assert.ok(matchesResearch(studies[0],'框架效应'))
 assert.deepEqual(studies[0].authors,['Original paper author'])
 assert.deepEqual(studies[0].contributors,[{name:'Reconstruction contributor',affiliation:'University',orcid:'0000-0002-1825-0097'}])
 assert.ok(lib.isAllowedExternal('https://orcid.org/0000-0002-1825-0097'))
 assert.ok(!lib.isAllowedExternal('https://orcid.org/0000-0002-1825-0097?redirect=https://example.com'))
 await assert.rejects(lib.forkCommunityStudy(id,async()=>{created++;throw Error('must not create')},'0'.repeat(64)), /different published version/)
 assert.equal(created,0)
 const project=await lib.forkCommunityStudy(id,async()=>{created++;const dir=join(temp,'project');await mkdir(dir);return dir},revision)
 assert.equal(created,1);assert.equal((await readFile(join(project,'program.json'))).toString(),content.toString())
 const metadata=JSON.parse(await readFile(join(project,'.humanstudy/community.json'),'utf8'))
 assert.equal(metadata.baseRevision,revision);assert.equal(metadata.commit,commit)
 assert.equal(await readFile(join(project,'materials/stimuli.txt'),'utf8'),'Complete material END')
 assert.equal(await readFile(join(project,'paper.pdf'),'utf8'),'%PDF-fixture')
 for(const [path, raw] of Object.entries(publishedMetadata)) {
  assert.deepEqual(await readFile(join(project,path)),raw,'aliases cannot overwrite verified metadata')
 }
 assert.equal(await readFile(join(project,'sources/attached/effects.json'),'utf8'),'{"source":"effects"}')
 assert.ok(!(await readdir(project)).includes('Capabilities.json'),'case variants cannot become root aliases')
 assert.equal(await readFile(join(project,'sources/study.json'),'utf8'),'{"participants":42}','local context must not overwrite a cited resource')
 assert.ok(!calls.some(url=>url.includes(`/main/${paper.assetRoot}`)))
 await lib.communityStudy(id)
})
test('a tampered immutable file fails before a local project is created',async()=>{
 globalThis.fetch=async input=>String(input).includes(`/${commit}/`)?new Response('tampered'):new Response('[]')
 let created=false
 await assert.rejects(lib.forkCommunityStudy(id,async()=>{created=true;return '/not-used'}),/verification failed/)
 assert.equal(created,false)

})

test('a pinned handoff ignores cached detail and verifies the catalog at the same commit', async () => {
 const previousCommit = 'b'.repeat(40)
 const nextContent = Buffer.from('{"schemaVersion":2,"id":"new-version"}')
 const manifest = [{ path: 'program.json', sha256: createHash('sha256').update(nextContent).digest('hex'), bytes: nextContent.length }]
 const nextRevision = createHash('sha256').update(JSON.stringify(manifest.map(({ path, sha256 }) => ({ path, sha256 })))).digest('hex')
 const nextPaper = { ...paper, currentRevision: nextRevision, assetRoot: `community/fixture/revisions/${nextRevision}`, assetFiles: manifest }
 const calls = []
 let head = previousCommit
 let pinnedCatalogAvailable = true
 let created = 0
 globalThis.fetch = async input => {
  const url = String(input)
  calls.push(url)
  if (url.endsWith('/commits/main')) return new Response(head)
  if (url.includes('/commits?')) return new Response('[]')
  if (url.includes('/main/') && url.endsWith('research_index.json')) return Response.json(catalog)
  if (url.includes(`/${commit}/`) && url.endsWith('research_index.json')) {
   if (!pinnedCatalogAvailable) return new Response(null, { status: 503 })
   return Response.json({ ...catalog, papers: [nextPaper] })
  }
  if (url.endsWith(`/${commit}/${nextPaper.assetRoot}/program.json`)) return new Response(nextContent)
  throw new Error('Unexpected URL ' + url)
 }
 lib.setCommunityCacheDir(join(temp, 'handoff-cache'))
 const cached = await lib.communityStudy(id)
 assert.equal(cached.currentRevision, revision)
 assert.equal(cached.sourceCommit, previousCommit)

 head = commit
 const create = async () => {
  created++
  const project = join(temp, 'handoff-project')
  await mkdir(project)
  return project
 }
 calls.length = 0
 await assert.rejects(lib.forkCommunityStudy(id, create, revision), /different published version/)
 assert.equal(created, 0)
 assert.deepEqual(calls.map(url => new URL(url).pathname.split('/').slice(-2)), [
  ['commits', 'main'], ['data', 'research_index.json'],
 ])
 assert.ok(calls[1].includes(`/${commit}/`), 'the handoff uses the catalog from the pinned commit')

 pinnedCatalogAvailable = false
 await assert.rejects(lib.forkCommunityStudy(id, create, revision), /503/)
 assert.equal(created, 0)
 assert.equal((await lib.communityStudy(id)).sourceCommit, previousCommit, 'ordinary browsing still uses its cached detail')

 pinnedCatalogAvailable = true
 await assert.rejects(lib.communityStudy(id, revision), /different published version/)
 const detail = await lib.communityStudy(id, nextRevision)
 assert.equal(detail.currentRevision, nextRevision)
 assert.equal(detail.sourceCommit, commit)
 assert.ok(detail.files.every(file => file.url.includes(`/${commit}/`)))
 assert.equal((await lib.communityStudy(id)).sourceCommit, previousCommit)
 const project = await lib.forkCommunityStudy(id, create, nextRevision)
 assert.equal(created, 1)
 assert.deepEqual(await readFile(join(project, 'program.json')), nextContent)
 const metadata = JSON.parse(await readFile(join(project, '.humanstudy/community.json'), 'utf8'))
 assert.equal(metadata.baseRevision, nextRevision)
 assert.equal(metadata.sourceCommit, commit)
 assert.equal(metadata.commit, commit)
})

after(async()=>{globalThis.fetch=previous;await rm(temp,{recursive:true,force:true})})
test('a protocol-only revision imports exact files and pins its received held list',async()=>{
 const protocol={schema_version:'1',id:'fixture',distribution:{format:'hsenv-projection/1',held:{h1:{path:'data.item',text_sha256:'a'.repeat(64)}}},meta:{title:'Fixture'}}
 const files={...publishedMetadata,'protocol.json':Buffer.from(JSON.stringify(protocol)),'study.json':Buffer.from('{"hsenv": ">=0.8,<0.9"}'),'sourcetext/open.txt':Buffer.from('invented public source'),'review/checks-latest.json':Buffer.from('{"PASS":true}')}
 const manifest=Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([path,raw])=>({path,sha256:createHash('sha256').update(raw).digest('hex'),bytes:raw.length}))
 const rev=createHash('sha256').update(JSON.stringify(manifest.map(({path,sha256})=>({path,sha256})))).digest('hex')
 const entry={...paper,currentRevision:rev,assetRoot:'community/fixture/revisions/'+rev,assetFiles:manifest}
 const cache=join(temp,'protocol-cache');lib.setCommunityCacheDir(cache)
 globalThis.fetch=async input=>{
  const url=String(input)
  if(url.endsWith('research_index.json'))return new Response(JSON.stringify({papers:[entry]}))
  if(url.includes('/commits/main'))return new Response(commit)
  if(url.includes('/commits?'))return new Response('[]')
  for(const [path,raw] of Object.entries(files))if(url.includes(`/${commit}/${entry.assetRoot}/${path}`))return new Response(raw)
  throw Error('Unexpected URL '+url)
 }
 const dir=await lib.forkCommunityStudy(id,async()=>{const d=join(temp,'protocol-project');await mkdir(d);return d})
 assert.equal(await readFile(join(dir,'protocol.json'),'utf8'),files['protocol.json'].toString())
 for(const [path, raw] of Object.entries(publishedMetadata)) assert.deepEqual(await readFile(join(dir,path)),raw)
 const pins=JSON.parse(await readFile(join(cache,'original-text/pins.json'),'utf8'))
 assert.equal(Object.keys(pins).length,1)
 const root=Object.keys(pins)[0]
 const received=JSON.parse(await readFile(join(cache,'original-text/received',createHash('sha256').update(root).digest('hex')+'.json'),'utf8'))
 assert.deepEqual(received,protocol)
})
test('protocol allowlist rejects private sources, runs, traversal and app configuration',()=>{
 for(const path of ['sources/private/x.pdf','sources/researcher/x.txt','artifacts/runs/x.json','artifacts/records.jsonl','runs/a.json','../protocol.json','.opencode/hsenv.py','sources/open/.env','review/raw-chat.json','paper/paper.pdf','capabilities-other.json','Effects.json'])assert.equal(lib.protocolAssetPath(path),false,path)
 for(const path of ['protocol.json','study.json','capabilities.json','effects.json','sourcetext/a.txt','sources/open/survey.qsf','review/fidelity-review-1.md','review/checks-latest.json','variants/a.json','package/x/study.json'])assert.equal(lib.protocolAssetPath(path),true,path)
})
