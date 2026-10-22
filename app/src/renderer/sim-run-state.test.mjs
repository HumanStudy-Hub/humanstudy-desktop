// #16: the Simulation tab keeps chat activity and simulation runs apart. Real React state transitions,
// accelerated wall clock, isolated Electron profile.   node src/renderer/sim-run-state.test.mjs
import {build} from 'esbuild'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
const here=dirname(fileURLToPath(import.meta.url)),out=mkdtempSync(join(tmpdir(),'sim-run-state-'))
try{
 await build({stdin:{resolveDir:here,loader:'tsx',contents:`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{SimulationPanel}from'./components/SimulationPanel';import sample from'../shared/sample-program.json';import'./styles.css';
 const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;
 const texts={};window.fixture={stops:[]};window.humanstudy={telemetry:{track:async()=>{}},project:{readText:async p=>{if(p in texts)return texts[p];throw Error('missing')}}};
 const S='artifacts/simulations';
 const file=(rel,extra={})=>({name:rel.split('/').pop(),path:'/fixture/'+rel,rel,kind:'file',ext:rel.split('.').pop(),mtime:Date.now(),size:10,url:'about:blank',...extra});
 const dir=(rel,children)=>({name:rel.split('/').pop(),path:'/fixture/'+rel,rel,kind:'dir',ext:'',children});
 const pkg=dir('package',[dir('package/p',[dir('package/p/task',[file('package/p/task/adapter.py')])])]);
 // runs: {id: {files:[name|[name,extra]], progress?}}
 const treeOf=runs=>[pkg,dir('artifacts',[dir(S,Object.entries(runs).map(([id,r])=>{const rel=S+'/'+id;if(r.progress){texts['/fixture/'+rel+'/progress.json']=JSON.stringify(r.progress)}const m=r.mtime??(r.progress?.updatedAt?Date.parse(r.progress.updatedAt):Date.now());return dir(rel,[...(r.progress?['progress.json']:[]),...r.files].map(x=>Array.isArray(x)?file(rel+'/'+x[0],{mtime:m,...x[1]}):file(rel+'/'+x,{mtime:m})))}))])];
 window.fixture.treeOf=treeOf;
 function Fixture(){const[state,setState]=useState({busy:false,turn:null,thread:'t1',tree:[pkg]}),[key,setKey]=useState(0);
 window.fixture.set=patch=>setState(s=>({...s,...patch}));window.fixture.advance=ms=>{offset+=ms;setState(s=>({...s}))};window.fixture.remount=()=>setKey(n=>n+1);
 return <SimulationPanel key={key} project={{dir:'/fixture',name:'Fixture',tree:state.tree}} program={sample} studyId={sample.studies[0].id} studies={sample.studies} model='fixture' agentBusy={state.busy} agentThreadId={state.thread} agentTurnKey={state.turn}
  onStudy={()=>{}} onBuild={()=>{}} onRun={async()=>{if(!window.fixture.noStart)setState(s=>({...s,busy:true,turn:'run-'+Date.now()}))}} onStop={runs=>{window.fixture.stops.push(runs);setState(s=>({...s,busy:false}))}} onAsk={()=>{}} onOpenFile={()=>{}}/>};
 createRoot(document.getElementById('root')).render(<Fixture/>);
 `},bundle:true,format:'iife',platform:'browser',jsx:'automatic',outfile:join(out,'fixture.js'),define:{'process.env.NODE_ENV':'"production"'},logLevel:'error'})
 writeFileSync(join(out,'index.html'),'<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
 writeFileSync(join(out,'runner.cjs'),`
 const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(out,'userdata'))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{backgroundThrottling:false}}),errors=[];w.webContents.on('console-message',(_e,l,m)=>{if(l>=3)errors.push(m)});const js=x=>w.webContents.executeJavaScript(x,true),wait=ms=>new Promise(r=>setTimeout(r,ms)),text=()=>js('document.body.textContent'),has=sel=>js('Boolean(document.querySelector('+JSON.stringify(sel)+'))'),runReady=()=>js("(b=>Boolean(b&&!b.disabled))(document.querySelector('.sim-actions .primary'))");
 try{await w.loadFile(${JSON.stringify(join(out,'index.html'))});await wait(100);
 // (1) A stopped run (progress quiet for 5 minutes) stays stopped while the agent answers a question about a report.
 await js("window.fixture.set({tree:window.fixture.treeOf({'2026-10-20-0900':{files:['run.py'],progress:{stage:'running',done:3,total:40,updatedAt:new Date(Date.now()-300000).toISOString()}}})})");await wait(150);
 assert.ok(!(await has('.sim-live')),'a quiet run looked active');
 await js("window.fixture.set({busy:true,turn:'t1:question-about-report'})");await wait(150);
 assert.ok(!(await has('.sim-live')),'asking the agent about a report revived a stopped run');assert.ok(!(await text()).includes('Getting ready'),'chat activity showed Getting ready');
 await js('window.fixture.set({busy:false,turn:"t1:q-done"})');await wait(50);

 // (4) Stop during preparation, before the run folder exists: back to idle and retryable at once.
 await js("document.querySelector('.sim-actions .primary').click()");await wait(150);
 assert.ok((await text()).includes("Getting ready"),"Run did not show preparation: "+(await text()));
 await js("document.querySelector('.sim-stop').click()");await wait(150);
 assert.ok(!(await has('.sim-live')),'Stop before the folder existed left the page on Getting ready');assert.ok(await runReady(),'Run is not available again after Stop');
 // (4) Stop while the agent has just created the run folder (fresh mtime, progress says preparing).
 await js("document.querySelector('.sim-actions .primary').click()");await wait(100);
 await js("window.fixture.advance(1000);window.fixture.set({tree:window.fixture.treeOf({'2026-10-20-0900':{files:['run.py'],progress:{stage:'running',done:3,total:40,updatedAt:new Date(Date.now()-300000).toISOString()}},'2026-10-22-1000':{files:['run.py'],progress:{stage:'preparing',total:40,updatedAt:new Date().toISOString()}}})})");await wait(150);
 assert.ok((await text()).includes('Getting ready'),'the new run was not shown while preparing');
 await js("document.querySelector('.sim-stop').click()");await wait(150);
 const stops=await js('window.fixture.stops');assert.deepEqual(stops.at(-1),['/fixture/artifacts/simulations/2026-10-22-1000'],'Stop did not target the preparing run folder');
 assert.ok(!(await has('.sim-live')),'Stop during preparation left the page on Getting ready');assert.ok(await runReady(),'Run is not retryable after Stop during preparation');
 await js('window.fixture.remount()');await wait(150);assert.ok(!(await has('.sim-live')),'switching tabs revived the stopped run');
 await js("window.fixture.set({busy:true,turn:'t1:late-busy'})");await wait(150);assert.ok(!(await has('.sim-live')),'a later chat turn revived the stopped run');
 await js('window.fixture.set({busy:false})');await wait(50);
 // Retry right after Stop: the new run is shown and is not swallowed by the earlier Stop.
 await js("window.fixture.advance(2000);document.querySelector('.sim-actions .primary').click()");await wait(150);
 assert.ok((await text()).includes('Getting ready'),'retry after Stop did not start');
 await js("window.fixture.set({tree:window.fixture.treeOf({'2026-10-22-1003':{files:['run.py'],progress:{stage:'running',done:1,total:40,updatedAt:new Date().toISOString()}}})})");await wait(150);
 assert.ok((await text()).includes('1 of 40'),'the retried run did not show its progress');
 await js("document.querySelector('.sim-stop').click()");await wait(150);

 // A quiet scoring stage of a live run (heartbeat moving, no progress for 10 minutes) is not "Stopped",
 // whatever the chat is doing; a stale heartbeat (process gone) is.
 await js("window.fixture.advance(600000);window.fixture.set({busy:true,turn:'t1:unrelated',tree:window.fixture.treeOf({'2026-10-22-1200':{files:['run.py',['sessions.jsonl',{size:500}]],mtime:Date.now()-15000,progress:{stage:'scoring',runner:'alive',done:40,total:40,updatedAt:new Date(Date.now()-600000).toISOString(),heartbeatAt:new Date(Date.now()-15000).toISOString()}}})})");await wait(1200);
 assert.ok((await text()).includes('Comparing with the paper'),'a live run in a quiet scoring stage was not shown as running');
 await js("window.fixture.set({busy:false,turn:'t1:unrelated-done'})");await wait(1200);
 assert.ok((await text()).includes('Comparing with the paper'),'the end of an unrelated chat turn stopped a live run');
 // run.py ended and the agent is writing up: still running for the write-up window.
 await js("window.fixture.set({tree:window.fixture.treeOf({'2026-10-22-1200':{files:['run.py','report.md',['sessions.jsonl',{size:500}]],mtime:Date.now()-300000,progress:{stage:'writing',runner:'exited',done:40,total:40,updatedAt:new Date(Date.now()-480000).toISOString()}}})})");await wait(1200);
 assert.ok((await text()).includes('Writing up the results'),'a quiet write-up was shown as stopped');
 await js("window.fixture.set({tree:window.fixture.treeOf({'2026-10-22-1200':{files:['run.py',['sessions.jsonl',{size:500}]],mtime:Date.now()-120000,progress:{stage:'scoring',runner:'alive',done:40,total:40,updatedAt:new Date(Date.now()-600000).toISOString(),heartbeatAt:new Date(Date.now()-120000).toISOString()}}})})");await wait(1200);
 assert.ok(!(await has('.sim-live')),'a run whose heartbeat went stale (process gone) still looked active');

 // (3) Only runs with participant data are results; empty and aborted folders are not listed or shown.
 await js("window.fixture.advance(600000);window.fixture.set({busy:false,tree:window.fixture.treeOf({'2026-10-22-1100':{files:[],mtime:Date.now()-600000},'2026-10-22-1000':{files:['run.py','STOP'],mtime:Date.now()-600000,progress:{stage:'preparing',total:40}},'2026-10-21-0900':{files:['results.html',['sessions.jsonl',{size:0}]],mtime:Date.now()-86400000}})})");await wait(200);
 assert.ok(!(await has('.sim-result')),'a folder without participant data was shown as a result');assert.ok(!(await has('.sim-history')),'empty run folders were listed as runs');
 await js("window.fixture.set({tree:window.fixture.treeOf({'2026-10-22-1100':{files:[],mtime:Date.now()-600000},'2026-10-22-1000':{files:['run.py','STOP'],mtime:Date.now()-600000,progress:{stage:'preparing',total:40}},'2026-10-21-0900':{files:['results.html',['sessions.jsonl',{size:0}]],mtime:Date.now()-86400000},'2026-10-20-0800':{files:['results.html',['sessions.jsonl',{size:900}]],mtime:Date.now()-172800000,progress:{stage:'done',done:40,total:40}}})})");await wait(200);
 assert.ok(await has('.sim-result'),'a run with participants was not shown as a result');assert.ok(!(await has('.sim-history')),'empty folders were counted next to the one real result');
 assert.ok(!(await has('.sim-live')),'an aborted folder looked active');
 assert.equal(errors.length,0,errors.join('\\n'));console.log('Chat vs run state, quiet live stages, stale heartbeat, Stop during preparation (with and without a folder), retry, and result counting passed');
 }catch(e){console.error(e);process.exitCode=1}finally{w.destroy();app.exit(process.exitCode||0)}});
 `)
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const code=await new Promise((resolve,reject)=>{const c=spawn(join(here,'../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),[join(out,'runner.cjs')],{stdio:'inherit',env});const t=setTimeout(()=>{c.kill('SIGTERM');reject(Error('Simulation run state test timed out'))},30000);c.on('error',reject);c.on('exit',code=>{clearTimeout(t);resolve(code)})});if(code!==0)process.exitCode=1
}finally{rmSync(out,{recursive:true,force:true})}
