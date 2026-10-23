import {build} from 'esbuild'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL, fileURLToPath } from 'node:url'
const temp=await mkdtemp(join(tmpdir(),'research-collector-test-'))
await build({entryPoints:[fileURLToPath(new URL('./research-collector.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(temp,'collector.mjs')})
const {createResearchCollector}=await import(pathToFileURL(join(temp,'collector.mjs')))
const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',PROJECT='33333333-3333-4333-8333-333333333333'
async function setup(){
 const root=await mkdtemp(join(temp,'case-')), state={owner:OWNER,allowed:true,offline:false,failObject:false,afterObject:null,objectPosts:0,rejectEvent:null},objects=new Map(),rows=new Map(),events=new Map()
 const auth=async()=>{if(state.offline)throw Error('offline');return {supabaseUrl:'https://db.test',supabaseKey:'public-test',accessToken:state.owner,userId:state.owner}}
 const fetcher=async(url,init={})=>{
  if(state.offline)throw Error('offline')
  const u=new URL(url),owner=init.headers.Authorization.slice(7),p=u.pathname
  if(p==='/auth/v1/user')return Response.json({id:owner})
  if(p==='/rest/v1/research_consents')return init.method==='POST'?new Response(null,{status:201}):Response.json([{owner_id:owner,surface:'desktop',version:3}])
  if(p==='/rest/v1/research_content'){
   if(init.method==='POST'){const row=JSON.parse(init.body);rows.set(owner+'/'+row.sha256,row);return new Response(null,{status:201})}
   const q=u.searchParams.get('sha256');if(!q)return Response.json([...rows.entries()].filter(([k])=>k.startsWith(owner+'/')).map(([,r])=>r))
   return Response.json(rows.has(owner+'/'+q.slice(3))?[{sha256:q.slice(3)}]:[])
  }
  if(p.startsWith('/storage/v1/object/')){
   if(!init.method||init.method==='GET'){const name=p.replace('/authenticated/','/');return new Response(objects.get(name),{status:objects.has(name)?200:404})}
   if(state.failObject)return new Response(null,{status:503})
   state.objectPosts++;objects.set(p,Buffer.from(init.body));state.afterObject?.();return new Response(null,{status:201})
  }
  if(p==='/rest/v1/research_events'){if(init.method!=='POST')return Response.json([...events.values()].filter(e=>e.owner_id===owner));if(state.holdEvent)await state.holdEvent;const row=JSON.parse(init.body);if(row.id===state.rejectEvent)return new Response(null,{status:400});events.set(row.id,{...row,owner_id:owner});return new Response(null,{status:201})}
  throw Error('Unexpected fixture route '+p)
 }
 const make=()=>createResearchCollector({root:join(root,'queue'),surface:'desktop',appVersion:'test',ownerId:()=>state.owner,auth,allowed:()=>state.allowed,fetch:fetcher})
 const source=join(root,'paper.pdf');await writeFile(source,Buffer.from('Original source: αβγ\n'))
 return {root,state,objects,rows,events,make,source}
}
test('older/no agreement captures nothing; explicit source consent gates capture and upload',async()=>{
 const f=await setup();f.state.allowed=false;const c=f.make();await c.queueSource(f.source,PROJECT);await c.flush();assert.equal(await c.pending(),0);assert.equal(f.objects.size,0)
 f.state.allowed=true;await c.queueSource(f.source,PROJECT);await c.flush();assert.equal(await c.pending(),0);assert.equal([...f.events.values()].filter(e=>e.event_type==='source.import').length,1)
})
test('offline expired credentials: original bytes survive restart and upload once per owner/hash',async()=>{
 const f=await setup();f.state.offline=true;const c=f.make();await c.queueSource(f.source,PROJECT);assert.equal(await c.pending(),2);await c.flush();assert.equal(await c.pending(),2)
 const restarted=f.make();f.state.offline=false;await restarted.flush();assert.equal(await restarted.pending(),0);assert.equal(f.state.objectPosts,1)
 assert.deepEqual([...f.objects.values()][0],await readFile(f.source));await restarted.queueSource(f.source,PROJECT);await restarted.queueSource(f.source,'44444444-4444-4444-8444-444444444444');await restarted.flush();assert.equal(f.state.objectPosts,1)
 assert.equal([...f.events.values()].filter(e=>e.event_type==='source.import').length,2)
})
test('multi-part source reassembles byte-for-byte and pending events survive failed Storage upload',async()=>{
 const f=await setup(),raw=Buffer.alloc(4*1024*1024+237,97);raw[raw.length-1]=122;await writeFile(f.source,raw);const c=f.make();await c.queueSource(f.source,PROJECT);f.state.failObject=true;await c.flush();assert.ok(await c.pending()>0)
 assert.equal([...f.events.values()].filter(e=>e.event_type==='source.import').length,0);f.state.failObject=false;await c.flush();assert.equal(await c.pending(),0)
 const manifest=[...f.rows.values()].find(r=>r.kind==='manifest');assert.ok(manifest);const restored=Buffer.concat(manifest.parts.map(s=>f.objects.get('/storage/v1/object/research-content/'+OWNER+'/'+s)));assert.deepEqual(restored,raw)
})
test('account switch during upload cannot send old source records under the new owner',async()=>{
 const f=await setup(),c=f.make();await c.queueSource(f.source,PROJECT);f.state.afterObject=()=>{f.state.owner=OTHER};await c.flush();assert.equal([...f.events.values()].filter(e=>e.event_type==='source.import').length,0)
 f.state.owner=OWNER;assert.ok(await c.pending()>0);f.state.afterObject=null;await c.flush();assert.ok([...f.events.values()].filter(e=>e.event_type==='source.import').every(e=>e.owner_id===OWNER))
})
test('local corruption is retained and never acknowledged as a delivered source',async()=>{
 const f=await setup(),c=f.make();await c.queueSource(f.source,PROJECT);const dir=join(f.root,'queue',OWNER,'content'),bin=(await readdir(dir)).find(f=>f.endsWith('.bin'));await writeFile(join(dir,bin),'corrupt');await c.flush();assert.ok(await c.pending()>0);assert.match(c.error(),/hash/);assert.equal([...f.events.values()].filter(e=>e.event_type==='source.import').length,0)
})
test('export includes stored source bytes and remains available without expanded agreement',async()=>{
 const f=await setup(),c=f.make();await c.queueSource(f.source,PROJECT);await c.flush();f.state.allowed=false;const out=await c.exportFiles();assert.ok(out['research-v1/research_events.json']);const file=Object.keys(out).find(k=>k.startsWith('research-v1/objects/'));assert.deepEqual(Buffer.from(out[file]),await readFile(f.source));assert.ok(out['research-v1/research_consents.json'])
})
test('full multibyte chat/tool content, owner binding, ordered checkpoints and restart delivery',async()=>{
 const f=await setup(),c=f.make(),text='完整 αβγ '.repeat(700000)
 f.state.offline=true
 await c.capture({event_type:'conversation.message',thread_id:'thread_1',message_id:'message_1',metadata:{role:'assistant',part:0,part_kind:'text',status:'partial',text}})
 assert.equal(await c.pending(),2)
 const switched=c.capture({event_type:'action.invoke',view:'study',target:'should-not-migrate',metadata:{via:'pointer'}})
 f.state.owner=OTHER;await switched;f.state.owner=OWNER;f.state.offline=false
 const restart=f.make();await restart.flush();const message=[...f.events.values()].find(e=>e.event_type==='conversation.message')
 const ref=message.content_refs.find(r=>r.role==='text'),meta=f.rows.get(OWNER+'/'+ref.sha256)
 const z=await import('node:zlib')
 const unpack=sha=>{const r=f.rows.get(OWNER+'/'+sha),b=f.objects.get('/storage/v1/object/research-content/'+OWNER+'/'+sha);return r.encoding==='gzip'?z.gunzipSync(b):b}
 const bytes=meta.kind==='manifest'?Buffer.concat(meta.parts.map(unpack)):unpack(ref.sha256)
 assert.equal(bytes.toString('utf8'),text);assert.ok(![...f.events.values()].some(e=>e.target==='should-not-migrate'))
 assert.ok([...f.events.values()].every(e=>e.owner_id===OWNER));assert.equal(await restart.pending(),0)
})
test('one rejected row is quarantined intact; later events deliver and the sequence gap is reported',async()=>{
 const f=await setup(),c=f.make()
 const id=await c.capture({event_type:'action.invoke',view:'study',target:'bad',metadata:{via:'pointer'}});f.state.rejectEvent=id
 await c.capture({event_type:'action.invoke',view:'study',target:'good',metadata:{via:'pointer'}})
 await c.flush();assert.ok([...f.events.values()].some(e=>e.target==='good'));assert.match(c.error(),/rejected/)
 const rejected=JSON.parse(await readFile(join(f.root,'queue',OWNER,'rejected',id+'.json'),'utf8'));assert.equal(rejected.row.target,'bad')
 await c.flush();assert.ok([...f.events.values()].some(e=>e.event_type==='delivery.rejected'&&e.metadata.rejected_event_id===id))
 assert.ok([...f.events.values()].some(e=>e.event_type==='delivery.checkpoint'))
 const seq=[...f.events.values()].sort((a,b)=>a.client_seq-b.client_seq).map(e=>e.client_seq);assert.ok(!seq.includes(rejected.row.client_seq))
 const restarted=f.make();assert.equal(await restarted.pending(),1);assert.match(restarted.error(),/retained locally/)
})
test('generated program and binary versions survive restart; unchanged files are not recaptured',async()=>{
 const f=await setup(),c=f.make(),program=join(f.root,'program.json'),figure=join(f.root,'figure.png')
 await writeFile(program,JSON.stringify({schemaVersion:2,text:'Scientific text',path:join(f.root,'private-location')}));await writeFile(figure,Buffer.from([0,1,2,250]))
 await c.queueArtifact(program,PROJECT,'program.json','human');await c.queueArtifact(figure,PROJECT,'artifacts/figure.png','agent');await c.flush()
 const restarted=f.make();await restarted.queueArtifact(program,PROJECT,'program.json','human');await restarted.queueArtifact(figure,PROJECT,'artifacts/figure.png','agent');await restarted.flush()
 assert.equal([...f.events.values()].filter(e=>e.event_type==='program.version').length,1)
 assert.equal([...f.events.values()].filter(e=>e.event_type==='artifact.version').length,1)
 await writeFile(program,JSON.stringify({schemaVersion:2,text:'Revised scientific text'}));await restarted.queueArtifact(program,PROJECT,'program.json','human');await restarted.flush()
 assert.equal([...f.events.values()].filter(e=>e.event_type==='program.version').at(-1).artifact_version,2)
})
test('a slow network upload never blocks durable capture of new interactions',async()=>{
 const f=await setup(),c=f.make();await c.capture({event_type:'action.invoke',view:'study',target:'first',metadata:{via:'pointer'}})
 let release;f.state.holdEvent=new Promise(resolve=>{release=resolve});const uploading=c.flush()
 await new Promise(resolve=>setTimeout(resolve,30))
 const capture=c.capture({event_type:'conversation.message',thread_id:'t1',message_id:'m1',metadata:{role:'user',part:0,part_kind:'text',status:'complete',text:'Persist while upload is slow'}})
 let timer;try {await Promise.race([capture,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('network blocked persistence')),500)})])}
 finally {clearTimeout(timer);release();await uploading}
 await c.flush();assert.ok([...f.events.values()].some(e=>e.metadata.text==='Persist while upload is slow'));assert.equal(await c.pending(),0)
})
test.after(async()=>{await rm(temp,{recursive:true,force:true})})
