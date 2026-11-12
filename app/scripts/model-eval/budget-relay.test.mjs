import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {budgetLedger} from './budget-relay.mjs'
test('budget is durable, exclusive, conservative and refuses before request',()=>{
 const dir=mkdtempSync(join(tmpdir(),'budget-test-')),path=join(dir,'ledger.json')
 const config={budgetUsd:0.01,maxCalls:2,inputUsdPerMillion:1,outputUsdPerMillion:1}
 try{
  const b=budgetLedger(path,config);assert.throws(()=>budgetLedger(path,config))
  const id=b.reserve(1000,1000);assert.equal(b.snapshot().reservedUsd,0.004)
  b.finish(id,'uncertain-reserved');b.close()
  const next=budgetLedger(path,config);assert.equal(next.snapshot().reservedUsd,0.004)
  assert.throws(()=>next.reserve(10000,1000));next.reserve(1000,1000)
  assert.throws(()=>next.reserve(1,1));assert.throws(()=>next.reserve(1,16385));next.close()
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('only confirmed costs settle; missing usage retains reservation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'budget-settle-')),path=join(dir,'ledger.json')
 try{
 const b=budgetLedger(path,{budgetUsd:.01,maxCalls:4,inputUsdPerMillion:1,outputUsdPerMillion:1})
 const id=b.reserve(1000,1000);b.finish(id,'completed-reserved',{cost:.0001});assert.equal(b.snapshot().calls[0].chargedUsd,.0002)
 const next=b.reserve(2000,2000);b.finish(next,'uncertain-reserved',{cost:0});assert.equal(b.snapshot().calls[1].chargedUsd,undefined);b.close()
 }finally{rmSync(dir,{recursive:true,force:true})}
})
