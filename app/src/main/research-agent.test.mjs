import {build} from 'esbuild'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
const temp=await mkdtemp(join(tmpdir(),'research-agent-'))
await build({entryPoints:[new URL('./research-agent.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',outfile:join(temp,'agent.mjs')})
const {createResearchAgent}=await import(pathToFileURL(join(temp,'agent.mjs')))
test('one shared adapter preserves partial chat, parallel native calls, questions, permissions, errors and usage',async()=>{
 const rows=[],a=createResearchAgent(async e=>{rows.push(e)})
 a.bind('ses_1','project01','/project','reported-model');a.start('ses_1','Build this paper')
 const e=fields=>a.event({sessionId:'ses_1',...fields})
 e({type:'text',text:'First full paragraph. '})
 e({type:'tool',tool:'bash',toolCallId:'call_1',text:'running',input:{command:'a'}})
 e({type:'tool',tool:'bash',toolCallId:'call_2',text:'running',input:{command:'b'}})
 e({type:'tool',tool:'bash',toolCallId:'call_2',text:'completed',output:'b done'})
 e({type:'tool',tool:'bash',toolCallId:'call_1',text:'error',output:'a failed'})
 e({type:'question',question:{id:'q1',questions:[{question:'Which condition?',options:[]}]}})
 e({type:'question',question:{id:'q1',questions:[],answers:[['Original']],resolved:'answered'}})
 e({type:'permission',permission:{id:'p1',type:'bash'}})
 e({type:'permission',permission:{id:'p1',type:'bash',resolved:'once',automatic:true}})
 e({type:'usage',messageId:'native_message',usage:{input:300,output:70,reasoning:20,cost:0.01}})
 e({type:'text',text:'Partial work kept.'});e({type:'error',text:'Connection failed'});e({type:'done'})
 await a.close()
 assert.equal(rows.filter(r=>r.event_type==='action.invoke').length,1)
 assert.equal(rows.filter(r=>r.event_type==='tool.end').length,2)
 assert.equal(rows.find(r=>r.event_type==='tool.end'&&r.tool_call_id==='call_1').metadata.output,'a failed')
 assert.equal(rows.find(r=>r.event_type==='tool.end'&&r.tool_call_id==='call_2').metadata.output,'b done')
 const text=rows.filter(r=>r.event_type==='conversation.message'&&r.metadata.role==='assistant').map(r=>r.metadata.text).join('')
 assert.equal(text,'First full paragraph. Partial work kept.')
 assert.equal(rows.find(r=>r.event_type==='agent.usage').message_id,'native_message')
 assert.equal(rows.find(r=>r.event_type==='agent.turn_end').metadata.status,'error')
 assert.ok(rows.filter(r=>r.event_type!=='action.invoke').every(r=>r.action_id===rows[0].id))
 assert.equal(rows.filter(r=>r.event_type==='conversation.question').length,2)
})
test('abort saves pending text and emits interruption for unfinished tools',async()=>{
 const rows=[],a=createResearchAgent(async e=>rows.push(e));a.bind('ses_1');a.start('ses_1','Run')
 a.event({sessionId:'ses_1',type:'tool',tool:'write',toolCallId:'c1',text:'running',input:{content:'whole file'}})
 a.event({sessionId:'ses_1',type:'text',text:'received before abort'});a.abort('ses_1');await a.close()
 assert.ok(rows.some(r=>r.event_type==='tool.end'&&r.metadata.status==='interrupted'))
 assert.ok(rows.some(r=>r.metadata.text==='received before abort'&&r.metadata.status==='partial'))
})
test('a second send while busy cannot close or reattribute the active response',async()=>{
 const rows=[],a=createResearchAgent(async e=>rows.push(e));a.bind('ses_1');a.start('ses_1','Original request')
 a.event({sessionId:'ses_1',type:'text',text:'First part. '});a.start('ses_1','Repeated send')
 a.event({sessionId:'ses_1',type:'text',text:'Second part.'});a.event({sessionId:'ses_1',type:'done'});await a.close()
 assert.equal(rows.filter(r=>r.event_type==='agent.turn_start').length,1)
 assert.equal(rows.filter(r=>r.event_type==='agent.turn_end').length,1)
 assert.equal(rows.filter(r=>r.event_type==='conversation.message'&&r.metadata.role==='assistant').map(r=>r.metadata.text).join(''),'First part. Second part.')
 assert.ok(rows.some(r=>r.metadata.status==='submitted_while_busy'))
})
test.after(()=>rm(temp,{recursive:true,force:true}))
