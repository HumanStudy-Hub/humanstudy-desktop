import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import vm from 'node:vm'
import { build } from 'esbuild'
const require = createRequire(import.meta.url), ts = require('typescript')
const transpile = source => ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText

test('real preload and browser JSON HTTP transport preserve omitted community revisions safely', async () => {
 const temp=await mkdtemp(join(tmpdir(),'community-wire-')), nativeFetch=globalThis.fetch
 const id='paper_'+'a'.repeat(24), commit='c'.repeat(40), bytes=Buffer.from('{"schemaVersion":2,"id":"wire"}')
 const assetFiles=[{path:'program.json',sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length}]
 const revision=createHash('sha256').update(JSON.stringify(assetFiles.map(({path,sha256})=>({path,sha256})))).digest('hex')
 const entry={id,title:'Transport fixture',authors:[],year:2026,currentRevision:revision,assetRoot:'community/wire/revisions/'+revision,assetFiles}
 const handlers=new Map(), wire=[]; let created=0, server
 try {
  await build({entryPoints:[new URL('../src/main/community.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',outfile:join(temp,'community.mjs')})
  const lib=await import(pathToFileURL(join(temp,'community.mjs')));lib.setCommunityCacheDir(join(temp,'cache'))
  globalThis.fetch=async input=>{
   const url=String(input)
   if(url.endsWith('research_index.json'))return Response.json({papers:[entry]})
   if(url.endsWith('/commits/main'))return new Response(commit)
   if(url.includes('/commits?'))return Response.json([])
   if(url.endsWith('/program.json'))return new Response(bytes)
   throw Error('Unexpected upstream request')
  }
  // Execute the actual registered production community handlers, not a parallel normalizer.
  const main=await readFile(new URL('../src/main/index.ts',import.meta.url),'utf8')
  const registrations=main.slice(main.indexOf("  ipcMain.handle('community:studies'"),main.indexOf("  ipcMain.handle('community:openExternal'"))
  vm.runInNewContext(transpile(registrations),{
   ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},communityStudies:lib.communityStudies,communityStudy:lib.communityStudy,forkCommunityStudy:lib.forkCommunityStudy,
   createProject:async()=>{const dir=join(temp,'project-'+ ++created);await mkdir(dir);return dir},telemetry:{track(){}},
  })
  server=createServer(async(req,res)=>{
   const chunks=[];for await(const chunk of req)chunks.push(chunk)
   const {args}=JSON.parse(Buffer.concat(chunks));const channel=decodeURIComponent(req.url.slice('/ipc/'.length));wire.push({channel,args})
   try{const value=await handlers.get(channel)({},...args);res.end(JSON.stringify({ok:true,value}))}
   catch(error){res.end(JSON.stringify({ok:false,error:{name:error.name,message:error.message}}))}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const origin='http://127.0.0.1:'+server.address().port
  const browser={exports:{},console,URL,Uint8Array,Event,navigator:{language:'en'},window:{__HS_WEB__:{uploads:'/uploads',sep:'/'},addEventListener(){},dispatchEvent(){}},EventSource:class{addEventListener(){} close(){}},fetch:(url,options)=>nativeFetch(origin+url,options)}
  vm.runInNewContext(transpile(await readFile(new URL('./browser-electron.ts',import.meta.url),'utf8')),browser)
  vm.runInNewContext(transpile(await readFile(new URL('../src/preload/index.ts',import.meta.url),'utf8')),{require:()=>browser.exports,exports:{}})
  const api=browser.window.humanstudy.community
  assert.equal((await api.study(id)).currentRevision,revision)
  assert.equal(wire.at(-1).args[1],null,'actual JSON array encodes omitted revision as null')
  assert.equal((await api.study(id,undefined,true)).sourceCommit,commit)
  assert.deepEqual(wire.at(-1).args,[id,null,true]);assert.equal(created,0)
  const copied=await api.fork(id);assert.equal(created,1);assert.deepEqual(await readFile(join(copied,'program.json')),bytes)
  for(const bad of ['0'.repeat(64),'']) {
   await assert.rejects(api.study(id,bad),/different published version/)
   await assert.rejects(api.fork(id,bad),/different published version/)
  }
  assert.equal(created,1,'explicit wrong revisions must never create a project')
 } finally {globalThis.fetch=nativeFetch;if(server)await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true})}
})
