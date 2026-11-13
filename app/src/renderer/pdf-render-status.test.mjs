import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawn,execFileSync} from 'node:child_process'
import {existsSync,readFileSync,mkdtempSync,rmSync} from 'node:fs'
import {createServer} from 'node:http'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'esbuild'
const here=dirname(fileURLToPath(import.meta.url)),app=join(here,'../..')
const chrome=[process.env.HUMANSTUDY_TEST_CHROME,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/google-chrome','/usr/bin/chromium','C:/Program Files/Google/Chrome/Application/chrome.exe'].find(p=>p&&existsSync(p))
if(process.env.HUMANSTUDY_REQUIRE_CHROME==='1')assert.ok(chrome,'Chrome required for PDF rendering acceptance')
test('complete PDF rendering, retry and cancellation in the real page component',{skip:!chrome&&'Chrome unavailable'},async()=>{
 const profile=mkdtempSync(join(tmpdir(),'hs-pdf-ready-'));let browser,closed,server,timer
 try{
  const result=await build({stdin:{resolveDir:here,loader:'tsx',contents:`
   import React,{useState,useRef} from 'react';import{createRoot}from'react-dom/client';import{SourceDrawer,PdfPage}from'./components/SourceDrawer';import'./styles.css';import program from '../../resources/protocol-sample/program.json';
   window.humanstudy={project:{readText:async()=>{throw Error('ENOENT')}}};
   const check=(x,m)=>{if(!x)throw Error(m)};
   async function until(fn,m){const end=Date.now()+15000;while(!fn()){if(Date.now()>end)throw Error(m);await new Promise(r=>setTimeout(r,20))}}
   const root=createRoot(document.getElementById('root'));
   const pdf={path:'/paper.pdf',url:'/paper.pdf',ext:'pdf',sha256:'a'.repeat(64)};
   const quote=program.evidence.find(e=>e.locator.page===1&&e.quote).quote;let matches=[],replaceSource;
   function RealFixture(){const[file,setFile]=useState(pdf);replaceSource=setFile;return <SourceDrawer pdf={file} active source={{page:1,quote}} onClose={()=>{}} onQuote={(_,r)=>matches.push(r)}/>}
   async function run(){
    const start=performance.now();root.render(<RealFixture/>);
    await until(()=>document.body.textContent.includes('Loading paper'),'Missing document loading status');
    await until(()=>document.querySelector('[data-page="1"][data-render-state="ready"]'),'Page1 never completed');
    const c=document.querySelector('[data-page="1"] canvas'),d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;let ink=0;for(let i=Math.floor(c.height*.25)*c.width*4;i<Math.floor(c.height*.9)*c.width*4;i+=4)if(d[i+3]&&d[i]<180)ink++;check(ink>2000,'Completed page lacks body text');
    await until(()=>matches.some(r=>r.found),'Source quote failed');const elapsed=performance.now()-start;replaceSource({...pdf,url:'/replacement.pdf'});await until(()=>document.body.textContent.includes('Loading paper'),'URL change did not invalidate source');check(!document.querySelector('.pdf-page'),'Previous source bitmap retained');await until(()=>document.querySelector('[data-page="1"][data-render-state="ready"]'),'Replacement did not complete');
    const tasks=[];const doc={getPage:async()=>({getViewport:()=>({width:240,height:320}),render:({canvasContext})=>{canvasContext.fillStyle='rgb(10,20,30)';canvasContext.fillRect(0,0,240,320);let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});const t={promise,resolve,reject,cancel(){t.cancelled=true;reject(Error('cancelled'))}};tasks.push(t);return t}})};
    const info={n:1,w:240,h:320,words:[]},loadPage=async()=>info;let setActive,setSize;
    function Fixture(){const[active,a]=useState(true),[size,b]=useState(300),host=useRef(null);setActive=a;setSize=b;return <div ref={host} style={{height:600,width:size,overflow:'auto'}}><PdfPage doc={doc} info={info} loadPage={loadPage} active={active} preserveText={false} root={host} rects={[]} zoom={1} annotations={[]} onAnnotation={()=>{}}/></div>}
    root.render(<Fixture/>);await until(()=>tasks.length===1,'No render');check(document.querySelector('.pdf-page').dataset.renderState==='loading','Partial pixels marked ready');tasks[0].resolve();await until(()=>document.querySelector('.pdf-page').dataset.renderState==='ready','No completion');
    setSize(350);await until(()=>tasks.length===2,'No replacement render');check(document.querySelector('canvas').width>0,'Replacement erased bitmap');tasks[1].reject(Error('injected failure'));await until(()=>document.body.textContent.includes('This page could not be displayed.'),'Swallowed error');check(document.querySelector('canvas').width>0,'Failure erased bitmap');
    [...document.querySelectorAll('button')].find(b=>b.textContent==='Retry page').click();await until(()=>tasks.length===3,'No retry');tasks[2].resolve();await until(()=>document.querySelector('.pdf-page').dataset.renderState==='ready','Retry failed');
    setSize(400);await until(()=>tasks.length===4,'No cancellable render');setActive(false);await until(()=>tasks[3].cancelled,'Not cancelled');await until(()=>document.querySelector('canvas').width===0,'Hidden bitmap retained');check(document.querySelector('.pdf-page').dataset.renderState==='idle','Hidden page not idle');check(!document.querySelector('.pdf-page-status'),'Hidden loading retained');
    setActive(true);await until(()=>tasks.length===5,'No reopen');tasks[4].resolve();await until(()=>document.querySelector('.pdf-page').dataset.renderState==='ready','Stale cancellation overwrote latest');return {ok:true,completePageMs:Math.round(elapsed),ink};
   }
   run().then(r=>fetch('/result',{method:'POST',body:JSON.stringify(r)}),e=>fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:e.stack})}));
  `},bundle:true,format:'iife',platform:'browser',jsx:'automatic',write:false,outfile:'fixture.js',define:{'process.env.NODE_ENV':'"production"'},logLevel:'error',plugins:[{name:'fixture',setup(b){b.onResolve({filter:/\?url$/},()=>({path:'worker',namespace:'worker'}));b.onLoad({filter:/.*/,namespace:'worker'},()=>({contents:'export default "/worker.mjs"'}));b.onLoad({filter:/SourceDrawer\.tsx$/},a=>({contents:readFileSync(a.path,'utf8')+'\nexport {PdfPage};',loader:'tsx'}))}}],loader:{'.woff2':'empty','.svg':'empty'}})
  let finish;const report=new Promise(r=>finish=r)
  server=createServer((req,res)=>{if(req.url==='/result'){let b='';req.on('data',c=>b+=c);req.on('end',()=>{res.end();finish(JSON.parse(b))});return}
   let data,type='text/javascript';const url=new URL(req.url,'http://local');if(url.pathname==='/'){type='text/html';data='<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; worker-src \'self\' blob:; connect-src \'self\'"><link rel="stylesheet" href="/fixture.css"><style>html,body,#root,.source-body{height:100%;margin:0}#root{width:700px}</style><div id="root"></div><script src="/fixture.js"></script>'}else if(url.pathname==='/fixture.js')data=result.outputFiles.find(f=>f.path.endsWith('.js')).contents;else if(url.pathname==='/fixture.css'){type='text/css';data=result.outputFiles.find(f=>f.path.endsWith('.css')).contents}else if(url.pathname==='/worker.mjs')data=readFileSync(join(app,'node_modules/pdfjs-dist/build/pdf.worker.min.mjs'));else if(['/paper.pdf','/replacement.pdf'].includes(url.pathname)){setTimeout(()=>res.writeHead(200,{'Content-Type':'application/pdf'}).end(readFileSync(join(app,'resources/protocol-sample/paper.pdf'))),200);return}else if(/^\/pdfjs\/(standard_fonts|cmaps)\/[\w.-]+$/.test(url.pathname)){data=readFileSync(join(here,'public',url.pathname));type='application/octet-stream'}else {res.writeHead(404).end();return}res.writeHead(200,{'Content-Type':type}).end(data)
  });await new Promise(r=>server.listen(0,'127.0.0.1',r))
  const args=['--headless','--disable-gpu','--no-first-run','--disable-background-networking',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}/`];let command=chrome
  // Translated Node otherwise silently launches Intel Chrome on Apple Silicon.
  if(process.platform==='darwin'&&!process.env.HUMANSTUDY_TEST_CHROME){let arm=false;try{arm=execFileSync('/usr/sbin/sysctl',['-n','hw.optional.arm64'],{encoding:'utf8'}).trim()==='1'}catch{}if(arm){command='/usr/bin/arch';args.unshift('-arm64',chrome)}}
  browser=spawn(command,args,{stdio:['ignore','ignore','pipe']});closed=new Promise(r=>browser.once('close',r));let errors='';browser.stderr.on('data',c=>errors=(errors+c).slice(-1000));browser.on('error',e=>finish({ok:false,error:e.message}));timer=setTimeout(()=>finish({ok:false,error:'PDF completion timed out: '+errors}),45000)
  const outcome=await report;clearTimeout(timer);console.log('PDF completion:',outcome);assert.equal(outcome.ok,true,outcome.error)
 }finally{clearTimeout(timer);if(browser&&browser.exitCode===null&&browser.signalCode===null)browser.kill();if(closed)await closed;await new Promise(r=>server?server.close(r):r());rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
})
