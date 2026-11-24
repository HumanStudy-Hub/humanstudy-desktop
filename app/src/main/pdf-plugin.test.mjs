import {build} from 'esbuild'
import assert from 'node:assert/strict'
import {mkdtempSync,copyFileSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)),root=mkdtempSync(join(tmpdir(),'pdf-transport-'))
await build({entryPoints:[join(here,'../../../pack/plugins/humanstudy-pdf.ts')],bundle:true,platform:'node',format:'esm',outfile:join(root,'guard.mjs'),logLevel:'error'})
// A deterministic extractor emits the ENTIRE fixture, including its final page and final token.
const bin=join(root,'bin');mkdirSync(bin)
const full='=== page 1 ===\n'+('source text '.repeat(30000))+'\n=== page 500 ===\nFINAL EVIDENCE'
writeFileSync(join(root,'full.txt'),full)
writeFileSync(join(bin,'hs-pdf'),'#!/bin/sh\ncat '+JSON.stringify(join(root,'full.txt'))+'\n',{mode:0o755})
process.env.PATH=bin+':'+process.env.PATH
writeFileSync(join(root,'paper.pdf'),Buffer.alloc(3500000,65))
const factory=(await import(pathToFileURL(join(root,'guard.mjs')))).default
const hooks=await factory({directory:root});const args={filePath:join(root,'paper.pdf')}
await hooks['tool.execute.before']({tool:'read'},{args});assert.equal(readFileSync(args.filePath,'utf8'),full)
const url='data:application/pdf;base64,'+readFileSync(join(root,'paper.pdf')).toString('base64')
const original={type:'tool',state:{status:'completed',input:{filePath:join(root,'paper.pdf')},output:'PDF read successfully',attachments:[{mime:'application/pdf',url}]}}
const context={messages:[{parts:[original]}]};assert.ok(JSON.stringify(context).length>4500000)
await hooks['experimental.chat.messages.transform']({},context)
assert.equal(original.state.attachments[0].url,url,'stored tool record stays intact')
assert.equal(context.messages[0].parts[0].state.attachments.length,0)
assert.ok(JSON.stringify(context).length<2000)
const userFile={type:'file',mime:'application/pdf',url};const user={messages:[{parts:[userFile]}]}
await hooks['experimental.chat.messages.transform']({},user);assert.equal(user.messages[0].parts[0].type,'text');assert.equal(userFile.type,'file')
await assert.rejects(hooks['tool.execute.before']({tool:'read'},{args:{filePath:join(root,'../outside.pdf')}}))
console.log('large PDF transport guarded; complete 500-page text and original history preserved')
