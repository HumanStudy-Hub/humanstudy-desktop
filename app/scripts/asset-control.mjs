// JSON-lines supervision of the actual desktop Kernel interface. No model/provider implementation here.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const READS = new Set(['status','context','todos','history','changes','catalog','models','tools','skills','commands','agents','providers','session'])
const MUTATIONS = new Set(['compact','select','fork','undo','redo'])

export function packPath(value) {
  if(typeof value!=='string')throw Error('Invalid pack path.')
  const rel=value.replaceAll('\\','/')
  if(rel.split('/').some(p=>!p||p==='.'||p==='..'))throw Error('Invalid pack path.')
  if(rel==='.opencode/HUMANSTUDY_AGENT.md')return {rel,original:'AGENTS.md'}
  if(rel==='.opencode/PROJECT_FORMAT.md')return {rel,original:'PROJECT_FORMAT.md'}
  if(rel.startsWith('schema/')||/^\.opencode\/(skills|artifact-kit)\//.test(rel))return {rel,original:rel.replace(/^\.opencode\//,'')}
  throw Error('Invalid pack path.')
}

export async function controlAssets({kernel, project, session, input, output, logDir, timeoutMs=30*60_000, stallMs=5*60_000,onEvent=()=>{},onRequest=()=>{},onSession=()=>{},onOperation=()=>{}}) {
  mkdirSync(logDir, {recursive:true})
  const eventPath=join(logDir,'events.jsonl'), transcript=join(logDir,'assistant.txt'), resultPath=join(logDir,'result.json')
  const pendingPermissions=new Set(), pendingQuestions=new Set()
  let sid, active=false, failed=false, closed=false, line=0, started=0, progress=0, lastTurn='not_started'
  const emit=value=>output.write(JSON.stringify(value)+'\n')
  const save=()=>writeFileSync(resultPath,JSON.stringify({sessionId:sid,active,lastTurn,pendingPermissions:[...pendingPermissions],pendingQuestions:[...pendingQuestions],eventPath,transcript},null,2)+'\n')
  let resolveExit
  const exited=new Promise(resolve=>{resolveExit=resolve})
  const stop=async(reason='closed')=>{
    if(closed)return
    closed=true
    clearInterval(timer)
    if(active&&sid)await kernel.abort(sid).catch(()=>{})
    active=false;lastTurn=reason;save()
    await kernel.dispose()
    off();rl.close()
    emit({type:'closed',reason,sessionId:sid,resultPath})
    resolveExit(reason)
  }
  const off=kernel.onEvent(event=>{
    if(sid&&event.sessionId!==sid)return
    onEvent(event)
    appendFileSync(eventPath,JSON.stringify({at:new Date().toISOString(),event})+'\n');line++
    if(event.type==='text'&&event.text){appendFileSync(transcript,event.text);progress=Date.now()}
    if(event.type==='tool'&&event.text==='completed')progress=Date.now()
    if(event.type==='permission'&&event.permission){
      if(event.permission.resolved){pendingPermissions.delete(event.permission.id);progress=Date.now()}
      else pendingPermissions.add(event.permission.id)
    }
    if(event.type==='question'&&event.question){
      if(event.question.resolved){pendingQuestions.delete(event.question.id);progress=Date.now()}
      else pendingQuestions.add(event.question.id)
    }
    if(event.type==='error')failed=true
    if(event.type==='done'){active=false;lastTurn=failed?'error':'idle';save()}
    // Full scientific/tool output remains in the private log, not clipped into a console preview.
    emit({type:'event',sessionId:event.sessionId,eventType:event.type,line,eventPath,
      ...(event.type==='text'?{transcript}:{}),
      ...(['status','tool','error'].includes(event.type)?{state:event.text,tool:event.tool}:{}),
      ...(event.permission?{permission:event.permission}:{}),...(event.question?{question:event.question}:{}),
      ...(event.usage?{usage:event.usage}:{})})
  })
  const rl=createInterface({input,crlfDelay:Infinity})
  let queue=Promise.resolve()
  let readyResolve
  const ready=new Promise(resolve=>{readyResolve=resolve})
  const timer=setInterval(()=>{
    if(!active||closed)return
    const now=Date.now(),waiting=pendingPermissions.size+pendingQuestions.size>0
    if(now-started>timeoutMs)void stop('deadline_exceeded')
    else if(!waiting&&now-progress>stallMs)void stop('no_progress')
    else emit({type:'heartbeat',sessionId:sid,active,waiting,elapsedSeconds:Math.floor((now-started)/1000),noProgressSeconds:Math.floor((now-progress)/1000)})
  },Math.min(20_000,Math.max(20,Math.min(timeoutMs,stallMs)/2)))
  const command=async request=>{
    if(closed)throw Error('Bridge is closed.')
    onOperation(sid,request)
    if(request.op==='send'||request.op==='build'){
      if(active)throw Error('A turn is active. Wait or abort before sending another request.')
      const text=request.op==='build'?readFileSync(join(project,'CONVERT.md'),'utf8'):request.text
      if(typeof text!=='string'||!text.trim())throw Error('A non-empty text is required.')
      onRequest(sid,{...request,text})
      active=true;failed=false;started=progress=Date.now();lastTurn='running'
      appendFileSync(eventPath,JSON.stringify({at:new Date().toISOString(),request:{op:request.op,text}})+'\n');line++
      try{await kernel.send(sid,text)}catch(error){active=false;lastTurn='error';throw error}
    }else if(request.op==='permission'){
      if(!['once','reject'].includes(request.reply))throw Error('Use a one-call permission reply: once or reject.')
      await kernel.reply(sid,request.permissionId,request.reply)
    }else if(request.op==='answer')await kernel.answerQuestion(sid,request.questionId,request.answers)
    else if(request.op==='reject-question')await kernel.rejectQuestion(sid,request.questionId)
    else if(request.op==='questions')return await kernel.questions(sid)
    else if(request.op==='abort'){onRequest(sid,request);await kernel.abort(sid);active=false;lastTurn='aborted'}
    else if(request.op==='auto'){
      if(!['on','off'].includes(request.mode))throw Error('Auto must be on or off.')
      kernel.setPermissionMode(request.mode==='on'?'project':'ask')
    }else if(request.op==='native'){
      if(!READS.has(request.operation)&&!MUTATIONS.has(request.operation))throw Error('This operation is outside asset generation. Use the desktop for unrelated account/sharing/settings changes.')
      if(request.operation==='compact'&&active)throw Error('Stop the active turn before compacting.')
      if(request.operation==='compact'){active=true;failed=false;lastTurn='running';started=progress=Date.now()}
      try{
        const value=await kernel.native(sid,{operation:request.operation,input:request.input??{}})
        if(request.operation==='fork'&&value?.id){sid=value.id;onSession(sid);active=false}
        return value
      }catch(error){if(request.operation==='compact'){active=false;failed=true;lastTurn='error'};throw error}
    }else if(request.op==='quit'){await stop('closed');return}
    else throw Error('Unknown operation.')
    save()
  }
  rl.on('line',text=>{
    let request,parseError
    try{request=JSON.parse(text)}catch(error){parseError=error}
    const dispatch=async()=>{
      await ready
      try{if(parseError)throw parseError;const value=await command(request);emit({type:'reply',id:request.id??null,ok:true,...(value!==undefined?{value}:{})})}
      catch(error){save();emit({type:'reply',id:request?.id??null,ok:false,error:String(error.message??error)})}
    }
    if(request?.op==='abort'||request?.op==='quit')void dispatch()
    else queue=queue.then(dispatch)
  })
  rl.on('close',()=>{
    if(active)void stop('input_closed_during_turn')
    else void queue.then(()=>stop(active?'input_closed_during_turn':'closed'))
  })
  try{
    sid=session?await kernel.resumeSession(project,session):await kernel.startSession(project)
    if(sid)onSession(sid)
    if(!sid)throw Error('The requested session cannot be resumed. Do not silently create a replacement.')
    save()
    emit({type:'ready',sessionId:sid,eventPath,transcript,resultPath})
    readyResolve()
    return {sessionId:sid,exited,stop,eventPath,resultPath}
  }catch(error){readyResolve();await stop('startup_error');throw error}
}
