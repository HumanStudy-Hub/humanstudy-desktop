import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { test } from 'node:test'
const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '../..')
const assets = join(appRoot, 'resources/protocol-sample')
const bundleDir = mkdtempSync(join(tmpdir(), 'sample-project-test-'))
const source = readFileSync(join(here, 'sample-project.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
writeFileSync(join(bundleDir, 'sample-project.mjs'), compiled)
const { installSampleAssets } = await import(pathToFileURL(join(bundleDir, 'sample-project.mjs')).href)
const sha = b => createHash('sha256').update(b).digest('hex')

test('installs a protocol-only real study, exact licensed paper and current participant preview', async () => {
 const project = mkdtempSync(join(tmpdir(), 'sample-project-'))
 try {
  await installSampleAssets(assets, project)
  assert.equal(existsSync(join(project,'program.json')),false)
  assert.equal(existsSync(join(project,'package')),false)
  const raw=readFileSync(join(project,'protocol.json')), p=JSON.parse(raw)
  assert.equal(p.schema_version,'1');assert.equal(p.arms.length,2)
  assert.ok(p.arms.every(a=>a.runnable===true))
  assert.equal(sha(readFileSync(join(project,'paper.pdf'))),'1d2f8db33a2f14e8b08b549ecbb5b4d88483c53af0790c1ddb6123bd1fe801da')
  assert.equal(p.meta.sources.paper.file,'paper.pdf')
  assert.ok(existsSync(join(project,'sourcetext/paper.txt')))
  assert.equal(JSON.parse(readFileSync(join(assets,'review/checks-latest.json'))).PASS,true)
  const html=readFileSync(join(project,'artifacts/preview.html'),'utf8')
  const identity=JSON.parse(html.match(/id="hs-protocol"[^>]*>([^<]+)/)[1])
  assert.equal(identity.sha256,sha(raw));assert.equal(identity.id,p.id)
  assert.deepEqual(identity.arms,['s1','s2'])
  assert.match(readFileSync(join(project,'README.md'),'utf8'),/Reaction-time/)
 } finally {rmSync(project,{recursive:true,force:true})}
})
test('preflights before copying and preserves an existing researcher protocol', async()=>{
 const project=mkdtempSync(join(tmpdir(),'sample-project-'))
 try {
  writeFileSync(join(project,'protocol.json'),'researcher edit')
  await assert.rejects(installSampleAssets(assets,project),/destination already exists/)
  assert.equal(readFileSync(join(project,'protocol.json'),'utf8'),'researcher edit')
  assert.equal(existsSync(join(project,'paper.pdf')),false)
 }finally{rmSync(project,{recursive:true,force:true})}
})
test('missing protocol sources fail before any assets are installed',async()=>{
 const empty=mkdtempSync(join(tmpdir(),'sample-empty-')), project=mkdtempSync(join(tmpdir(),'sample-project-'))
 try {await assert.rejects(installSampleAssets(empty,project),/required sample asset/);assert.equal(existsSync(join(project,'protocol.json')),false)}
 finally{rmSync(project,{recursive:true,force:true});rmSync(empty,{recursive:true,force:true})}
})
