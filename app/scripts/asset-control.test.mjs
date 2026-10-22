import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {PassThrough} from 'node:stream'
import {controlAssets,packPath} from './asset-control.mjs'

class FakeKernel {
  listeners=new Set();calls=[];disposed=false
  onEvent(cb){this.listeners.add(cb);return()=>this.listeners.delete(cb)}
  emit(event){for(const cb of this.listeners)cb({sessionId:'s',...event})}
  async startSession(){await new Promise(r=>setTimeout(r,5));return 's'}
  async resumeSession(_dir,id){return id==='s'?'s':null}
  async send(id,text){this.calls.push(['send',id,text])}
  async abort(id){this.calls.push(['abort',id]);this.emit({type:'done'})}
  async dispose(){this.disposed=true}
  async reply(...args){this.calls.push(['permission',...args]);this.emit({type:'permission',permission:{id:args[1],resolved:args[2]}})}
  async answerQuestion(...args){this.calls.push(['answer',...args])}
  async rejectQuestion(...args){this.calls.push(['reject-question',...args])}
  async questions(){return []}
  setPermissionMode(mode){this.calls.push(['auto',mode])}
  async native(id,request){this.calls.push(['native',id,request]);return request.operation==='fork'?{id:'forked'}:{operation:request.operation}}
}

async function setup(t,options={}){
  const root=mkdtempSync(join(tmpdir(),'asset-control-')),input=new PassThrough(),output=new PassThrough(),kernel=new FakeKernel(),messages=[]
  writeFileSync(join(root,'CONVERT.md'),'Build the initial fixture; retain missing items.')
  const waiters=[]
  output.on('data',data=>{for(const line of String(data).trim().split('\n')){if(!line)continue;const value=JSON.parse(line);messages.push(value);for(const w of [...waiters])if(w.test(value)){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(value)}}})
  const wait=test=>{
    const found=messages.find(test);if(found)return Promise.resolve(found)
    return new Promise((resolve,reject)=>{const w={test,resolve,timer:setTimeout(()=>reject(Error('Expected bridge message was not emitted')),2000)};waiters.push(w)})
  }
  const starting=controlAssets({kernel,project:root,input,output,logDir:join(root,'private-log'),...options})
  const bridge=await starting
  t.after(async()=>{await bridge.stop();rmSync(root,{recursive:true,force:true})})
  const command=async body=>{const id='request-'+messages.length;input.write(JSON.stringify({...body,id})+'\n');return await wait(m=>m.type==='reply'&&m.id===id)}
  return {root,kernel,bridge,messages,input,command,wait}
}

test('Codex controls the same session; turn completion retains the entire scientific transcript',async t=>{
  const x=await setup(t)
  assert.equal((await x.command({op:'build'})).ok,true)
  assert.equal((await x.command({op:'send',text:'overlap'})).ok,false)
  const full='Full material '.repeat(50_000)+'END'
  x.kernel.emit({type:'text',text:full});x.kernel.emit({type:'tool',tool:'write',text:'completed',output:full});x.kernel.emit({type:'done'})
  assert.equal(readFileSync(join(x.root,'private-log/assistant.txt'),'utf8'),full)
  const logged=readFileSync(x.bridge.eventPath,'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(logged.some(r=>r.event?.output===full))
  assert.ok(!JSON.stringify(x.messages).includes(full),'console uses log references, not truncated data')
  assert.equal((await x.command({op:'send',text:'Repair the exact checker error.'})).ok,true)
  assert.deepEqual(x.kernel.calls.filter(c=>c[0]==='send').map(c=>c[1]),['s','s'])
})

test('Windows and POSIX pack paths resolve to the same upstream files',()=>{
  assert.deepEqual(packPath('.opencode\\skills\\build\\SKILL.md'),{rel:'.opencode/skills/build/SKILL.md',original:'skills/build/SKILL.md'})
  assert.equal(packPath('.opencode\\HUMANSTUDY_AGENT.md').original,'AGENTS.md')
  for(const value of ['../secret','/absolute','schema/../secret','C:\\secret'])assert.throws(()=>packPath(value))
})

test('abort and quit interrupt a slow native operation instead of waiting in its queue',async t=>{
  const x=await setup(t)
  let finishCompact
  x.kernel.native=(_id,request)=>request.operation==='compact'?new Promise(resolve=>{finishCompact=resolve}):Promise.resolve({})
  x.input.write('{"op":"native","operation":"compact","id":"slow"}\n')
  await new Promise(r=>setTimeout(r,10))
  assert.equal((await x.command({op:'abort'})).ok,true)
  assert.ok(x.kernel.calls.some(c=>c[0]==='abort'))
  assert.equal((await x.command({op:'quit'})).ok,true)
  assert.ok(x.kernel.disposed)
  finishCompact({compacted:true})
})

test('permissions, questions and context are controlled explicitly without a blanket grant',async t=>{
  const x=await setup(t)
  await x.command({op:'build'})
  x.kernel.emit({type:'permission',permission:{id:'outside',type:'edit',metadata:{filepath:'/outside'}}})
  assert.equal((await x.command({op:'permission',permissionId:'outside',reply:'always'})).ok,false)
  assert.equal((await x.command({op:'permission',permissionId:'outside',reply:'reject'})).ok,true)
  assert.equal((await x.command({op:'answer',questionId:'question',answers:[['Actual supplied answer']]})).ok,true)
  assert.equal((await x.command({op:'auto',mode:'off'})).ok,true)
  assert.equal((await x.command({op:'native',operation:'context'})).ok,true)
  assert.equal((await x.command({op:'native',operation:'share'})).ok,false)
  assert.equal((await x.command({op:'native',operation:'compact'})).ok,false)
  x.kernel.emit({type:'done'})
  assert.equal((await x.command({op:'native',operation:'fork'})).ok,true)
  assert.equal((await x.command({op:'send',text:'Inspect this fork.'})).ok,true)
  assert.equal(x.kernel.calls.at(-1)[1],'forked')
})

test('EOF aborts an active worker and disposes its server',async t=>{
  const x=await setup(t);await x.command({op:'build'});x.input.end()
  assert.equal(await x.bridge.exited,'input_closed_during_turn')
  assert.ok(x.kernel.disposed);assert.ok(x.kernel.calls.some(c=>c[0]==='abort'))
})

test('no progress has a bounded stop rather than another model request',async t=>{
  const x=await setup(t,{stallMs:30,timeoutMs:1000});await x.command({op:'build'})
  assert.equal(await x.bridge.exited,'no_progress')
  assert.equal(x.kernel.calls.filter(c=>c[0]==='send').length,1)
  assert.equal(JSON.parse(readFileSync(x.bridge.resultPath)).lastTurn,'no_progress')
})

test('pending questions pause stall detection but the total deadline still ends the run',async t=>{
  const x=await setup(t,{stallMs:25,timeoutMs:90});await x.command({op:'build'})
  x.kernel.emit({type:'question',question:{id:'q',questions:[]}})
  assert.equal(await x.bridge.exited,'deadline_exceeded')
})

test('a resumed unknown session fails instead of creating a replacement',async()=>{
  const root=mkdtempSync(join(tmpdir(),'asset-control-resume-')),kernel=new FakeKernel(),input=new PassThrough(),output=new PassThrough()
  try{
    await assert.rejects(controlAssets({kernel,project:root,session:'missing',input,output,logDir:join(root,'log')}),/cannot be resumed/)
    assert.ok(kernel.disposed)
  }finally{rmSync(root,{recursive:true,force:true})}
})

test('stdin commands sent during startup are queued rather than silently lost',async t=>{
  const root=mkdtempSync(join(tmpdir(),'asset-control-early-')),kernel=new FakeKernel(),input=new PassThrough(),output=new PassThrough()
  writeFileSync(join(root,'CONVERT.md'),'Initial build')
  const starting=controlAssets({kernel,project:root,input,output,logDir:join(root,'log')})
  input.write('{"op":"build"}\n');input.end()
  const bridge=await starting
  await bridge.exited
  assert.equal(kernel.calls.filter(c=>c[0]==='send').length,1)
  rmSync(root,{recursive:true,force:true})
})
