// Real HumanStudy OpenCode + local model fixture. No paid model calls or Hub credentials.
// HUMANSTUDY_TEST_KERNEL_BIN=<binary> HUMANSTUDY_TEST_RUNTIME_BIN=<runtime/bin> node --test scripts/opencode-assets.live.test.mjs
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn,spawnSync} from 'node:child_process'
import {mkdtempSync,readFileSync,mkdirSync,writeFileSync,rmSync,existsSync,chmodSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createInterface} from 'node:readline'

const here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../..')
const binary=process.env.HUMANSTUDY_TEST_KERNEL_BIN,runtime=process.env.HUMANSTUDY_TEST_RUNTIME_BIN
test('actual CLI controls the desktop OpenCode server, writes a native asset, checks it and closes cleanly',
  {skip:!binary||!runtime,timeout:120_000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'asset-worker-live-')),project=join(root,'project'),messages=[],errors=[]
  let child,closed,modelCalls=0
  const python=join(runtime,process.platform==='win32'?'python.cmd':'python')
  const prepared=spawnSync(python,[join(repo,'scripts/prepare_conversion.py'),'--engine','opencode','--project',project,'--paper',join(repo,'app/resources/sample/KNOBE.pdf')],{encoding:'utf8',shell:process.platform==='win32'})
  assert.equal(prepared.status,0,prepared.stderr)
  const program=readFileSync(join(repo,'app/src/shared/sample-program.json'))
  const html='<!doctype html><html lang="en"><head><title>Study overview</title><link rel="stylesheet" href="hs-kit.css"><script src="hs-kit.js"></script></head><body><main id="app"></main><script>HS.overview("#app")</script></body></html>'
  const code=`import base64, pathlib, subprocess; pathlib.Path('program.json').write_bytes(base64.b64decode('${program.toString('base64')}')); pathlib.Path('artifacts').mkdir(exist_ok=True); pathlib.Path('artifacts/study-overview.html').write_bytes(base64.b64decode('${Buffer.from(html).toString('base64')}')); subprocess.run(['python','.opencode/skills/build/check_program.py','program.json'],check=True); subprocess.run(['python','.opencode/artifact-kit/inline.py','artifacts/study-overview.html'],check=True)`
  const command="python -c '"+code.replaceAll("'","'\\''")+"'"
  const model=createServer(async(req,res)=>{
    const chunks=[];for await(const part of req)chunks.push(part)
    const body=JSON.parse(Buffer.concat(chunks).toString());modelCalls++
    const tools=body.tools?.some(t=>t.function?.name==='bash'),done=body.messages?.some(m=>m.role==='tool')
    const delta=tools&&!done?{tool_calls:[{index:0,id:'write_native_asset',type:'function',function:{name:'bash',arguments:JSON.stringify({command,description:'Save and validate the complete native fixture asset'})}}]}:{content:'Fixture asset saved with its missing items.'}
    const msg={id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:null}]}
    res.writeHead(200,{'content-type':'text/event-stream'})
    res.write(`data: ${JSON.stringify(msg)}\n\n`)
    res.end(`data: ${JSON.stringify({...msg,choices:[{index:0,delta:{},finish_reason:tools&&!done?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(r=>model.listen(0,'127.0.0.1',r))
  const configDir=join(project,'.humanstudy/asset-agent/kernel-home/config/opencode');mkdirSync(configDir,{recursive:true})
  writeFileSync(join(configDir,'opencode.json'),JSON.stringify({provider:{fixture:{npm:'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'local-fixture'},models:{fixture:{name:'Fixture',tool_call:true,limit:{context:200000,output:16000}}}}}}))
  const waiters=[]
  const wait=test=>{
    const found=messages.find(test);if(found)return Promise.resolve(found)
    return new Promise((resolve,reject)=>{const w={test,resolve,timer:setTimeout(()=>reject(Error(`Bridge event missing. ${JSON.stringify(messages.slice(-6))}; ${errors.join('')}`)),70_000)};waiters.push(w)})
  }
  try{
    child=spawn(process.execPath,[join(here,'opencode-assets.mjs'),'--project',project,'--binary',binary,'--runtime-bin',runtime,'--provider','fixture','--model','fixture'],{stdio:['pipe','pipe','pipe'],env:{...process.env,HUMANSTUDY_DESKTOP_KEY:'',OPENROUTER_API_KEY:''}})
    closed=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})))
    child.stderr.on('data',data=>errors.push(String(data)))
    const lines=createInterface({input:child.stdout})
    lines.on('line',line=>{
      const message=JSON.parse(line);messages.push(message)
      for(const w of [...waiters])if(w.test(message)){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(message)}
    })
    const ready=await wait(m=>m.type==='ready')
    assert.ok(ready.sessionId)
    // A second worker must neither start nor remove the first worker's lock.
    const second=spawnSync(process.execPath,[join(here,'opencode-assets.mjs'),'--project',project,'--binary',binary,'--runtime-bin',runtime,'--provider','fixture','--model','fixture'],{encoding:'utf8',timeout:15000})
    assert.notEqual(second.status,0);assert.ok(existsSync(join(project,'.humanstudy/asset-agent/running.lock')))
    child.stdin.write('{"op":"build","id":"initial"}\n')
    await wait(m=>m.type==='event'&&m.eventType==='done')
    assert.ok(!messages.some(m=>m.eventType==='error'),JSON.stringify(messages.filter(m=>m.eventType==='error')))
    assert.deepEqual(JSON.parse(readFileSync(join(project,'program.json'))),JSON.parse(program))
    assert.ok(readFileSync(join(project,'artifacts/study-overview.html'),'utf8').includes('data-hs-kit="program"'))
    assert.ok(messages.some(m=>m.permission?.automatic&&m.permission.resolved==='once'))
    const check=spawnSync(python,[join(project,'.opencode/skills/build/check_program.py'),join(project,'program.json')],{encoding:'utf8',shell:process.platform==='win32'})
    assert.equal(check.status,0,check.stdout+check.stderr)
    assert.ok(modelCalls>=2)
    child.stdin.write('{"op":"quit","id":"quit"}\n')
    assert.equal((await closed).code,0,errors.join(''))
    assert.ok(!existsSync(join(project,'.humanstudy/asset-agent/running.lock')))
  }finally{
    if(child&&child.exitCode===null){child.kill('SIGTERM');await closed}
    for(const w of waiters)clearTimeout(w.timer)
    await new Promise(r=>model.close(r));rmSync(root,{recursive:true,force:true})
  }
})

test('SIGTERM during startup stops the owned worker before a session is ready',
  {skip:!runtime||process.platform==='win32',timeout:30_000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'asset-worker-startup-')),project=join(root,'project'),pidPath=join(root,'owned-worker.pid'),fake=join(root,'fake-opencode')
  const python=join(runtime,'python')
  const prepared=spawnSync(python,[join(repo,'scripts/prepare_conversion.py'),'--engine','opencode','--project',project,'--paper',join(repo,'app/resources/sample/KNOBE.pdf')],{encoding:'utf8'})
  assert.equal(prepared.status,0,prepared.stderr)
  writeFileSync(fake,`#!${process.execPath}\nif(process.argv.includes('--version')){console.log('opencode-humanstudy 1.19.0');process.exit(0)};require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000)\n`)
  chmodSync(fake,0o755)
  let child,pid
  try{
    child=spawn(process.execPath,[join(here,'opencode-assets.mjs'),'--project',project,'--binary',fake,'--runtime-bin',runtime,'--provider','fixture','--model','fixture'],{stdio:['pipe','pipe','pipe']})
    const closed=new Promise(resolve=>child.on('close',code=>resolve(code)))
    const deadline=Date.now()+15_000
    while(!existsSync(pidPath)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30))
    assert.ok(existsSync(pidPath),'owned test worker must start before cancellation')
    pid=Number(readFileSync(pidPath,'utf8'))
    child.kill('SIGTERM')
    assert.notEqual(await closed,0)
    assert.throws(()=>process.kill(pid,0),/ESRCH/,'startup cancellation must not orphan its worker')
    assert.ok(!existsSync(join(project,'.humanstudy/asset-agent/running.lock')))
  }finally{
    if(child?.exitCode===null)child.kill('SIGKILL')
    if(pid){try{process.kill(pid,'SIGKILL')}catch{}}
    rmSync(root,{recursive:true,force:true})
  }
})
