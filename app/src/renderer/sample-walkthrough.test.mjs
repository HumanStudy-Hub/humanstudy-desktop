import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
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

if (process.env.HUMANSTUDY_REQUIRE_CHROME === '1') assert.ok(chrome, 'Chrome required for guide acceptance')

test('sample guide opens the real source and participant preview without sending or running', { skip: !chrome && 'Chrome unavailable' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-sample-guide-'))
  let testError
  try {
    await build({
      stdin: {
        contents: `
          import React, {useState,useRef} from 'react'
          import {appendChatDraft} from './chat-draft'
          import {createRoot} from 'react-dom/client'
          import {SampleOnboarding,walkthroughSample} from './components/SampleOnboarding'
          import {Workbench} from './components/Workbench'
          import {Chat} from './components/Chat'
          import program from '../../resources/protocol-sample/program.json'
          import protocol from '../../resources/protocol-sample/protocol.json?raw'
          import preview from '../../resources/protocol-sample/artifacts/preview.html?raw'
          import './styles.css'
          let calls=[]
          window.humanstudy={app:{info:async()=>({})},project:{readText:async path=>path.endsWith('protocol.json')?protocol:path.endsWith('preview.html')?preview:Promise.reject(Error('No annotations'))}}
          const entry=(rel,ext)=>({name:rel.split('/').pop(),rel,path:'/sample/'+rel,ext,type:'file',url:'/'+rel,size:1,mtime:1})
          const pdf=entry('paper.pdf','pdf');const project={dir:'/sample',name:'Renamed sample',program,pdf,tree:[entry('protocol.json','json'),entry('artifacts/preview.html','html'),pdf],artifacts:[],exports:[]}
          function Fixture(){
            const workbench=useRef(null);const [activeProject,setActiveProject]=useState(project);const [visible,setVisible]=useState(true),[draft,setDraft]=useState('My unsent research question'),[source,setSource]=useState(null)
            return <><button onClick={()=>setVisible(true)}>Sample guide</button>
              {visible&&<SampleOnboarding agentReady={true} onClose={()=>setVisible(false)} onAction={action=>{
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
          const blockedCalls=[]
          function LockedFixture(){
            const [open,setOpen]=useState(false)
            const noop=()=>{}
            const forbidden=()=>{blockedCalls.push('forbidden')}
            return <><SampleOnboarding agentReady={false} onClose={noop} onAction={action=>{blockedCalls.push(action);if(action==='setup')setOpen(true)}}/>
              {open&&<Chat session={{id:null,messages:[],queue:[],pendingPermissions:[],usage:{input:0,output:0},native:forbidden,send:forbidden}} selected={[]} onClearSelection={noop} account={{signedIn:true,modelAccess:'hosted'}} onSettings={noop} agreement="needed" onReview={forbidden} projectDir="/sample" tree={[]} model="" auto={true} onAuto={forbidden} onModel={noop} busyEnter="queue" kernel={{status:null,retry:noop}} onOpenStudy={noop} onOpenFile={noop}/>}
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
            const root=createRoot(document.getElementById('root'));root.render(<Fixture/>);
            await until(()=>button('Show the overview'),'Guide not visible');
            check(!document.querySelector('[aria-modal="true"]'),'Guide blocks workspace');
            await until(()=>document.querySelector('.sample-guide-spotlight'),'Spotlight missing');
            check(getComputedStyle(document.querySelector('.sample-guide-spotlight')).boxShadow.includes('9999px'),'Background is not dimmed');
            check(getComputedStyle(document.querySelector('.sample-guide-layer')).pointerEvents==='none','Spotlight blocks real controls');
            const coach=document.querySelector('.sample-onboarding').getBoundingClientRect();
            check(coach.left>=0&&coach.right<=innerWidth&&coach.bottom<=innerHeight,'Coach card outside viewport');
            await until(()=>document.querySelector('.research-overview'),'Actual research overview missing');
            button('Show the overview').click();await until(()=>button('Compare with the source'),'Step two missing');
            await until(()=>document.querySelector('.research-cite')?.getBoundingClientRect().top>0,'Citation not revealed');
            await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
            const cite=document.querySelector('.research-cite'), citeRect=cite.getBoundingClientRect();
            check(cite.contains(document.elementFromPoint(citeRect.left+citeRect.width/2,citeRect.top+citeRect.height/2)),'Guide covers citation control');
            cite.click();await until(()=>button('Explore participant view'),'Actual source click did not advance');await until(()=>document.querySelector('.wb-paper:not([hidden])'),'Real Workbench source pane not shown');
            check(document.querySelector('.wb-paper:not([hidden])'),'Source comparison invisible');
            button('Explore participant view').click();await until(()=>document.querySelector('.research-preview[open] iframe'),'Real preview not opened');
            check(document.querySelector('textarea').value==='My unsent research question','Existing draft changed before trial action');
            button('Draft a trial request').click();await until(()=>button('Finish guide'),'Completion missing');
            check(document.querySelector('textarea').value==='My unsent research question\\n\\nReview a small trial before sending','Existing draft was overwritten');
            check(document.activeElement===button('Finish guide'),'Keyboard focus lost at final step');
            check(calls.join(',')==='overview,participant,trial','Unexpected action');
            check(document.documentElement.scrollWidth<=innerWidth,'Narrow page overflows');
            button('Finish guide').click();await until(()=>!document.querySelector('.sample-onboarding'),'Finish did not close');
            check(!document.querySelector('.sample-guide-layer'),'Spotlight leaked after close');
            check(!document.querySelector('[aria-describedby*="sample-guide-description"]'),'Target description leaked');
            button('Sample guide').focus();button('Sample guide').click();await until(()=>button('Show the overview'),'Replay did not reset');
            check(document.activeElement===button('Show the overview'),'Guide has no keyboard entry');
            window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));await until(()=>!document.querySelector('.sample-onboarding'),'Escape did not skip');
            check(calls.length===3,'Skipping or replay caused actions');
            check(document.activeElement===button('Sample guide'),'Skip did not restore focus');
            button('Other project').click();await new Promise(r=>setTimeout(r,100));
            check(!document.querySelector('.research-preview[open]'),'Preview opened automatically in another project');
            root.render(<LockedFixture/>);await until(()=>button('Show the overview'),'Blocked guide missing');
            button('Show the overview').click();await until(()=>button('Compare with the source'),'Blocked step2');
            button('Compare with the source').click();await until(()=>button('Explore participant view'),'Blocked step3');
            button('Explore participant view').click();await until(()=>button('See agent setup'),'Setup action not substituted');
            check(!button('Draft a trial request'),'Unavailable draft action shown');
            button('See agent setup').click();await until(()=>document.querySelector('.agreement-lock'),'Actual Chat agreement gate not opened');
            check(!document.querySelector('textarea'),'Locked Chat rendered composer');
            check(document.querySelector('.sample-guide-copy').textContent.includes('No request was drafted or sent'),'Blocked completion misleading');
            check(blockedCalls.join(',')==='overview,source,participant,setup','Blocked guide drafted, sent, or accepted consent');
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
    let nativeMac = false
    try { nativeMac = process.platform === 'darwin' && !process.env.HUMANSTUDY_TEST_CHROME && execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1' } catch {}
    const browser = spawn(nativeMac ? '/usr/bin/arch' : chrome, [
      ...(nativeMac ? ['-arm64', chrome] : []),
      '--headless', '--window-size=' + (process.env.HUMANSTUDY_TEST_VIEWPORT || '700,900'), '--disable-gpu', '--no-first-run', '--disable-dev-shm-usage', '--disable-background-networking',
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      `--user-data-dir=${join(dir, 'chrome')}`, `http://127.0.0.1:${server.address().port}/`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    // Register before teardown so a fast exit cannot race the waiter.
    const browserClosed = new Promise(resolve => browser.once('close', resolve))
    let diagnostics = ''
    browser.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000) })
    const timeout = setTimeout(() => failTest(new Error('Browser did not complete the guide test: ' + diagnostics)), 60_000)
    browser.on('error', failTest)
    browser.on('exit', code => failTest(new Error(`Chrome exited early (${code})`)))
    try {
      assert.equal(await result, 'GUIDE_OK')
    } catch (error) {
      testError = error
      throw error
    } finally {
      clearTimeout(timeout)
      if (browser.exitCode === null && browser.signalCode === null) browser.kill('SIGTERM')
      let shutdownTimer
      try {
        await Promise.race([browserClosed, new Promise((_, reject) => {
          shutdownTimer = setTimeout(() => reject(new Error('Test Chrome did not close within 10 seconds')), 10_000)
        })])
      } catch (error) {
        if (testError) throw new AggregateError([testError, error], 'Guide assertion failed and Chrome teardown also failed')
        throw error
      } finally {
        clearTimeout(shutdownTimer)
        browser.stderr.destroy()
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }
    }
  } catch (error) {
    testError = error
    throw error
  } finally {
    try {
      // Chromium helpers can briefly finish profile writes after the parent exits.
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    } catch (error) {
      if (testError) throw new AggregateError([testError, error], 'Guide test failed and temporary-profile cleanup also failed')
      throw error
    }
  }
})
