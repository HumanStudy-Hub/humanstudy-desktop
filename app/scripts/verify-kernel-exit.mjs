// Verify actual Electron exit still kills its owned kernel helpers (no model/server calls).
import { build } from 'esbuild'
import electron from 'electron'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
const here = dirname(fileURLToPath(import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'hs-kernel-exit-'))
await build({ entryPoints: [join(here, '../src/main/kernel/index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(root, 'kernel.cjs'), logLevel: 'error' })
writeFileSync(join(root, 'probe.cjs'), `
const fs=require('node:fs'),{spawn}=require('node:child_process');
const {OpencodeKernel}=require(${JSON.stringify(join(root, 'kernel.cjs'))});
const k=new OpencodeKernel({binary:'/bin/true',home:${JSON.stringify(root)}});
const helper=spawn(${JSON.stringify(process.execPath)},['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(join(root, 'helper.json'))},JSON.stringify({pid:helper.pid}));
k.live.add({proc:helper,sse:new AbortController(),exited:false});
require(${JSON.stringify(join(here, 'verify-shutdown.cjs'))});
`)
let pid, succeeded = false
try {
  const code = await new Promise((resolve, reject) => {
    const app = spawn(electron, [join(root, 'probe.cjs')], { stdio: 'inherit' })
    app.once('error', reject); app.once('exit', resolve)
  })
  pid = JSON.parse(readFileSync(join(root, 'helper.json'))).pid
  assert.equal(code, 0)
  for (let i = 0; i < 20; i++) {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') { console.log('Electron exit killed its owned helper without disposing sessions during preparation'); pid = undefined; break }
      throw error
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(pid, undefined, 'helper must not remain running after app exit')
  succeeded = true
} finally {
  // Cleanup only the dummy helper spawned by this fixture, including failed-test paths.
  if (!succeeded && pid === undefined) { try { pid = JSON.parse(readFileSync(join(root, 'helper.json'))).pid; process.kill(pid, 0) } catch { pid = undefined } }
  if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
}
