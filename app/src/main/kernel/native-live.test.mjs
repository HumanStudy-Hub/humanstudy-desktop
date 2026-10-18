// Actual installed OpenCode, isolated Git project/home, local model and MCP fixtures; no user credentials.
import {build} from 'esbuild'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
const binary=process.env.HUMANSTUDY_KERNEL_BIN
if(!binary)throw Error('Set HUMANSTUDY_KERNEL_BIN to test the actual installed kernel.')
const root=mkdtempSync(join(dirname(fileURLToPath(import.meta.url)),'.native-capabilities-')),project=join(root,'project');mkdirSync(project)
execFileSync('git',['init','-q',project]);writeFileSync(join(project,'source.txt'),'完整原文\nFINAL EVIDENCE\n')
writeFileSync(join(project,'draft.txt'),'ORIGINAL DRAFT\n');execFileSync('git',['-C',project,'add','source.txt','draft.txt']);execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-C',project,'commit','-qm','Fixture'])
const here=dirname(fileURLToPath(import.meta.url));await build({entryPoints:[join(here,'opencode.ts')],bundle:true,platform:'node',format:'esm',outfile:join(root,'kernel.mjs'),logLevel:'error'})
const {OpencodeKernel}=await import(pathToFileURL(join(root,'kernel.mjs')))
const bodies=[];let wrote=false
const model=createServer(async(req,res)=>{const chunks=[];for await(const c of req)chunks.push(c);const body=JSON.parse(Buffer.concat(chunks).toString());bodies.push(body);const write=Boolean(body.tools?.length)&&!wrote;if(write)wrote=true;const delta=write?{tool_calls:[{index:0,id:'write_fixture',type:'function',function:{name:'write',arguments:JSON.stringify({filePath:join(project,'draft.txt'),content:'CHANGED DRAFT 完整原文 FINAL'})}}]}:{content:'Complete fixture response. 完整原文 FINAL EVIDENCE'};const chunk={id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:null}]};res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: '+JSON.stringify(chunk)+'\n\n');res.end('data: '+JSON.stringify({...chunk,choices:[{index:0,delta:{},finish_reason:write?'tool_calls':'stop'}],usage:{prompt_tokens:20,completion_tokens:10}})+'\n\ndata: [DONE]\n\n')})
await new Promise(r=>model.listen(0,'127.0.0.1',r))
const k=new OpencodeKernel({binary,home:join(root,'home'),provider:'humanstudy',model:'fixture',permission:'project'})
const cfg=JSON.parse(k.configContent());k.configContent=()=>JSON.stringify({...cfg,command:{fixture:{template:'Return the supplied words exactly: $ARGUMENTS',description:'Local fixture command'}},provider:{humanstudy:{npm:'@ai-sdk/openai-compatible',options:{baseURL:`http://127.0.0.1:${model.address().port}/v1`,apiKey:'fixture-only'},models:{fixture:{name:'Fixture',tool_call:true,limit:{context:200000,output:32000},variants:{low:{reasoningEffort:'low'}}}}}}})
const events=[];k.onEvent(e=>events.push(e));let sid
async function done(action){const before=events.length;await action();const until=Date.now()+20000;while(!events.slice(before).some(e=>e.type==='done')){if(Date.now()>until)throw Error('No completion: '+JSON.stringify(events.slice(before)));await new Promise(r=>setTimeout(r,40))}}
async function action(operation,input){return k.native(sid,{operation,input})}
try{
 sid=await k.startSession(project)
 const catalog=await action('catalog');assert.ok(catalog.commands.some(c=>c.name==='fixture'));assert.ok(catalog.agents.some(a=>a.name==='build'));assert.ok(Array.isArray(catalog.skills))
 for(const op of ['session','status','todos','changes','files','commands','agents','skills','models','tools','mcp','providers','providerAuth','lsp','formatters','terminals','shells','children','worktrees','workspaces']){await action(op);console.log('native read:',op)}
 const file=await action('file',{path:'source.txt'});assert.ok(JSON.stringify(file).includes('FINAL EVIDENCE'))
 await assert.rejects(action('file',{path:'../../outside'}))
 await assert.rejects(action('select',{variant:'not-a-variant'}),/does not offer/);await action('select',{agent:'build',variant:'low'});await done(()=>k.send(sid,'Return fixture text.'));assert.equal(events.filter(e=>e.type==='identity').length,1)
 await action('context');
 const native=await action('history');assert.ok(native.some(r=>r.info.role==='user'));assert.ok(native.some(r=>r.parts.some(p=>p.text?.includes('FINAL EVIDENCE'))))
 const fork=await action('fork');assert.ok(fork.id!==sid);assert.ok((await k.native(fork.id,{operation:'history'})).length>=native.length);assert.ok(k.sessions.get(fork.id).roles.size>=native.length,'forked history is seeded before future connection repair')
 assert.equal(readFileSync(join(project,'draft.txt'),'utf8'),'CHANGED DRAFT 完整原文 FINAL')
 const user=native.find(r=>r.info.role==='user').info.id;await action('undo',{messageID:user});assert.equal((await action('session')).revert.messageID,user);assert.equal(readFileSync(join(project,'draft.txt'),'utf8'),'ORIGINAL DRAFT\n');await action('redo');assert.equal(readFileSync(join(project,'draft.txt'),'utf8'),'CHANGED DRAFT 完整原文 FINAL');assert.ok(!(await action('session')).revert)
 await done(()=>action('command',{command:'fixture',arguments:'唯一参数 FINAL ARGUMENT'}));assert.ok(bodies.some(b=>JSON.stringify(b.messages).includes('FINAL ARGUMENT')))
 const identitiesBeforeCompact=events.filter(e=>e.type==='identity').length;await done(()=>action('compact'));assert.equal(events.filter(e=>e.type==='identity').length,identitiesBeforeCompact,'compaction must not replace the real user turn identity');assert.ok((await action('history')).some(r=>r.info.id===user),'compaction retains original records')
 await done(()=>action('shell',{command:'printf native-shell-fixture'}));assert.ok(JSON.stringify(await action('history')).includes('native-shell-fixture'))
 await action('rename',{title:'Native renamed fixture'});assert.equal((await action('session')).title,'Native renamed fixture')
 await action('archive');assert.ok((await action('session')).time.archived>0);await action('open',{id:sid});assert.equal((await action('session')).time.archived,0)
 const terminal=await action('terminalCreate',{command:'/bin/sh',args:['-i']});const link=await action('terminalConnect',{id:terminal.id});assert.ok(link.url.includes('ticket='));assert.ok(!link.url.includes('password'))
 const require=createRequire(import.meta.url),{WebSocket}=require('ws')
 await new Promise((resolve,reject)=>{const ws=new WebSocket(link.url);const timer=setTimeout(()=>{ws.close();reject(Error('PTY timeout'))},10000);let seen='';ws.on('open',()=>ws.send("printf 'NATIVE_PTY_OK\\n'\n"));ws.on('message',(data,binary)=>{if(binary)return;seen+=data.toString();if(seen.includes('NATIVE_PTY_OK')){clearTimeout(timer);ws.close();resolve()}});ws.on('error',reject)})
 await action('terminalResize',{id:terminal.id,cols:100,rows:30});await action('terminalRemove',{id:terminal.id})
 const mcp=join(root,'mcp.cjs');writeFileSync(mcp,`require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:r.method==='tools/list'?{tools:[]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n')}).on('close',()=>process.exit())`)
 await action('mcpAdd',{name:'fixture-tools',config:{type:'local',command:[process.execPath,mcp]}});assert.equal((await action('mcp'))['fixture-tools'].status,'connected');await action('mcpDisconnect',{name:'fixture-tools'});await action('mcpConnect',{name:'fixture-tools'})
 await action('providerKey',{id:'fixture-provider',key:'test-only-secret'});await action('providerRemove',{id:'fixture-provider'})
 assert.equal(readFileSync(join(project,'source.txt'),'utf8'),'完整原文\nFINAL EVIDENCE\n')
 console.log('Real native commands, compact, fork, undo/redo, archive/open, shell, ticketed PTY, MCP and credential API passed')
}finally{await k.dispose();await new Promise(r=>model.close(r));rmSync(root,{recursive:true,force:true})}
