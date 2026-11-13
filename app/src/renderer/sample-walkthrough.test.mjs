import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const chrome = [
  process.env.HUMANSTUDY_TEST_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(path => path && existsSync(path))

test('sample guide opens the real source and participant preview without sending or running', { skip: !chrome && 'Chrome unavailable' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-sample-guide-'))
  try {
    await build({
      stdin: {
        contents: `
          import React, {useState,useRef} from 'react'
          import {appendChatDraft} from './chat-draft'
          import {createRoot} from 'react-dom/client'
          import {SampleOnboarding,walkthroughSample} from './components/SampleOnboarding'
          import {Workbench} from './components/Workbench'
          import program from '../../resources/protocol-sample/program.json'
          import protocol from '../../resources/protocol-sample/protocol.json?raw'
          import preview from '../../resources/protocol-sample/artifacts/preview.html?raw'
          import './styles.css'
          let calls=[]
          window.humanstudy={project:{readText:async path=>path.endsWith('protocol.json')?protocol:path.endsWith('preview.html')?preview:Promise.reject(Error('No annotations'))}}
          const entry=(rel,ext)=>({name:rel.split('/').pop(),rel,path:'/sample/'+rel,ext,type:'file',url:'/'+rel,size:1,mtime:1})
          const pdf=entry('paper.pdf','pdf');const project={dir:'/sample',name:'Renamed sample',program,pdf,tree:[entry('protocol.json','json'),entry('artifacts/preview.html','html'),pdf],artifacts:[],exports:[]}
          function Fixture(){
            const workbench=useRef(null);const [activeProject,setActiveProject]=useState(project);const [visible,setVisible]=useState(true),[draft,setDraft]=useState('My unsent research question'),[source,setSource]=useState(null)
            return <><button onClick={()=>setVisible(true)}>Sample guide</button>
              {visible&&<SampleOnboarding onClose={()=>setVisible(false)} onAction={action=>{
                calls.push(action)
                if(action==='overview')workbench.current.showTab('study')
                if(action==='source'){const evidence=program.evidence.find(e=>e.locator.page&&e.quote);workbench.current.compareSource({page:evidence.locator.page,quote:evidence.quote,file:evidence.path})}
                if(action==='participant')workbench.current.showParticipantPreview()
                if(action==='trial')setDraft(current=>appendChatDraft(current,'Review a small trial before sending'))
              }}/>}
              <button onClick={()=>setActiveProject({...project,dir:'/other',name:'Unrelated project'})}>Other project</button>
              <Workbench ref={workbench} project={activeProject} source={source} selectedIds={[]} onSource={(id,ref)=>setSource(ref)} onPick={()=>{}} onAsk={()=>{}} onClearSelection={()=>{}} onAskSelection={()=>{}} onFold={()=>{}}/>
              <textarea aria-label="Chat draft" value={draft} onChange={e=>setDraft(e.target.value)}/>
            </>
          }
          function check(value,message){if(!value)throw Error(message)}
          async function until(fn,message){for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,10))}throw Error(message)}
          function button(label){return [...document.querySelectorAll('button')].find(x=>x.textContent.trim()===label)}
          async function run(){
            check(walkthroughSample({...program,title:'Renamed paper'}),'Renaming must not hide sample guide');
            check(!walkthroughSample({...program,id:'different-paper'}),'Non-sample must not get sample guide');
            check(!walkthroughSample(null),'Empty project must not get sample guide');
            check(appendChatDraft('!echo safe','trial')==='!echo safe','Shell draft must stay untouched');
            check(appendChatDraft('/compact','trial')==='/compact','Command draft must stay untouched');
            createRoot(document.getElementById('root')).render(<Fixture/>);
            await until(()=>button('Show the overview'),'Guide not visible');
            check(!document.querySelector('[aria-modal="true"]'),'Guide blocks workspace');
            await until(()=>document.querySelector('.research-overview'),'Actual research overview missing');
            button('Show the overview').click();await until(()=>button('Compare with the source'),'Step two missing');
            button('Compare with the source').click();await until(()=>document.querySelector('.wb-paper:not([hidden])'),'Real Workbench source pane not shown');
            check(document.querySelector('.wb-paper:not([hidden])'),'Source comparison invisible');
            button('Explore participant view').click();await until(()=>document.querySelector('.research-preview[open] iframe'),'Real preview not opened');
            check(document.querySelector('textarea').value==='My unsent research question','Existing draft changed before trial action');
            button('Draft a trial request').click();await until(()=>button('Finish guide'),'Completion missing');
            check(document.querySelector('textarea').value==='My unsent research question\\n\\nReview a small trial before sending','Existing draft was overwritten');
            check(document.activeElement===button('Finish guide'),'Keyboard focus lost at final step');
            check(calls.join(',')==='overview,source,participant,trial','Unexpected action');
            check(document.documentElement.scrollWidth<=innerWidth,'Narrow page overflows');
            button('Finish guide').click();await until(()=>!document.querySelector('.sample-onboarding'),'Finish did not close');
            button('Sample guide').click();await until(()=>button('Show the overview'),'Replay did not reset');
            window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await until(()=>!document.querySelector('.sample-onboarding'),'Escape did not skip');
            check(calls.length===4,'Skipping or replay caused actions');
            button('Other project').click();await new Promise(r=>setTimeout(r,100));
            check(!document.querySelector('.research-preview[open]'),'Preview opened automatically in another project');
            return 'GUIDE_OK'
          }
          run().then(result=>fetch('/result',{method:'POST',body:result}),error=>fetch('/result',{method:'POST',body:error.stack}));
        `,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader:'tsx',
      },
      bundle:true,platform:'browser',jsx:'automatic',logLevel:'error',
      plugins:[{name:'raw',setup(build){
        build.onResolve({filter:/[?]url$/},()=>({path:'worker',namespace:'worker'}));
        build.onLoad({filter:/.*/,namespace:'worker'},()=>({contents:'export default "/pdf.worker.mjs"'}));
        build.onResolve({filter:/[?]raw$/},args=>({path:join(args.resolveDir,args.path.slice(0,-4)),namespace:'raw'}));
        build.onLoad({filter:/.*/,namespace:'raw'},async args=>({contents:await readFile(args.path,'utf8'),loader:'text'}));
      }}],
      loader:{'.css':'css','.woff2':'empty','.svg':'empty'},outfile:join(dir,'guide.js'),
    })
    const script = await readFile(join(dir, 'guide.js'))
    const stylesheet = await readFile(join(dir, 'guide.css'))
    let reportResult
    let failTest
    const result = new Promise((resolve, reject) => {
      reportResult = resolve
      failTest = reject
    })
    const server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/result') {
        let message = ''
        request.setEncoding('utf8')
        request.on('data', chunk => { message += chunk })
        request.on('end', () => {
          response.writeHead(204).end()
          reportResult(message)
        })
      } else if (request.url === '/paper.pdf') {
        readFile(fileURLToPath(new URL('../../resources/protocol-sample/paper.pdf', import.meta.url))).then(data => response.writeHead(200, { 'Content-Type':'application/pdf' }).end(data))
      } else if (request.url === '/pdf.worker.mjs') {
        readFile(fileURLToPath(new URL('../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url))).then(data => response.writeHead(200, { 'Content-Type':'text/javascript' }).end(data))
      } else if (request.url === '/artifacts/preview.html') {
        readFile(fileURLToPath(new URL('../../resources/protocol-sample/artifacts/preview.html', import.meta.url))).then(html => response.writeHead(200, { 'Content-Type': 'text/html' }).end(html))
      } else if (request.url === '/guide.css') {
        response.writeHead(200, { 'Content-Type': 'text/css' }).end(stylesheet)
      } else if (request.url === '/guide.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(script)
      } else {
        response.writeHead(200, { 'Content-Type': 'text/html' }).end(
          '<!doctype html><title>GUIDE_PENDING</title><link rel="stylesheet" href="/guide.css"><div id="root"></div><script>window.__HS_WEB__ = true; window.onerror = (msg, file, line, column, error) => fetch("/result", {method: "POST", body: error?.stack || String(msg)}); window.onunhandledrejection = (e) => fetch("/result", {method: "POST", body: String(e.reason)})</script><script src="/guide.js"></script>')
      }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const browser = spawn(chrome, [
      '--headless', '--window-size=700,900', '--disable-gpu', '--no-first-run', '--disable-dev-shm-usage', '--disable-background-networking',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      `--user-data-dir=${join(dir, 'chrome')}`, `http://127.0.0.1:${server.address().port}/`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let diagnostics = ''
    browser.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000) })
    const timeout = setTimeout(() => failTest(new Error('Browser did not complete the guide test: ' + diagnostics)), 60_000)
    browser.on('error', failTest)
    browser.on('exit', code => failTest(new Error(`Chrome exited early (${code})`)))
    try {
      assert.equal(await result, 'GUIDE_OK')
    } finally {
      clearTimeout(timeout)
      browser.kill('SIGKILL')
      browser.stderr.destroy()
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
