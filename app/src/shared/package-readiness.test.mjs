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
