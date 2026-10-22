// node --test src/shared/package-readiness.test.mjs — when the Simulation tab may offer a run (issue #19),
// and the main process's refusal of a run approval for an incomplete package.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'package-readiness-'))
await build({ entryPoints: [join(here, '../main/package-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'main.mjs'), logLevel: 'error' })
await build({ entryPoints: [join(here, 'package-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'shared.mjs'), logLevel: 'error' })
const M = await import(pathToFileURL(join(out, 'main.mjs')).href)
const S = await import(pathToFileURL(join(out, 'shared.mjs')).href)

const COMPLETE = {
  'study.json': '{"title": "Knobe (2003)", "program": {}}',
  'source/paper_metadata.json': '{}',
  'source/evidence.json': '[]',
  'materials/materials.json': '{}',
  'task/task.json': '{}',
  'task/adapter.py': 'import json\n\n\ndef run_sessions(llm, seed, n, arms=None):\n    return []\n',
  'evaluation/evaluation.py': 'def evaluate(sessions):\n    return {}\n',
  'audit/missing_information.json': '{"entries": []}',
}
const COMMENT_ONLY = { 'task/adapter.py': '# Replay adapter: run_sessions(llm, seed, n, arms=None) goes here\n# def run_sessions(llm, seed, n):\n' }

const project = (packages) => {
  const dir = mkdtempSync(join(tmpdir(), 'pkg-project-'))
  for (const [slug, files] of Object.entries(packages))
    for (const [rel, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, 'package', slug, rel)), { recursive: true })
      writeFileSync(join(dir, 'package', slug, rel), text)
    }
  return dir
}
const reader = (files) => async (f) => (f in files ? files[f] : null)
const APPROVAL = '[Simulation scope approved]\n{}\nRun it'

test('the required files are the ones check_package.py requires', () => {
  const py = readFileSync(join(here, '../../../pack/skills/build/check_package.py'), 'utf8')
  const required = [...py.match(/REQUIRED = \[([\s\S]*?)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual([...S.PACKAGE_FILES], required)
})

test('issue #19: a package with only a comment-only adapter.py is not ready', async () => {
  const problems = await S.packageProblems(reader(COMMENT_ONLY))
  const missing = problems.filter((p) => p.kind === 'missing').map((p) => p.file)
  assert.equal(missing.length, 7)
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

test('invalid JSON and missing entry points are problems; unread large files are not', async () => {
  const broken = { ...COMPLETE, 'task/task.json': '{"agents": [', 'evaluation/evaluation.py': 'def score(sessions):\n    return {}\n' }
  assert.deepEqual(await S.packageProblems(reader(broken)), [
    { file: 'task/task.json', kind: 'invalid-json' },
    { file: 'evaluation/evaluation.py', kind: 'no-entry', entry: 'evaluate' },
  ])
  assert.deepEqual(await S.packageProblems(async (f) => (f === 'source/evidence.json' ? undefined : COMPLETE[f])), [])
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
  assert.equal(r.problems.filter((p) => p.kind === 'missing').length, 7)
  assert.equal((await M.projectPackageReadiness(mkdtempSync(join(tmpdir(), 'pkg-none-')))).exists, false)
})

test('main process: refuses a run approval for an incomplete package, and only that', async () => {
  const stub = project({ knobe: COMMENT_ONLY })
  await assert.rejects(M.assertRunnablePackage(stub, APPROVAL), /not complete.*study\.json is missing.*task\/adapter\.py does not define run_sessions\(\)/s)
  await assert.rejects(M.assertRunnablePackage(mkdtempSync(join(tmpdir(), 'pkg-none-')), APPROVAL), /no package/)
  await M.assertRunnablePackage(project({ knobe: COMPLETE }), APPROVAL)
  await M.assertRunnablePackage(stub, 'Please complete the package')
  await M.assertRunnablePackage(undefined, APPROVAL)
})
