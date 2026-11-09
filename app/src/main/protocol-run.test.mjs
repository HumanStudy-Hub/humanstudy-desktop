// node --test src/main/protocol-run.test.mjs — an approved protocol run is started by the main process from the
// app's trusted copy (review 4, S1): code outside the project, plan.json from the checked approval, nothing the
// agent can edit on the run's sys.path. A made-up fixture protocol and a local fake model only.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packDir = join(here, '../../../pack')
const out = mkdtempSync(join(tmpdir(), 'protocol-run-'))
await build({ entryPoints: [join(here, 'protocol-run.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'r.mjs'), logLevel: 'error' })
await build({ entryPoints: [join(here, 'model-relay.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'relay.mjs'), logLevel: 'error' })
const R = await import(pathToFileURL(join(out, 'r.mjs')).href)
const { startModelRelay } = await import(pathToFileURL(join(out, 'relay.mjs')).href)
const python = ['python3.12', 'python3.13', 'python3.11', 'python3'].map((p) =>
  spawnSync(p, ['-c', 'import sys; print(sys.executable) if sys.version_info >= (3, 11) else sys.exit(1)'], { encoding: 'utf8' }))
  .find((r) => r.status === 0)?.stdout.trim()

// The same layout as pack.ts trustedRunFiles(), read from the pack on disk.
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? (n === '__pycache__' ? [] : walk(join(d, n))) : [join(d, n)]))
const read = (p) => readFileSync(p, 'utf8')
const FILES = [
  ...walk(join(packDir, 'runtime/hsenv')).map((p) => ['hsenv/' + relative(join(packDir, 'runtime/hsenv'), p), read(p)]),
  ...['run_study.py', 'fspec.py', 'render.py', 'app_run.py', 'protocol_report.py', 'launch.py'].map((f) => ['skills/run/' + f, read(join(packDir, 'skills/run', f))]),
  ['skills/build/sandbox_run.py', read(join(packDir, 'skills/build/sandbox_run.py'))],
  ...readdirSync(join(packDir, 'artifact-kit')).filter((f) => f !== '__pycache__').map((f) => ['artifact-kit/' + f, read(join(packDir, 'artifact-kit', f))]),
  // The runtime's humanstudy_llm lives in the bundled Python's site-packages; this test Python has none, so the
  // test hands the shipped module over with the trusted code.
  ['skills/run/humanstudy_llm.py', read(join(packDir, 'runtime/lib/humanstudy_llm.py'))],
]

const project = () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-run-project-'))
  cpSync(join(here, 'fixtures/protocol-mini'), dir, { recursive: true })
  mkdirSync(join(dir, '.humanstudy'))
  // What an agent could leave in the project: none of it may run (the trusted run never imports from here).
  for (const rel of ['.opencode/skills/run/render.py', '.opencode/skills/run/app_run.py', '.opencode/hsenv/hsenv/engine.py', 'artifacts/simulations/json.py'])
    mkdirSync(dirname(join(dir, rel)), { recursive: true }), writeFileSync(join(dir, rel), "open(__file__ + '.RAN', 'w').write('x'); raise SystemExit('agent code ran')\n")
  return dir
}
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const fakeModel = async () => {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const page = body.messages.at(-1).content
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ message: { content: page.includes('r1') ? '{"r1": "o1"}' : '{}' }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }))
  })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  return server
}
const exited = (child) => new Promise((res) => child.once('exit', res))

test('a new run folder never reuses an existing one; plan.json comes from the approval and the app\'s hash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'runs-'))
  const at = new Date(2026, 10, 9, 14, 5)
  const first = R.newRunFolder(dir, at)
  assert.match(first, /artifacts[/\\]simulations[/\\]2026-11-09-1405$/)
  mkdirSync(first, { recursive: true })
  assert.match(R.newRunFolder(dir, at), /2026-11-09-1405-2$/)
  const plan = JSON.parse(R.planJson({ route: 'protocol', runId: 'r', approvedAt: 1, protocolSha256: 'abc' }, { perArm: 7, arms: null, seeds: [1], temperature: 1 }))
  assert.deepEqual(plan, { route: 'protocol', protocolSha256: 'abc', perArm: 7, arms: null, seeds: [1], temperature: 1, startedBy: 'app' })
})

test('the app refuses to start a run whose protocol changed after approval', async () => {
  const dir = project()
  await assert.rejects(R.launchProtocolRun({ python: 'python3', files: FILES, codeDir: join(out, 'code-x'), project: dir, runDir: join(dir, 'artifacts/simulations/x'),
    binding: { route: 'protocol', runId: 'x', approvedAt: Date.now(), protocolSha256: 'f'.repeat(64) }, plan: { perArm: 2, arms: null, seeds: [1], temperature: 1 } }), /changed after approval/)
  assert.ok(!existsSync(join(dir, 'artifacts/simulations/x/plan.json')))
})

test('pre-relay path: the app runs the protocol from its trusted copy; agent-written code in the project never runs', { skip: !python }, async () => {
  const dir = project()
  const server = await fakeModel()
  try {
    const runDir = R.newRunFolder(dir)
    const binding = { route: 'protocol', runId: 'run-1', approvedAt: Date.now(), protocolSha256: sha(join(dir, 'protocol.json')) }
    const codeDir = join(out, 'code-1')
    const child = await R.launchProtocolRun({ python, files: FILES, codeDir, project: dir, runDir, binding,
      plan: { perArm: 3, arms: null, seeds: [1], temperature: 1 },
      env: { PATH: process.env.PATH, HUMANSTUDY_HOSTED_BASEURL: `http://127.0.0.1:${server.address().port}/v1`, HUMANSTUDY_DESKTOP_KEY: 'fake-key', HUMANSTUDY_SIM_MODEL: 'stub' } })
    assert.equal(await exited(child), 0, readFileSync(join(runDir, 'run.log'), 'utf8'))
    const progress = JSON.parse(readFileSync(join(runDir, 'progress.json'), 'utf8'))
    assert.equal(progress.stage, 'done', readFileSync(join(runDir, 'run.log'), 'utf8'))
    assert.ok(existsSync(join(runDir, 'results.html')) && existsSync(join(runDir, 'summary.json')))
    const meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
    assert.equal(meta.app.runId, 'run-1')
    assert.ok(meta.engine.path.startsWith(realpathSync(codeDir)), 'the engine that ran is the app\'s copy: ' + meta.engine.path)
    for (const rel of ['.opencode/skills/run/render.py', '.opencode/skills/run/app_run.py', '.opencode/hsenv/hsenv/engine.py', 'artifacts/simulations/json.py'])
      assert.ok(!existsSync(join(dir, rel + '.RAN')), rel + ' ran')
    assert.equal(JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8')).startedBy, 'app')
  } finally { server.close() }
})

test('macOS: the app runs the protocol confined, through the relay only, and the relay closes when it ends', { skip: !python || process.platform !== 'darwin' }, async () => {
  const dir = project()
  const server = await fakeModel()
  let closed = false
  const relay = await startModelRelay({ project: dir, storage: join(out, 'relay-app'), model: 'stub', key: 'fake-upstream-sentinel',
    upstream: `http://127.0.0.1:${server.address().port}`, tokenCap: 200_000, onClose: () => { closed = true } })
  try {
    const runDir = R.newRunFolder(dir)
    const binding = { route: 'protocol', runId: 'run-2', approvedAt: Date.now(), protocolSha256: sha(join(dir, 'protocol.json')) }
    const child = await R.launchProtocolRun({ python, files: FILES, codeDir: join(out, 'code-2'), project: dir, runDir, binding,
      plan: { perArm: 2, arms: null, seeds: [1], temperature: 1 }, relay: { baseURL: relay.baseURL, token: relay.token, model: 'stub', expiresAt: relay.expiresAt },
      onExit: () => { void relay.close() } })
    assert.equal(await exited(child), 0, readFileSync(join(runDir, 'run.log'), 'utf8'))
    assert.equal(JSON.parse(readFileSync(join(runDir, 'progress.json'), 'utf8')).stage, 'done', readFileSync(join(runDir, 'run.log'), 'utf8'))
    assert.ok(readFileSync(join(runDir, 'llm-usage.jsonl'), 'utf8').length > 0, 'the run used the relay')
    for (const f of walk(runDir)) assert.ok(!readFileSync(f, 'utf8').includes('fake-upstream-sentinel'), f)
    await new Promise((res) => setTimeout(res, 100))
    assert.ok(closed, 'the run gave its model access back')
  } finally { await relay.close(); server.close() }
})
