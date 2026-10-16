import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'updates-test-'))
await build({ entryPoints: [join(here, 'updates-core.ts'),join(here,'shutdown-core.ts')], bundle:true,platform:'node',format:'esm',outdir:out,outExtension:{'.js':'.mjs'},logLevel:'error' })
const U=await import(pathToFileURL(join(out,'updates-core.mjs')).href)
const S=await import(pathToFileURL(join(out,'shutdown-core.mjs')).href)
assert.ok(U.isNoReleaseError('No published versions on GitHub'))
assert.ok(!U.isNoReleaseError('Cannot find latest-mac.yml (404)'))
assert.ok(!U.isNoReleaseError('Cannot find latest release (HTTP 403)'))
assert.equal(U.shortError('net::ERR_INTERNET_DISCONNECTED\n at x'),'net::ERR_INTERNET_DISCONNECTED')
class Client extends EventEmitter {
  count=0
  async checkForUpdates(){this.count++;this.emit('checking-for-update');return this.run()}
  run=()=>Promise.resolve(null)
}
const client=new Client(),timers=[]
const c=U.createUpdateController({client,version:'0.6.1',notify:()=>{},schedule:(fn,delay)=>{const t={fn,delay,cancelled:false};timers.push(t);return()=>t.cancelled=true}})
client.run=()=>({downloadPromise:Promise.reject(Error('net::ERR_NETWORK_CHANGED'))})
await c.check()
assert.equal(c.status().state,'error');assert.deepEqual(timers.map(t=>t.delay),[15000])
for(let i=0;i<3;i++){timers[i].fn();await new Promise(r=>setImmediate(r))}
assert.equal(client.count,4);assert.equal(timers.length,3,'bounded automatic retries')
assert.equal(c.status().error,'net::ERR_NETWORK_CHANGED')
client.run=()=>{client.emit('update-downloaded',{version:'0.6.2'});return{downloadPromise:Promise.resolve()}}
await c.check();assert.equal(c.status().state,'ready');await c.check();assert.equal(client.count,5)
const bad=new Client(),scheduled=[]
bad.run=()=>{throw Error('Cannot find latest-mac.yml (404)')}
const b=U.createUpdateController({client:bad,version:'0.6.1',notify:()=>{},schedule:(f,d)=>{scheduled.push(d);return()=>{}}})
await b.check();assert.equal(b.status().state,'error');assert.equal(scheduled.length,0)
bad.run=()=>({downloadPromise:Promise.reject(Error('SHA512 checksum mismatch'))})
await b.check();assert.equal(scheduled.length,0,'no automatic retries for integrity errors')
let resolveDownload
bad.run=()=>({downloadPromise:new Promise(r=>resolveDownload=r)})
const checking=b.check();await new Promise(r=>setImmediate(r));await b.check();assert.equal(bad.count,3)
resolveDownload();await checking
let save,disposed=0,faults=0
const q=S.createShutdown({busy:()=>true,confirm:async()=>false,flush:async()=>{},dispose:async()=>disposed++,failed:()=>faults++})
assert.equal(await q.prepare(true),false);assert.equal(disposed,0);assert.equal(q.closing(),false)
const order=[]
const gate=S.createShutdown({busy:()=>false,confirm:async()=>true,flush:()=>new Promise(r=>{order.push('save');save=r}),dispose:async()=>{order.push('dispose')},failed:()=>faults++})
const quit=gate.prepare(false),duplicate=gate.prepare(true)
assert.equal(quit,duplicate);assert.ok(gate.closing());assert.deepEqual(order,['save'])
save();await new Promise(r=>setImmediate(r));assert.deepEqual(order,['save','dispose','save'])
assert.equal(gate.ready(),false);save();assert.equal(await quit,true);assert.ok(gate.ready())
const failing=S.createShutdown({busy:()=>false,confirm:async()=>true,flush:async()=>{throw Error('disk full')},dispose:async()=>disposed++,failed:()=>faults++})
assert.equal(await failing.prepare(false),false);assert.equal(disposed,0);assert.equal(faults,1);assert.equal(failing.closing(),false)
assert.equal(await failing.prepare(false),false);assert.equal(faults,2)
console.log('update recovery and safe shutdown ok')

const native=new EventEmitter()
const staged=U.waitForNativeUpdate(native,1000)
native.emit('update-downloaded');await staged
assert.equal(native.listenerCount('error'),0)
const stageFailure=U.waitForNativeUpdate(native,1000)
native.emit('error',Error('Native verification failed'));await assert.rejects(stageFailure,/verification failed/)
await assert.rejects(U.waitForNativeUpdate(native,5),/still being prepared/)
assert.equal(native.listenerCount('update-downloaded'),0)
console.log('native staging readiness and cleanup ok')
