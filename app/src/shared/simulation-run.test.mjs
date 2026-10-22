// node src/shared/simulation-run.test.mjs — the Simulation tab's pure helpers.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'simulation-run-'))
await build({ stdin: { contents: "export * from './simulation-run'; export { approvalRequest, simulationScope, simulationLimits } from './simulation-scope'", resolveDir: here, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'sim.mjs'), logLevel: 'error' })
const S = await import(pathToFileURL(join(out, 'sim.mjs')).href)
const sample = JSON.parse(readFileSync(join(here, 'sample-program.json'), 'utf8'))

// progress.json as simkit writes it
const p = S.parseProgress(JSON.stringify({ stage: 'running', done: 12, total: 40, failed: 1, conditions: [{ id: 'harm', done: 6, total: 20 }, { id: 'help', done: 6, total: 20 }], model: 'anthropic/claude-haiku-5.5', startedAt: '2026-10-15T21:02:50Z', updatedAt: '2026-10-15T21:03:50Z' }))
assert.equal(p.stage, 'running'); assert.equal(p.done, 12); assert.equal(p.total, 40); assert.equal(p.failed, 1)
assert.deepEqual(p.conditions.map((c) => c.id), ['harm', 'help'])
assert.equal(p.updatedAt - p.startedAt, 60_000)
// tolerant: other spellings, counts only per condition, half-written file
const q = S.parseProgress(JSON.stringify({ status: 'Simulating', arms: { harm: { completed: 3, n: 5 }, help: { completed: 2, n: 5 } } }))
assert.equal(q.stage, 'running'); assert.equal(q.done, 5); assert.equal(q.total, 10)
assert.equal(S.parseProgress('{"stage": "runn'), null)
assert.equal(S.parseProgress(''), null)
assert.equal(S.parseProgress(JSON.stringify({ stage: 'error', message: 'The evaluation failed' })).stage, 'failed')
assert.equal(S.parseProgress(JSON.stringify({ stage: 'smoke test' })).stage, 'trial')
assert.equal(S.parseProgress(JSON.stringify({ stage: 'done', done: 99, total: 40 })).done, 40, 'done never exceeds total')

// summary.json
const sum = S.parseSummary(JSON.stringify({ outcome: 'replicated', paragraph: 'All 20 said yes.', paragraph_zh: '全部回答是。', perCondition: 20, example: true }))
assert.equal(sum.outcome, 'replicated'); assert.equal(sum.example, true); assert.equal(sum.paragraph, 'All 20 said yes.')
assert.equal(S.parseSummary(JSON.stringify({ outcome: 'replicated', paragraph: 'All 20 said yes.', paragraph_zh: '全部回答是。' }), 'zh-CN').paragraph, '全部回答是。')
assert.equal(S.parseSummary(JSON.stringify({ outcome: 'not replicated', paragraph: 'x' })).outcome, 'not_replicated')
assert.equal(S.parseSummary(JSON.stringify({ outcome: 'Partly', paragraph: 'x' })).outcome, 'partly')
assert.equal(S.parseSummary(JSON.stringify({ outcome: 'replicated' })), null, 'no paragraph, no summary')
const shipped = S.parseSummary(readFileSync(join(here, '../../resources/sample/example-simulation/summary.json'), 'utf8'), 'zh-CN')
assert.ok(shipped.example && shipped.paragraph.includes('董事长'), 'the shipped example is labelled and has a Chinese summary')

// run folders from the project tree
const f = (rel, mtime = 1) => ({ name: rel.split('/').pop(), path: `/p/${rel}`, rel, kind: 'file', mtime })
const d = (rel, children) => ({ name: rel.split('/').pop(), path: `/p/${rel}`, rel, kind: 'dir', children })
const tree = [d('artifacts', [d('artifacts/simulations', [
  d('artifacts/simulations/2026-10-15-1329-example', [f('artifacts/simulations/2026-10-15-1329-example/results.html', 5), f('artifacts/simulations/2026-10-15-1329-example/summary.json', 5)]),
  d('artifacts/simulations/2026-10-16-0910', [f('artifacts/simulations/2026-10-16-0910/progress.json', 9)]),
  f('artifacts/simulations/notes.md'),
])])]
const runs = S.runFolders(tree)
assert.deepEqual(runs.map((r) => r.id), ['2026-10-16-0910', '2026-10-15-1329-example'])
assert.equal(runs[0].progress, '/p/artifacts/simulations/2026-10-16-0910/progress.json')
assert.equal(runs[0].results, undefined); assert.equal(runs[1].results, '/p/artifacts/simulations/2026-10-15-1329-example/results.html')
assert.equal(runs[1].mtime, 5)
assert.deepEqual(S.runFolders([]), [])
assert.equal(new Date(S.runDate('2026-10-15-1329-example')).getHours(), 13)
assert.equal(S.runDate('latest'), null)

// run state: from the run itself (its folder and progress.json), never from chat activity
const now = 1_000_000
assert.equal(S.runState({ results: 'x' }, { stage: 'done' }, now, 0), 'done')
assert.equal(S.runState({}, { stage: 'failed' }, now, 0, true), 'failed')
assert.equal(S.runState({}, { stage: 'running', updatedAt: now - 10_000 }, now, 0), 'running', 'a detached run.py keeps going after the agent turn')
assert.equal(S.runState({}, { stage: 'running', updatedAt: now - 300_000 }, now, 0), 'stopped', 'progress that stopped moving')
assert.equal(S.runState({}, { stage: 'running', updatedAt: now - 300_000 }, now, 0, true), 'running', 'the turn that started this run is still working')
assert.equal(S.runState({ results: 'x' }, { stage: 'writing' }, now, 0, true), 'running', 'the agent is still writing the results page')
assert.equal(S.runState({ results: 'x' }, { stage: 'writing' }, now, 0), 'done')
// #16 (1): asking the agent about a report must not revive a stopped run. runState has no notion of
// "the agent is busy"; only the run's own turn (owned) counts, and a STOP file always wins.
assert.equal(S.runState.length, 4, 'runState takes no agent-busy input')
assert.equal(S.runState({}, { stage: 'stopped', updatedAt: now - 1_000 }, now, 0), 'stopped')
assert.equal(S.runState({}, { stage: 'running', updatedAt: now - 120_000 }, now, now - 120_000), 'stopped', 'a stopped run stays stopped while the agent answers a question')
// #16 (4): Stop during preparation: the STOP file ends the run at once, even with fresh files and the turn alive.
assert.equal(S.runState({ stop: true }, { stage: 'preparing', updatedAt: now - 1_000 }, now, now), 'stopped')
assert.equal(S.runState({ stop: true }, null, now, now, true), 'stopped', 'a folder with only run.py and STOP')
assert.equal(S.runState({ stop: true, results: 'x' }, { stage: 'done' }, now, 0), 'done', 'a run that finished before Stop stays a result')

// #16: a quiet stage of a live run is not "stopped". simkit's heartbeat says the process is alive;
// after run.py exits, the agent has the write-up window. Stopped only on STOP or when nothing is behind it.
const hb = (o) => S.parseProgress(JSON.stringify(o))
const iso = (ms) => new Date(ms).toISOString()
const scoring = hb({ stage: 'scoring', runner: 'alive', updatedAt: iso(now - 10 * 60_000), heartbeatAt: iso(now - 15_000) })
assert.equal(scoring.runner, 'alive'); assert.equal(now - scoring.heartbeatAt, 15_000)
assert.equal(S.runState({}, scoring, now, now - 15_000), 'running', 'a 10-minute scoring step with a live heartbeat')
assert.equal(S.runState({}, hb({ stage: 'scoring', runner: 'alive', updatedAt: iso(now - 10 * 60_000), heartbeatAt: iso(now - 120_000) }), now, now - 120_000), 'stopped', 'heartbeat stale: the process is gone')
assert.equal(S.runState({ stop: true }, scoring, now, now), 'stopped', 'STOP wins over a live heartbeat')
const writing = hb({ stage: 'writing', runner: 'exited', updatedAt: iso(now - 8 * 60_000) })
assert.equal(S.runState({}, writing, now, now - 8 * 60_000), 'running', 'run.py ended; the agent is writing up (8 quiet minutes)')
assert.equal(S.runState({}, writing, now, now - 60_000), 'running', 'report.md just written')
assert.equal(S.runState({}, hb({ stage: 'writing', runner: 'exited', updatedAt: iso(now - 25 * 60_000) }), now, now - 25 * 60_000), 'stopped', 'nothing written for the whole write-up window')
assert.equal(S.runState({}, hb({ stage: 'trial', runner: 'exited', updatedAt: iso(now - 60_000) }), now, now - 60_000), 'stopped', 'a finished trial is not a run being written up')
assert.equal(S.runState({}, hb({ stage: 'running', runner: 'exited', updatedAt: iso(now - 60_000) }), now, now - 60_000), 'stopped', 'run.py exited before scoring')
assert.equal(S.runState({}, hb({ stage: 'running', updatedAt: iso(now - 120_000) }), now, now - 120_000), 'stopped', 'older packs without a heartbeat keep the 90 s rule')

// #16 (3): a run counts as a result only with participant data
const tree3 = [d('artifacts', [d('artifacts/simulations', [
  d('artifacts/simulations/2026-10-20-0900', [f('artifacts/simulations/2026-10-20-0900/run.py'), f('artifacts/simulations/2026-10-20-0900/STOP')]),
  d('artifacts/simulations/2026-10-20-1000', [f('artifacts/simulations/2026-10-20-1000/results.html'), { ...f('artifacts/simulations/2026-10-20-1000/sessions.jsonl'), size: 0 }]),
  d('artifacts/simulations/2026-10-20-1100', [f('artifacts/simulations/2026-10-20-1100/results.html'), { ...f('artifacts/simulations/2026-10-20-1100/sessions.jsonl'), size: 812 }]),
  d('artifacts/simulations/2026-10-20-1200', []),
])])]
const [empty, real, blank, aborted] = S.runFolders(tree3)
assert.deepEqual([empty.id, real.id, blank.id, aborted.id], ['2026-10-20-1200', '2026-10-20-1100', '2026-10-20-1000', '2026-10-20-0900'])
assert.equal(aborted.stop, true); assert.equal(real.sessions, '/p/artifacts/simulations/2026-10-20-1100/sessions.jsonl'); assert.equal(real.sessionsSize, 812)
assert.equal(S.hasParticipantData(empty, null), false, 'an empty folder')
assert.equal(S.hasParticipantData(aborted, S.parseProgress('{"stage":"preparing","total":40}')), false, 'aborted while preparing')
assert.equal(S.hasParticipantData(blank, null), false, 'an empty sessions.jsonl')
assert.equal(S.hasParticipantData(real, null), true)
assert.equal(S.isResult(blank, null, 'done'), false, 'a results page without participants is not a result')
assert.equal(S.isResult(real, null, 'done'), true)
assert.equal(S.isResult(real, null, 'running'), false)
assert.equal(S.isResult(runs[1], S.parseProgress(readFileSync(join(here, '../../resources/sample/example-simulation/progress.json'), 'utf8')), 'done'), true, 'the shipped example (participant counts in progress.json) is still a result')
assert.equal(S.isResult(runs[1], null, 'done'), false)

// the plan from the study document
const plan = S.simulationPlan(sample, 'exp-1')
assert.deepEqual(plan.conditions.map((c) => c.label), ['Harm', 'Help'])
assert.equal(plan.paperPerCondition, 39); assert.equal(plan.defaultPerCondition, 39)
assert.equal(S.simulationPlan(sample, 'exp-2').paperPerCondition, 21)
assert.equal(S.sampleFor('Experiment 1: 78; Experiment 2: 42 (120 in total).', 'X', 1, 2), 42)
assert.equal(S.sampleFor({ 'Experiment 1': { n: 78 } }, 'Experiment 1', 0, 2), 78)
assert.equal(S.sampleFor('N = 240 students', '', 0, 1), 240)
assert.equal(S.sampleFor('two hundred', '', 0, 1), null)
const bare = { ...sample, nodes: sample.nodes.filter((n) => n.kind !== 'participants') }
assert.equal(S.simulationPlan(bare, 'exp-1').defaultPerCondition, 20, 'no sample size stated: 20 per condition')

// estimate: grows with participants, building adds time, honest ranges
const small = S.estimateRun({ conditions: 2, perCondition: 10, model: 'anthropic/claude-haiku-5.5', needsBuild: false })
const big = S.estimateRun({ conditions: 2, perCondition: 60, model: 'anthropic/claude-haiku-5.5', needsBuild: false })
const sonnet = S.estimateRun({ conditions: 2, perCondition: 10, model: 'anthropic/claude-sonnet-5.5', needsBuild: false })
const withBuild = S.estimateRun({ conditions: 2, perCondition: 10, model: 'anthropic/claude-haiku-5.5', needsBuild: true })
assert.equal(small.participants, 20); assert.equal(big.participants, 120)
assert.ok(big.cost[1] > small.cost[1] && big.minutes[1] >= small.minutes[1])
assert.ok(sonnet.cost[0] > small.cost[0] * 10, 'Sonnet costs about twenty times Haiku')
assert.ok(withBuild.minutes[0] > small.minutes[0] && withBuild.cost[1] > small.cost[1])
assert.ok(small.minutes[0] < small.minutes[1] && small.cost[0] < small.cost[1])
assert.ok(small.cost[1] < 0.5, `a Haiku pilot stays cheap: ${small.cost}`)
assert.deepEqual(S.costRange([0.01, 0.03]), { kind: 'under', a: '$0.05', b: '' })
assert.deepEqual(S.costRange([0.06, 0.18]), { kind: 'range', a: '$0.10', b: '$0.20' })
assert.deepEqual(S.costRange([0.11, 0.14]), { kind: 'about', a: '$0.15', b: '' })
assert.deepEqual(S.costRange([1.2, 4.1]), { kind: 'range', a: '$2', b: '$5' })

// scope: the sample can run (fields the agent marked "check" are confirmed by pressing Run), decisions are listed
const scope = S.simulationScope(sample, 'exp-1')
assert.equal(scope.ready, true)
const limits = S.simulationLimits(sample, 'exp-1')
assert.equal(limits.text.length, 1); assert.ok(limits.decisions.length >= 2)
const gap = { ...sample, nodes: sample.nodes.map((n) => n.kind === 'simulation' ? { ...n, fields: n.fields.map((x) => x.id === 'roles' ? { ...x, state: 'missing' } : x) } : n) }
assert.deepEqual(S.simulationScope(gap, 'exp-1').missing, ['roles'])

// the chat shows the confirmation, not the JSON header
assert.equal(S.approvalRequest('[Simulation scope approved]\n{"a":1}\nRun 20 per condition.'), 'Run 20 per condition.')
assert.equal(S.approvalRequest('Run a simulation'), null)
console.log('simulation-run: ok')
