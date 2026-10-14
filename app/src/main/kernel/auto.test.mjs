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
  replies.push(JSON.parse(Buffer.concat(chunks).toString()))
  res.writeHead(200,{'content-type':'application/json'});res.end('true')
})
await new Promise(r => api.listen(0,'127.0.0.1',r))
try {
  const k = new OpencodeKernel({ binary:'/bin/true', permission:'ask' })
  k.register('s',{dir:out,base:`http://127.0.0.1:${api.address().port}`,auth:'Basic fixture',exited:false})
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
  k.handle({type:'permission.asked',properties:{sessionID:'s',id:'outside',permission:'edit',patterns:['/etc/fixture'],metadata:{filepath:'/etc/fixture'}}})
  await new Promise(r=>setTimeout(r,30))
  assert.equal(replies.length,2,'out-of-project edits still require a user answer')
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
rmSync(out,{recursive:true,force:true})
