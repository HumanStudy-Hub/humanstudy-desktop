import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {test} from 'node:test'
const require=createRequire(import.meta.url)
const ts=require('typescript')
const source=ts.transpileModule(readFileSync(new URL('./sample-guide-flow.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
const {guideReplyReceived,guidePrompts,rearm,newUserIndex}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
const wait={ids:[1,2],count:2,thread:'current',startedAt:100}
const msg=(id,role,kind='text',at=101)=>({id,role,at,parts:[{kind,text:'Research answer'}]})
test('only a new sent question followed by a finished textual reply advances',()=>{
 const old=[msg(1,'user'),msg(2,'assistant')]
 assert.equal(guideReplyReceived(old,wait,'current',false,null),false)
 assert.equal(guideReplyReceived([...old,msg(3,'assistant')],wait,'current',false,null),false)
 const turn=[...old,msg(3,'user'),msg(4,'assistant')]
 assert.equal(guideReplyReceived(turn,wait,'current',true,null),false)
 assert.equal(guideReplyReceived(turn,wait,'other-thread',false,null),false)
 assert.equal(guideReplyReceived(turn,wait,'current',false,'Provider error'),false)
 assert.equal(guideReplyReceived(turn,wait,'current',false,null),true)
 assert.equal(guideReplyReceived([msg(3,'user'),msg(4,'assistant')],wait,'current',false,null),false,'messages before the anchor never count (reloaded history gets new ids)')
 assert.equal(guideReplyReceived([...old,msg(3,'user'),msg(4,'assistant','error')],wait,'current',false,null),false)
 assert.equal(guideReplyReceived([...old,msg(3,'user'),msg(4,'assistant','reasoning')],wait,'current',false,null),false)
})
test('the guide offers preparation prompts, not permission to run',()=>{
 assert.deepEqual(Object.keys(guidePrompts),['replicate','question','ai','variation','materials'])
 assert.match(guidePrompts.replicate,/Do not invent missing materials/)
 assert.match(guidePrompts.ai,/Do not run until I approve/)
 assert.match(guidePrompts.ai,/differs from replicating/)
 assert.match(guidePrompts.variation,/Keep the original study intact/)
})
test('commands, rejected questions and expired permissions are not finished replies',()=>{
 const old=[msg(1,'user'),msg(2,'assistant')]
 const cmd={id:3,role:'user',parts:[{kind:'text',text:'/compact'}]}
 assert.equal(newUserIndex([...old,cmd],wait),-1)
 assert.equal(guideReplyReceived([...old,cmd,msg(4,'assistant')],wait,'current',false,null),false)
 const rejected={id:4,role:'assistant',parts:[{kind:'text',text:'Partial answer'},{kind:'question',id:'q',questions:[],resolved:'rejected'}]}
 assert.equal(guideReplyReceived([...old,msg(3,'user'),rejected],wait,'current',false,null),false)
 const expired={id:4,role:'assistant',parts:[{kind:'text',text:'Partial answer'},{kind:'permission',id:'p',type:'bash',expired:true}]}
 assert.equal(guideReplyReceived([...old,msg(3,'user'),expired],wait,'current',false,null),false)
})
test('re-arming after a stopped reply only counts later messages',()=>{
 const stopped=[msg(1,'user'),msg(2,'assistant'),msg(3,'user'),msg(4,'assistant')]
 const next=rearm(stopped,'current',true)
 assert.equal(next.count,4); assert.equal(next.interrupted,true)
 assert.equal(guideReplyReceived(stopped,next,'current',false,null),false)
 assert.equal(guideReplyReceived([...stopped,msg(5,'user'),msg(6,'assistant')],next,'current',false,null),true)
})
test('a retry after an error, a rejected question or a stop advances on its complete reply',()=>{
 const old=[msg(1,'user'),msg(2,'assistant')]
 const failed=[...old,msg(3,'user'),msg(4,'assistant','error')]
 assert.equal(guideReplyReceived(failed,wait,'current',false,null),false)
 assert.equal(guideReplyReceived([...failed,msg(5,'user'),msg(6,'assistant')],wait,'current',false,null),true)
 const rejected=[...old,msg(3,'user'),{id:4,role:'assistant',parts:[{kind:'text',text:'Let me ask'},{kind:'question',id:'q',questions:[],resolved:'rejected'}]}]
 assert.equal(guideReplyReceived([...rejected,msg(5,'user'),msg(6,'assistant')],wait,'current',false,null),true)
})
test('a refused permission followed by a complete answer counts',()=>{
 const old=[msg(1,'user'),msg(2,'assistant')]
 const reply={id:4,role:'assistant',parts:[{kind:'permission',id:'p',type:'bash',resolved:'reject'},{kind:'text',text:'Here is the answer without running it.'}]}
 assert.equal(guideReplyReceived([...old,msg(3,'user'),reply],wait,'current',false,null),true)
})
test('the count anchor survives a reload that renumbers ids',()=>{
 const reloaded=[msg(11,'user'),msg(12,'assistant')]
 assert.equal(guideReplyReceived(reloaded,wait,'current',false,null),false,'renumbered history before the anchor does not count')
 assert.equal(guideReplyReceived([...reloaded,msg(13,'user'),msg(14,'assistant')],wait,'current',false,null),true)
})
