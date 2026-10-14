import {test} from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {mkdtempSync,rmSync,readFileSync,existsSync,cpSync,mkdirSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath,pathToFileURL} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url)),appRoot=join(here,'../..')
const temp=mkdtempSync(join(tmpdir(),'editable-project-'))
const fixture={root:join(temp,'projects'),packaged:false,appRoot}
globalThis.__projectTest=fixture
const previous=Object.getOwnPropertyDescriptor(process,'resourcesPath')
Object.defineProperty(process,'resourcesPath',{value:join(temp,'resources'),configurable:true})
mkdirSync(fixture.root);mkdirSync(process.resourcesPath)
await build({entryPoints:[join(here,'projects.ts')],bundle:true,platform:'node',format:'esm',outfile:join(temp,'projects.mjs'),logLevel:'error',plugins:[{name:'electron-test-wiring',setup(b){
 b.onResolve({filter:/^(electron|\.\/settings|\.\/pack)$/},a=>({path:a.path,namespace:'project-fixture'}))
 b.onLoad({filter:/.*/,namespace:'project-fixture'},a=>({contents:a.path==='electron'?`export const app={get isPackaged(){return globalThis.__projectTest.packaged},getAppPath:()=>globalThis.__projectTest.appRoot};export const shell={trashItem:async()=>{throw Error('not used')}}`:a.path==='./settings'?`export const ensureProjectsRoot=()=>globalThis.__projectTest.root;export const getSettings=()=>({projectsRoot:globalThis.__projectTest.root})`:`export const installPack=async()=>{}`,loader:'js'}))
}}]})
const {createProject,listProjects}=await import(pathToFileURL(join(temp,'projects.mjs')))
process.on('exit',()=>{rmSync(temp,{recursive:true,force:true});delete globalThis.__projectTest;if(previous)Object.defineProperty(process,'resourcesPath',previous);else delete process.resourcesPath})
function check(dir){
 const p=JSON.parse(readFileSync(join(dir,'program.json'),'utf8'))
 assert.ok(existsSync(join(dir,'.humanstudy/project.json')))
 assert.equal(readFileSync(join(dir,'paper.pdf')).subarray(0,5).toString(),'%PDF-')
 assert.ok(existsSync(join(dir,p.source.filename)))
 for(const e of p.evidence)assert.equal(JSON.parse(readFileSync(join(dir,e.path),'utf8')).instructions,e.quote)
}
test('actual project creation produces an editable offline sample and lists its paper and program',async()=>{
 const dir=await createProject({name:'Sample',sample:true});check(dir)
 const list=await listProjects();assert.equal(list[0].hasPaper,true);assert.equal(list[0].hasProgram,true)
 const edited=join(dir,'experiment_1_help.json');const fs=await import('node:fs/promises');await fs.writeFile(edited,'{"myEdit":true}')
 const next=await createProject({name:'Sample',sample:true});assert.notEqual(next,dir);check(next)
 assert.equal(readFileSync(edited,'utf8'),'{"myEdit":true}')
})
test('packaged creation reads resources/sample independently of the source checkout',async()=>{
 fixture.packaged=true;cpSync(join(appRoot,'resources/sample'),join(process.resourcesPath,'sample'),{recursive:true})
 const dir=await createProject({name:'Packaged sample',sample:true});check(dir)
 rmSync(join(process.resourcesPath,'sample/experiment_2_help.json'))
 await assert.rejects(createProject({name:'Incomplete package',sample:true}),/required sample asset/)
 assert.equal((await listProjects()).some(p=>p.name==='Incomplete package'),false,'an incomplete project must never be listed as usable')
 fixture.packaged=false
})
test('sample cannot replace a user-selected paper',async()=>{
 await assert.rejects(createProject({name:'Conflict',sample:true,pdfPath:join(appRoot,'resources/sample/KNOBE.pdf')}),/sample.*PDF|sample.*paper/i)
 assert.equal(existsSync(join(fixture.root,'Conflict')),false)
})
