// Local evaluation guard. Never logs credentials, prompts, responses or tool arguments.
import {createServer} from 'node:http'
import {readFileSync,writeFileSync,renameSync,mkdirSync,rmdirSync,existsSync} from 'node:fs'
import {dirname} from 'node:path'
import {randomUUID} from 'node:crypto'

export function budgetLedger(path, {budgetUsd,maxCalls,inputUsdPerMillion,outputUsdPerMillion,safety=2,maxOutput=16384,scope,scopeBudgetUsd}) {
  for(const n of [budgetUsd,maxCalls,inputUsdPerMillion,outputUsdPerMillion,safety,maxOutput])if(!Number.isFinite(n)||n<=0)throw Error('Explicit positive limits required')
  if(budgetUsd>15||maxOutput>16384||safety<2)throw Error('Limit exceeds approved ceiling or insufficient safety')
  mkdirSync(dirname(path),{recursive:true});const lock=path+'.lock';mkdirSync(lock)
  let state
  try {state=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{reservedUsd:0,calls:[]}} catch(e){rmdirSync(lock);throw e}
  const save=()=>{const temp=path+'.'+randomUUID();writeFileSync(temp,JSON.stringify(state,null,2),{mode:0o600});renameSync(temp,path)}
  return {
    reserve(bytes,output){
      if(state.halted)throw Error("Provider cost exceeded reserved bound; review required")
      if(!Number.isSafeInteger(bytes)||bytes<0||!Number.isInteger(output)||output<1||output>maxOutput)throw Error('Invalid request bounds')
      const cost=safety*(bytes*inputUsdPerMillion+output*outputUsdPerMillion)/1e6
      const charged=state.calls.reduce((sum,c)=>sum+(c.chargedUsd??c.reservedUsd),0)
      if(state.calls.length>=maxCalls||charged+cost>budgetUsd)throw Error('Evaluation budget exhausted')
      if(scope&&(!Number.isFinite(scopeBudgetUsd)||state.calls.filter(c=>c.scope===scope).reduce((sum,c)=>sum+(c.chargedUsd??c.reservedUsd),0)+cost>scopeBudgetUsd))throw Error('Model allocation exhausted')
      const row={scope,id:randomUUID(),inputBytes:bytes,maxOutput:output,reservedUsd:cost,status:'reserved',at:new Date().toISOString()}
      state.reservedUsd+=cost;state.calls.push(row);save();return row.id
    },
    finish(id,status,usage){const row=state.calls.find(x=>x.id===id);if(!row)throw Error('Unknown reservation');row.status=status;if(usage)row.usage=usage;if(Number.isFinite(usage?.cost)&&usage.cost>row.reservedUsd)state.halted=true;if(status==='completed-reserved'&&Number.isFinite(usage?.cost)&&usage.cost>=0)row.chargedUsd=Math.max(0.000001,usage.cost*2);save()},
    close(){rmdirSync(lock)},snapshot(){return structuredClone(state)}
  }
}

export async function startRelay({ledger,upstream,model,authorization,cookie,timeoutMs=120000,maxDurationMs=900000,maxCalls, inputUsdPerMillion,outputUsdPerMillion,budgetUsd,scopeBudgetUsd,reasoningEffort,fetchImpl=fetch}){
  const url=new URL(upstream)
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw Error('Upstream must be HTTPS without URL credentials/query')
  if(!url.hostname.endsWith('.vercel.app'))throw Error('Only explicit Vercel preview upstream permitted')
  const budget=budgetLedger(ledger,{budgetUsd,maxCalls,inputUsdPerMillion,outputUsdPerMillion,scope:model,scopeBudgetUsd})
  const controllers=new Set();const expires=Date.now()+maxDurationMs
  const server=createServer(async(req,res)=>{
    let id,controller
    try{
      if(req.method==='GET'&&['/api/desktop/config','/api/desktop/identity'].includes(req.url)){
        const upstreamResponse=await fetchImpl(new URL(req.url,url.origin),{redirect:'error',headers:{Authorization:authorization,...(cookie?{Cookie:cookie}:{})},signal:AbortSignal.timeout(15000)})
        res.writeHead(upstreamResponse.status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(Buffer.from(await upstreamResponse.arrayBuffer()));return
      }
      if(req.method!=='POST'||req.url!=='/v1/chat/completions')throw Error('Unsupported evaluation endpoint')
      if(Date.now()>expires)throw Error('Evaluation time limit reached')
      let size=0;const chunks=[]
      for await(const c of req){size+=c.length;if(size>16*1024*1024)throw Error('Oversized request; not truncated');chunks.push(c)}
      const body=JSON.parse(Buffer.concat(chunks).toString());if(body.model!==model)throw Error('Unexpected model')
      // Cap only generated response tokens, never source material or input history.
      const unsupported=o=>o&&typeof o==='object'&&(Array.isArray(o)?o.some(unsupported):Object.entries(o).some(([k,v])=>['image_url','image','file','input_audio'].includes(k)||unsupported(v)))
      if(unsupported(body.messages))throw Error('Image/file/audio inputs have no approved byte-cost bound')
      if(reasoningEffort)body.reasoning={effort:reasoningEffort}
      const requested=body.max_completion_tokens??body.max_tokens??16384
      if(!Number.isInteger(requested)||requested<1)throw Error('Invalid output limit')
      body.max_tokens=Math.min(requested,16384);delete body.max_completion_tokens
      const wire=Buffer.from(JSON.stringify(body));id=budget.reserve(wire.length,body.max_tokens)
      controller=new AbortController();controllers.add(controller)
      const timer=setTimeout(()=>controller.abort(),Math.min(timeoutMs,expires-Date.now()))
      res.on('close',()=>{if(!res.writableEnded)controller.abort()})
      try{
        const response=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:authorization,...(cookie?{Cookie:cookie}:{})},body:wire,signal:controller.signal})
        res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store'})
        // Reservations remain charged even when usage is missing, transport fails,
        // or cached/provider billing is uncertain. No retry is issued here.
        let pending='',usage
        const capture=text=>{try{const obj=JSON.parse(text);if(obj.usage&&typeof obj.usage==='object'){const safe={};for(const [k,v]of Object.entries(obj.usage))if(typeof v==='number'&&Number.isFinite(v)&&v>=0)safe[k]=v;usage=safe}}catch{}}
        const decoder=new TextDecoder()
        for await(const part of response.body??[]){
          res.write(part);pending+=decoder.decode(part,{stream:true})
          let newline
          while((newline=pending.indexOf('\n'))>=0){const line=pending.slice(0,newline);pending=pending.slice(newline+1);if(line.startsWith('data: '))capture(line.slice(6))}
          if(pending.length>2*1024*1024)pending='' // discard usage-parser scratch only; response already forwarded in full
        }
        pending+=decoder.decode();capture(pending)
        res.end();budget.finish(id,response.ok?'completed-reserved':'upstream-error-reserved',usage)
      }finally{clearTimeout(timer)}
    }catch(e){if(id)budget.finish(id,'uncertain-reserved');if(!res.headersSent)res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Bounded evaluation request stopped; inspect local budget status.'}}))}
    finally{if(controller)controllers.delete(controller)}
  })
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  return {baseURL:`http://127.0.0.1:${server.address().port}/v1`,budget,async close(){for(const c of controllers)c.abort();await new Promise(r=>server.close(r));budget.close()}}
}
