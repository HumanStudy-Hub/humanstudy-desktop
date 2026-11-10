import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
const here=dirname(fileURLToPath(import.meta.url)),out=mkdtempSync(join(tmpdir(),'protocol-view-'))
await build({entryPoints:[join(here,'components/ProtocolStudy.tsx')],bundle:true,platform:'node',format:'esm',jsx:'automatic',outfile:join(out,'view.mjs'),logLevel:'error'})
const {matchingPreview}=await import(pathToFileURL(join(out,'view.mjs')))
const text=readFileSync(join(here,'../../resources/protocol-sample/protocol.json'),'utf8')
const html=readFileSync(join(here,'../../resources/protocol-sample/artifacts/preview.html'),'utf8')
test('only the current protocol bytes can supply the initial participant view',async()=>{
 assert.equal(await matchingPreview(text,html),true)
 const changed=JSON.parse(text);changed.meta.title='Researcher change'
 assert.equal(await matchingPreview(JSON.stringify(changed),html),false)
 assert.equal(await matchingPreview(text,html.replace('hs-protocol','wrong-marker')),false)
 assert.equal(await matchingPreview('broken',html),false)
})
