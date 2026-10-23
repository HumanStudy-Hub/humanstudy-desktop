#!/usr/bin/env node
// A thin client of the desktop's real kernel, not a second OpenCode implementation.
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { controlAssets, packPath } from './asset-control.mjs'
import { openResearchAccount } from './research-auth.mjs'

const exec=promisify(execFile),here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../..')
const {values:o}=parseArgs({options:{project:{type:'string'},binary:{type:'string'},'runtime-bin':{type:'string'},provider:{type:'string',default:'humanstudy'},model:{type:'string'},auto:{type:'string',default:'on'},session:{type:'string'},'timeout-minutes':{type:'string',default:'30'},'stall-minutes':{type:'string',default:'5'},'research-auth':{type:'string'},doctor:{type:'boolean'},help:{type:'boolean'}}})
if(o.help){console.log('node app/scripts/opencode-assets.mjs --project <prepared project> --binary <HumanStudy opencode> --runtime-bin <managed runtime/bin> --research-auth <private-profile> [--provider humanstudy|openrouter] [--model <id>] [--auto on|off] [--session <id>] [--doctor]\nJSON-lines stdin: build, send, permission, answer, reject-question, questions, native, auto, abort, quit. See the Codex skill.');process.exit(0)}
let lock, ownsLock=false, ownedKernel, bridge, interrupted=false, research, researchAgent, captureArtifacts
const stopOwned=()=>{interrupted=true;void (bridge?bridge.stop('interrupted'):ownedKernel?.dispose())}
try{
  if(!o['research-auth'])throw Error('Supply --research-auth with your own private account profile. Read docs/headless-research.md; another person’s desktop key is not a research identity.')
  const account=await openResearchAccount(resolve(o['research-auth']))
  if(account.desktopKey)process.env.HUMANSTUDY_DESKTOP_KEY=account.desktopKey
  else if(o.provider==='humanstudy')throw Error('Your research profile has no hosted model access. Sign in with your own invitation code.')
  process.env.HUMANSTUDY_HOSTED_BASEURL=account.server+'/api/desktop/v1'
  if(!o.project||!o.binary||!o['runtime-bin'])throw Error('Supply --project, --binary and --runtime-bin. No app credentials or personal config are discovered automatically.')
  if(!['on','off'].includes(o.auto))throw Error('--auto must be on or off.')
  const timeout=Number(o['timeout-minutes']),stall=Number(o['stall-minutes'])
  if(!Number.isFinite(timeout)||!Number.isFinite(stall)||timeout<=0||stall<=0)throw Error('Timeouts must be positive numbers of minutes.')
  const project=realpathSync(resolve(o.project)),binary=realpathSync(resolve(o.binary)),runtime=realpathSync(resolve(o['runtime-bin']))
  const authPath=realpathSync(resolve(o['research-auth'])),authDistance=relative(project,authPath)
  if(!authDistance.startsWith('..')&&!isAbsolute(authDistance))throw Error('Keep the private research account profile outside the project and source bundle.')
  const manifest=JSON.parse(readFileSync(join(project,'.humanstudy/conversion-pack.json'),'utf8'))
  if(manifest.engine!=='opencode')throw Error('Prepare this project with --engine opencode; direct-agent instructions are not the desktop worker contract.')
  for(const [stored,hash] of Object.entries(manifest.files)){
    const {rel,original}=packPath(stored)
    const actual=realpathSync(join(project,rel))
    const distance=relative(project,actual)
    if(distance.startsWith('..')||isAbsolute(distance)||createHash('sha256').update(readFileSync(actual)).digest('hex')!==hash||!readFileSync(actual).equals(readFileSync(join(repo,'pack',original))))throw Error('The prepared pack differs from this desktop checkout. Prepare a fresh project instead of silently changing the contract.')
  }
  if(!readFileSync(join(project,'AGENTS.md')).equals(readFileSync(join(repo,'pack/AGENTS.md'))))throw Error('Worker AGENTS.md differs from the desktop pack.')
  for(const name of ['python','python3','hs-pdf'])if(!existsSync(join(runtime,name))&&!existsSync(join(runtime,name+'.cmd')))throw Error(`Managed runtime is missing ${name}.`)
  const cache=join(project,'.humanstudy/asset-agent');mkdirSync(cache,{recursive:true})
  const compiled=join(cache,'desktop-kernel.mjs')
  await build({stdin:{contents:"export {createResearchAgent} from '../src/main/research-agent.ts'; export {createResearchCollector} from '../src/main/research-collector.ts'; export {OpencodeKernel,DEFAULT_MODEL} from '../src/main/kernel/opencode.ts'; export {KERNEL_VERSION} from '../src/main/opencode-install-core.ts'; export {runtimeVersion,runtimePaths} from '../src/main/runtime-core.ts'; export {programCertificate} from '../src/main/paper-build.ts';",resolveDir:here,loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node20',outfile:compiled,logLevel:'error'})
  const {createResearchAgent,createResearchCollector,OpencodeKernel,DEFAULT_MODEL,KERNEL_VERSION,runtimeVersion:versionForLock,runtimePaths,programCertificate}=await import(pathToFileURL(compiled).href)
  // Read the same version constants and runtime marker used by desktop.
  const version=(await exec(binary,['--version'],{timeout:15_000})).stdout.trim()
  if(!version.includes('opencode-humanstudy')||!version.split(/\s+/).includes(KERNEL_VERSION))throw Error(`Expected the desktop HumanStudy OpenCode ${KERNEL_VERSION}; got ${version}.`)
  const runtimeMarker=readFileSync(join(runtime,'../.ok'),'utf8').trim()
  const runtimeVersion=versionForLock(readFileSync(join(repo,'pack/runtime/requirements.lock'),'utf8'))
  if(runtimeMarker!==runtimeVersion)throw Error('Managed runtime version differs from this desktop checkout. Use app/scripts/install-runtime.mjs.')
  await exec(runtimePaths(dirname(runtime),process.platform).python,['-E','-s','-c','import jsonschema, pypdf, hs_pdf_tools; print("conversion-runtime-ok")'],{timeout:30_000})
  if(o.provider==='openrouter'&&!(process.env.HUMANSTUDY_DEV_KEYS==='1'&&process.env.OPENROUTER_API_KEY))throw Error('Own OpenRouter access requires HUMANSTUDY_DEV_KEYS=1 and OPENROUTER_API_KEY in the environment.')
  if(o.provider==='humanstudy'&&!process.env.HUMANSTUDY_DESKTOP_KEY)throw Error('HumanStudy hosted access requires an explicitly supplied authorized HUMANSTUDY_DESKTOP_KEY. Do not copy another user\'s key.')
  const provenance={researchOwner:account.userId,researchConsentVersion:3,kernelVersion:version,runtimeVersion,model:o.model??DEFAULT_MODEL,provider:o.provider,packFiles:Object.keys(manifest.files).length}
  if(o.doctor){console.log(JSON.stringify({status:'ready',...provenance},null,2));process.exit(0)}
  lock=join(cache,'running.lock');writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n',{flag:'wx'});ownsLock=true
  research=createResearchCollector({root:join(cache,'research-data'),surface:'headless',appVersion:'headless/1.0.0',auth:account.auth,ownerId:()=>account.userId,allowed:account.allowed})
  const identityFile=join(cache,'research-project.json')
  const projectId=existsSync(identityFile)?JSON.parse(readFileSync(identityFile,'utf8')).id:randomUUID()
  writeFileSync(identityFile,JSON.stringify({id:projectId}),{mode:0o600})
  const inside=file=>{const distance=relative(project,realpathSync(file));return !distance.startsWith('..')&&!isAbsolute(distance)}
  async function collect(dir){if(!inside(dir))return;for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;const file=join(dir,entry.name);if(entry.isDirectory())await collect(file);else if(entry.isFile())await research.queueSource(file,projectId,file.toLowerCase().endsWith('.pdf')?'application/pdf':'application/octet-stream')}}
  if(existsSync(join(project,'paper.pdf'))&&inside(join(project,'paper.pdf')))await research.queueSource(join(project,'paper.pdf'),projectId,'application/pdf')
  if(existsSync(join(project,'sources')))await collect(join(project,'sources'))
  researchAgent=createResearchAgent((event,context)=>research.capture(event,context))
  let artifactChain=Promise.resolve()
  captureArtifacts=()=>{
    artifactChain=artifactChain.then(async()=>{
      if(existsSync(join(project,'program.json'))&&inside(join(project,'program.json')))await research.queueArtifact(join(project,'program.json'),projectId,'program.json','agent-or-external')
      async function walk(rel){if(!inside(join(project,rel)))return;for(const entry of readdirSync(join(project,rel),{withFileTypes:true})){if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;const child=rel+'/'+entry.name;if(entry.isDirectory())await walk(child);else if(entry.isFile())await research.queueArtifact(join(project,child),projectId,child,'agent-or-external')}}
      for(const rel of ['artifacts','package','exports'])if(existsSync(join(project,rel)))await walk(rel)
    }).catch(()=>{})
    return artifactChain
  }
  await captureArtifacts()
  void research.flush()
  process.env.HUMANSTUDY_RUNTIME_BIN=runtime
  const kernel=ownedKernel=new OpencodeKernel({binary,home:join(cache,'kernel-home'),provider:o.provider,model:o.model??DEFAULT_MODEL,permission:o.auto==='on'?'project':'ask'})
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stopOwned)
  const logDir=join(cache,'runs',new Date().toISOString().replace(/[:.]/g,'-'))
  mkdirSync(logDir,{recursive:true});writeFileSync(join(logDir,'provenance.json'),JSON.stringify(provenance,null,2)+'\n')
  // Same completion rule as desktop: schema plus minimum per-study coverage of the exact program bytes.
  // An idle turn or a tool's PASS text alone never certifies the asset; this is not scientific validation.
  const certify=sessionId=>{
    const c=programCertificate(project)
    const completion={type:'completion',sessionId,at:new Date().toISOString(),status:c===null?'unreadable':c.problems.length?'incomplete':'complete',programSha256:c?.hash??null,problems:c?.problems??['program.json is missing, unreadable or schema-invalid.']}
    writeFileSync(join(logDir,'completion.json'),JSON.stringify(completion,null,2)+'\n')
    process.stdout.write(JSON.stringify(completion)+'\n')
  }
  bridge=await controlAssets({kernel,project,session:o.session,input:process.stdin,output:process.stdout,logDir,timeoutMs:timeout*60_000,stallMs:stall*60_000,onOperation:(sid,request)=>{if(!['build','send'].includes(request.op))void research.capture({event_type:'action.invoke',thread_id:sid,project_id:projectId,view:'headless',target:String(request.op),metadata:{via:'system',command:JSON.stringify(request)}}).catch(()=>{})},onSession:sid=>researchAgent.bind(sid,projectId,project,o.model??DEFAULT_MODEL),onEvent:event=>{researchAgent.event(event);if(event.type==='done'){certify(event.sessionId);void captureArtifacts()}},onRequest:(sid,request)=>{if(request.op==='abort')researchAgent.abort(sid);else researchAgent.start(sid,request.text)}})
  if(interrupted)await bridge.stop('interrupted')
  const result=await bridge.exited
  if(!['closed'].includes(result))process.exitCode=2
}catch(error){console.error(JSON.stringify({type:'fatal',error:String(error.message??error)}));process.exitCode=1}
finally{await ownedKernel?.dispose();if(captureArtifacts)await captureArtifacts();if(researchAgent)await researchAgent.close();if(research){await research.end('worker-exit');await research.flush();const pending=await research.pending();if(pending||research.error())console.error(JSON.stringify({type:'research_delivery_pending',pending,error:research.error()??null}));}for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,stopOwned);if(ownsLock&&existsSync(lock))unlinkSync(lock)}
