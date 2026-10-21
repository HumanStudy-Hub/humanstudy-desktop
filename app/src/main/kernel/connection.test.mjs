// A disconnected event stream must repair observation, never repeat a research task.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname,join } from 'node:path'
import { fileURLToPath,pathToFileURL } from 'node:url'
const out=mkdtempSync(join(tmpdir(),'connection-recovery-'))
await build({entryPoints:[join(dirname(fileURLToPath(import.meta.url)),'index.ts')],bundle:true,platform:'node',format:'esm',outfile:join(out,'kernel.mjs'),logLevel:'error'})
const { OpencodeKernel }=await import(pathToFileURL(join(out,'kernel.mjs')))
process.on('exit',()=>rmSync(out,{recursive:true,force:true}))
const assistant=(text,complete=true,id='a')=>({info:{id,sessionID:'s',role:'assistant',time:{created:1,...(complete?{completed:2}:{})},finish:complete?'stop':undefined,tokens:{input:5,output:text.length}},parts:[{id:'part-'+id,type:'text',messageID:id,text}]})
async function fixture(run) {
 const k=new OpencodeKernel({binary:'/bin/true',provider:'humanstudy',permission:'ask'})
 const server={dir:out,exited:false,eventsOnline:true,sse:new AbortController()}
 k.register('s',server)
 const events=[],requests=[]
 const state={messages:[],statuses:{},permissions:[],questions:[],fail:false,hold:null}
 k.onEvent(e=>events.push(e))
 k.request=async(_server,method,path,body)=>{
  requests.push({method,path,body})
  if(method==='POST')return Response.json(true)
  if(state.fail)throw Error('fixture offline')
  if(path==='/session/status')return Response.json(state.statuses)
  if(path==='/permission')return Response.json(state.permissions)
  if(path==='/question')return Response.json(state.questions)
  if(path==='/session/s/message') { if(state.hold)await state.hold;return Response.json(state.messages) }
  throw Error('Unexpected path '+path)
 }
 try{await run({k,server,events,requests,state})}finally{await k.dispose()}
}
test('lost final text, tool completion and idle are restored once without a second prompt',()=>fixture(async({k,server,state,events,requests})=>{
 await k.send('s','Build the study')
 k.handle({type:'message.updated',properties:{info:{id:'a',sessionID:'s',role:'assistant'}}})
 k.handle({type:'message.part.updated',properties:{part:{id:'part-a',sessionID:'s',messageID:'a',type:'text',text:'Saved '}}})
 const final=assistant('Saved all original details.');final.parts.push({id:'tool',type:'tool',tool:'write',state:{status:'completed',input:{filePath:'program.json'},output:'Saved'}})
 state.messages=[final]
 await k.restoreSnapshot(server);await k.restoreSnapshot(server)
 k.handle({type:'message.part.delta',properties:{sessionID:'s',messageID:'a',partID:'part-a',field:'text',delta:'all original details.'}})
 assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'Saved all original details.')
 assert.equal(events.filter(e=>e.type==='tool').length,1);assert.equal(events.filter(e=>e.type==='usage').length,1);assert.equal(events.filter(e=>e.type==='done').length,1)
 assert.equal(requests.filter(r=>r.method==='POST').length,1)
}))
test('busy snapshots append absolute text without duplicating streamed prefixes',()=>fixture(async({k,server,state,events})=>{
 await k.send('s','Extract all details');state.statuses={s:{type:'busy'}};state.messages=[assistant('First',false)]
 await k.restoreSnapshot(server);state.messages=[assistant('First, second',false)];await k.restoreSnapshot(server)
 assert.equal(k.sessions.get('s').inFlight,true)
 state.statuses={};state.messages=[assistant('First, second, complete.')];await k.restoreSnapshot(server)
 assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'First, second, complete.')
 assert.equal(events.filter(e=>e.type==='done').length,1)
}))
test('old conversation history is excluded from the active turn',()=>fixture(async({k,server,state,events})=>{
 k.sessions.get('s').roles.set('old','assistant');await k.send('s','New request')
 state.messages=[assistant('Old answer',true,'old'),assistant('New answer')]
 await k.restoreSnapshot(server)
 assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'New answer')
 assert.equal(events.filter(e=>e.type==='usage').length,1)
}))
test('pending researcher questions and permissions remain explicit after reconnect',()=>fixture(async({k,server,state,events,requests})=>{
 await k.send('s','Prepare study');state.messages=[assistant('',true)]
 state.questions=[{id:'q',sessionID:'s',questions:[{header:'Participants',question:'Which population?',options:[{label:'Default to study',description:'Use the paper.'}]}]}]
 state.permissions=[{id:'p',sessionID:'s',permission:'edit',patterns:['program.json'],metadata:{filepath:join(out,'program.json')}}]
 await k.restoreSnapshot(server);await k.restoreSnapshot(server)
 assert.ok(events.some(e=>e.type==='question'&&e.question.id==='q'))
 assert.equal(events.filter(e=>e.type==='permission').length,1)
 assert.equal(events.filter(e=>e.type==='done').length,0)
 assert.equal(requests.filter(r=>r.method==='POST').length,1,'no automatic answers, approvals or task replays')
}))
test('a Stop acknowledged during catchup prevents late text and extra requests',()=>fixture(async({k,server,state,events,requests})=>{
 await k.send('s','Extract');let release;state.hold=new Promise(r=>{release=r});state.messages=[assistant('Late text')]
 const restored=k.restoreSnapshot(server);await new Promise(r=>setImmediate(r));await k.abort('s');release();await restored
 assert.equal(events.filter(e=>e.type==='text').length,0)
 assert.equal(events.filter(e=>e.type==='done').length,1)
 assert.equal(requests.filter(r=>r.path.endsWith('prompt_async')).length,1)
}))
test('a newer user request supersedes an in-progress snapshot',()=>fixture(async({k,server,state,events})=>{
 await k.send('s','Old task');let release;state.hold=new Promise(r=>{release=r});state.messages=[assistant('Old pending reply')]
 const restored=k.restoreSnapshot(server);await new Promise(r=>setImmediate(r));await k.send('s','New task');release();await restored
 assert.equal(events.filter(e=>e.type==='text'||e.type==='done').length,0)
 assert.equal(k.sessions.get('s').inFlight,true)
}))
test('bounded connection failure keeps work and never retries model or tool actions',()=>fixture(async({k,server,state,events,requests})=>{
 await k.send('s','Build');state.fail=true;k.reconnectIntervalMs=1
 const finished=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('catchup stuck')),2000);k.onEvent(e=>{if(e.type==='done'){clearTimeout(timer);resolve()}})})
 k.beginCatchup(server);await finished
 assert.equal(events.filter(e=>e.type==='error').length,1);assert.match(events.find(e=>e.type==='error').text,/may still be running/)
 assert.equal(requests.filter(r=>r.method==='POST').length,1)
}))
test('SSE handles CRLF and Unicode even when every byte arrives separately',()=>fixture(async({k})=>{
 const data=new TextEncoder().encode('data: {"type":"test","properties":{"text":"研究"}}\r\n\r\n')
 const stream=new ReadableStream({start(c){for(const byte of data)c.enqueue(Uint8Array.of(byte));c.close()}})
 const events=[];await k.readStream(stream,e=>events.push(e));assert.equal(events[0].properties.text,'研究')
}))

test('a healthy but silent event connection still reconciles a lost completion',()=>fixture(async({k,server,state,events,requests})=>{
 let now=0;k.clock=()=>now
 await k.send('s','Build once');state.messages=[assistant('Saved the complete program.')]
 now=60_001;await k.checkLiveness()
 assert.equal(events.filter(e=>e.type==='done').length,1)
 assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'Saved the complete program.')
 assert.equal(requests.filter(r=>r.method==='POST').length,1,'observation repair must not rerun a task')
}))
test('accepted request with no assistant and repeatedly idle native state cannot spin forever',()=>fixture(async({k,state,events,requests})=>{
 let now=0;k.clock=()=>now;await k.send('s','Build')
 now=60_001;await k.checkLiveness();assert.equal(events.some(e=>e.type==='error'),false,'allow dispatch grace')
 now=120_002;await k.checkLiveness()
 assert.equal(events.filter(e=>e.type==='error').length,1)
 assert.match(events.find(e=>e.type==='error').text,/no longer running/)
 assert.equal(events.filter(e=>e.type==='done').length,1)
 assert.equal(requests.filter(r=>r.method==='POST').length,1)
}))
test('quiet probes do not swallow future live deltas from an unfinished response',()=>fixture(async({k,state,events})=>{
 let now=0;k.clock=()=>now;await k.send('s','Build');state.statuses={s:{type:'busy'}};state.messages=[assistant('Full',false)]
 now=60_001;await k.checkLiveness();assert.equal(events.filter(e=>e.type==='text').length,0)
 k.handle({type:'message.updated',properties:{info:{sessionID:'s',id:'a',role:'assistant'}}})
 k.handle({type:'message.part.delta',properties:{sessionID:'s',messageID:'a',partID:'part-a',field:'text',delta:'Full live response'}})
 assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'Full live response')
 state.statuses={};state.messages=[assistant('Full live response')];now=120_002;await k.checkLiveness()
 assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'Full live response')
 assert.equal(events.filter(e=>e.type==='done').length,1)
}))
test('a long-running native job warns without aborting, replaying or pretending completion',()=>fixture(async({k,state,events,requests})=>{
 let now=0;k.clock=()=>now;await k.send('s','Run the approved job');state.statuses={s:{type:'busy'}}
 now=60_001;await k.checkLiveness();assert.equal(events.some(e=>e.text==='stalled'),false)
 now=300_001;await k.checkLiveness();assert.ok(events.some(e=>e.type==='status'&&e.text==='stalled'))
 assert.equal(events.some(e=>e.type==='error'||e.type==='done'),false)
 assert.equal(k.sessions.get('s').inFlight,true)
 assert.equal(requests.filter(r=>r.method==='POST').length,1)
 k.handle({type:'message.updated',properties:{info:{sessionID:'s',id:'progress',role:'assistant'}}})
 k.handle({type:'message.part.updated',properties:{part:{sessionID:'s',messageID:'progress',id:'progress-text',type:'text',text:'A new saved checkpoint.'}}})
 assert.equal(k.sessions.get('s').stalled,false,'new visible progress clears the warning')
}))
for(const kind of ['question','permission'])test('liveness never times out an unanswered '+kind,()=>fixture(async({k,events,requests})=>{
 let now=0;k.clock=()=>now;await k.send('s','Build')
 k.handle({type:kind+'.asked',properties:{sessionID:'s',id:'waiting',permission:'bash',patterns:['python'],questions:[]}})
 now=109*60000;await k.checkLiveness()
 assert.equal(events.some(e=>e.type==='error'||e.type==='done'||e.text==='stalled'),false)
 assert.equal(requests.filter(r=>r.method==='POST').length,1)
}))
test('Stop during a liveness probe excludes its late snapshot and prevents task replay',()=>fixture(async({k,state,events,requests})=>{
 let now=0;k.clock=()=>now;await k.send('s','Build');state.messages=[assistant('Late response')]
 let release;state.hold=new Promise(r=>{release=r});now=60_001
 const probing=k.checkLiveness();await new Promise(r=>setImmediate(r));await k.abort('s');release();await probing
 assert.equal(events.filter(e=>e.type==='text').length,0)
 assert.equal(events.filter(e=>e.type==='done').length,1)
 assert.equal(requests.filter(r=>r.path.endsWith('prompt_async')).length,1)
}))
test('late busy notifications cannot revive a stopped chat',()=>fixture(async({k,events})=>{
 await k.send('s','Build');await k.abort('s');const count=events.length
 k.handle({type:'session.status',properties:{sessionID:'s',status:{type:'busy'}}})
 assert.equal(events.length,count,'late busy would leave the renderer waiting forever')
 assert.equal(k.sessions.get('s').inFlight,false)
}))

test('an actual dropped SSE connection restores the final reply through read-only HTTP',async()=>{
 const {createServer}=await import('node:http')
 let stream,postCount=0
 const sockets=new Set()
 const http=createServer((req,res)=>{
  if(req.url==='/event') {res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"server.connected"}\n\n');stream=res;return}
  if(req.method==='POST') {postCount++;res.writeHead(204);res.end();return}
  res.setHeader('content-type','application/json')
  if(req.url==='/session/s/message')res.end(JSON.stringify([assistant('Recovered complete response.')]))
  else res.end(req.url==='/session/status'?'{}':'[]')
 })
 http.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))})
 await new Promise(r=>http.listen(0,'127.0.0.1',r))
 const k=new OpencodeKernel({binary:'/bin/true',provider:'humanstudy'})
 const server={dir:out,base:`http://127.0.0.1:${http.address().port}`,auth:'fixture',sse:new AbortController(),eventsOnline:false,exited:false}
 try{
  await k.openEvents(server);k.register('s',server);const events=[]
  const done=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('stream repair stuck')),4000);k.onEvent(e=>{events.push(e);if(e.type==='done'){clearTimeout(t);resolve()}})})
  await k.send('s','Build once');stream.end();await done
  assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'Recovered complete response.')
  assert.equal(postCount,1,'transport repair must never resend prompt_async')
  assert.ok(events.some(e=>e.type==='status'&&e.text==='reconnecting'))
 }finally{server.sse.abort();server.exited=true;await k.dispose();for(const s of sockets)s.destroy();await new Promise(r=>http.close(r))}
})

test('actual HTTP reconciliation finds completion while SSE stays open and silent',async()=>{
 const {createServer}=await import('node:http');let postCount=0
 const sockets=new Set()
 const http=createServer((req,res)=>{
  if(req.url==='/event'){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: {"type":"server.connected"}\n\n');return}
  if(req.method==='POST'){postCount++;res.writeHead(204);res.end();return}
  res.setHeader('content-type','application/json')
  res.end(req.url==='/session/s/message'?JSON.stringify([assistant('Complete original result.')]):req.url==='/session/status'?'{}':'[]')
 });http.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))})
 await new Promise(r=>http.listen(0,'127.0.0.1',r))
 const k=new OpencodeKernel({binary:'/bin/true',provider:'humanstudy'}),events=[]
 let now=0;k.clock=()=>now
 const server={dir:out,base:`http://127.0.0.1:${http.address().port}`,auth:'fixture',sse:new AbortController(),eventsOnline:false,exited:false}
 try{
  await k.openEvents(server);k.register('s',server);k.onEvent(e=>events.push(e));await k.send('s','Build once')
  now=60_001;await k.checkLiveness()
  assert.equal(server.eventsOnline,true,'the SSE stream never disconnected')
  assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'Complete original result.')
  assert.equal(events.filter(e=>e.type==='done').length,1);assert.equal(postCount,1)
 }finally{server.sse.abort();server.exited=true;await k.dispose();for(const s of sockets)s.destroy();await new Promise(r=>http.close(r))}
})

if(process.env.HUMANSTUDY_KERNEL_BIN) test('real installed OpenCode catches up after a stream gap without another model execution',async()=>{
 const {createServer}=await import('node:http')
 let mainCalls=0
 const model=createServer(async(req,res)=>{
  const chunks=[];for await(const c of req)chunks.push(c)
  const body=JSON.parse(Buffer.concat(chunks).toString());if(body.tools?.length)mainCalls++
  const base={id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture'}
  const chunk=(delta,finish_reason=null)=>({...base,choices:[{index:0,delta,finish_reason}]})
  res.writeHead(200,{'content-type':'text/event-stream'})
  res.write(`data: ${JSON.stringify(chunk({content:'First part. '}))}\n\n`)
  setTimeout(()=>{res.write(`data: ${JSON.stringify(chunk({content:'All details preserved.'}))}\n\n`);res.end(`data: ${JSON.stringify({...chunk({},'stop'),usage:{prompt_tokens:5,completion_tokens:8,total_tokens:13}})}\n\ndata: [DONE]\n\n`)},500)
 })
 await new Promise(r=>model.listen(0,'127.0.0.1',r))
 const k=new OpencodeKernel({binary:process.env.HUMANSTUDY_KERNEL_BIN,home:join(out,'native-home'),provider:'fixture',model:'fixture'})
 k.configContent=()=>JSON.stringify({model:'fixture/fixture',small_model:'fixture/fixture',provider:{fixture:{npm:'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture-only'},models:{fixture:{name:'Fixture',tool_call:true,limit:{context:200000,output:1000}}}}}})
 try{
  const id=await k.startSession(out),events=[];let cut=false
  const done=new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Native catchup timed out')),30000);k.onEvent(e=>{
   if(e.sessionId!==id)return;events.push(e)
   if(e.type==='text'&&!cut){cut=true;const server=k.sessions.get(id).server,old=server.sse;server.sse=new AbortController();old.abort()}
   if(e.type==='done'){clearTimeout(t);resolve()}
  })})
  await k.send(id,'Report this fixture response once.');await done
  assert.equal(events.filter(e=>e.type==='text').map(e=>e.text).join(''),'First part. All details preserved.')
  assert.equal(events.filter(e=>e.type==='usage').length,1)
  assert.equal(events.filter(e=>e.type==='error').length,0)
  assert.equal(mainCalls,1)
  assert.ok(events.some(e=>e.type==='status'&&e.text==='reconnecting'))
 }finally{await k.dispose();await new Promise(r=>model.close(r))}
})
