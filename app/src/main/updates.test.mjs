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
{
 const stale=new Client(),states=[]
 const controller=U.createUpdateController({client:stale,version:'0.6.5',notify:s=>states.push(s)})
 stale.emit('update-available',{version:'v0.6.5'})
 assert.equal(controller.status().state,'none')
 stale.emit('update-downloaded',{version:'0.6.5'})
 assert.equal(controller.status().state,'none','a completion for the installed version must not prompt another installation')
 stale.emit('update-downloaded',{version:'0.6.6'})
 assert.equal(controller.status().state,'ready','a genuinely newer version must still be installable')
 controller.stop()
}
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
const q=S.createShutdown({busy:()=>true,confirm:async()=>false,flush:async()=>{},quiesce:async()=>disposed++,failed:()=>faults++})
assert.equal(await q.prepare(true),false);assert.equal(disposed,0);assert.equal(q.closing(),false)
const order=[]
const gate=S.createShutdown({busy:()=>false,confirm:async()=>true,flush:()=>new Promise(r=>{order.push('save');save=r}),quiesce:async()=>{order.push('stop turn')},failed:()=>faults++})
const quit=gate.prepare(false),duplicate=gate.prepare(true)
assert.equal(quit,duplicate);assert.ok(gate.closing());assert.deepEqual(order,['save'])
save();await new Promise(r=>setImmediate(r));assert.deepEqual(order,['save','stop turn','save'])
assert.equal(gate.ready(),false);save();assert.equal(await quit,true);assert.ok(gate.ready())
const failing=S.createShutdown({busy:()=>false,confirm:async()=>true,flush:async()=>{throw Error('disk full')},quiesce:async()=>disposed++,failed:()=>faults++})
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

// The second save can fail after stopping a turn; its session must remain usable.
let saves=0, stopped=false, saveFaults=0
const reversible=S.createShutdown({busy:()=>!stopped,confirm:async()=>true,quiesce:async()=>{stopped=true},flush:async()=>{if(++saves===2)throw Error('second save failed')},failed:()=>saveFaults++})
assert.equal(await reversible.prepare(true),false)
assert.equal(stopped,true);assert.equal(reversible.closing(),false);assert.equal(saveFaults,1)
assert.equal(await reversible.prepare(true),true)
assert.equal(reversible.reset(),true);assert.equal(reversible.closing(),false);assert.equal(reversible.ready(),false)

const launchTimers=[],installErrors=[]
let launched=0,rollbacks=0,throwInstall=true
const barrier=S.createShutdown({busy:()=>false,confirm:async()=>true,quiesce:async()=>{},flush:async()=>{},failed:()=>assert.fail('unexpected save error')})
const launch=U.createUpdateInstaller({ready:()=>true,waitForNative:async()=>{},prepare:()=>barrier.prepare(true),rollback:()=>{rollbacks++;barrier.reset()},launch:()=>{launched++;if(throwInstall)throw Error('installer failed')},report:e=>installErrors.push(e),schedule:(fn,delay)=>{const t={fn,delay,cancelled:false};launchTimers.push(t);return()=>t.cancelled=true}})
await launch.run()
assert.equal(barrier.closing(),false);assert.equal(barrier.ready(),false);assert.equal(rollbacks,1)
throwInstall=false
await launch.run();await launch.run();assert.equal(launched,2,'duplicate install requests stay serialized')
launch.failed(Error('async native error'));assert.equal(rollbacks,2);assert.equal(barrier.closing(),false)
await launch.run();launchTimers.at(-1).fn();assert.equal(rollbacks,3);assert.equal(barrier.closing(),false)
await launch.run();launch.exiting();assert.equal(launchTimers.at(-1).cancelled,true)
assert.equal(installErrors.length,3)

// An error during saving must not unblock sends until that save barrier completes.
let finishPrepare,rollbackDuringSave=0,lateLaunches=0
const delayed=U.createUpdateInstaller({ready:()=>true,waitForNative:async()=>{},prepare:()=>new Promise(r=>finishPrepare=r),rollback:()=>rollbackDuringSave++,launch:()=>lateLaunches++,report:()=>{}})
const waiting=delayed.run();await new Promise(r=>setImmediate(r))
delayed.failed(Error('native error while saving'));assert.equal(rollbackDuringSave,0)
finishPrepare(true);await waiting;assert.equal(rollbackDuringSave,1);assert.equal(lateLaunches,0)
console.log('second-save and installer failure rollback/retry ok')
