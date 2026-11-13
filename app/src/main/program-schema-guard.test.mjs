import {test} from 'node:test'
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {fileURLToPath} from 'node:url'
const here=dirname(fileURLToPath(import.meta.url))
const checker=join(here,'../../../pack/skills/build/check_program.py')
const python=process.env.HUMANSTUDY_TEST_PYTHON || 'python3'
const sample=readFileSync(join(here,'fixtures/complete-program.json'),'utf8')

function fixture(run) {
 const root=mkdtempSync(join(tmpdir(),'program-schema-guard-'))
 try { writeFileSync(join(root,'program.json'),sample); run(root) }
 finally { rmSync(root,{recursive:true,force:true}) }
}
function check(root,script=checker,args=[]) {
 return spawnSync(python,[...args,script,join(root,'program.json'),'--complete'],{encoding:'utf8'})
}
test('completion fails closed when the validator dependency cannot load',()=>fixture(root=>{
 const result=check(root,checker,['-S']) // isolated interpreter: no site-packages/jsonschema
 assert.equal(result.status,1,result.stderr)
 assert.match(result.stdout,/schema validation unavailable: jsonschema/)
 assert.match(result.stdout,/managed Python runtime/)
 assert.doesNotMatch(result.stdout,/^PASS/m)
}))
test('completion fails closed when the installed schema is missing',()=>fixture(root=>{
 const script=join(root,'isolated','pack','skills','build','check_program.py')
 mkdirSync(dirname(script),{recursive:true});copyFileSync(checker,script)
 const result=check(root,script)
 assert.equal(result.status,1,result.stderr)
 assert.match(result.stdout,/human-program.schema.json is missing/)
 assert.doesNotMatch(result.stdout,/^PASS/m)
}))
test('managed validator accepts a complete valid Program and rejects a schema-invalid field',()=>fixture(root=>{
 const valid=check(root)
 assert.equal(valid.status,0,valid.stdout+valid.stderr)
 assert.match(valid.stdout,/^PASS/m)
 const invalid=JSON.parse(sample);invalid.title=123
 writeFileSync(join(root,'program.json'),JSON.stringify(invalid))
 const result=check(root)
 assert.equal(result.status,1,result.stderr)
 assert.match(result.stdout,/schema: title/)
 assert.doesNotMatch(result.stdout,/^PASS/m)
}))
