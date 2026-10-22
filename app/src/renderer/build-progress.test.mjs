// Real React state transitions, accelerated wall clock, isolated Electron profile.
import {build} from 'esbuild'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
const here=dirname(fileURLToPath(import.meta.url)),out=mkdtempSync(join(tmpdir(),'build-progress-'))
try{
 await build({stdin:{resolveDir:here,loader:'tsx',contents:`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{SimulationPanel}from'./components/SimulationPanel';import sample from'../shared/sample-program.json';import {packageReadiness} from '../shared/package-readiness';import'./styles.css';
 const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;
 // A complete package (#20: only a package with all eight valid files counts as built).
 const P='package/p',pkgFiles=['study.json','source/paper_metadata.json','source/evidence.json','materials/materials.json','task/task.json','task/adapter.py','evaluation/evaluation.py','audit/missing_information.json'];
 const texts=Object.fromEntries(pkgFiles.map(f=>['/fixture/'+P+'/'+f,f==='task/adapter.py'?'def run_sessions(llm, seed, n, arms=None): return []':f==='evaluation/evaluation.py'?'def evaluate(sessions): return {}':'{}']));
 const entry=rel=>({name:rel.split('/').pop(),path:'/fixture/'+rel,rel,kind:'file',ext:rel.split('.').pop(),size:10,mtime:0});
 const folder=(rel,children)=>({name:rel.split('/').pop(),path:'/fixture/'+rel,rel,kind:'dir',ext:'',children});
 const sub=d=>folder(P+'/'+d,pkgFiles.filter(f=>f.startsWith(d+'/')).map(f=>entry(P+'/'+f)));
 window.fixture={package:[folder('package',[folder(P,[entry(P+'/study.json'),sub('source'),sub('materials'),sub('task'),sub('evaluation'),sub('audit')])])]};
 window.humanstudy={telemetry:{track:async()=>{}},project:{packageReadiness:async(dir,studyId)=>packageReadiness(window.fixture.tree?.find(e=>e.rel==='package')?.children.map(e=>e.name)??[],async(slug,file)=>texts[dir+'/package/'+slug+'/'+file]??null,{studyId,program:sample}),readText:async p=>{if(p in texts)return texts[p];throw Error('missing')}}};
 sessionStorage.setItem('hs.sim.pending:/fixture',JSON.stringify({at:Date.now()-109*60000,kind:'build'}));
 texts['/fixture/package/p/study.json']=JSON.stringify({program:sample});texts['/fixture/package/p/task/task.json']=JSON.stringify({programBindings:{programId:sample.id,stepIds:sample.steps.map(s=>s.id),recordNodeIds:sample.nodes.filter(n=>['record','variable'].includes(n.kind)).map(n=>n.id),analysisNodeIds:sample.nodes.filter(n=>n.kind==='analysis').map(n=>n.id)}});
 function Fixture(){const[state,setState]=useState({busy:true,turn:'unrelated',thread:'thread-1',tree:[]}),[key,setKey]=useState(0);window.fixture.set=patch=>setState(s=>({...s,...patch}));window.fixture.advance=ms=>{offset+=ms;setState(s=>({...s}))};window.fixture.remount=()=>setKey(n=>n+1);
 window.fixture.tree=state.tree;return <SimulationPanel key={key} project={{dir:'/fixture',name:'Fixture',tree:state.tree}} program={sample} studyId={sample.studies[0].id} studies={sample.studies} model='fixture' agentBusy={state.busy} agentThreadId={state.thread} agentTurnKey={state.turn} onStudy={()=>{}} onBuild={()=>{if(!window.fixture.ignoreBuild)setState(s=>({...s,busy:true,turn:'build-'+Date.now()}))}} onRun={async()=>{}} onStop={()=>setState(s=>({...s,busy:false}))} onAsk={()=>{}} onOpenFile={()=>{}}/>};createRoot(document.getElementById('root')).render(<Fixture/>);
 `},bundle:true,format:'iife',platform:'browser',jsx:'automatic',outfile:join(out,'fixture.js'),define:{'process.env.NODE_ENV':'"production"'},logLevel:'error'})
 writeFileSync(join(out,'index.html'),'<link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
 writeFileSync(join(out,'runner.cjs'),`
 const {app,BrowserWindow}=require('electron'),assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(out,'userdata'))});app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{backgroundThrottling:false}}),errors=[];w.webContents.on('console-message',(_e,l,m)=>{if(l>=3)errors.push(m)});const js=x=>w.webContents.executeJavaScript(x,true),wait=ms=>new Promise(r=>setTimeout(r,ms)),text=()=>js('document.body.textContent');
 try{await w.loadFile(${JSON.stringify(join(out,'index.html'))});await wait(100);assert.ok(!(await text()).includes('Building the runnable'),'legacy pending state resurrected a 109-minute build');
 await js("window.fixture.set({busy:false})");await wait(50);await js("document.querySelector('.sim-actions .primary').click()");await wait(100);assert.ok((await text()).includes('Building the runnable'),'a real build did not start');
 await js('window.fixture.advance(2000);window.fixture.set({busy:false})');await wait(100);assert.ok(!(await text()).includes('Building the runnable'),'quick completion kept the build active');assert.ok((await text()).includes('Saved work is kept'),'missing output was not explained');
 await js("window.fixture.advance(109*60000);window.fixture.set({busy:true,turn:'later-question'})");await wait(100);assert.ok(!(await text()).includes('Building the runnable'),'unrelated chat revived an old build');
 await js('window.fixture.set({busy:false})');await wait(50);await js("document.querySelector('.sim-actions .primary').click()");await wait(100);await js('window.fixture.remount()');await wait(100);assert.ok((await text()).includes('Building the runnable'),'switching tabs lost the active build');
 await js("window.fixture.set({thread:''})");await wait(100);await js("window.fixture.set({thread:'thread-1'})");await wait(100);assert.ok((await text()).includes('Building the runnable'),'the build was dropped while the conversation was reloading');
 await js("window.fixture.set({busy:true,thread:'thread-2',turn:'another-conversation'})");await wait(100);assert.ok(!(await text()).includes('Building the runnable'),'another conversation adopted this build');
 await js('window.fixture.set({busy:false})');await wait(50);await js("document.querySelector('.sim-actions .primary').click()");await wait(100);await js("document.querySelector('.sim-stop').click()");await wait(100);assert.ok(!(await text()).includes('Building the runnable'),'Stop left the build running');
 await js('window.fixture.ignoreBuild=true');await js("document.querySelector('.sim-actions .primary').click()");await wait(50);await js('window.fixture.advance(10000)');await wait(1100);assert.ok((await text()).includes('Saved work is kept'),'dispatch without a busy event never expired');
 await js('window.fixture.ignoreBuild=false');await js("document.querySelector('.sim-actions .primary').click()");await wait(100);await js("window.fixture.set({busy:false,tree:window.fixture.package})");await wait(100);assert.equal(await js("document.querySelector('.sim-problem')"),null,'successful package produced a failure banner');
 await js("document.querySelector('.sim-actions .primary').click()");await wait(50);await js('window.fixture.advance(10000)');await wait(1100);assert.ok((await text()).includes('without starting a simulation'),'missing simulation was not explained');
 await js("window.fixture.set({busy:true,turn:'another-unrelated-question'})");await wait(100);assert.ok(!(await text()).includes('Looking through the project'),'unrelated chat revived a failed run');
 assert.equal(errors.length,0,errors.join('\\n'));console.log('Legacy timer, quick completion, unrelated chat, tab remount, thread switching, Stop, failed dispatch and missing/successful output passed');
 }catch(e){console.error(e);process.exitCode=1}finally{w.destroy();app.exit(process.exitCode||0)}});
 `)
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const code=await new Promise((resolve,reject)=>{const c=spawn(join(here,'../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),[join(out,'runner.cjs')],{stdio:'inherit',env});const t=setTimeout(()=>{c.kill('SIGTERM');reject(Error('Build progress test timed out'))},30000);c.on('error',reject);c.on('exit',code=>{clearTimeout(t);resolve(code)})});if(code!==0)process.exitCode=1
}finally{rmSync(out,{recursive:true,force:true})}
