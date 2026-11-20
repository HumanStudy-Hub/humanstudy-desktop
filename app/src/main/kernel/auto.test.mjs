// Auto on/off must affect the current session and must never persist an "always" grant.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const out = mkdtempSync(join(tmpdir(), 'auto-mode-'))
const here = dirname(fileURLToPath(import.meta.url))
await build({ entryPoints: [join(here,'index.ts')], bundle:true, platform:'node', format:'esm', outfile:join(out,'k.mjs'),logLevel:'error' })
const { OpencodeKernel } = await import(pathToFileURL(join(out,'k.mjs')).href)
const replies = []
const api = createServer(async(req,res) => {
  const chunks=[];for await(const c of req) chunks.push(c)
  if (req.url.includes('/gone')) { res.writeHead(404,{'content-type':'application/json'}); return res.end(JSON.stringify({_tag:'PermissionNotFoundError'})) }
  replies.push(JSON.parse(Buffer.concat(chunks).toString()))
  res.writeHead(200,{'content-type':'application/json'});res.end('true')
})
await new Promise(r => api.listen(0,'127.0.0.1',r))
try {
  const k = new OpencodeKernel({ binary:'/bin/true', permission:'ask' })
  k.register('s',{dir:out,base:`http://127.0.0.1:${api.address().port}`,auth:'Basic fixture',exited:false})
  k.sessions.get('s').inFlight = true
  const events=[]; k.onEvent(e=>events.push(e))
  const approved = id => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('Automatic permission reply timed out')) }, 5000)
    const off = k.onEvent(e => { if (e.permission?.id === id && e.permission?.automatic && e.permission?.resolved) { clearTimeout(timer); off(); resolve() } })
  })
  const ask=id=>k.handle({type:'permission.asked',properties:{sessionID:'s',id,permission:'bash',patterns:['echo fixture > study.txt']}})
  ask('first')
  assert.equal(replies.length,0)
  const firstReply = approved('first')
  k.setPermissionMode('project')
  await firstReply
  assert.deepEqual(replies,[{reply:'once'}])
  k.setPermissionMode('ask');ask('second')
  await new Promise(r=>setTimeout(r,50))
  assert.equal(replies.length,1,'switching Auto off stops automatic replies in the same session')
  assert.ok(events.some(e=>e.permission?.id==='second'&&!e.permission.resolved))
  const secondReply = approved('second')
  k.setPermissionMode('project')
  await secondReply
  assert.deepEqual(replies,[{reply:'once'},{reply:'once'}])
  assert.ok(events.some(e=>e.permission?.automatic&&e.permission.resolved==='once'))
  // Project mode never prompts: inside-project work is approved, everything else is rejected with a reason.
  const decided = (id, reply) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`Automatic ${reply} of ${id} timed out`)) }, 5000)
    const off = k.onEvent(e => { if (e.permission?.id === id && e.permission?.automatic && e.permission?.resolved === reply) { clearTimeout(timer); off(); resolve() } })
  })
  const bash = (id, cmd) => k.handle({type:'permission.asked',properties:{sessionID:'s',id,permission:'bash',patterns:[cmd]}})
  const session = k.sessions.get('s')
  session.recovery.cancelled = false
  let done = decided('py', 'once'); bash('py', 'python3 scripts/run.py --n 5'); await done
  assert.deepEqual(replies.at(-1), {reply:'once'})
  const reason = /only permits actions inside this project folder/
  for (const [id, cmd] of [['rm-in', 'rm -f stray-empty.txt'], ['rm-root', 'rm -rf .'], ['rm-out', 'rm -f /etc/fixture'], ['sudo', 'sudo ls']]) {
    done = decided(id, 'reject'); bash(id, cmd); await done
    assert.equal(replies.at(-1).reply, 'reject', cmd)
    assert.match(replies.at(-1).message, reason, 'the agent is told why, so the turn continues')
    k.handle({type:'permission.replied',properties:{sessionID:'s',requestID:id,reply:'reject'}})
  }
  done = decided('web', 'once')
  k.handle({type:'permission.asked',properties:{sessionID:'s',id:'web',permission:'webfetch',patterns:['https://osf.io/abcd']}})
  await done
  assert.deepEqual(replies.at(-1), {reply:'once'}, 'public source fetches are approved')
  done = decided('outside', 'reject')
  k.handle({type:'permission.asked',properties:{sessionID:'s',id:'outside',permission:'edit',patterns:['/etc/fixture'],metadata:{filepath:'/etc/fixture'}}})
  await done
  k.handle({type:'permission.replied',properties:{sessionID:'s',requestID:'outside',reply:'reject'}})
  // opencode's cascade: one reject also rejects the session's other pending requests (no message).
  session.pendingPermissions.set('cascaded', {id:'cascaded', type:'bash', patterns:['ls']}) // never replied by us
  k.handle({type:'permission.replied',properties:{sessionID:'s',requestID:'cascaded',reply:'reject'}})
  assert.ok(events.some(e => e.permission?.id === 'cascaded' && e.permission.automatic && e.permission.resolved === 'reject'), 'a cascade reject is recorded as automatic')
  // An automatic reply that finds the request already answered (404) is resolved, not shown.
  bash('gone', 'ls data')
  await new Promise(r=>setTimeout(r,50))
  assert.equal(replies.length,9)
  for (const id of ['py', 'rm-in', 'rm-root', 'rm-out', 'sudo', 'web', 'outside', 'cascaded', 'gone'])
    assert.ok(!events.some(e => e.permission?.id === id && !e.permission.resolved), `no permission prompt for ${id}`)
  assert.equal(session.recovery.cancelled, false, 'an automatic reject does not cancel the turn')
  assert.deepEqual(k.permissions('s'), [])
  // Developer opt-in ask mode still prompts.
  k.setPermissionMode('ask')
  k.handle({type:'permission.asked',properties:{sessionID:'s',id:'outside2',permission:'edit',patterns:['/etc/fixture'],metadata:{filepath:'/etc/fixture'}}})
  await new Promise(r=>setTimeout(r,30))
  assert.equal(replies.length,9,'ask mode waits for the researcher')
  assert.ok(events.some(e => e.permission?.id === 'outside2' && !e.permission.resolved))
  const original = k.sessions.get('s')
  k.register('other', original.server)
  k.sessions.get('other').inFlight = true
  assert.deepEqual(k.permissions('s').map(p => p.id), ['outside2'])
  await assert.rejects(k.reply('other', 'outside2', 'once'), /no longer pending/)
  await k.reply('s', 'outside2', 'once')
  ask('outside2') // A captured GET /permission snapshot can arrive after the reply.
  assert.deepEqual(k.permissions('s'), [])
  assert.equal(events.filter(e => e.permission?.id === 'outside2' && !e.permission.resolved).length, 1)
  k.handle({type:'permission.asked',properties:{sessionID:'other',id:'kept',permission:'bash',patterns:['echo fixture']}})
  let acknowledge
  const stopRequest = new Promise(resolve => { acknowledge = resolve })
  k.request = async (_server, _method, path) => path.endsWith('/abort') ? stopRequest : new Response('[]')
  original.recovery.running = true
  original.recovery.cancelled = false
  const recovery = k.recover('s', original)
  const stop = k.abort('s')
  await recovery
  assert.equal(original.recovery.attempts, 0, 'a scheduled recovery cannot send during Stop')
  ask('stopped')
  ask('late')
  assert.deepEqual(k.permissions('s'), [])
  assert.ok(!events.some(e => e.permission?.id === 'late'))
  await assert.rejects(k.reply('s', 'stopped', 'once'), /no longer pending/)
  await assert.rejects(k.send('s', 'start early'), /Wait for this conversation/)
  acknowledge(new Response('true'))
  await stop
  assert.deepEqual(replies.slice(-2), [{ reply: 'reject' }, { reply: 'reject' }])
  assert.deepEqual(k.permissions('s'), [])
  assert.deepEqual(k.permissions('other').map(p => p.id), ['kept'])
  original.inFlight = true // A new turn must still ignore an old request replay.
  ask('stopped')
  ask('late')
  assert.deepEqual(k.permissions('s'), [])
  ask('after-stop')
  k.request = async () => { throw new Error('Stop unavailable') }
  await assert.rejects(k.abort('s'), /Stop unavailable/)
  assert.deepEqual(k.permissions('s').map(p => p.id), ['after-stop'])
  await k.dispose()
  console.log('Auto current-session toggle, pending requests, one-call grants and project boundary passed')
} finally { await new Promise(r=>api.close(r)) }

if (process.env.HUMANSTUDY_KERNEL_BIN) {
  const model = createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c)
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const n=body.messages?.filter(m=>m.role==='tool').length??0
    const tool=body.tools?.some(t=>t.function?.name==='bash') && n<2
    const delta=tool?{tool_calls:[{index:0,id:`call_${n}`,type:'function',function:{name:'bash',arguments:JSON.stringify({command:'echo fixture > study.txt',description:'Write a fixture study note'})}}]}:{content:'Completed study steps.'}
    const msg={id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:null}]}
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(`data: ${JSON.stringify(msg)}\n\n`)
    res.end(`data: ${JSON.stringify({...msg,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(r=>model.listen(0,'127.0.0.1',r))
  const k=new OpencodeKernel({binary:process.env.HUMANSTUDY_KERNEL_BIN,home:join(out,'home'),provider:'fixture',model:'fixture',permission:'project'})
  k.configContent=()=>JSON.stringify({model:'fixture/fixture',small_model:'fixture/fixture',permission:{bash:'ask'},provider:{fixture:{npm:'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture'},models:{fixture:{name:'Fixture',tool_call:true,limit:{context:200000,output:10000}}}}}})
  try {
    const sid=await k.startSession(out)
    let off=false;let pending=false;const events=[]
    const done=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`Native Auto did not resume: ${JSON.stringify(events)}`)),45000)
      k.onEvent(e=>{
        if(e.sessionId!==sid)return
        events.push(e)
        if(e.type==='permission' && e.permission.resolved==='once' && !off){off=true;k.setPermissionMode('ask')}
        if(e.type==='permission' && !e.permission.resolved){pending=true;k.setPermissionMode('project')}
        if(e.type==='done'){clearTimeout(timer);resolve()}
      })
    })
    await k.send(sid,'Write the same study note twice with bash, then finish.')
    await done
    assert.ok(off&&pending,'native repeated command asks again after Auto is switched off')
    assert.ok(events.some(e=>e.type==='text'&&e.text.includes('Completed')))
    assert.ok(!events.some(e=>e.permission?.resolved==='always'),'Auto must not silently create a remembered permission grant')
    console.log('Real OpenCode Auto on → off → pending → on round trip passed')
  } finally { await k.dispose();await new Promise(r=>model.close(r)) }
}

if (process.env.HUMANSTUDY_KERNEL_BIN) {
  // A real automatic reject: the model asks to delete the project folder, receives the reason as the
  // tool result and the same turn continues to its final answer, with no prompt shown.
  const toolResults=[]
  const model = createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c)
    const body=JSON.parse(Buffer.concat(chunks).toString())
    const tools=body.messages?.filter(m=>m.role==='tool')??[]
    toolResults.splice(0,toolResults.length,...tools.map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)))
    const tool=body.tools?.some(t=>t.function?.name==='bash') && tools.length<1
    const delta=tool?{tool_calls:[{index:0,id:'call_rm',type:'function',function:{name:'bash',arguments:JSON.stringify({command:`rm -rf ${out}`,description:'Delete the project folder'})}}]}:{content:'Skipped the deletion and finished.'}
    const msg={id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:null}]}
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(`data: ${JSON.stringify(msg)}\n\n`)
    res.end(`data: ${JSON.stringify({...msg,choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(r=>model.listen(0,'127.0.0.1',r))
  const k=new OpencodeKernel({binary:process.env.HUMANSTUDY_KERNEL_BIN,home:join(out,'home'),provider:'fixture',model:'fixture',permission:'project'})
  k.configContent=()=>JSON.stringify({model:'fixture/fixture',small_model:'fixture/fixture',permission:{bash:'ask'},provider:{fixture:{npm:'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture'},models:{fixture:{name:'Fixture',tool_call:true,limit:{context:200000,output:10000}}}}}})
  try {
    const sid=await k.startSession(out)
    const events=[]
    const done=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error(`Automatic reject did not continue: ${JSON.stringify(events)}`)),45000)
      k.onEvent(e=>{ if(e.sessionId!==sid)return; events.push(e); if(e.type==='done'){clearTimeout(timer);resolve()} })
    })
    await k.send(sid,'Clean up, then finish.')
    await done
    assert.ok(events.some(e=>e.permission?.automatic&&e.permission.resolved==='reject'))
    assert.ok(!events.some(e=>e.type==='permission'&&!e.permission.resolved),'no prompt')
    assert.ok(toolResults.some(t=>/only permits actions inside this project folder/.test(t)),'the model saw the reason')
    assert.ok(events.some(e=>e.type==='text'&&e.text.includes('Skipped')),'the turn continued after the reject')
    console.log('Real OpenCode automatic reject continues the turn')
  } finally { await k.dispose();await new Promise(r=>model.close(r)) }
}
rmSync(out,{recursive:true,force:true})
