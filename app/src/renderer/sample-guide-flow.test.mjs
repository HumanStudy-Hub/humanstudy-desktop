import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {test} from 'node:test'
const require=createRequire(import.meta.url)
const ts=require('typescript')
const source=ts.transpileModule(readFileSync(new URL('./sample-guide-flow.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText
const {guideReplyReceived,guidePrompts}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'))
const wait={ids:[1,2],thread:'current',startedAt:100}
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
 assert.equal(guideReplyReceived([msg(3,'user','text',50),msg(4,'assistant')],wait,'current',false,null),false)
 assert.equal(guideReplyReceived([msg(3,'user'),msg(4,'assistant','error')],wait,'current',false,null),false)
 assert.equal(guideReplyReceived([msg(3,'user'),msg(4,'assistant','reasoning')],wait,'current',false,null),false)
})
test('the guide offers preparation prompts, not permission to run',()=>{
 assert.deepEqual(Object.keys(guidePrompts),['replicate','question','ai','variation','materials'])
 assert.match(guidePrompts.replicate,/Do not invent missing materials/)
 assert.match(guidePrompts.ai,/Do not run until I approve/)
 assert.match(guidePrompts.ai,/differs from replicating/)
 assert.match(guidePrompts.variation,/Keep the original study intact/)
})
