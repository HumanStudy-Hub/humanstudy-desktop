import {build} from 'esbuild'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {test} from 'node:test'
const here=dirname(fileURLToPath(import.meta.url)),out=mkdtempSync(join(tmpdir(),'pdf-page-cache-'))
await build({entryPoints:[join(here,'pdf-page-cache.ts'),join(here,'components/pdf-words.ts'),join(here,'../shared/source-anchor.ts')],bundle:true,platform:'node',format:'esm',outdir:out,logLevel:'error',outExtension:{'.js':'.mjs'}})
const {createPageCache}=await import(pathToFileURL(join(out,'renderer/pdf-page-cache.mjs')))
const {makeWords}=await import(pathToFileURL(join(out,'renderer/components/pdf-words.mjs')))
const {quoteRects,quoteKey}=await import(pathToFileURL(join(out,'shared/source-anchor.mjs')))
process.on('exit',()=>rmSync(out,{recursive:true,force:true}))
test('page text is demand-loaded and concurrent requests share the same complete result',async()=>{
 const calls=[],text='Complete original source '.repeat(10000)
 const page=createPageCache(async n=>{calls.push(n);return {page:n,text}})
 assert.equal(calls.length,0)
 const [a,b]=await Promise.all([page(90),page(90)])
 assert.deepEqual(calls,[90]);assert.equal(a,b);assert.equal(a.text,text)
 await page(90);assert.equal(calls.length,1)
})
test('a failed page load can be retried without poisoning the document',async()=>{
 let calls=0;const page=createPageCache(async()=>{if(++calls===1)throw Error('Transient page error');return 'complete'})
 await assert.rejects(page(1));assert.equal(await page(1),'complete')
})
test('dense pages retain more than 5000 words with linear text measurement',()=>{
 const text=Array.from({length:6001},(_,i)=>'word'+i).join(' ');let measured=0
 const measure={font:'',measureText:s=>{measured+=s.length;return {width:s.length}}}
 const words=makeWords([{str:text,width:470,transform:[1,0,0,10,20,40]}],{}, {width:500,height:800,scale:1,transform:[1,0,0,1,0,0]},measure,(_vp,tx)=>tx)
 assert.equal(words.length,6001);assert.equal(words.at(-1).t,'word6000');assert.ok(measured<=text.length*2)
})
test('a matching prefix or one ellipsis segment cannot verify a complete missing quotation',()=>{
 const prefix='This sentence is a long original opening passage with important qualifications'
 const words=prefix.split(' ').map((t,i)=>({t,x:i,y:20,w:1,h:2}))
 assert.deepEqual(quoteRects(words,prefix+' but this ending was invented'),[])
 assert.deepEqual(quoteRects(words,prefix+' … a missing second passage'),[])
 assert.deepEqual(quoteRects(words,prefix+' … xyz'),[])
 assert.notEqual(quoteKey(1,'a'.repeat(200)+'first','paper'),quoteKey(1,'a'.repeat(200)+'second','paper'))
 assert.notEqual(quoteKey(1,prefix,'paper'),quoteKey(1,prefix,'supplement'))
})
