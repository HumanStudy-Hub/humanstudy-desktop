import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
const temp = await mkdtemp(join(tmpdir(), 'model-relay-'))
await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'model-relay.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'relay.mjs') })
const { startModelRelay, relayDescriptor } = await import(pathToFileURL(join(temp, 'relay.mjs')))
test('run capability, model allow-list, reservation cap, safe forwarding, and revocation', async () => {
  const seen = []
  const stub = createServer(async (req, res) => {
    const chunks = []; for await (const p of req) chunks.push(p)
    seen.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks)) })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: 'stub answer' } }], usage: { total_tokens: 3 }, secret_diagnostic: 'never forward' }))
  })
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
  const project = join(temp, 'project'); await mkdir(project)
  const storage = join(temp, 'app-owned')
  const relay = await startModelRelay({ project, storage, model: 'allowed', upstream: `http://127.0.0.1:${stub.address().port}`, key: 'fake-upstream-only', tokenCap: 1000 })
  const call = (body, token = relay.token) => fetch(relay.baseURL + '/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
  const body = { model: 'allowed', messages: [{ role: 'user', content: 'hello' }], max_tokens: 20 }
  try {
    assert.equal((await call(body, 'wrong')).status, 401)
    assert.equal((await call({ ...body, model: 'forbidden' })).status, 400)
    assert.equal((await call({ ...body, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://invalid.test' } }] }] })).status, 400)
    const response = await call({ ...body, provider: { order: ['evil'] }, n: 50 })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).choices[0].message.content, 'stub answer')
    assert.equal(seen[0].headers.authorization, 'Bearer fake-upstream-only')
    assert.equal(seen[0].body.provider, undefined); assert.equal(seen[0].body.n, undefined)
    assert.equal((await call({ ...body, max_tokens: 4096 })).status, 402)
    assert.equal(seen.length, 1)
    const log = await readFile(relayDescriptor(storage, project) + '.usage.jsonl', 'utf8')
    assert.ok(!log.includes('hello')); assert.ok(!log.includes('fake-upstream-only'))
    assert.ok(log.includes('total_tokens')); assert.ok(log.includes('reserved'))
  } finally { await relay.close(); await new Promise(resolve => stub.close(resolve)) }
  await assert.rejects(readFile(relayDescriptor(storage, project)))
  await assert.rejects(call(body))
})
test.after(() => rm(temp, { recursive: true, force: true }))

test('trusted launcher completes a real confined script through the relay and revokes it', { skip: process.platform !== 'darwin' }, async () => {
  const { spawn } = await import('node:child_process')
  const { writeFile, copyFile } = await import('node:fs/promises')
  const project = join(temp, 'integration-project')
  const storage = join(temp, 'integration-app')
  const run = join(project, 'artifacts/simulations/test')
  await mkdir(run, { recursive: true }); await mkdir(join(project, '.humanstudy'))
  const stub = createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    res.end(JSON.stringify({ choices: [{ message: { content: 'normal completion' } }] }))
  })
  await new Promise(resolve => stub.listen(0, '127.0.0.1', resolve))
  let closed = false
  const relay = await startModelRelay({ project, storage, model: 'allowed', key: 'fake-upstream-sentinel', upstream: `http://127.0.0.1:${stub.address().port}`, onClose: () => { closed = true } })
  const script = join(run, 'run.py')
  const repo = join(dirname(fileURLToPath(import.meta.url)), '../../..')
  await copyFile(join(repo, 'pack/runtime/lib/humanstudy_llm.py'), join(run, 'humanstudy_llm.py'))
  await copyFile(join(repo, 'pack/skills/export/agent/study_core.py'), join(run, 'study_core.py'))
  const helpers = join(project, '.opencode/skills/simulate'); await mkdir(helpers, { recursive: true })
  await copyFile(join(repo, 'pack/skills/simulate/simkit.py'), join(helpers, 'simkit.py'))
  await writeFile(script, `import os,sys
from pathlib import Path
RUN=Path(__file__).resolve().parent
sys.path.insert(0,str(RUN.parents[2]/'.opencode/skills/simulate'))
from simkit import SimRun
from humanstudy_llm import llm,model_name
from study_core import http_llm
assert model_name()=='allowed'
assert os.environ['OPENROUTER_API_KEY']!='fake-upstream-sentinel'
run=SimRun(RUN,plan={'A':1},model=model_name(),seed=1)
sessions=run.participants(lambda condition,index,rng: {'reply':llm('hello')})
assert sessions[0]['reply']=='normal completion'
assert http_llm(model_name())('study core completion')=='normal completion'
run.finish()
print('normal confined run succeeded')
`)

  try {
    const child = spawn(process.env.HUMANSTUDY_TEST_PYTHON || 'python3', [join(dirname(fileURLToPath(import.meta.url)), '../../../pack/skills/simulate/run_confined.py'), '--final', script], { env: { ...process.env, HUMANSTUDY_RELAY_REQUIRED: '1', HUMANSTUDY_RELAY_DESCRIPTOR: relayDescriptor(storage, project) } })
    let out = '', err = ''; child.stdout.on('data', p => { out += p }); child.stderr.on('data', p => { err += p })
    const code = await new Promise(resolve => child.once('exit', resolve))
    assert.equal(code, 0, err); assert.match(out, /normal confined run succeeded/)
    assert.ok(closed)
    await assert.rejects(readFile(relayDescriptor(storage, project)))
  } finally { await relay.close(); await new Promise(resolve => stub.close(resolve)) }
})

test('relay only on macOS with the system sandbox-exec; never decided from PATH', async () => {
  const { relaySupported, SANDBOX_EXEC } = await import(pathToFileURL(join(temp, 'relay.mjs')))
  assert.equal(SANDBOX_EXEC, '/usr/bin/sandbox-exec')
  const asked = []
  const has = (path) => { asked.push(path); return true }
  assert.equal(relaySupported('darwin', has), true)
  assert.deepEqual(asked, ['/usr/bin/sandbox-exec'])
  assert.equal(relaySupported('darwin', () => false), false, 'macOS without sandbox-exec takes the pre-relay path')
  for (const platform of ['linux', 'win32', 'freebsd']) assert.equal(relaySupported(platform, has), false, platform)
  const { existsSync } = await import('node:fs')
  assert.equal(relaySupported(), process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))
})

test('without the relay (Linux, Windows) the launcher runs the script exactly as before, with its key', async () => {
  const { spawn } = await import('node:child_process')
  const { writeFile } = await import('node:fs/promises')
  const run = join(temp, 'legacy-project/artifacts/simulations/test')
  await mkdir(run, { recursive: true })
  await writeFile(join(run, 'run.py'), `import os, sys
from pathlib import Path
assert Path.cwd().resolve() == Path(__file__).resolve().parent, 'runs in its run folder, as python run.py did'
assert os.environ['HUMANSTUDY_DESKTOP_KEY'] == 'fake-hosted-sentinel', 'pre-relay path: the key is in the environment'
assert 'HUMANSTUDY_RELAY_DESCRIPTOR' not in os.environ
print('legacy run ok', sys.argv[1:])
`)
  const env = { ...process.env, HUMANSTUDY_DESKTOP_KEY: 'fake-hosted-sentinel' }
  delete env.HUMANSTUDY_RELAY_REQUIRED; delete env.HUMANSTUDY_RELAY_DESCRIPTOR
  const child = spawn(process.env.HUMANSTUDY_TEST_PYTHON || 'python3', [join(dirname(fileURLToPath(import.meta.url)), '../../../pack/skills/simulate/run_confined.py'), '--final', join(run, 'run.py'), '--trial'], { env })
  let out = '', err = ''; child.stdout.on('data', p => { out += p }); child.stderr.on('data', p => { err += p })
  const code = await new Promise(resolve => child.once('exit', resolve))
  assert.equal(code, 0, err.replace(/fake-hosted-sentinel/g, '[key]'))
  assert.match(out, /legacy run ok \['--trial'\]/)
  assert.ok(!out.includes('fake-hosted-sentinel') && !err.includes('fake-hosted-sentinel'), 'the launcher never prints the key')
})
