import { build } from 'esbuild'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temp = await mkdtemp(join(tmpdir(), 'simulation-research-'))
await build({
  entryPoints: [fileURLToPath(new URL('simulation-research.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'bundle.mjs'),
})
const { simulationResearch } = await import(pathToFileURL(join(temp, 'bundle.mjs')).href)
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
