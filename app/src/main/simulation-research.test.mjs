import { build } from 'esbuild'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as pause } from 'node:timers/promises'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temp = await mkdtemp(join(tmpdir(), 'simulation-research-'))
await build({
  stdin: { contents: "export * from './simulation-research'; export * from './protocol-run'",
    resolveDir: dirname(fileURLToPath(import.meta.url)) },
  bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'bundle.mjs'),
})
const bundle = pathToFileURL(join(temp, 'bundle.mjs')).href
const { simulationResearch, detachedRunJournal } = await import(bundle)
test.after(() => rm(temp, { recursive: true, force: true }))

const runId = '22222222-2222-4222-8222-222222222222'
const scope = { study_id: 'study', revision: 'a'.repeat(64), per_condition: 2, model: 'anthropic/model' }

for (const [name, stage, code, signal, stop, shutdown, expected] of [
  ['successful result', 'done', 0, null, false, false, 'completed'],
  ['partial result with a zero exit code', 'failed', 0, null, false, false, 'failed'],
  ['process exits without a terminal stage', 'running', 1, null, false, false, 'failed'],
  ['stop marker after an interrupted process', 'running', null, 'SIGTERM', true, false, 'stopped'],
  ['explicit stopped stage', 'stopped', 0, null, false, false, 'stopped'],
  ['terminated by a signal', 'running', null, 'SIGTERM', false, false, 'interrupted'],
  ['launcher deadline', 'running', 124, null, false, false, 'interrupted'],
  ['app shutdown', 'running', null, null, false, true, 'interrupted'],
]) {
  test(name, async () => {
    const dir = join(await mkdtemp(join(temp, 'case-')), '2026-11-20-1329')
    await mkdir(dir)
    await writeFile(join(dir, 'plan.json'), '{}')
    await writeFile(join(dir, 'progress.json'), JSON.stringify({ stage }))
    if (expected === 'completed') await writeFile(join(dir, 'results.html'), '<p>Results</p>')
    if (stop) await writeFile(join(dir, 'STOP'), '')
    await writeFile(join(dir, 'llm-usage.jsonl'), '{"request_id":"req_1"}\n{"request_id":"req_1"}\n{"request_id":"req_2"}\n{')
    const events = []
    const run = simulationResearch(runId, scope, (type, data) => events.push({ type, data }))
    run.started(dir)
    if (shutdown) await run.interrupt()
    else await run.finish(code, signal)
    await run.finish(1, null)
    assert.deepEqual(events.map(e => e.type), ['approved', 'started', expected])
    for (const { data } of events) {
      assert.equal(data.run_id, runId)
      assert.deepEqual(data.scope, scope)
    }
    assert.deepEqual(events.at(-1).data.model_request_ids, ['req_1', 'req_2'])
    assert.deepEqual(events.at(-1).data.outputs, ['plan.json', 'progress.json', ...(expected === 'completed' ? ['results.html'] : [])]
      .map(name => 'artifacts/simulations/2026-11-20-1329/' + name))
  })
}

test('a launch failure produces a terminal result without a started event', async () => {
  const stages = []
  const run = simulationResearch(runId, scope, type => stages.push(type))
  await run.finish(null, null)
  run.started(temp)
  assert.deepEqual(stages, ['approved', 'failed'])
})

for (const method of ['finish', 'quit']) {
  test(`a failed journal write does not block ${method}`, async () => {
    const stages = []
    const run = simulationResearch(runId, scope, stage => stages.push(stage))
    run.started(temp, Promise.reject(Error('journal unavailable')))
    if (method === 'finish') await run.finish(0, null)
    else await run.quit()
    assert.deepEqual(stages, ['approved', 'started', method === 'finish' ? 'failed' : 'interrupted'])
  })
}

test('reconciliation rejects a reused PID and a previous boot', async () => {
  const root = await mkdtemp(join(temp, 'identity-'))
  const journal = detachedRunJournal(root)
  const marker = join(root, runId + '.json')
  await journal.remember(runId, { runDir: root, scope, pid: process.pid })
  const run = JSON.parse(await readFile(marker, 'utf8'))
  if (process.platform === 'linux') {
    assert.equal(run.bootId, (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim())
    assert.ok(run.processStartTime)
  }
  const stages = []
  const publisher = () => stage => stages.push(stage)
  if (run.processStartTime) {
    await journal.reconcile(publisher)
    assert.deepEqual(stages, [], 'identity still matches the live process')
  }
  for (const stale of [{ processStartTime: 'other process' }, { bootId: 'previous boot' }]) {
    stages.length = 0
    await writeFile(marker, JSON.stringify({ ...run, ...stale }))
    await journal.reconcile(publisher)
    assert.deepEqual(stages, ['interrupted'])
    assert.deepEqual(await readdir(root), [])
  }
})

test('large request lists are preserved in bounded parts', async () => {
  const dir = join(temp, 'many')
  await mkdir(dir)
  const ids = Array.from({ length: 189 }, (_, i) => 'req_' + i)
  await writeFile(join(dir, 'llm-usage.jsonl'), ids.map(request_id => JSON.stringify({ request_id })).join('\n'))
  const parts = []
  const run = simulationResearch(runId, scope, (type, data) => { if (type === 'failed') parts.push(data) })
  run.started(dir)
  await run.finish(1, null)
  assert.deepEqual(parts.map(({ part }) => part), [0, 1, 2, 3])
  assert.deepEqual(parts.flatMap(part => part.model_request_ids), ids)
})

// Windows: the runner is not detached and libuv puts it in a kill-on-close job object, so it ends with the app;
// the next start reconciles it as interrupted. Only macOS/Linux runners can outlive the app.
test('a detached runner can finish after the app quits and is reconciled once on the next start', { timeout: 8000, skip: process.platform === 'win32' && 'runner does not outlive the app on Windows' }, async () => {
  const projectDir = await mkdtemp(join(temp, 'detached-'))
  const journalDir = join(projectDir, 'journal')
  const runDir = join(projectDir, 'artifacts', 'simulations', 'run')
  const script = `
import json, pathlib, sys, time
out, project = map(pathlib.Path, sys.argv[1:3])
until = time.monotonic() + 5
while not (project / "release").exists():
    if time.monotonic() > until: sys.exit(1)
    time.sleep(0.01)
(out / "run.json").write_text(json.dumps(dict(status="done")), encoding="utf-8")
(out / "progress.json").write_text(json.dumps(dict(stage="done")), encoding="utf-8")
`
  const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim()
  const parent = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createHash } from 'node:crypto'
    import { appendFileSync } from 'node:fs'
    import { writeFile } from 'node:fs/promises'
    import { detachedRunJournal, simulationResearch, launchProtocolRun } from ${JSON.stringify(bundle)}
    const [projectDir, runDir, journalDir, runId, script, python] = process.argv.slice(1)
    const protocol = '{"id":"study"}'
    await writeFile(projectDir + '/protocol.json', protocol)
    const revision = createHash('sha256').update(protocol).digest('hex')
    const scope = { study_id: 'study', revision, per_condition: 2, model: 'fixture' }
    const journal = detachedRunJournal(journalDir)
    const run = simulationResearch(runId, scope, stage => appendFileSync(projectDir + '/stages', stage + '\\n'))
    await journal.prepare()
    await launchProtocolRun({
      python, files: [['skills/run/launch.py', script]], project: projectDir, runDir, codeDir: projectDir + '/code',
      binding: { route: 'protocol', runId, approvedAt: 0, protocolSha256: revision },
      plan: { perArm: 2, arms: null, seeds: [1], temperature: 1 }, exitFile: journal.exitFile(runId),
      onStart: pid => run.started(runDir, journal.remember(runId, { researchScope: 'fixture', projectDir, runDir, scope, pid })),
    })
    await run.quit()
    process.exit(0)
  `, projectDir, runDir, journalDir, runId, script, python], {
    env: { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  assert.deepEqual(await once(parent, 'exit'), [0, null])
  assert.equal(await readFile(join(projectDir, 'stages'), 'utf8'), 'approved\nstarted\n')
  await writeFile(join(projectDir, 'release'), '')
  const restarted = detachedRunJournal(journalDir)
  let code
  for (let i = 0; i < 100 && code === undefined; i++) {
    code = await readFile(restarted.exitFile(runId), 'utf8').catch(() => undefined)
    if (code === undefined) await pause(25)
  }
  assert.equal(code, '0', `runner outputs: ${(await readdir(runDir)).join(', ')}`)
  const events = []
  const publish = run => {
    assert.equal(run.projectDir, projectDir)
    return (stage, metadata) => { events.push({ stage, metadata }) }
  }
  await restarted.reconcile(publish)
  await restarted.reconcile(publish)
  assert.deepEqual(events.map(event => event.stage), ['completed'])
  assert.deepEqual(events[0].metadata.outputs.map(path => path.split('/').at(-1)), ['plan.json', 'run.json', 'progress.json'])
})
