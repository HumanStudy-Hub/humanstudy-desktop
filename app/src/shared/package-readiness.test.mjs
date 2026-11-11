// node --test src/shared/package-readiness.test.mjs — when the Simulation tab may offer a run (issue #19),
// and the main process's refusal of a run approval for an incomplete package.
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'package-readiness-'))
await build({ entryPoints: [join(here, '../main/package-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'main.mjs'), logLevel: 'error' })
await build({ entryPoints: [join(here, 'package-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'shared.mjs'), logLevel: 'error' })
const M = await import(pathToFileURL(join(out, 'main.mjs')).href)
// The build checks (check_readiness.py) have their own tests below and in scientific-readiness.test.mjs;
// here a stub that passes, so these tests see the static contract alone.
let scienceCalls = 0
let science = async () => []
M.configureScientificChecks(async (...a) => { scienceCalls++; return science(...a) }, 'test')
const S = await import(pathToFileURL(join(out, 'shared.mjs')).href)

const PROGRAM = JSON.parse(readFileSync(join(here, '../main/fixtures/complete-program.json'), 'utf8'))
const COMPLETE = {
  'study.json': JSON.stringify({ title: 'Fixture', program: PROGRAM }),
  'source/paper_metadata.json': '{}',
  'source/evidence.json': '[]',
  'materials/materials.json': '{}',
  'task/task.json': JSON.stringify({ programBindings: { programId: PROGRAM.id, stepIds: [], recordNodeIds: ['variable'], analysisNodeIds: ['analysis'] } }),
  'task/adapter.py': 'import json\n\n\ndef run_sessions(llm, seed, n, arms=None):\n    return []\n',
  'evaluation/evaluation.py': 'def evaluate(sessions):\n    return {}\n',
  'audit/missing_information.json': '{"entries": []}',
}
const COMMENT_ONLY = { 'task/adapter.py': '# Replay adapter: run_sessions(llm, seed, n, arms=None) goes here\n# def run_sessions(llm, seed, n):\n' }

const project = (packages) => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-project-'))
  writeFileSync(join(dir, 'program.json'), JSON.stringify(PROGRAM))
  for (const [slug, files] of Object.entries(packages))
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, 'package', slug, rel)), { recursive: true })
      writeFileSync(join(dir, 'package', slug, rel), text)
    }
  return dir
}
const reader = (files) => async (f) => (f in files ? files[f] : null)
const approval = (program = PROGRAM) => '[Simulation scope approved]\n' + JSON.stringify({ studyId: 's1', programId: program.id, programHash: createHash('sha256').update(JSON.stringify(program)).digest('hex') }) + '\nRun it'
const APPROVAL = approval()

test('the required files are the ones check_package.py requires', () => {
  const py = readFileSync(join(here, '../../../pack/skills/build/check_package.py'), 'utf8')
  const required = [...py.match(/REQUIRED = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual([...S.PACKAGE_FILES], required)
})

test('issue #19: a package with only a comment-only adapter.py is not ready', async () => {
  const problems = await S.packageProblems(reader(COMMENT_ONLY))
  const missing = problems.filter((p) => p.kind === 'missing').map((p) => p.file)
  assert.equal(missing.length, 5)
  assert.deepEqual(missing, S.PACKAGE_FILES.filter((f) => f !== 'task/adapter.py'))
  assert.deepEqual(problems.find((p) => p.file === 'task/adapter.py'), { file: 'task/adapter.py', kind: 'no-entry', entry: 'run_sessions' })
  const r = await S.packageReadiness(['knobe'], (_slug, f) => reader(COMMENT_ONLY)(f))
  assert.equal(r.exists, true)
  assert.equal(r.ready, false)
})

test('a complete, valid package is ready', async () => {
  assert.deepEqual(await S.packageProblems(reader(COMPLETE)), [])
  const r = await S.packageReadiness(['knobe'], (_s, f) => reader(COMPLETE)(f))
  assert.deepEqual(r, { exists: true, ready: true, slug: 'knobe', problems: [] })
})

test('invalid JSON and missing entry points are problems; unread files cannot enable Run', async () => {
  const broken = { ...COMPLETE, 'task/task.json': '{"agents": [', 'evaluation/evaluation.py': 'def score(sessions):\n    return {}\n' }
  assert.deepEqual(await S.packageProblems(reader(broken)), [
    { file: 'task/task.json', kind: 'invalid-json' },
    { file: 'evaluation/evaluation.py', kind: 'no-entry', entry: 'evaluate' },
  ])
  assert.deepEqual(await S.packageProblems(async (f) => (f === 'materials/materials.json' ? undefined : COMPLETE[f])), [{ file: 'materials/materials.json', kind: 'unvalidated' }])
  assert.deepEqual(await S.packageProblems(reader({ ...COMPLETE, 'task/adapter.py': 'async def run_sessions(llm, seed, n, arms=None):\n    return []\n' })), [])
})

test('no package folder: not built; several folders: the complete one wins', async () => {
  assert.deepEqual(await S.packageReadiness([], async () => null), { exists: false, ready: false, slug: null, problems: [] })
  const r = await S.packageReadiness(['a-stub', 'b-full'], (slug, f) => reader(slug === 'b-full' ? COMPLETE : COMMENT_ONLY)(f))
  assert.equal(r.ready, true)
  assert.equal(r.slug, 'b-full')
})

test('the stamp changes when a package file changes and ignores other files', () => {
  const a = S.packageStamp([{ rel: 'package/k/task/adapter.py', size: 10, mtime: 1 }, { rel: 'program.json', size: 5, mtime: 1 }])
  assert.notEqual(a, S.packageStamp([{ rel: 'package/k/task/adapter.py', size: 12, mtime: 2 }, { rel: 'program.json', size: 5, mtime: 1 }]))
  assert.equal(a, S.packageStamp([{ rel: 'package/k/task/adapter.py', size: 10, mtime: 1 }, { rel: 'program.json', size: 9, mtime: 3 }]))
})

test('main process: reads the package from disk', async () => {
  assert.equal((await M.projectPackageReadiness(project({ knobe: COMPLETE }))).ready, true)
  const r = await M.projectPackageReadiness(project({ knobe: COMMENT_ONLY }))
  assert.equal(r.ready, false)
  assert.equal(r.problems.filter((p) => p.kind === 'missing').length, 5)
  assert.equal((await M.projectPackageReadiness(mkdtempSync(join(tmpdir(), 'pkg-none-')))).exists, false)
})

test('main process: refuses a run approval for an incomplete package, and only that', async () => {
  const stub = project({ knobe: COMMENT_ONLY })
  await assert.rejects(M.assertRunnablePackage(stub, APPROVAL), /not complete.*study\.json is missing.*task\/adapter\.py does not define run_sessions\(\)/s)
  await assert.rejects(M.assertRunnablePackage(project({}), APPROVAL), /no package/)
  await M.assertRunnablePackage(project({ knobe: COMPLETE }), APPROVAL)
  await M.assertRunnablePackage(stub, 'Please complete the package')
  await assert.rejects(M.assertRunnablePackage(undefined, APPROVAL), /no project/)
})

test('large invalid files are checked; large valid files are retained in full', async () => {
  const large = '!'.repeat(4 * 1024 * 1024 + 1)
  const allInvalid = project({ broken: Object.fromEntries(S.PACKAGE_FILES.map(f => [f, large])) })
  const r = await M.projectPackageReadiness(allInvalid, 's1')
  assert.equal(r.ready, false)
  assert.equal(r.problems.length, 6)
  const valid = project({ valid: { ...COMPLETE, 'source/evidence.json': JSON.stringify([{ quote: 'x'.repeat(5 * 1024 * 1024) }]) } })
  assert.equal((await M.projectPackageReadiness(valid, 's1')).ready, true, 'large valid resources are not truncated or arbitrarily rejected')
  await M.assertRunnablePackage(valid, APPROVAL)
})

test('a complete unrelated or outdated package cannot certify the selected study', async () => {
  const unrelated = structuredClone(PROGRAM); unrelated.studies = [{ id: 'other', title: 'Other', type: 'empirical' }]
  const dir = project({ unrelated: { ...COMPLETE, 'study.json': JSON.stringify({ program: unrelated }) }, selected: COMMENT_ONLY })
  assert.equal((await M.projectPackageReadiness(dir, 's1')).ready, false)
  await assert.rejects(M.assertRunnablePackage(dir, APPROVAL), /not complete/)
  const stale = project({ old: COMPLETE })
  const next = { ...PROGRAM, title: 'Researcher revised title' }
  writeFileSync(join(stale, 'program.json'), JSON.stringify(next))
  assert.equal((await M.projectPackageReadiness(stale, 's1')).ready, false)
  await assert.rejects(M.assertRunnablePackage(stale, APPROVAL), /changed after approval/)
  await assert.rejects(M.assertRunnablePackage(stale, approval(next)), /stale-program/)
  await assert.rejects(M.assertRunnablePackage(stale, '[Simulation scope approved]\n{}'), /selected study/)
  await assert.rejects(M.assertRunnablePackage(stale, '[Simulation scope approved]\nnot-json'), /unreadable/)
})

test('issue #45: a slim package refers to program.json instead of copying it', async () => {
  const { 'source/evidence.json': _e, 'audit/missing_information.json': _a, ...rest } = COMPLETE
  const slim = { ...rest, 'study.json': JSON.stringify({ title: 'Fixture', programRef: { path: '../../program.json', id: PROGRAM.id } }) }
  const dir = project({ slim })
  assert.equal((await M.projectPackageReadiness(dir, 's1')).ready, true)
  await M.assertRunnablePackage(dir, APPROVAL)
  assert.equal((await M.projectPackageReadiness(dir, 'other')).ready, false, 'a study the program does not have')
  const wrongId = project({ slim: { ...slim, 'study.json': JSON.stringify({ programRef: { path: '../../program.json', id: 'another-program' } }) } })
  const r = await M.projectPackageReadiness(wrongId, 's1')
  assert.equal(r.ready, false)
  assert.ok(r.problems.some(p => p.kind === 'stale-program'))
  const noRef = project({ slim: { ...slim, 'study.json': JSON.stringify({ title: 'no program, no ref' }) } })
  assert.equal((await M.projectPackageReadiness(noRef, 's1')).ready, false)
})

test('malformed package metadata and missing task bindings fail closed rather than escaping context validation', async () => {
  const malformed = project({ bad: { ...COMPLETE, 'study.json': JSON.stringify({ program: { studies: 'not an array' } }) } })
  assert.equal((await M.projectPackageReadiness(malformed, 's1')).ready, false)
  const noBindings = project({ bad: { ...COMPLETE, 'task/task.json': '{}' } })
  const r = await M.projectPackageReadiness(noBindings, 's1')
  assert.equal(r.ready, false)
  assert.ok(r.problems.some(p => p.kind === 'bindings'))
})

test('T11: a failed build check blocks ready and the run approval, one line per check', async () => {
  const dir = project({ k: COMPLETE })
  science = async () => [{ check: 'effects', reason: 'effect e1: reported.n is empty although the paper prints N' }, { check: 'verbatim', reason: 'm1.text: not found' }]
  try {
    const r = await M.projectPackageReadiness(dir, 's1')
    assert.equal(r.ready, false)
    assert.equal(r.slug, 'k')
    assert.deepEqual(r.problems.map((p) => [p.kind, p.check]), [['scientific', 'effects'], ['scientific', 'verbatim']])
    await assert.rejects(M.assertRunnablePackage(dir, APPROVAL), /not complete.*effects: effect e1: reported\.n is empty.*verbatim: m1\.text: not found/s)
  } finally { science = async () => [] }
})

test('T11: build checks run only on a package that passes the static contract; old projects still load', async () => {
  const before = scienceCalls
  const r = await M.projectPackageReadiness(project({ k: COMMENT_ONLY }), 's1')
  assert.equal(r.ready, false)
  assert.equal(scienceCalls, before, 'an incomplete package is not handed to the checker')
  assert.ok(r.problems.every((p) => p.kind !== 'scientific'))
})

test('T11: results are reused for unchanged inputs and rerun when the package, sources or effects change', async () => {
  const dir = project({ k: COMPLETE })
  const start = scienceCalls
  await M.projectPackageReadiness(dir, 's1')
  await M.projectPackageReadiness(dir, 's1')
  await M.assertRunnablePackage(dir, APPROVAL)
  assert.equal(scienceCalls - start, 1, 'one run for one input state')
  for (const rel of ['package/k/task/adapter.py', 'effects.json', 'sources/SOURCE.json', 'paper.pdf']) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    const n = scienceCalls
    writeFileSync(join(dir, rel), (rel.endsWith('.py') ? COMPLETE['task/adapter.py'] : '{}') + '\n# ' + rel)
    await M.projectPackageReadiness(dir, 's1')
    assert.equal(scienceCalls - n, 1, rel + ' is an input of the build checks')
  }
  // Restoring the old size and mtime does not bring back an earlier result (ctime/inode are in the stamp).
  const file = join(dir, 'package/k/task/adapter.py')
  const old = statSync(file)
  const n = scienceCalls
  writeFileSync(file, readFileSync(file, 'utf8').replace('# ', '#!'))
  utimesSync(file, old.atime, old.mtime)
  await M.projectPackageReadiness(dir, 's1')
  assert.equal(scienceCalls - n, 1)
})

test('T11: a runtime problem is never cached, and edits during a check rerun it', async () => {
  const dir = project({ k: COMPLETE })
  science = async () => [{ check: 'runtime', reason: 'not installed' }]
  try {
    assert.equal((await M.projectPackageReadiness(dir, 's1')).ready, false)
    science = async () => []
    assert.equal((await M.projectPackageReadiness(dir, 's1')).ready, true, 'the runtime installed later: checked again')
    let edits = 0
    science = async (project) => { if (edits++ < 1) writeFileSync(join(project, 'effects.json'), '{"edit": ' + edits + '}'); return [] }
    assert.equal((await M.projectPackageReadiness(dir, 's1')).ready, true, 'one edit during a check: checked again, then ready')
    science = async (project) => { writeFileSync(join(project, 'effects.json'), '{"edit": ' + (++edits) + '}'); return [] }
    writeFileSync(join(dir, 'effects.json'), '{"edit": "new state, not checked yet"}')
    const r = await M.projectPackageReadiness(dir, 's1')
    assert.equal(r.ready, false, 'inputs that keep changing are never certified')
    assert.equal(r.problems[0].check, 'changed')
  } finally { science = async () => [] }
})

test('T11: unconfigured or failing checkers fail closed', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'package-readiness-fresh-'))
  await build({ entryPoints: [join(here, '../main/package-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(fresh, 'main.mjs'), logLevel: 'error' })
  const F = await import(pathToFileURL(join(fresh, 'main.mjs')).href)
  const dir = project({ k: COMPLETE })
  const r = await F.projectPackageReadiness(dir, 's1')
  assert.equal(r.ready, false)
  assert.equal(r.problems[0].check, 'runtime')
  await assert.rejects(F.assertRunnablePackage(dir, APPROVAL), /not complete/)
  F.configureScientificChecks(async () => { throw Error('boom') }, 'x')
  assert.equal((await F.projectPackageReadiness(dir, 's1')).ready, false)
})

test('T11: the Simulation tab rechecks when an input of the build checks changes', () => {
  const base = [{ rel: 'package/k/task/adapter.py', size: 1, mtime: 1 }, { rel: 'sources/SOURCE.json', size: 1, mtime: 1 }, { rel: 'effects.json', size: 1, mtime: 1 }, { rel: 'paper.pdf', size: 1, mtime: 1 }, { rel: 'build.log', size: 1, mtime: 1 }]
  const a = S.readinessStamp(base)
  for (const rel of ['sources/SOURCE.json', 'effects.json', 'paper.pdf'])
    assert.notEqual(a, S.readinessStamp(base.map((e) => e.rel === rel ? { ...e, mtime: 2 } : e)), rel)
  assert.equal(a, S.readinessStamp(base.map((e) => e.rel === 'build.log' ? { ...e, mtime: 2 } : e)), 'unrelated files do not recheck')
})

test('T11 review: the paper named by source.filename and files inside a linked sources/ folder are inputs', async () => {
  const dir = project({ k: COMPLETE })
  const program = { ...PROGRAM, source: { ...PROGRAM.source, filename: 'papers/main.pdf' } }
  writeFileSync(join(dir, 'program.json'), JSON.stringify(program))
  mkdirSync(join(dir, 'papers'))
  writeFileSync(join(dir, 'papers/main.pdf'), '%PDF-1.4 a')
  const outside = mkdtempSync(join(tmpdir(), 'linked-sources-'))
  writeFileSync(join(outside, 'SOURCE.json'), '{}')
  try { symlinkSync(outside, join(dir, 'sources'), 'junction') } catch { return } // no links allowed here
  await M.projectPackageReadiness(dir)
  let n = scienceCalls
  writeFileSync(join(dir, 'papers/main.pdf'), '%PDF-1.4 bb')
  await M.projectPackageReadiness(dir)
  assert.equal(scienceCalls - n, 1, 'source.filename')
  n = scienceCalls
  writeFileSync(join(outside, 'SOURCE.json'), '{"changed": true}')
  await M.projectPackageReadiness(dir)
  assert.equal(scienceCalls - n, 1, 'a file inside a linked folder')
})

test('run confirmation: Linux/Windows say the study code can read the key; macOS relay shows its limits', async () => {
  const dictOut = mkdtempSync(join(tmpdir(), 'run-confirmation-'))
  await build({ entryPoints: [join(here, '../renderer/i18n-dict.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dictOut, 'dict.mjs'), logLevel: 'error' })
  const { EN, ZH } = await import(pathToFileURL(join(dictOut, 'dict.mjs')).href)
  const KEY = "On this computer, the study's code can read your API key. Only run studies you trust."
  for (const readiness of [{ modelAccess: 'key' }, {}, null, undefined, { modelAccess: 'other' }]) {
    const c = S.runConfirmation(readiness)
    assert.equal(c.note, 'sim.note_key', JSON.stringify(readiness))
    assert.ok(EN[c.note].includes(KEY)); assert.ok(ZH[c.note].includes('API 密钥'))
    assert.equal(c.notice, null)
    assert.equal(c.detail, null, 'the key notice is never folded away behind Details')
  }
  assert.equal(S.runConfirmation({ modelAccess: 'key', runNotice: 'x' }).notice, 'sim.run_notice')
  assert.equal(EN['sim.run_notice'], "This study's code will run on your computer with access to your model key.")
  const relay = S.runConfirmation({ modelAccess: 'relay', runNotice: 'x' })
  assert.equal(relay.note, 'sim.note'); assert.equal(relay.notice, 'sim.run_notice_relay')
  assert.ok(!EN[relay.note].includes('API key'))
  // Visible wording states only the time limit; tokens and the relay sit behind Details.
  assert.match(EN[relay.note], /at most \{minutes\} minutes/); assert.match(ZH[relay.note], /最多运行 \{minutes\} 分钟/)
  for (const k of [relay.note, relay.notice]) {
    assert.ok(!/token|relay/i.test(EN[k]), k); assert.ok(!/词元|中转/.test(ZH[k]), k)
  }
  assert.equal(relay.detail, 'sim.relay_detail')
  assert.match(EN['sim.relay_detail'], /\{tokens\} tokens .*\{minutes\} minutes/); assert.match(ZH['sim.relay_detail'], /\{tokens\}.*\{minutes\}/)
  assert.match(EN['sim.relay_detail'], /limited model relay/)
  // The panel renders exactly these keys next to Run simulation (no other confirmation surface).
  const panel = readFileSync(join(here, '../renderer/components/SimulationPanel.tsx'), 'utf8')
  assert.match(panel, /runConfirmation\(readiness\)/)
  assert.match(panel, /t\(confirmation\.note, accessVars\)/); assert.match(panel, /t\(confirmation\.notice, accessVars\)/)
  assert.match(panel, /<details[^>]*>\s*<summary>\{t\('sim\.details'\)\}<\/summary>\s*<p>\{t\(confirmation\.detail, accessVars\)\}/)
  // Signed out: Run is disabled and says so; the "no run" problem never points to a reply that cannot exist.
  assert.match(panel, /disabled=\{!canRun \|\| !scopeReady/)
  assert.match(panel, /\{!canRun && <p className="sim-note">\{t\('sim\.sign_in_to_run'\)\}<\/p>\}/)
  assert.match(panel, /const quietMiss = canRun && /)
  assert.equal(EN['sim.sign_in_to_run'], 'Sign in to run a simulation.'); assert.equal(ZH['sim.sign_in_to_run'], '登录后才能运行模拟。')
  const app = readFileSync(join(here, '../renderer/App.tsx'), 'utf8')
  assert.match(app, /canRun=\{Boolean\(hasAccess\)\}/)
  const bench = readFileSync(join(here, '../renderer/components/Workbench.tsx'), 'utf8')
  assert.match(bench, /if \(!canRun\) return/)
  assert.match(panel, /runLimits\(\{ conditions: runConditions, perCondition \}\)/, 'the wording states the limits the relay will enforce')
  assert.match(panel, /const runConditions = route === 'protocol' \? readiness\?\.protocol\?\.arms \?\? \[\] : plan\.conditions/, 'a protocol run is capped by its arms, as the main process does')
  assert.ok(!panel.includes("t('sim.note')") && !panel.includes("t('sim.run_notice')"), 'no hard-coded wording bypasses the platform choice')
})

// v0.8 protocol route: protocol.json checked by the bundled engine (hsenv.checks; stubbed here, real in
// main/protocol-readiness.test.mjs). Runnable when EITHER route passes; fail-closed and cached like T11.
let protocolCalls = 0
let protocolCheck = async () => []
// The measured model budget of a run (skills/run/budget.py; real in main/protocol-readiness.test.mjs).
const BUDGET = { arms: { control: { group_size: 1, calls: 3, tokens_per_member: 5000 }, treatment: { group_size: 1, calls: 3, tokens_per_member: 5000 } }, output_tokens: 512 }
let budgetCheck = async () => BUDGET
let budgetCalls = 0
M.configureProtocolChecks(async (...a) => { protocolCalls++; return protocolCheck(...a) }, 'test', async (...a) => { budgetCalls++; return budgetCheck(...a) })
const PROTOCOL = readFileSync(join(here, '../main/fixtures/protocol-mini/protocol.json'))
const withProtocol = (dir) => {
  writeFileSync(join(dir, 'protocol.json'), PROTOCOL)
  mkdirSync(join(dir, 'sourcetext'), { recursive: true })
  writeFileSync(join(dir, 'sourcetext/survey.txt'), 'Please read the question below.')
  return dir
}
// per 5, two arms of one member at 5,000 tokens: 50,000 + a 10,000 trial, under the 200,000 floor.
const protocolApproval = (bytes = PROTOCOL, plan = { perCondition: 5, tokenBudget: 200_000 }) => '[Simulation scope approved]\n' + JSON.stringify({ route: 'protocol', protocolHash: createHash('sha256').update(bytes).digest('hex'), plan }) + '\nRun it'

test('review 1 M2: a passing protocol.json reports beside the package and never makes the package ready', async () => {
  const only = withProtocol(mkdtempSync(join(tmpdir(), 'protocol-only-')))
  const r = await M.projectPackageReadiness(only)
  assert.deepEqual([r.exists, r.ready, r.protocol], [false, false, { ready: true, problems: [], arms: ['control', 'treatment'], budget: BUDGET }])
  const broken = withProtocol(project({ k: COMMENT_ONLY }))
  const b = await M.projectPackageReadiness(broken, 's1')
  assert.equal(b.ready, false, 'an incomplete package stays not ready whatever protocol.json says')
  assert.ok(b.problems.some((p) => p.kind === 'missing'))
  assert.equal(b.protocol.ready, true)
  await assert.rejects(M.assertRunnablePackage(broken, APPROVAL), /package is not complete/, 'a program approval cannot run an unchecked package')
  await assert.rejects(M.assertRunnablePackage(only, APPROVAL), 'no program, no package: a program approval cannot run')
  await assert.rejects(M.assertRunnablePackage(withProtocol(project({})), APPROVAL), /no package under package\//)
})

test('review 1 M2: a program approval still needs check_readiness, even with a passing protocol', async () => {
  const dir = withProtocol(project({ k: COMPLETE }))
  science = async () => [{ check: 'effects', reason: 'effect e1 does not compute' }]
  try {
    const r = await M.projectPackageReadiness(dir, 's1')
    assert.deepEqual([r.ready, r.protocol.ready], [false, true])
    await assert.rejects(M.assertRunnablePackage(dir, APPROVAL), /package is not complete.*effects: effect e1/s)
  } finally { science = async () => [] }
  writeFileSync(join(dir, 'effects.json'), '{"fixed": true}')
  await M.assertRunnablePackage(dir, APPROVAL)
})

test('review 1 M2: approvals name their route; a protocol approval needs the protocol route, never the package', async () => {
  const dir = withProtocol(project({ k: COMPLETE }))
  const routed = (route, extra = {}) => '[Simulation scope approved]\n' + JSON.stringify({ ...JSON.parse(APPROVAL.split('\n')[1]), route, ...extra }) + '\nRun it'
  await M.assertRunnablePackage(dir, routed('package'))
  await assert.rejects(M.assertRunnablePackage(dir, routed('engine')), /names no runnable form/)
  await assert.rejects(M.assertRunnablePackage(dir, routed('package', { protocolHash: 'x' })), /names no runnable form/)
  await M.assertRunnablePackage(dir, protocolApproval())
  await assert.rejects(M.assertRunnablePackage(dir, protocolApproval(Buffer.from('{}'))), /changed after approval/)
  protocolCheck = async () => [{ check: 'refs', reason: 'flow names stage nowhere' }]
  try {
    writeFileSync(join(dir, 'sourcetext/survey.txt'), 'a new input state')
    await assert.rejects(M.assertRunnablePackage(dir, protocolApproval()), /protocol did not pass.*refs: flow names stage nowhere/s,
      'a ready package does not run a protocol approval')
  } finally { protocolCheck = async () => [] }
  await assert.rejects(M.assertRunnablePackage(mkdtempSync(join(tmpdir(), 'empty-')), protocolApproval()), /no protocol\.json/)
  const only = withProtocol(mkdtempSync(join(tmpdir(), 'protocol-only-run-')))
  await M.assertRunnablePackage(only, protocolApproval(), 'a project with only protocol.json runs on the protocol route')
  assert.deepEqual((await M.projectPackageReadiness(only)).protocol.arms, ['control', 'treatment'])
})

test('v0.8: failing protocol checks are listed one line per check under protocol', async () => {
  const dir = withProtocol(project({ k: COMPLETE }))
  protocolCheck = async () => [{ check: 'refs', reason: 'flow names stage nowhere' }, { check: 'verbatim', reason: '2 texts not found' }]
  try {
    const r = await M.projectPackageReadiness(dir, 's1')
    assert.equal(r.ready, true, 'the package route is kept')
    assert.deepEqual(r.protocol.problems.map((p) => [p.file, p.kind, p.check]), [['protocol.json', 'scientific', 'refs'], ['protocol.json', 'scientific', 'verbatim']])
    const before = protocolCalls
    assert.equal((await M.projectPackageReadiness(project({ k: COMPLETE }), 's1')).protocol, undefined)
    assert.equal(protocolCalls, before, 'no protocol.json: the engine is not asked')
  } finally { protocolCheck = async () => [] }
})

test('v0.8: protocol results are reused for unchanged inputs and rerun when the protocol, a source text or an asset changes', async () => {
  const dir = withProtocol(mkdtempSync(join(tmpdir(), 'protocol-cache-')))
  const p = JSON.parse(PROTOCOL.toString('utf8'))
  p.stages.intro.content.push({ id: 'img', image: { src: 'media/figure.png' } })
  writeFileSync(join(dir, 'protocol.json'), JSON.stringify(p))
  mkdirSync(join(dir, 'media'))
  writeFileSync(join(dir, 'media/figure.png'), 'png')
  const start = protocolCalls
  await M.projectPackageReadiness(dir)
  await M.projectPackageReadiness(dir)
  assert.equal(protocolCalls - start, 1, 'one run for one input state')
  for (const rel of ['protocol.json', 'sourcetext/survey.txt', 'sourcetext/survey#second.txt', 'media/figure.png', 'study.json']) {
    const n = protocolCalls
    writeFileSync(join(dir, rel), (rel === 'protocol.json' ? JSON.stringify(p) : 'x') + ' '.repeat(protocolCalls))
    await M.projectPackageReadiness(dir)
    assert.equal(protocolCalls - n, 1, rel + ' is an input of the protocol checks')
  }
  const n = protocolCalls
  mkdirSync(join(dir, 'runs/2026-11-08'), { recursive: true })
  writeFileSync(join(dir, 'runs/2026-11-08/report.md'), 'a run')
  await M.projectPackageReadiness(dir)
  assert.equal(protocolCalls, n, 'a run folder is not an input')
})

test('v0.8: the protocol route fails closed and never caches a runtime problem', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'package-readiness-protocol-'))
  await build({ entryPoints: [join(here, '../main/package-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(fresh, 'main.mjs'), logLevel: 'error' })
  const F = await import(pathToFileURL(join(fresh, 'main.mjs')).href)
  const dir = withProtocol(mkdtempSync(join(tmpdir(), 'protocol-closed-')))
  const r = await F.projectPackageReadiness(dir)
  assert.deepEqual([r.ready, r.protocol.ready, r.protocol.problems[0].check], [false, false, 'runtime'])
  await assert.rejects(F.assertRunnablePackage(dir, protocolApproval()), /protocol did not pass/)
  let calls = 0
  F.configureProtocolChecks(async () => (calls++ ? [] : [{ check: 'runtime', reason: 'not installed' }]), 'x', async () => BUDGET)
  assert.equal((await F.projectPackageReadiness(dir)).protocol.ready, false)
  assert.equal((await F.projectPackageReadiness(dir)).protocol.ready, true, 'the runtime installed later: checked again')
  F.configureProtocolChecks(async () => { throw Error('boom') }, 'y', async () => BUDGET)
  assert.equal((await F.projectPackageReadiness(dir)).protocol.ready, false)
  F.configureProtocolChecks(async () => [], 'z')
  assert.equal((await F.projectPackageReadiness(dir)).protocol.ready, false, 'checks pass but no budget measurement configured: not ready')
  assert.equal((await F.projectPackageReadiness(dir)).protocol.ready, false)
})

test('v0.8: the Simulation tab rechecks when a protocol input changes', () => {
  const base = [{ rel: 'protocol.json', size: 1, mtime: 1 }, { rel: 'sourcetext/survey.txt', size: 1, mtime: 1 }, { rel: 'runs/x/report.md', size: 1, mtime: 1 }]
  const s = S.readinessStamp(base)
  assert.notEqual(S.readinessStamp([{ ...base[0], mtime: 2 }, base[1], base[2]]), s)
  assert.notEqual(S.readinessStamp([base[0], { ...base[1], size: 2 }, base[2]]), s)
  assert.equal(S.readinessStamp([base[0], base[1], { ...base[2], size: 9 }]), s)
})

test('review 2 M3: a protocol run is sized from its measured budget, and the approval must name that figure', async () => {
  const dir = withProtocol(mkdtempSync(join(tmpdir(), 'protocol-budget-')))
  await M.assertRunnablePackage(dir, protocolApproval())
  await assert.rejects(M.assertRunnablePackage(dir, protocolApproval(PROTOCOL, { perCondition: 5 })), /approved token budget is not this run's \(200,000 tokens\)/)
  await assert.rejects(M.assertRunnablePackage(dir, protocolApproval(PROTOCOL, { perCondition: 5, tokenBudget: 16_000_000 })), /not this run's/, 'a larger number is not approved either')
  await assert.rejects(M.assertRunnablePackage(dir, protocolApproval(PROTOCOL, { perCondition: 61, tokenBudget: 200_000 })), /whole number from 1 to 60/)
  // A long survey with groups: 4 members x 2,000,000 tokens; 2 groups per arm need 2 x 2 x 4 x 2M + trial > 16M.
  budgetCheck = async () => ({ arms: { a: { group_size: 4, calls: 110, tokens_per_member: 2_000_000 }, b: { group_size: 4, calls: 110, tokens_per_member: 2_000_000 } }, output_tokens: 512 })
  writeFileSync(join(dir, 'sourcetext/survey.txt'), 'new input state: budget measured again')
  try {
    await assert.rejects(M.assertRunnablePackage(dir, protocolApproval(PROTOCOL, { perCondition: 2, tokenBudget: 16_000_000 })), /would need 48,000,000 tokens, more than the limit of 16,000,000/)
  } finally { budgetCheck = async () => BUDGET }
})

test('review 2 M3: no measured budget, no protocol run (fail closed, runtime problems are not cached)', async () => {
  const dir = withProtocol(mkdtempSync(join(tmpdir(), 'protocol-nobudget-')))
  budgetCheck = async () => [{ check: 'budget', reason: 'The model budget of a run could not be measured' }]
  try {
    const r = await M.projectPackageReadiness(dir)
    assert.deepEqual([r.protocol.ready, r.protocol.problems[0].check, r.protocol.budget], [false, 'budget', undefined])
    await assert.rejects(M.assertRunnablePackage(dir, protocolApproval()), /protocol did not pass.*budget/s)
    budgetCheck = async () => [{ check: 'runtime', reason: 'not installed' }]
    writeFileSync(join(dir, 'sourcetext/survey.txt'), 'another state')
    assert.equal((await M.projectPackageReadiness(dir)).protocol.ready, false)
    budgetCheck = async () => BUDGET
    assert.equal((await M.projectPackageReadiness(dir)).protocol.ready, true, 'a runtime problem is checked again')
  } finally { budgetCheck = async () => BUDGET }
})

test('review 2 M3: the Simulation tab shows and sends the same budget the main process recomputes', async () => {
  const outL = mkdtempSync(join(tmpdir(), 'run-limits-'))
  await build({ entryPoints: [join(here, 'run-limits.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(outL, 'l.mjs'), logLevel: 'error' })
  const L = await import(pathToFileURL(join(outL, 'l.mjs')).href)
  const big = { arms: { a: { group_size: 4, calls: 110, tokens_per_member: 2_000_000 } }, output_tokens: 512 }
  const one = L.protocolRunLimits(big, 1)
  assert.deepEqual([one.participants, one.needed, one.fits, one.tokens], [4, 16_000_000, true, 16_000_000])
  assert.deepEqual([L.protocolRunLimits(big, 2).fits, L.protocolRunLimits(big, 2).needed], [false, 24_000_000])
  assert.equal(L.protocolRunLimits(null, 5).fits, false)
  assert.equal(L.protocolRunLimits(BUDGET, 5).tokens, 200_000)
  const panel = readFileSync(join(here, '../renderer/components/SimulationPanel.tsx'), 'utf8')
  assert.match(panel, /protocolRunLimits\(readiness\?\.protocol\?\.budget, perCondition\)/)
  assert.match(panel, /protocolLimits\?\.tokens\) \} catch/, 'the approval carries the figure shown')
  assert.match(panel, /protocolLimits\?\.fits === false/, 'a plan over the ceiling cannot be run')
  const bench = readFileSync(join(here, '../renderer/components/Workbench.tsx'), 'utf8')
  assert.match(bench, /tokenBudget: plan\.tokenBudget/)
})

test('a project with only protocol.json opens the Simulation tab: readiness from the protocol alone', async () => {
  const dir = withProtocol(mkdtempSync(join(tmpdir(), 'protocol-tab-')))
  // The tab asks with its study id; there is no program.json to bind a package to, and that must not fail.
  const r = await M.projectPackageReadiness(dir, 'protocol')
  assert.deepEqual([r.exists, r.ready, r.protocol.ready, r.protocol.arms], [false, false, true, ['control', 'treatment']])
  // The view-only program the tab reads: one study, the runnable arms as conditions, the paper's n as the sample.
  const outP = mkdtempSync(join(tmpdir(), 'protocol-program-'))
  await build({ entryPoints: [join(here, 'protocol-program.ts'), join(here, 'simulation-run.ts'), join(here, 'simulation-scope.ts')], bundle: true, platform: 'node', format: 'esm', outdir: outP, logLevel: 'error', outExtension: { '.js': '.mjs' } })
  const PP = await import(pathToFileURL(join(outP, 'protocol-program.mjs')).href)
  const SR = await import(pathToFileURL(join(outP, 'simulation-run.mjs')).href)
  const program = PP.protocolProgram(PROTOCOL.toString('utf8'))
  assert.equal(program.studies[0].id, PP.PROTOCOL_STUDY_ID)
  assert.deepEqual(SR.simulationPlan(program, PP.PROTOCOL_STUDY_ID).conditions.map((c) => c.id), ['control', 'treatment'])
  assert.equal(SR.simulationPlan(program, PP.PROTOCOL_STUDY_ID).paperPerCondition, 10, 'the fixture prints n 10 per arm')
  assert.equal(PP.protocolProgram('{"arms": []}'), null)
  assert.equal(PP.protocolProgram('not json'), null)
  assert.deepEqual(PP.protocolProgram(JSON.stringify({ id: 'x', arms: [{ id: 'a', runnable: false }] })).nodes, [], 'blocked protocols remain previewable without inventing runnable conditions')
  // The Workbench shows the tab for that program and the panel gates a protocol run by the protocol, not section 12.
  const bench = readFileSync(join(here, '../renderer/components/Workbench.tsx'), 'utf8')
  assert.match(bench, /const simProgram = useMemo\(\(\) => hasProtocol \? protocolProgram\(protocolText\) : program/)
  assert.match(bench, /\{simProgram && tabBtn\('simulation'/)
  const panel = readFileSync(join(here, '../renderer/components/SimulationPanel.tsx'), 'utf8')
  assert.match(panel, /const scopeReady = route === 'protocol' \|\| scope\.ready/)
  // And a protocol approval from such a project runs.
  await M.assertRunnablePackage(dir, protocolApproval())
})

test('a protocol with no runnable arms explains missing material and never sizes a paid run',async()=>{
 const dir=withProtocol(mkdtempSync(join(tmpdir(),'blocked-protocol-')))
 const p=JSON.parse(PROTOCOL.toString('utf8'))
 for(const arm of p.arms){arm.runnable=false;arm.why='The original questionnaire is not available.'}
 writeFileSync(join(dir,'protocol.json'),JSON.stringify(p))
 const before=budgetCalls
 const r=await M.projectPackageReadiness(dir,'protocol')
 assert.equal(r.protocol.ready,false)
 assert.deepEqual(r.protocol.arms,[])
 assert.match(r.protocol.problems.find(p=>p.check==='materials').reason,/original questionnaire/)
 assert.equal(budgetCalls,before,'blocked study has no model budget request')
})

test('read-only readiness never starts checks and exposes only results for the current files', async () => {
  const legacy = project({ knobe: COMPLETE })
  const protocol = withProtocol(mkdtempSync(join(tmpdir(), 'protocol-status-')))
  const before = protocolCalls
  let legacyCalls = 0
  const out = mkdtempSync(join(tmpdir(), 'readiness-read-only-'))
  await build({ entryPoints: [join(here, '../main/package-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'readiness.mjs'), logLevel: 'error' })
  const F = await import(pathToFileURL(join(out, 'readiness.mjs')).href)
  F.configureScientificChecks(async () => { legacyCalls++; return [] }, 'read-only')
  for (let i = 0; i < 2; i++) {
    const status = await F.projectPackageReadiness(legacy, undefined, false)
    assert.equal(status.ready, false)
    assert.equal(status.problems[0].check, 'unchecked')
    assert.equal((await M.projectPackageReadiness(protocol, undefined, false)).protocol.ready, false)
  }
  assert.equal(legacyCalls, 0)
  assert.equal(protocolCalls, before)
  assert.equal((await F.projectPackageReadiness(legacy)).ready, true)
  assert.equal((await F.projectPackageReadiness(legacy, undefined, false)).ready, true)
  writeFileSync(join(legacy, 'notes.pdf'), 'new source')
  assert.equal((await F.projectPackageReadiness(legacy, undefined, false)).ready, false)
  assert.equal(legacyCalls, 1)
  assert.equal((await M.projectPackageReadiness(protocol)).protocol.ready, true)
  assert.equal((await M.projectPackageReadiness(protocol, undefined, false)).protocol.ready, true)
  assert.equal(protocolCalls, before + 1)
  F.configureScientificChecks(async () => assert.fail('platform isolation required'), 'read-only', false)
  assert.equal((await F.projectPackageReadiness(legacy)).problems[0].check, 'isolation')
})

test('legacy warnings survive reinitializing the cache and do not block runnable packages', async () => {
  const dir = project({ knobe: COMPLETE })
  const store = mkdtempSync(join(tmpdir(), 'legacy-report-'))
  const out = mkdtempSync(join(tmpdir(), 'legacy-review-'))
  await build({ entryPoints: [join(here, '../main/package-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'readiness.mjs'), logLevel: 'error' })
  const F = await import(pathToFileURL(join(out, 'readiness.mjs')).href)
  const report = { problems: [], warnings: [{ check: 'results', reason: 'p=1.2 is outside 0..1' }], checks: { results: 'pass' } }
  F.configureScientificChecks(async () => report, 'legacy-review', true, store)
  const checked = await F.projectPackageReadiness(dir)
  assert.equal(checked.ready, true)
  assert.deepEqual(checked.scientificReport, report)
  F.configureScientificChecks(async () => assert.fail('opening cannot start a checker'), 'legacy-review', true, store)
  const reopened = await F.projectPackageReadiness(dir, undefined, false)
  assert.equal(reopened.ready, true)
  assert.deepEqual(reopened.scientificReport, report)
  writeFileSync(join(dir, 'effects.json'), '{}')
  assert.equal((await F.projectPackageReadiness(dir, undefined, false)).scientificReport, undefined)
})

test('program-only and unsupported legacy projects can prepare a protocol without executing package code', async () => {
  const out = mkdtempSync(join(tmpdir(), 'windows-protocol-route-'))
  await build({ entryPoints: [join(here, '../main/package-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'readiness.mjs'), logLevel: 'error' })
  const F = await import(pathToFileURL(join(out, 'readiness.mjs')).href)
  F.configureScientificChecks(async () => assert.fail('legacy code cannot run without file isolation'), 'windows', false)
  F.configureProtocolChecks(async () => [], 'windows', async () => BUDGET)
  const programOnly = project({})
  const legacy = project({ knobe: COMMENT_ONLY })
  assert.equal((await F.projectPackageReadiness(programOnly, 's1', false, true)).exists, false)
  assert.ok((await F.projectPackageReadiness(legacy, 's1', false, true)).problems.some(p => p.check === 'isolation'))
  for (const dir of [programOnly, legacy]) {
    const program = readFileSync(join(dir, 'program.json'))
    withProtocol(dir)
    assert.equal((await F.projectPackageReadiness(dir, undefined, false, true)).protocol.ready, false)
    const checked = await F.projectPackageReadiness(dir, undefined, true, true)
    assert.equal(checked.ready, false)
    assert.equal(checked.protocol.ready, true)
    await F.assertRunnablePackage(dir, protocolApproval())
    assert.deepEqual(readFileSync(join(dir, 'program.json')), program)
  }
  const messages = readFileSync(join(here, '../renderer/i18n-dict.ts'), 'utf8')
  const prompt = messages.split('\n').find(line => line.includes("'sim.build_prompt'"))
  assert.match(prompt, /\{studyId\}.*protocol[.]json.*existing program[.]json/)
})
