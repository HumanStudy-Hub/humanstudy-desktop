// Automatic paper build after import (issue #15): state machine, restart recovery and the
// program_io.py checkpoint writer. No kernel, no network.
//   node src/main/paper-build.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'paper-build-test-'))
await build({ entryPoints: [join(here, 'paper-build.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'core.mjs'), logLevel: 'error' })
const P = await import(pathToFileURL(join(out, 'core.mjs')).href)
const sample = readFileSync(join(here, '../shared/sample-program.json'), 'utf8')

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'paper-build-proj-'))
  mkdirSync(join(dir, '.humanstudy'))
  P.pendingPaperBuild(dir)
  return dir
}
function tracker() {
  const changes = []
  return { changes, builds: P.createPaperBuilds((dir) => changes.push(dir)) }
}

test('a pending build is claimed once, by a conversation of the same project', () => {
  const dir = project(), { builds, changes } = tracker()
  builds.bind('s1', dir)
  assert.throws(() => builds.start(dir, 'other'), /different project/)
  assert.equal(builds.start(dir, 's1'), true)
  assert.equal(builds.start(dir, 's1'), false, 'never sent twice')
  assert.deepEqual(builds.read(dir), { status: 'running', phase: 'reading', sessionId: 's1' })
  assert.ok(changes.includes(dir), 'the renderer hears about state changes (.humanstudy is not watched)')
  builds.release(dir, 's1')
  assert.equal(builds.read(dir).status, 'pending', 'a claim that could not be sent goes back to pending')
})

test('progress follows the build skill commands; a full program completes the build', () => {
  const dir = project(), { builds } = tracker()
  builds.bind('s1', dir)
  builds.start(dir, 's1')
  builds.event({ sessionId: 's1', type: 'tool', tool: 'bash', input: { command: 'python .opencode/skills/build/program_io.py .humanstudy/tmp/batch-01.json' } })
  assert.equal(builds.read(dir).phase, 'writing')
  builds.event({ sessionId: 's1', type: 'tool', tool: 'bash', input: { command: 'python .opencode/skills/build/check_program.py program.json' } })
  assert.equal(builds.read(dir).phase, 'checking')
  builds.event({ sessionId: 'unrelated', type: 'done' })
  assert.equal(builds.read(dir).status, 'running')
  writeFileSync(join(dir, 'program.json'), sample)
  builds.event({ sessionId: 's1', type: 'done' })
  assert.equal(builds.read(dir).status, 'complete')
  builds.event({ sessionId: 's1', type: 'done' })
  assert.equal(builds.start(dir, 's1'), false, 'a complete build never restarts')
})

test('failures are named and can be retried; finishing by hand clears them', () => {
  const dir = project(), { builds } = tracker()
  builds.bind('s1', dir)
  builds.start(dir, 's1')
  builds.event({ sessionId: 's1', type: 'done' })
  assert.deepEqual(builds.read(dir), { status: 'error', phase: 'reading', sessionId: 's1', error: 'incomplete' })
  assert.equal(builds.retry(dir), true)
  assert.equal(builds.read(dir).status, 'pending')
  builds.start(dir, 's1')
  builds.event({ sessionId: 's1', type: 'error', text: 'Request failed (413): Request Entity Too Large' })
  builds.event({ sessionId: 's1', type: 'done' })
  assert.equal(builds.read(dir).error, 'too_large')
  builds.retry(dir); builds.start(dir, 's1')
  builds.sendFailed('s1', new Error('kernel gone'))
  assert.equal(builds.read(dir).error, 'failed')
  builds.retry(dir); builds.start(dir, 's1')
  builds.event({ sessionId: 's1', type: 'done', detail: 'shutdown' })
  assert.equal(builds.read(dir).error, 'closed')
  assert.equal(builds.retry(dir), true); assert.equal(builds.retry(dir), false, 'only a failed build is retried')
  builds.start(dir, 's1'); builds.event({ sessionId: 's1', type: 'done' })
  // The researcher finishes the study in the chat (or another conversation of the project).
  builds.bind('s2', dir)
  writeFileSync(join(dir, 'program.json'), sample)
  builds.event({ sessionId: 's2', type: 'done' })
  assert.equal(builds.read(dir).status, 'complete')
})

test('a first checkpoint alone is not a complete study', () => {
  const dir = project(), { builds } = tracker()
  builds.bind('s1', dir)
  builds.start(dir, 's1')
  const p = JSON.parse(sample)
  writeFileSync(join(dir, 'program.json'), JSON.stringify({ ...p, nodes: [], steps: [], relations: [], evidence: [], issues: [] }))
  builds.event({ sessionId: 's1', type: 'done' })
  assert.equal(builds.read(dir).error, 'incomplete')
})

test('a build left running by an earlier app process reads as interrupted, never resumed silently', () => {
  const dir = project(), first = tracker()
  first.builds.bind('s1', dir)
  first.builds.start(dir, 's1')
  const next = tracker() // app restarted
  next.builds.bind('s1', dir)
  assert.equal(next.builds.start(dir, 's1'), false)
  assert.equal(next.builds.read(dir).error, 'interrupted')
  assert.equal(P.readPaperBuild(dir).status, 'error', 'persisted')
  assert.equal(next.builds.retry(dir), true)
  assert.equal(next.builds.start(dir, 's1'), true)
})

test('the build request is an authorization to build, not to simulate', async () => {
  const out2 = mkdtempSync(join(tmpdir(), 'paper-build-i18n-'))
  await build({ entryPoints: [join(here, '../shared/simulation-scope.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out2, logLevel: 'error' })
  const dict = readFileSync(join(here, '../renderer/i18n-dict.ts'), 'utf8')
  // Chat text never starts a simulation (#22); only a Run-button approval does.
  const { approvalRequest } = await import(pathToFileURL(join(out2, 'simulation-scope.js')).href)
  const row = /\['build\.prompt', '([^']+)', '([^']+)'\]/.exec(dict)
  assert.ok(row, 'build.prompt has English and Chinese')
  for (const prompt of [row[1], row[2]]) {
    assert.equal(approvalRequest(prompt), null, prompt)
    assert.match(prompt, /simulation|模拟/i, 'the prompt says not to simulate')
    assert.match(prompt, /program_io\.py/)
    assert.match(prompt, /missing/)
  }
  for (const key of ['study.paper_no_study', 'study.build_from_paper', 'build.title', 'build.pending', 'build.reading', 'build.writing', 'build.checking', 'build.packaging', 'build.failed_title', 'build.kept', 'build.retry',
    'build.error.closed', 'build.error.interrupted', 'build.error.incomplete', 'build.error.too_large', 'build.error.failed'])
    assert.ok(dict.includes(`['${key}',`), key)
})

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0)
test('program_io.py saves checkpoints by id without losing saved work', { skip: !python }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'program-io-'))
  const io = join(here, '../../../pack/skills/build/program_io.py')
  const run = (batch) => {
    writeFileSync(join(dir, 'batch.json'), JSON.stringify(batch), 'utf8')
    return spawnSync(python, [io, 'batch.json'], { cwd: dir, encoding: 'utf8' })
  }
  const p = JSON.parse(sample)
  let r = run({ studies: p.studies })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /lacks schemaVersion, id, title, intent, source/)
  assert.ok(!existsSync(join(dir, 'program.json')))
  const node = p.nodes[0]
  r = run({ schemaVersion: 2, id: p.id, title: p.title, intent: p.intent, source: p.source, studies: p.studies, nodes: [node] })
  assert.equal(r.status, 0, r.stderr)
  let saved = JSON.parse(readFileSync(join(dir, 'program.json'), 'utf8'))
  assert.deepEqual(saved.evidence, [])
  // A later batch adds records and updates one field of a saved node; other fields are kept.
  const field = node.fields[0]
  r = run({ nodes: [{ id: node.id, fields: [{ id: field.id, value: 'Überprüft — 已核对' }] }, p.nodes[1]], evidence: p.evidence })
  assert.equal(r.status, 0, r.stderr)
  saved = JSON.parse(readFileSync(join(dir, 'program.json'), 'utf8'))
  assert.equal(saved.nodes.length, 2)
  assert.equal(saved.nodes[0].title, node.title)
  assert.equal(saved.nodes[0].fields[0].value, 'Überprüft — 已核对')
  assert.equal(saved.nodes[0].fields[0].origin, field.origin)
  assert.equal(saved.nodes[0].fields.length, node.fields.length)
  assert.equal(saved.evidence.length, p.evidence.length)
  // A malformed batch leaves the saved program untouched.
  const before = readFileSync(join(dir, 'program.json'), 'utf8')
  r = run({ nodes: [{ title: 'no id' }] })
  assert.equal(r.status, 1)
  assert.equal(readFileSync(join(dir, 'program.json'), 'utf8'), before)
  // A program.json saved with a BOM (Windows Notepad) and holding a duplicated id the researcher has
  // not resolved (#17): the batch updates the first one, the one the app shows, and drops nothing.
  const dup = JSON.parse(before)
  dup.nodes.push({ ...dup.nodes[0], title: 'Duplicate kept' })
  writeFileSync(join(dir, 'program.json'), '\ufeff' + JSON.stringify(dup, null, 2), 'utf8')
  r = run({ nodes: [{ id: node.id, title: 'First updated' }] })
  assert.equal(r.status, 0, r.stderr)
  saved = JSON.parse(readFileSync(join(dir, 'program.json'), 'utf8'))
  assert.deepEqual(saved.nodes.map((n) => n.title), ['First updated', p.nodes[1].title, 'Duplicate kept'])
})

test('an older project with a paper but no study is offered a build, never started unasked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'paper-build-old-')), { builds } = tracker()
  builds.bind('s1', dir)
  assert.equal(builds.read(dir), undefined, 'no state: the Study view offers the link')
  assert.equal(builds.start(dir, 's1'), false, 'no automatic start without a pending build')
  assert.equal(builds.retry(dir), false, 'no paper: nothing to build')
  writeFileSync(join(dir, 'paper.pdf'), '%PDF-1.4')
  assert.equal(builds.retry(dir), true, 'the link marks the build pending')
  assert.equal(builds.start(dir, 's1'), true)
  const done = mkdtempSync(join(tmpdir(), 'paper-build-done-'))
  writeFileSync(join(done, 'paper.pdf'), '%PDF-1.4'); writeFileSync(join(done, 'program.json'), sample)
  assert.equal(builds.retry(done), false, 'a project that already has a study is left alone')
})

test('every conversation the main process attaches to a project can claim its build', () => {
  // A conversation opened or forked from history must be bound like a new or resumed one; otherwise
  // project:startBuild throws "belongs to a different project" and the pending build never starts.
  const main = readFileSync(join(here, 'index.ts'), 'utf8')
  const records = main.match(/sessionProject\.set\(([^)]+)\)/g) ?? []
  assert.ok(records.length >= 3, 'start, resume and native open/fork record the project')
  for (const r of records) {
    const [sid, dir] = r.slice('sessionProject.set('.length, -1).split(',').map((s) => s.trim())
    assert.ok(main.includes(`paperBuilds.bind(${sid}, ${dir})`) || main.includes(`paperBuilds.bind(${sid},${dir})`), `${r} without paperBuilds.bind`)
  }
})
