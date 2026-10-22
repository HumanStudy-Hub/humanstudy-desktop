// Acceptance harness: executes the packaged main/preload/renderer bytes with isolated userData.
// Supply a private synthetic-account fixture, never a real user's profile. The model is a mock;
// Auth, Storage and research-event delivery are real. This is not a real-model or installed-app test.
const {app,BrowserWindow,ipcMain,safeStorage,dialog}=require('electron')
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'hs-research-bundle-'))
const repo=path.resolve(__dirname,'../..'),profile=process.env.HSH_ACCEPTANCE_PROFILE,bundle=process.env.HSH_ACCEPTANCE_BUNDLE
if(!profile||!bundle)throw Error('Set HSH_ACCEPTANCE_PROFILE and HSH_ACCEPTANCE_BUNDLE explicitly.')
const fixture=JSON.parse(fs.readFileSync(profile,'utf8')),auth=fixture.users[0].auth
const asar=path.join(bundle,'Contents/Resources/app.asar')
const claims=JSON.parse(Buffer.from(auth.accessToken.split('.')[1],'base64url'))
if(!claims.email?.endsWith('@acceptance.humanstudy.invalid'))throw Error('Only synthetic acceptance accounts are allowed.')
app.setPath('userData',root)
fs.writeFileSync(path.join(root,'settings.json'),JSON.stringify({projectsRoot:path.join(root,'projects'),notifications:false,language:'en'}))
process.env.HUMANSTUDY_KERNEL='mock'
const handles=new Map(),original=ipcMain.handle.bind(ipcMain)
ipcMain.handle=(channel,fn)=>{handles.set(channel,fn);return original(channel,fn)}
const invoke=(name,...args)=>handles.get(name)({sender:BrowserWindow.getAllWindows()[0]?.webContents},...args),sleep=ms=>new Promise(r=>setTimeout(r,ms))
const until=async(fn,label)=>{for(let i=0;i<100;i++){const value=await fn();if(value)return value;await sleep(150)}throw Error('Timeout: '+label)}
dialog.showSaveDialog=async()=>({canceled:false,filePath:path.join(root,'research-export.zip')})
dialog.showMessageBox=async()=>({response:0})
const timer=setTimeout(()=>{console.error('Bundle acceptance timed out');app.exit(2)},90000)
app.whenReady().then(async()=>{
 if(!safeStorage.isEncryptionAvailable())throw Error('OS encryption unavailable; cannot inject an encrypted synthetic session.')
 const session={accessToken:auth.accessToken,refreshToken:'synthetic-no-refresh',expiresAt:claims.exp*1000,email:claims.email}
 fs.writeFileSync(path.join(root,'account.json'),JSON.stringify({session:safeStorage.encryptString(JSON.stringify(session)).toString('base64'),
  config:{supabaseUrl:auth.supabaseUrl,supabaseKey:auth.supabaseKey,models:['test-model'],defaultModel:'test-model'}}),{mode:0o600})
 await until(()=>handles.has('telemetry:setConsent'),'IPC registration')
 await invoke('telemetry:setConsent',{usage:true,content:true})
 const dir=await invoke('projects:create',{name:'Collection acceptance',pdfPath:path.join(repo,'app/resources/sample/KNOBE.pdf')})
 const program=fs.readFileSync(path.join(repo,'app/src/shared/fixtures/knobe-e2e.json'),'utf8')
 fs.writeFileSync(path.join(dir,'program.json'),program)
 fs.writeFileSync(path.join(dir,'.humanstudy/paper-build.json'),JSON.stringify({status:'complete',phase:'checking'}))
 const win=await until(()=>BrowserWindow.getAllWindows()[0],'application window')
 await until(()=>win.webContents.executeJavaScript('Boolean(window.humanstudy)'), 'packaged preload')
 const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));win.webContents.reload();await loaded
 await until(()=>win.webContents.executeJavaScript(`(()=>{const b=[...document.querySelectorAll('button.project-row')].find(b=>b.textContent.includes('Collection acceptance'));if(b){b.click();return true}return false})()`),'project directory UI')
 await until(()=>win.webContents.executeJavaScript(`Boolean(document.querySelector('.wb-compare'))`),'study workspace UI')
 await win.webContents.executeJavaScript(`document.querySelector('.wb-compare').click()`)
 await until(()=>win.webContents.executeJavaScript(`document.querySelectorAll('.pdf-page canvas').length>0`),'paper comparison UI')
 await invoke('project:read',dir)
 const projectId=await invoke('telemetry:projectId',dir)
 await invoke('telemetry:track','tab.switch',{target:'study',projectId,durationMs:1200})
 const thread=await invoke('threads:create',dir)
 await invoke('kernel:send',thread.kernelSessionId,'Synthetic acceptance: preserve this complete conversation and tool event.')
 await until(async()=>{const t=await invoke('threads:get',dir,thread.id);return t.messages.some(m=>m.parts.some(p=>p.kind==='text'&&p.text.includes('built-in mock agent')))},'completed mock conversation')
 await sleep(1500)
 const status=await invoke('telemetry:flush')
 assert.equal(status.sourcePending,0,status.sourceError)
 assert.equal(status.sourceError,undefined)
 const request=async p=>{const r=await fetch(auth.supabaseUrl+p,{headers:{apikey:auth.supabaseKey,Authorization:'Bearer '+auth.accessToken}});assert.ok(r.ok,'live research read failed: '+r.status);return r.json()}
 const rows=await request('/rest/v1/research_events?project_id=eq.'+projectId+'&select=*')
 for(const type of ['source.import','program.version','conversation.message','tool.start','tool.end','agent.usage'])assert.ok(rows.some(r=>r.event_type===type),'missing '+type)
 assert.ok(rows.some(r=>r.event_type==='view.dwell'||r.event_type==='action.invoke'))
 await invoke('telemetry:exportMyData')
 assert.ok(fs.statSync(path.join(root,'research-export.zip')).size>0)
 await win.webContents.capturePage().then(image=>fs.writeFileSync(path.join(root,'renderer.png'),image.toPNG()))
 const evidence={root,projectId,model:'mock',packagedBytes:true,installedApp:false,realDatabase:true,workspaceAndPaperUI:true,sourceAndProgram:true,chatAndTools:true,export:true,events:rows.length,
  asarSha256:crypto.createHash('sha256').update(require('original-fs').readFileSync(asar)).digest('hex')}
 fs.writeFileSync(path.join(root,'evidence.json'),JSON.stringify(evidence,null,2))
 console.log(JSON.stringify(evidence));clearTimeout(timer);app.exit(0)
}).catch(error=>{console.error(error.stack);clearTimeout(timer);app.exit(1)})

require(path.join(asar,'out/main/index.js'))
