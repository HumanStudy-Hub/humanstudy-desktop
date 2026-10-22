#!/usr/bin/env node
// A thin client of the desktop's real kernel, not a second OpenCode implementation.
import { build } from 'esbuild'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { controlAssets, packPath } from './asset-control.mjs'

const exec=promisify(execFile),here=dirname(fileURLToPath(import.meta.url)),repo=resolve(here,'../..')
const {values:o}=parseArgs({options:{project:{type:'string'},binary:{type:'string'},'runtime-bin':{type:'string'},provider:{type:'string',default:'humanstudy'},model:{type:'string'},auto:{type:'string',default:'on'},session:{type:'string'},'timeout-minutes':{type:'string',default:'30'},'stall-minutes':{type:'string',default:'5'},doctor:{type:'boolean'},help:{type:'boolean'}}})
if(o.help){console.log('node app/scripts/opencode-assets.mjs --project <prepared project> --binary <HumanStudy opencode> --runtime-bin <managed runtime/bin> [--provider humanstudy|openrouter] [--model <id>] [--auto on|off] [--session <id>] [--doctor]\nJSON-lines stdin: build, send, permission, answer, reject-question, questions, native, auto, abort, quit. See the Codex skill.');process.exit(0)}
let lock, ownsLock=false, ownedKernel, bridge, interrupted=false
const stopOwned=()=>{interrupted=true;void (bridge?bridge.stop('interrupted'):ownedKernel?.dispose())}
try{
  if(!o.project||!o.binary||!o['runtime-bin'])throw Error('Supply --project, --binary and --runtime-bin. No app credentials or personal config are discovered automatically.')
  if(!['on','off'].includes(o.auto))throw Error('--auto must be on or off.')
  const timeout=Number(o['timeout-minutes']),stall=Number(o['stall-minutes'])
  if(!Number.isFinite(timeout)||!Number.isFinite(stall)||timeout<=0||stall<=0)throw Error('Timeouts must be positive numbers of minutes.')
  const project=realpathSync(resolve(o.project)),binary=realpathSync(resolve(o.binary)),runtime=realpathSync(resolve(o['runtime-bin']))
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
  await build({stdin:{contents:"export {OpencodeKernel,DEFAULT_MODEL} from '../src/main/kernel/opencode.ts'; export {KERNEL_VERSION} from '../src/main/opencode-install-core.ts'; export {runtimeVersion,runtimePaths} from '../src/main/runtime-core.ts';",resolveDir:here,loader:'ts'},bundle:true,platform:'node',format:'esm',target:'node20',outfile:compiled,logLevel:'error'})
  const {OpencodeKernel,DEFAULT_MODEL,KERNEL_VERSION,runtimeVersion:versionForLock,runtimePaths}=await import(pathToFileURL(compiled).href)
  // Read the same version constants and runtime marker used by desktop.
  const version=(await exec(binary,['--version'],{timeout:15_000})).stdout.trim()
  if(!version.includes('opencode-humanstudy')||!version.split(/\s+/).includes(KERNEL_VERSION))throw Error(`Expected the desktop HumanStudy OpenCode ${KERNEL_VERSION}; got ${version}.`)
  const runtimeMarker=readFileSync(join(runtime,'../.ok'),'utf8').trim()
  const runtimeVersion=versionForLock(readFileSync(join(repo,'pack/runtime/requirements.lock'),'utf8'))
  if(runtimeMarker!==runtimeVersion)throw Error('Managed runtime version differs from this desktop checkout. Use app/scripts/install-runtime.mjs.')
  await exec(runtimePaths(dirname(runtime),process.platform).python,['-E','-s','-c','import jsonschema, pypdf, hs_pdf_tools; print("conversion-runtime-ok")'],{timeout:30_000})
  if(o.provider==='openrouter'&&!(process.env.HUMANSTUDY_DEV_KEYS==='1'&&process.env.OPENROUTER_API_KEY))throw Error('Own OpenRouter access requires HUMANSTUDY_DEV_KEYS=1 and OPENROUTER_API_KEY in the environment.')
  if(o.provider==='humanstudy'&&!process.env.HUMANSTUDY_DESKTOP_KEY)throw Error('HumanStudy hosted access requires an explicitly supplied authorized HUMANSTUDY_DESKTOP_KEY. Do not copy another user\'s key.')
  const provenance={kernelVersion:version,runtimeVersion,model:o.model??DEFAULT_MODEL,provider:o.provider,packFiles:Object.keys(manifest.files).length}
  if(o.doctor){console.log(JSON.stringify({status:'ready',...provenance},null,2));process.exit(0)}
  lock=join(cache,'running.lock');writeFileSync(lock,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()})+'\n',{flag:'wx'});ownsLock=true
  process.env.HUMANSTUDY_RUNTIME_BIN=runtime
  const kernel=ownedKernel=new OpencodeKernel({binary,home:join(cache,'kernel-home'),provider:o.provider,model:o.model??DEFAULT_MODEL,permission:o.auto==='on'?'project':'ask'})
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,stopOwned)
  const logDir=join(cache,'runs',new Date().toISOString().replace(/[:.]/g,'-'))
  mkdirSync(logDir,{recursive:true});writeFileSync(join(logDir,'provenance.json'),JSON.stringify(provenance,null,2)+'\n')
  bridge=await controlAssets({kernel,project,session:o.session,input:process.stdin,output:process.stdout,logDir,timeoutMs:timeout*60_000,stallMs:stall*60_000})
  if(interrupted)await bridge.stop('interrupted')
  const result=await bridge.exited
  if(!['closed'].includes(result))process.exitCode=2
}catch(error){console.error(JSON.stringify({type:'fatal',error:String(error.message??error)}));process.exitCode=1}
finally{await ownedKernel?.dispose();for(const signal of ['SIGINT','SIGTERM'])process.removeListener(signal,stopOwned);if(ownsLock&&existsSync(lock))unlinkSync(lock)}
