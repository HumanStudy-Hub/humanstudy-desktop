import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'program-save-tests-'))
for (const name of ['program-save', 'program-lock']) await build({ entryPoints: [join(here, `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(out, `${name}.mjs`), logLevel: 'error' })
const { saveProjectText } = await import(pathToFileURL(join(out, 'program-save.mjs')))
const { withProgramLock } = await import(pathToFileURL(join(out, 'program-lock.mjs')))
const python = ['python3', 'python'].find(p => spawnSync(p, ['--version']).status === 0)
const helper = join(here, '../../../pack/skills/build/program_io.py')
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/complete-program.json'), 'utf8'))
const start = (args, cwd) => {
  const process = spawn(python, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  process.stdout.on('data', x => { stdout += x }); process.stderr.on('data', x => { stderr += x })
  const done = new Promise((resolve, reject) => { process.on('error', reject); process.on('exit', code => resolve({ code, stdout, stderr })) })
  return { process, done }
}
const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'program-save-'))
  const target = join(dir, 'program.json')
  writeFileSync(target, JSON.stringify(fixture))
  return { dir, target }
}

test('real Python batch waits for the app save, keeps the confirmed field and retains its complete conflicting proposal', { skip: !python }, async () => {
  const { dir, target } = project()
  const original = readFileSync(target, 'utf8')
  const human = structuredClone(fixture)
  Object.assign(human.nodes[0].fields[0], { value: 'Human correction — preserved', origin: 'researcher', state: 'confirmed' })
  const batch = { nodes: [{ id: 'participants', fields: [{ id: 'sample', value: 'Old model interpretation', origin: 'reported', state: 'check' }] }, { ...fixture.nodes[1], id: 'new-node', title: 'New work preserved' }] }
  writeFileSync(join(dir, 'batch.json'), JSON.stringify(batch))
  let child
  await saveProjectText(target, JSON.stringify(human), { ifUnchanged: original, beforeWrite: async () => {
    child = start([helper, 'batch.json'], dir)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(readFileSync(target, 'utf8'), original, 'agent must not enter while the app holds the lock')
    assert.equal(child.process.exitCode, null)
  } })
  const result = await child.done
  assert.equal(result.code, 0, result.stderr)
  assert.match(result.stderr, /Kept 1 confirmed researcher edit/)
  const saved = JSON.parse(readFileSync(target, 'utf8'))
  assert.equal(saved.nodes[0].fields[0].value, 'Human correction — preserved')
  assert.equal(saved.nodes[0].fields[0].origin, 'researcher')
  assert.ok(saved.nodes.some(n => n.id === 'new-node'))
  assert.ok(saved.issues.some(i => i.nodeId === 'participants' && i.fieldId === 'sample'))
  const reports = readdirSync(join(dir, '.humanstudy/program-conflicts'))
  const conflict = JSON.parse(readFileSync(join(dir, '.humanstudy/program-conflicts', reports[0]), 'utf8'))[0]
  assert.equal(conflict.proposed.value, 'Old model interpretation')
  assert.equal(conflict.kept.value, 'Human correction — preserved')
  assert.ok(!readdirSync(dir).some(n => n.endsWith('.lock') || n.endsWith('.tmp')))
})

test('app CAS is evaluated after the Python lock is released; a stale human save is rejected without losing either draft', { skip: !python }, async () => {
  const { dir, target } = project(), original = readFileSync(target, 'utf8')
  // Real Python lock, read, merge and replace, with a barrier to force the previously unsafe ordering.
  const code = `import sys,json,os\nsys.path.insert(0,sys.argv[1])\nfrom program_lock import program_lock\nfrom program_io import apply\nfrom pathlib import Path\np=Path('program.json')\nwith program_lock(p):\n prior=json.loads(p.read_text())\n print('locked',flush=True)\n sys.stdin.readline()\n merged=apply(prior,{'title':'New agent checkpoint'})\n Path('agent.tmp').write_text(json.dumps(merged))\n os.replace('agent.tmp',p)`
  const child = start(['-c', code, dirname(helper)], dir)
  await new Promise(resolve => child.process.stdout.once('data', resolve))
  const attempted = saveProjectText(target, JSON.stringify({ ...fixture, title: 'Human draft' }), { ifUnchanged: original })
  const rejected = assert.rejects(attempted, /changed on disk/)
  child.process.stdin.write('\n')
  assert.equal((await child.done).code, 0)
  await rejected
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).title, 'New agent checkpoint')
})

test('dead owners recover; a live lock times out without being stolen; failed saves release their lock', async () => {
  const { target } = project(), lock = target + '.lock'
  mkdirSync(lock); writeFileSync(join(lock, '2147483647-00000000-0000-0000-0000-000000000000'), '')
  await saveProjectText(target, JSON.stringify(fixture))
  await withProgramLock(target, async () => {
    await assert.rejects(withProgramLock(target, async () => assert.fail('lock stolen'), 60), /save is still in progress/)
  })
  await assert.rejects(saveProjectText(target, JSON.stringify(fixture), { beforeWrite: async () => { throw Error('disk failure fixture') } }), /disk failure/)
  await saveProjectText(target, JSON.stringify(fixture))
})

test('Python protects confirmed step rules and parent replacement, including value-only patches', { skip: !python }, () => {
  const code = `import sys,json\nsys.path.insert(0,sys.argv[1])\nfrom program_io import merge\nf={'id':'rule','value':'human','origin':'researcher','state':'confirmed'}\na={'rule':f,'other':1}\nconflicts=[]\nx=merge(a,{'rule':{'value':'agent'},'other':2},conflicts)\nassert x['rule']==f and x['other']==2 and len(conflicts)==1\nassert merge(a,None)==a\nassert merge([a],['replacement'])==[a]\nprint('protected')`
  const r = spawnSync(python, ['-c', code, dirname(helper)], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
})

test('app and agent taking the lock in tight turns never fail each other (Windows delete-pending lock folder)', { skip: !python }, async () => {
  // On Windows a just-removed lock folder refuses mkdir with access denied for a moment; both sides
  // must treat that as busy. Python churns the lock for 3 s while the app takes it 40 times.
  const { dir, target } = project()
  const code = `import sys,time\nsys.path.insert(0,sys.argv[1])\nfrom program_lock import program_lock\nend=time.monotonic()+3\nn=0\nwhile time.monotonic()<end:\n with program_lock('program.json'):\n  n+=1\nprint(n)`
  const churn = start(['-c', code, dirname(helper)], dir)
  let taken = 0
  for (let i = 0; i < 40; i++) await withProgramLock(target, async () => { taken++ })
  const r = await churn.done
  assert.equal(r.code, 0, r.stderr)
  assert.equal(taken, 40)
  assert.ok(Number(r.stdout) > 0)
  assert.ok(!readdirSync(dir).some(n => n.endsWith('.lock')))
})
