// Real Chromium + PDF.js: paper.pdf replaced at the same path is reloaded with a notice, and a located
// quote whose comparison sign differs from the source is flagged rather than shown as a match.
// node src/renderer/source-replace.test.mjs
import {build} from 'esbuild'
import {mkdtempSync,writeFileSync,readFileSync,cpSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn} from 'node:child_process'
const here=dirname(fileURLToPath(import.meta.url)),out=mkdtempSync(join(tmpdir(),'source-replace-'))
const makePdf=(lines)=>{
 const content='BT /F1 12 Tf 72 740 Td '+lines.map((l,i)=>`${i?'0 -18 Td ':''}(${l}) Tj `).join('')+'ET'
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [4 0 R] /Count 1 >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`]
 let pdf='%PDF-1.4\n';const offsets=[];objects.forEach((o,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${o}\nendobj\n`})
 const xref=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.map(o=>String(o).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
 return pdf
}
try{
 writeFileSync(join(out,'paper.pdf'),makePdf(['DOCUMENT A ONLY first version of the paper.','The anchoring effect was reliable, t\\(38\\) = 2.45, p<.001, in both samples.']))
 writeFileSync(join(out,'paper-b.pdf'),makePdf(['DOCUMENT B ONLY second version of the paper.','A different paper replaced the first one at the same path.']))
 cpSync(join(here,'../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs'),join(out,'pdf.worker.min.mjs'))
 cpSync(join(here,'public/pdfjs'),join(out,'pdfjs'),{recursive:true})
 await build({stdin:{resolveDir:here,loader:'tsx',contents:`
 import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{SourceDrawer}from'./components/SourceDrawer';import'./styles.css';
 window.fixture={checks:[]};window.humanstudy={project:{readText:async()=>{throw Error('ENOENT')},writeText:async()=>{}},telemetry:{track:async()=>{}}};
 function Fixture(){const[pdf,setPdf]=useState({name:'paper.pdf',path:'/fixture/paper.pdf',url:'hsfile://local/paper.pdf',ext:'pdf',version:'v1',mtime:Date.UTC(2026,0,1)}),[source,setSource]=useState({page:1});
  window.fixture.version=(v)=>setPdf(p=>({...p,version:v,mtime:Date.UTC(2026,1,2)}));
  window.fixture.cite=(quote)=>setSource({page:1,nodeId:'claim',quote});
  return <SourceDrawer pdf={pdf} source={source} onClose={()=>{}} onQuote={(ref,result)=>window.fixture.checks.push({ref,result})}/>}
 createRoot(document.getElementById('root')).render(<Fixture/>);
 `},plugins:[{name:'pdf-test-assets',setup(b){b.onResolve({filter:/\\?url$/},args=>({path:args.path,namespace:'url'}));b.onLoad({filter:/.*/,namespace:'url'},()=>({contents:"export default new URL('pdf.worker.min.mjs',location.href).href",loader:'js'}))}}],bundle:true,format:'iife',platform:'browser',jsx:'automatic',outfile:join(out,'fixture.js'),define:{'process.env.NODE_ENV':'"production"'},logLevel:'error'})
 writeFileSync(join(out,'index.html'),'<meta http-equiv="Content-Security-Policy" content="default-src \'self\' hsfile:;script-src \'self\';style-src \'self\' \'unsafe-inline\';worker-src \'self\' blob:;connect-src \'self\' hsfile:"><link rel="stylesheet" href="fixture.css"><style>html,body,#root,.source-body{height:100%;margin:0}#root{width:680px}</style><div id="root"></div><script src="fixture.js"></script>')
 writeFileSync(join(out,'runner.cjs'),`
 const {app,BrowserWindow,protocol,net}=require('electron'),{pathToFileURL}=require('node:url'),{copyFileSync}=require('node:fs'),assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(join(out,'userdata'))});protocol.registerSchemesAsPrivileged([{scheme:'hsfile',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
 const requests=[];
 app.whenReady().then(async()=>{protocol.handle('hsfile',(req)=>{requests.push(req.url);return net.fetch(pathToFileURL(${JSON.stringify(join(out,'paper.pdf'))}).href)});const w=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{backgroundThrottling:false}}),errors=[];w.webContents.on('console-message',(_e,l,m)=>{if(l>=3&&!m.includes('unsafe-eval'))errors.push(m)});const js=x=>w.webContents.executeJavaScript(x,true),wait=ms=>new Promise(r=>setTimeout(r,ms));const until=async(code)=>{const end=Date.now()+15000;while(!await js(code)){if(Date.now()>end)throw Error('Timed out: '+code+'; '+errors.join(';'));await wait(50)}};
 const text="[...document.querySelectorAll('.pdf-text span')].map(s=>s.textContent).join('')";
 try{await w.loadFile(${JSON.stringify(join(out,'index.html'))});await until(text+".includes('DOCUMENT A ONLY')");
 // A located quote with a reversed comparison sign: boxed, but flagged with the differing tokens.
 await js("window.fixture.cite('The anchoring effect was reliable, t(38) = 2.45, p>.001, in both samples.')");await until('window.fixture.checks.length===1');
 assert.equal(await js('window.fixture.checks[0].result.found'),true);assert.ok(await js('Boolean(window.fixture.checks[0].result.differs)'),'p>.001 against p<.001 was not flagged');
 await until("document.querySelector('.paper-cite.warn .paper-differs mark')!==null");assert.deepEqual(await js("[...document.querySelectorAll('.paper-differs mark')].map(m=>m.textContent)"),['>','<']);assert.equal(await js("document.querySelector('.paper-located')"),null);
 await js("window.fixture.cite('The anchoring effect was reliable, t(38) = 2.45, p<.001, in both samples.')");await until('window.fixture.checks.length===2');assert.equal(await js('window.fixture.checks[1].result.differs'),undefined);await until("document.querySelector('.paper-located')!==null");assert.equal(await js("document.querySelector('.paper-cite.warn')"),null);
 // paper.pdf replaced at the same path: a new version stamp reloads it, with a notice.
 await js("window.fixture.cite('')");copyFileSync(${JSON.stringify(join(out,'paper-b.pdf'))},${JSON.stringify(join(out,'paper.pdf'))});await js("window.fixture.version('v2')");
 await until(text+".includes('DOCUMENT B ONLY')");assert.ok(!(await js(text+".includes('DOCUMENT A ONLY')")),'the old document is still shown');
 await until("document.querySelector('.paper-replaced')!==null");assert.ok(await js("document.querySelector('.paper-replaced').textContent.includes('paper.pdf')"));
 assert.ok(requests.some(u=>u.includes('v=v2')),'the new version was not fetched under a new URL: '+requests.join(' '));
 assert.equal(errors.length,0,errors.join('\\n'));console.log('Sign mismatch flagged, clean match labelled as located only, replaced PDF reloaded with a notice');
 }catch(e){console.error(e);app.exitCode=1}finally{w.destroy();app.exit(app.exitCode||0)}}).catch(e=>{console.error(e);app.exit(1)});
 `)
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const bin=process.platform==='win32'?join(here,'../../node_modules/electron/dist/electron.exe'):process.platform==='darwin'?join(here,'../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'):join(here,'../../node_modules/electron/dist/electron')
 const code=await new Promise((resolve,reject)=>{const c=spawn(bin,[join(out,'runner.cjs')],{stdio:'inherit',env});const t=setTimeout(()=>{c.kill('SIGTERM');reject(Error('Source replace fixture timed out'))},60000);c.on('error',reject);c.on('exit',code=>{clearTimeout(t);resolve(code)})});if(code!==0)process.exitCode=1
}finally{rmSync(out,{recursive:true,force:true})}
