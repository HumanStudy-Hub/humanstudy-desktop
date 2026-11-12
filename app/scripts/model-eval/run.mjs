// Explicit operator-run evaluation; no model calls on import or preparation.
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawn,spawnSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import {createHash} from 'node:crypto'
import {startRelay} from './budget-relay.mjs'
const repo=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
if(process.env.HUMANSTUDY_EVAL_AUTHORIZED!=='1')throw Error('No paid calls authorized. Root must allocate budget and set explicit execution flag.')
const config=JSON.parse(readFileSync(process.argv[2],'utf8'))
for(const k of ['project','paper','binary','runtimeBin','researchAuth','upstream','model','credentialFile','credentialField','ledger','budgetUsd','maxCalls','inputUsdPerMillion','outputUsdPerMillion'])if(config[k]===undefined)throw Error(`Missing ${k}`)
if(existsSync(config.project)&&!config.session)throw Error('Evaluation requires a fresh project or an explicitly identified continuation session')
if(config.session&&(!existsSync(join(config.project,'paper.pdf'))||!readFileSync(join(config.project,'paper.pdf')).equals(readFileSync(config.paper))))throw Error('Continuation source changed')
const secret=JSON.parse(readFileSync(config.credentialFile,'utf8'))[config.credentialField]
if(typeof secret!=='string'||!secret)throw Error('Missing explicit disposable credential')
const prepared=config.session?{status:0}:spawnSync(join(config.runtimeBin,'python'),[join(repo,'scripts/prepare_conversion.py'),'--engine','opencode','--project',config.project,'--paper',config.paper],{encoding:'utf8'})
if(prepared.status!==0)throw Error('Project preparation failed')
let cookie
if(config.cookieFile){
 const host=new URL(config.upstream).hostname
 const rows=readFileSync(config.cookieFile,'utf8').split('\n')
 cookie=rows.filter(line=>line&&!line.startsWith('#')||line.startsWith('#HttpOnly_')).map(line=>line.replace(/^#HttpOnly_/, '').split('\t')).filter(p=>p.length===7&&(p[0]===host||(p[0].startsWith('.')&&host.endsWith(p[0])))&&(!Number(p[4])||Number(p[4])*1000>Date.now())).map(p=>p[5]+'='+p[6]).join('; ')
 if(!cookie)throw Error('No matching unexpired preview cookies in Netscape cookie jar')
}
const relay=await startRelay({...config,authorization:`Bearer ${secret}`,cookie})
const privateProfile=JSON.parse(readFileSync(config.researchAuth,'utf8'))
privateProfile.server=relay.baseURL.replace(/\/v1$/, '')
const sessionProfile=config.researchAuth+'.relay'
writeFileSync(sessionProfile,JSON.stringify(privateProfile),{mode:0o600})
const durationMs=Math.min(config.maxDurationMs??900000,1200000)
if(!Number.isFinite(durationMs)||durationMs<1000)throw Error("Invalid remaining trial time")
let child,timer
try{
 const provider='bounded-eval',home=join(config.project,'.humanstudy/asset-agent/kernel-home/config/opencode');mkdirSync(home,{recursive:true})
 writeFileSync(join(home,'opencode.json'),JSON.stringify({provider:{[provider]:{npm:'@ai-sdk/openai-compatible',options:{baseURL:relay.baseURL,apiKey:'local-evaluation'},models:{[config.model]:{name:config.model,tool_call:true,limit:{context:200000,output:16384}}}}}}))
 const started=Date.now(),events=[]
 child=spawn(process.execPath,[join(repo,'app/scripts/opencode-assets.mjs'),'--project',config.project,'--binary',config.binary,'--runtime-bin',config.runtimeBin,'--provider',provider,'--model',config.model,'--research-auth',sessionProfile,'--timeout-minutes',String(durationMs/60000),'--stall-minutes','3',...(config.session?['--session',config.session]:[])],{stdio:['pipe','pipe','pipe'],env:{...process.env,OPENROUTER_API_KEY:'',HUMANSTUDY_DESKTOP_KEY:''}})
 const lines=createInterface({input:child.stdout})
 let startedBuild=false
 lines.on('line',line=>{let m;try{m=JSON.parse(line)}catch{return}events.push({type:m.type,eventType:m.eventType,...(m.type==='completion'?{status:m.status,problems:m.problems,programSha256:m.programSha256}:{}),at:Date.now()-started});if(m.type==='ready'&&!startedBuild){startedBuild=true;child.stdin.write(JSON.stringify(config.session?{op:'send',id:'eval-resume',text:'The evaluation request-count guard interrupted this build. Continue from the files already saved in this project, finish the remaining program.json content and run the required schema/minimum-coverage checks. Preserve exact source wording and missing items; do not restart extraction or invent absent materials.'}:{op:'build',id:'eval-build'})+'\n')}if(m.eventType==='done')child.stdin.write('{"op":"quit","id":"eval-quit"}\n')})
 // Keep raw agent output private in project; the evaluation report contains metadata only.
 const workerErrors=[]
 child.stderr.on('data',data=>workerErrors.push(String(data)))
 timer=setTimeout(()=>child.kill('SIGTERM'),durationMs)
 const code=await new Promise(r=>child.on('exit',r))
 writeFileSync(join(config.project,'evaluation-worker-stderr.log'),workerErrors.join(''),{mode:0o600})
 const program=join(config.project,'program.json')
 const check=existsSync(program)?spawnSync(join(config.runtimeBin,'python'),[join(config.project,'.opencode/skills/build/check_program.py'),program],{encoding:'utf8'}):null
 const report={model:config.model,continuationOf:config.session??null,sourceSha256:createHash('sha256').update(readFileSync(config.paper)).digest('hex'),desktopCommit:spawnSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).stdout.trim(),elapsedMs:Date.now()-started,exitCode:code,programSaved:existsSync(program),schemaCheckExit:check?.status??null,programSha256:existsSync(program)?createHash('sha256').update(readFileSync(program)).digest('hex'):null,events,budget:relay.budget.snapshot(),quoteReview:'pending independent exact-source verification; schema success is not scientific acceptance'}
 if(existsSync(join(config.project,'evaluation-report.json')))writeFileSync(join(config.project,`evaluation-report-${Date.now()}.json`),readFileSync(join(config.project,'evaluation-report.json')),{mode:0o600})
 writeFileSync(join(config.project,'evaluation-report.json'),JSON.stringify(report,null,2),{mode:0o600})
}finally{clearTimeout(timer);if(child&&child.exitCode===null)child.kill('SIGTERM');await relay.close()}
