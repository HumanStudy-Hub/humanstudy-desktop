import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const out = mkdtempSync(join(tmpdir(), 'support-test-'))
await build({entryPoints:[join(dirname(fileURLToPath(import.meta.url)), 'support-core.ts')],bundle:true,platform:'node',format:'esm',outfile:join(out,'support.mjs'),logLevel:'error'})
const { createSupport } = await import(pathToFileURL(join(out,'support.mjs')))
process.on('exit', () => rmSync(out,{recursive:true,force:true}))
const id='11111111-1111-4111-8111-111111111111'
const input={id,kind:'help',message:'Please help with the study.\nAll original details remain.',includeDiagnostics:false}
function fixture() {
  const rows=new Map(), calls=[]
  let signedIn=true, offline=false, failed=0
  const support=createSupport({auth:async()=>signedIn?{supabaseUrl:'https://db.test',supabaseKey:'public',accessToken:'test-session',userId:'owner'}:null,diagnostics:{version:'0.5.3',platform:'darwin',arch:'arm64',secret:'must not send'},fetch:async(url,init)=>{
    calls.push({url,init});if(offline) throw Error('raw secret error')
    if(failed)return new Response('{}',{status:failed})
    if(init.method==='POST') { const row=JSON.parse(init.body); if(!rows.has(row.id))rows.set(row.id,row); return Response.json([]) }
    if(String(url).includes('limit=0'))return Response.json([])
    const row=rows.get(new URL(url).searchParams.get('id')?.replace('eq.',''))
    return Response.json(row?[row]:[])
  }})
  return {support,rows,calls,signOut:()=>{signedIn=false},offline:()=>{offline=true},fail:code=>{failed=code}}
}
test('support stores exact text, optional reply email, no diagnostics by default; receipt is verified',async()=>{
  const f=fixture();assert.equal((await f.support.status()).available,true)
  assert.deepEqual(await f.support.submit({...input,replyEmail:'reply@example.test'}),{id})
  assert.equal(f.rows.get(id).message,input.message);assert.deepEqual(f.rows.get(id).diagnostics,{})
  assert.equal(f.rows.get(id).reply_email,'reply@example.test');assert.equal(f.rows.get(id).owner_id,'owner')
})
test('support rejects invalid fields and excess content instead of truncating',async()=>{
 const f=fixture();for(const patch of [{id:'bad'},{kind:'other'},{message:' '},{message:'x'.repeat(12001)},{replyEmail:'bad'}, {includeDiagnostics:'yes'}])await assert.rejects(f.support.submit({...input,...patch}))
 assert.equal(f.calls.length,0)
})
test('opt-in diagnostics contain only the three previewed safe fields',async()=>{
 const f=fixture();await f.support.submit({...input,includeDiagnostics:true});assert.deepEqual(f.rows.get(id).diagnostics,{version:'0.5.3',platform:'darwin',arch:'arm64'})
})
test('retry after a lost response does not duplicate or overwrite a received request',async()=>{
 const f=fixture();await f.support.submit(input);await f.support.submit(input);assert.equal(f.rows.size,1)
 await assert.rejects(f.support.submit({...input,message:'edited after timeout'}),/different content/)
 assert.equal(f.rows.get(id).message,input.message)
})
test('signed-out help cannot submit or claim success',async()=>{
 const f=fixture();f.signOut();assert.equal((await f.support.status()).available,false);await assert.rejects(f.support.submit(input),/Sign in/);assert.equal(f.calls.length,0)
})
test('network and database failures preserve the request and do not expose raw upstream text',async()=>{
 const f=fixture();f.offline();await assert.rejects(f.support.submit(input),/Could not reach support/)
 const g=fixture();g.fail(503);await assert.rejects(g.support.submit(input),/could not be confirmed/)
 g.fail(401);await assert.rejects(g.support.submit(input),/sign in again/)
 assert.equal(input.message,'Please help with the study.\nAll original details remain.')
})
