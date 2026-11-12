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

await build({stdin:{contents:`import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {ProtocolStudy} from './components/ProtocolStudy'; export {inspectHumanProgram,validateHumanProgram} from '../shared/human-program'; export const render=(program,text,problems)=>renderToStaticMarkup(React.createElement(ProtocolStudy,{program,text,problems,onSource:()=>{}}));`,resolveDir:here,loader:'tsx'},bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:join(out,'render.cjs'),logLevel:'error',loader:{'.css':'empty'}})
const {createRequire}=await import('node:module')
const {render,inspectHumanProgram,validateHumanProgram}=createRequire(import.meta.url)(join(out,'render.cjs'))
test('actual research renderer preserves readable incomplete notes without certifying or repairing them',()=>{
 const original=JSON.parse(readFileSync(join(here,'../../resources/protocol-sample/program.json'),'utf8'))
 delete original.extensions
 original.relations.push({...original.relations[0],id:'broken',from:'missing-node'})
 const before=JSON.stringify(original)
 const read=inspectHumanProgram(original)
 assert.ok(read.problems.length)
 assert.deepEqual(read.program,original)
 assert.throws(()=>validateHumanProgram(original))
 const markup=render(read.program,text,read.problems)
 assert.match(markup,/Research notes need checking/)
 assert.match(markup,/have not been checked against this experiment/)
 assert.match(markup,/missing-node/)
 assert.match(markup,/research-overview/)
 assert.ok(markup.includes(original.nodes[0].title))
 assert.equal(JSON.stringify(original),before)
 assert.throws(()=>inspectHumanProgram({...original,nodes:'not nodes'}))
})
