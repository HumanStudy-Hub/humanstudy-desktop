import {build} from 'esbuild'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)),root=mkdtempSync(join(tmpdir(),'paper-build-'))
await build({entryPoints:[join(here,'paper-build.ts')],bundle:true,platform:'node',format:'esm',outfile:join(root,'core.mjs'),logLevel:'error'})
const P=await import(pathToFileURL(join(root,'core.mjs')))
mkdirSync(join(root,'.humanstudy'));P.pendingPaperBuild(root)
const c=P.createPaperBuilds(()=>{});c.bind('s',root)
assert.throws(()=>c.claim(root,'other'),/different project/)
const claim=c.claim(root,'s');assert.ok(claim);assert.equal(c.claim(root,'s'),null)
c.release(root,claim.claimId);assert.equal(P.readPaperBuild(root).status,'pending')
const next=c.claim(root,'s');c.sent('s');assert.equal(P.readPaperBuild(root).status,'running');assert.equal(c.claim(root,'s'),null)
c.event({sessionId:'s',type:'tool',tool:'bash',input:{command:'python program_io.py batch.json'}});assert.equal(P.readPaperBuild(root).phase,'writing')
c.event({sessionId:'s',type:'error',text:'Request Entity Too Large'});assert.equal(P.readPaperBuild(root).status,'error');assert.match(P.readPaperBuild(root).error,/too large/)
c.sent('s','Continue building program');assert.equal(P.readPaperBuild(root).status,'running')
c.event({sessionId:'s',type:'done'});assert.equal(P.readPaperBuild(root).status,'error')
// Restart after a claimed/running build is recoverable; an already active main never duplicates it.
P.pendingPaperBuild(root);const old=c.claim(root,'s')
const restarted=P.createPaperBuilds(()=>{});restarted.bind('s',root);assert.ok(restarted.claim(root,'s'))
restarted.sent('s');assert.equal(restarted.claim(root,'s'),null)
const again=P.createPaperBuilds(()=>{});again.bind('s',root);assert.ok(again.claim(root,'s'))
again.sent('s');writeFileSync(join(root,'program.json'),readFileSync(join(here,'../shared/sample-program.json')))
again.event({sessionId:'s',type:'done'});assert.equal(P.readPaperBuild(root).status,'complete');assert.equal(again.claim(root,'s'),null)
console.log('paper build claims, concurrent starts, restart recovery and completion passed')
