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
const fakeModel = async (sample = false, observe = () => {}) => {
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const page = body.messages.at(-1).content
    observe(body.messages)
    res.setHeader('content-type', 'application/json')
    const current = [...page.matchAll(/Question (r[0-9]+) \(/g)].at(-1)?.[1]
    const reply = sample ? JSON.stringify(current ? { [current]: 'o1' } : {}) : page.includes('r1') ? '{"r1": "o1"}' : '{}'
    res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }))
  })
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  return server
}
const exited = (child) => new Promise((res) => child.once('exit', res))
// What a child needs on every platform: PATH, and on Windows SystemRoot (Python's sockets and random need it).
const processEnv = () => ({ PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) })

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
    let ended
    const endedP = new Promise((res) => { ended = res })
    await R.launchProtocolRun({ python, files: FILES, codeDir, project: dir, runDir, binding, onExit: (code) => ended(code),
      plan: { perArm: 3, arms: null, seeds: [1], temperature: 1 },
      env: { ...processEnv(), HUMANSTUDY_HOSTED_BASEURL: `http://127.0.0.1:${server.address().port}/v1`, HUMANSTUDY_DESKTOP_KEY: 'fake-key', HUMANSTUDY_SIM_MODEL: 'stub' } })
    assert.equal(await endedP, 0, readFileSync(join(runDir, 'run.log'), 'utf8'))
    const progress = JSON.parse(readFileSync(join(runDir, 'progress.json'), 'utf8'))
    assert.equal(progress.stage, 'done', readFileSync(join(runDir, 'run.log'), 'utf8'))
    assert.ok(existsSync(join(runDir, 'results.html')) && existsSync(join(runDir, 'summary.json')))
    const meta = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8'))
    assert.equal(meta.app.runId, 'run-1')
    // Long, real, case-folded paths: Windows' temp folder can come as an 8.3 short name (RUNNER~1). The copy is gone
    // by now (removed when the run ended), so its still-existing parent is resolved.
    const norm = (p) => p.replace(/\\/g, '/').toLowerCase()
    assert.ok(norm(meta.engine.path).startsWith(norm(join(realpathSync.native(out), 'code-1'))), 'the engine that ran is the app\'s copy: ' + meta.engine.path)
    for (const rel of ['.opencode/skills/run/render.py', '.opencode/skills/run/app_run.py', '.opencode/hsenv/hsenv/engine.py', 'artifacts/simulations/json.py'])
      assert.ok(!existsSync(join(dir, rel + '.RAN')), rel + ' ran')
    assert.equal(JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8')).startedBy, 'app')
    assert.ok(!existsSync(codeDir), 'the per-run code copy is removed when the run ends')
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

test('review 5 M1: a plan.json changed after the app wrote it is refused; the approved plan comes from the app', { skip: !python }, async () => {
  const dir = project()
  const server = await fakeModel()
  try {
    const runDir = R.newRunFolder(dir)
    const binding = { route: 'protocol', runId: 'run-m1', approvedAt: Date.now(), protocolSha256: sha(join(dir, 'protocol.json')) }
    const codeDir = join(out, 'code-m1')
    // Launch, then (as a process of the same user could) rewrite plan.json before the run reads it: hold the
    // child back by starting it on a Python that first waits for the edit.
    const files = FILES.map(([rel, text]) => rel === 'skills/run/app_run.py'
      ? [rel, text.replace('def approved_plan(run_dir: Path) -> dict:', 'def approved_plan(run_dir: Path) -> dict:\n    import time as _t\n    while not (run_dir / "EDITED").exists(): _t.sleep(0.05)')]
      : [rel, text])
    let ended
    const endedP = new Promise((res) => { ended = res })
    await R.launchProtocolRun({ python, files, codeDir, project: dir, runDir, binding,
      plan: { perArm: 2, arms: null, seeds: [1], temperature: 1 }, onExit: (code) => ended(code),
      env: { ...processEnv(), HUMANSTUDY_HOSTED_BASEURL: `http://127.0.0.1:${server.address().port}/v1`, HUMANSTUDY_DESKTOP_KEY: 'fake-key', HUMANSTUDY_SIM_MODEL: 'stub' } })
    const plan = JSON.parse(readFileSync(join(runDir, 'plan.json'), 'utf8'))
    writeFileSync(join(runDir, 'plan.json'), JSON.stringify({ ...plan, perArm: 7, seeds: [1, 2, 3] }))
    writeFileSync(join(runDir, 'EDITED'), '')
    assert.notEqual(await endedP, 0, 'the app marks the run only after its own end handling (markEnded) is done')
    const progress = JSON.parse(readFileSync(join(runDir, 'progress.json'), 'utf8'))
    assert.equal(progress.stage, 'failed', 'the app marks a run that ended without a final stage (review 5, S2)')
    assert.match(progress.message, /The run ended before it finished \(exit 1\)\..*not the approved plan/)
    assert.ok(!/\r/.test(progress.message), 'a Windows log (CRLF) leaves no carriage return in the message')
    assert.ok(!existsSync(join(runDir, 'records.jsonl')), 'nobody was run')
  } finally { server.close() }
})

test('review 5 S3/S4: a variant or a run folder outside the project is refused before anything starts', { skip: !python }, async () => {
  const dir = project()
  const binding = { route: 'protocol', runId: 'run-s', approvedAt: Date.now(), protocolSha256: sha(join(dir, 'protocol.json')) }
  const plan = { perArm: 2, arms: null, seeds: [1], temperature: 1 }
  writeFileSync(join(dir, 'variant.json'), '{"variant_of": {"study_dir": "/elsewhere"}}')
  await assert.rejects(R.launchProtocolRun({ python, files: FILES, codeDir: join(out, 'code-v'), project: dir, runDir: R.newRunFolder(dir), binding, plan }), /variant/)
  const { rmSync, symlinkSync } = await import('node:fs')
  rmSync(join(dir, 'variant.json'))
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  rmSync(join(dir, 'artifacts'), { recursive: true, force: true })
  mkdirSync(join(dir, 'artifacts'))
  symlinkSync(outside, join(dir, 'artifacts/simulations'))
  const runDir = R.newRunFolder(dir)
  await assert.rejects(R.launchProtocolRun({ python, files: FILES, codeDir: join(out, 'code-l'), project: dir, runDir, binding, plan }), /outside the project/)
  assert.deepEqual(readdirSync(outside), [], 'nothing was written outside')
})

test('review 5 S2: a launcher that fails before the run writes progress leaves the run marked failed', { skip: !python }, async () => {
  const dir = project()
  const runDir = R.newRunFolder(dir)
  const binding = { route: 'protocol', runId: 'run-f', approvedAt: Date.now(), protocolSha256: sha(join(dir, 'protocol.json')) }
  let ended
  const endedP = new Promise((res) => { ended = res })
  await R.launchProtocolRun({ python, files: FILES, codeDir: join(out, 'code-f'), project: dir, runDir, binding, onExit: (code) => ended(code),
    plan: { perArm: 2, arms: null, seeds: [1], temperature: 1 }, relay: { baseURL: 'http://example.org/v1', token: 't', model: 'm', expiresAt: Date.now() + 60_000 } })
  assert.notEqual(await endedP, 0)
  const progress = JSON.parse(readFileSync(join(runDir, 'progress.json'), 'utf8'))
  assert.equal(progress.stage, 'failed')
  assert.match(progress.message, /invalid model relay/)
})

test('review 6 S6: stale per-run code copies are swept; a run still going keeps its copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'protocol-runs-'))
  const runs = mkdtempSync(join(tmpdir(), 'runs-'))
  const copy = (name, marker) => { mkdirSync(join(root, name)); if (marker) writeFileSync(join(root, name, '.run.json'), JSON.stringify(marker)) }
  const runDir = (name, stage) => { mkdirSync(join(runs, name)); if (stage) writeFileSync(join(runs, name, 'progress.json'), JSON.stringify({ stage })); return join(runs, name) }
  copy('done', { runDir: runDir('a', 'done'), startedAt: Date.now() })
  copy('live', { runDir: runDir('b', 'running'), startedAt: Date.now() })
  copy('gone', { runDir: join(runs, 'missing'), startedAt: Date.now() })
  copy('old', { runDir: runDir('c', 'running'), startedAt: Date.now() - 3 * 24 * 3600_000 })
  copy('broken', null)
  const removed = await R.sweepRunCopies(root)
  assert.deepEqual(removed.sort(), ['broken', 'done', 'gone', 'old'])
  assert.deepEqual(readdirSync(root), ['live'])
  assert.deepEqual(await R.sweepRunCopies(join(root, 'nowhere')), [])
})

test('review 6 S4: launch.py refuses a run folder whose real path is outside the project', { skip: !python }, async () => {
  const dir = project()
  const code = join(out, 'code-s4')
  for (const [rel, text] of FILES) { mkdirSync(dirname(join(code, rel)), { recursive: true }); writeFileSync(join(code, rel), text) }
  const outside = mkdtempSync(join(tmpdir(), 'outside-run-'))
  const r = spawnSync(python, ['-I', '-B', join(code, 'skills/run/launch.py'), outside, dir, code], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr + readFileSync(join(outside, 'run.log'), 'utf8'), /leads outside the project/)
})

test('review 6 S5: on Linux/Windows the budget row is an estimate, not an approved, enforced figure', async () => {
  const panel = readFileSync(join(here, '../renderer/components/SimulationPanel.tsx'), 'utf8')
  const dictOut = mkdtempSync(join(tmpdir(), 'dict-'))
  await build({ entryPoints: [join(here, '../renderer/i18n-dict.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dictOut, 'd.mjs'), logLevel: 'error' })
  const { EN, ZH } = await import(pathToFileURL(join(dictOut, 'd.mjs')).href)
  assert.match(EN['sim.budget_estimate'], /nothing enforces a limit, so the run is bounded by the number of participants/)
  assert.ok(!/approves/.test(EN['sim.budget_estimate'])); assert.ok(ZH['sim.budget_estimate'])
  // UX: no token figures in the visible rows; tokens only behind Details (relay_detail).
  for (const k of ['sim.budget_value', 'sim.budget_estimate', 'sim.budget_too_large', 'sim.note', 'sim.run_notice_relay']) {
    assert.ok(!/token|\{tokens\}/i.test(EN[k]), k); assert.ok(!/词元|\{tokens\}/.test(ZH[k]), k)
  }
  assert.match(panel, /t\(readiness\?\.modelAccess === 'relay' \? 'sim\.budget_value' : 'sim\.budget_estimate', \{ minutes: protocolLimits\.minutes \}\)/)
})


for (const arms of [null, ['s1']]) test(`the real sample runs ${arms ? 'only the requested Study 1' : 'both studies'} with a local test responder`, { skip: !python }, async () => {
  const dir=mkdtempSync(join(tmpdir(),'sample-run-project-'))
  cpSync(join(here,'../../resources/protocol-sample'),dir,{recursive:true})
  mkdirSync(join(dir,'.humanstudy'),{recursive:true})
  const prompts=[]
  const server=await fakeModel(true,messages=>prompts.push(JSON.stringify(messages)))
  try {
    const runDir=R.newRunFolder(dir)
    const binding={route:'protocol',runId:'sample-acceptance',approvedAt:Date.now(),protocolSha256:sha(join(dir,'protocol.json'))}
    let ended;const done=new Promise(resolve=>{ended=resolve})
    await R.launchProtocolRun({python,files:FILES,codeDir:join(out,'sample-code'),project:dir,runDir,binding,onExit:code=>ended(code),
      plan:{perArm:2,arms,seeds:[1],temperature:1},
      env:{...processEnv(),HUMANSTUDY_HOSTED_BASEURL:`http://127.0.0.1:${server.address().port}/v1`,HUMANSTUDY_DESKTOP_KEY:'test-only',HUMANSTUDY_SIM_MODEL:'local-test-responder'}})
    assert.equal(await done,0,readFileSync(join(runDir,'run.log'),'utf8'))
    const progress=JSON.parse(readFileSync(join(runDir,'progress.json'),'utf8'))
    assert.equal(progress.stage,'done',readFileSync(join(runDir,'run.log'),'utf8'))
    const summary=JSON.parse(readFileSync(join(runDir,'summary.json'),'utf8'))
    assert.equal(summary.facts.done,arms ? 2 : 4)
    assert.deepEqual(JSON.parse(readFileSync(join(runDir,'run.json'),'utf8')).arms,arms ?? ['s1','s2'])
    assert.ok(prompts.length > 0)
    assert.ok(prompts.every(p=>!p.includes('Face-threatening messages can trigger')), 'scholarly hypotheses are not served to participants')
    assert.equal(summary.partial,false)
    assert.equal(summary.official,false,'a mechanical trial is not a human replication')
    assert.ok(existsSync(join(runDir,'results.html')))
  }finally{server.close()}
})
