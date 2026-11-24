import { createHash } from 'node:crypto'
// Automatic paper build after import (issue #15): state machine, restart recovery and the
// program_io.py checkpoint writer. No kernel, no network.
//   node src/main/paper-build.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'paper-build-test-'))
await build({ entryPoints: [join(here, 'paper-build.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'core.mjs'), logLevel: 'error' })
const P = await import(pathToFileURL(join(out, 'core.mjs')).href)
const sample = readFileSync(join(here, 'fixtures/complete-program.json'), 'utf8')

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
  const { startedAt, ...running } = builds.read(dir)
  assert.deepEqual(running, { status: 'running', phase: 'reading', sessionId: 's1' })
  assert.ok(Math.abs(startedAt - Date.now()) < 5000, 'the start time is kept for the elapsed-time line')
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
  builds.event({ sessionId: 's1', type: 'tool', tool: 'bash', input: { command: 'python .opencode/skills/build/check_program.py program.json' }, output: 'PASS program.json' })
  builds.event({ sessionId: 's1', type: 'done' })
  assert.equal(builds.read(dir).status, 'complete')
  builds.event({ sessionId: 's1', type: 'done' })
  assert.equal(builds.start(dir, 's1'), false, 'a complete build never restarts')
})

test('a to-do list or a read that mentions the checks is not a check (a finished build stays finished)', () => {
  const dir = project(), { builds } = tracker()
  builds.bind('s1', dir)
  builds.start(dir, 's1')
  writeFileSync(join(dir, 'program.json'), sample)
  builds.event({ sessionId: 's1', type: 'tool', tool: 'bash', input: { command: 'python .opencode/skills/build/program_io.py b.json && python .opencode/skills/build/check_program.py program.json --complete' }, output: 'Saved program.json\nPASS program.json' })
  // The agent's last step in a real build (2026-11-08): its to-do list names the checks and the package.
  builds.event({ sessionId: 's1', type: 'tool', tool: 'todowrite', input: { todos: [{ content: 'Program checks: check_program --complete, check_results', status: 'completed' }, { content: 'Build the runnable package/ after the researcher answers', status: 'pending' }] }, output: '[{"content":"Program checks: check_program --complete"}]' })
  builds.event({ sessionId: 's1', type: 'tool', tool: 'read', input: { filePath: join(dir, 'program.json') }, output: '{}' })
  builds.event({ sessionId: 's1', type: 'tool', tool: 'grep', input: { pattern: 'check_package' }, output: 'skills/build/SKILL.md' })
  assert.equal(builds.read(dir).phase, 'checking', 'mentions do not move the stage')
  builds.event({ sessionId: 's1', type: 'done' })
  assert.equal(builds.read(dir).status, 'complete')
})

test('writing program.json or package files by tool counts; the shell command is what was run', () => {
  assert.equal(P.checkResult({ tool: 'write', input: { filePath: '/p/program.json', content: 'check_program PASS' } }), false)
  assert.equal(P.checkResult({ tool: 'edit', input: { filePath: '/p/program.json' } }), false)
  assert.equal(P.checkResult({ tool: 'todowrite', input: { todos: [{ content: 'check_program' }] }, output: 'x' }), null)
  assert.equal(P.checkResult({ tool: 'bash', input: { command: 'grep -n PASS .opencode/skills/build/check_program.py' }, output: '41:    print(f"PASS {path}")' }), null, 'reading the checker is not a check')
  assert.equal(P.checkResult({ tool: 'bash', input: { command: 'python check_program.py program.json' }, output: 'PROBLEM x\nFAIL 1 problem(s)' }), false)
  assert.equal(P.buildPhase('write', { filePath: '/p/package/study/task/adapter.py' }), 'packaging')
  assert.equal(P.buildPhase('todowrite', { todos: [{ content: 'package/' }] }), null)
  assert.equal(P.buildPhase('bash', { command: 'python check_package.py package/x' }), 'packaging')
  // The protocol route (v0.8): protocol.json is the runnable form, hsenv.checks its check.
  assert.equal(P.buildPhase('write', { filePath: '/p/protocol.json' }), 'packaging')
  assert.equal(P.buildPhase('bash', { command: 'python -m hsenv.checks . --sessions 50' }), 'packaging')
  assert.equal(P.buildPhase('write', { filePath: '/p/variants/v1/protocol.json' }), 'packaging')
  assert.equal(P.buildPhase('write', { filePath: '/p/my-protocol.json.md' }), null)
  assert.equal(P.checkResult({ tool: 'bash', input: { command: 'python -m hsenv.checks .' }, output: '{\n "refs": [],\n "PASS": true\n}' }), true)
  assert.equal(P.checkResult({ tool: 'bash', input: { command: 'python -m hsenv.checks .' }, output: '{\n "refs": ["x"],\n "PASS": false\n}' }), false)
  assert.equal(P.checkResult({ tool: 'bash', input: { command: 'python -m hsenv.checks .' }, output: 'Traceback (most recent call last):' }), null, 'a crash is not a verdict')
  assert.equal(P.checkResult({ tool: 'bash', input: { command: 'grep -n PASS .opencode/runtime/hsenv/hsenv/checks.py' }, output: '1102:    report["PASS"] = not fail' }), null)
})

test('failures are named and can be retried; finishing by hand clears them', () => {
  const dir = project(), { builds } = tracker()
  builds.bind('s1', dir)
  builds.start(dir, 's1')
  builds.event({ sessionId: 's1', type: 'done' })
  const { startedAt: _, ...failed } = builds.read(dir)
  assert.deepEqual(failed, { status: 'error', phase: 'reading', sessionId: 's1', error: 'incomplete' })
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
  assert.equal(builds.read(dir).status, 'error', 'a readable program is not finished until its check passes')
  builds.event({ sessionId: 's2', type: 'tool', tool: 'bash', input: { command: 'python .opencode/skills/build/check_program.py program.json' }, output: 'PASS program.json' })
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
  // Nor is a first checkpoint that already has a study, a node and evidence: the turn ended (Stop, an
  // output limit, a question) before the check passed. It stays retryable, also after a restart.
  builds.retry(dir); builds.start(dir, 's1')
  writeFileSync(join(dir, 'program.json'), sample)
  builds.event({ sessionId: 's1', type: 'tool', tool: 'bash', input: { command: 'python .opencode/skills/build/check_program.py program.json' }, output: 'PROBLEM node x lacks evidence\nFAIL 1 problem(s) in program.json' })
  builds.event({ sessionId: 's1', type: 'done' })
  assert.equal(builds.read(dir).error, 'incomplete')
  assert.equal(tracker().builds.read(dir).status, 'error', 'not promoted to complete on the next read')
  // A pass followed by another checkpoint needs checking again.
  builds.retry(dir); builds.start(dir, 's1')
  builds.event({ sessionId: 's1', type: 'tool', tool: 'bash', input: { command: 'python .opencode/skills/build/check_program.py program.json' }, output: 'PASS program.json' })
  builds.event({ sessionId: 's1', type: 'tool', tool: 'bash', input: { command: 'python .opencode/skills/build/program_io.py .humanstudy/tmp/batch-07.json' }, output: 'Saved program.json' })
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
    assert.match(prompt, /protocol_io\.py/)
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
  // One saved record without an id (a slip the app tolerates) must not make a batch replace the list.
  const slip = JSON.parse(readFileSync(join(dir, 'program.json'), 'utf8'))
  slip.evidence.splice(1, 0, { quote: 'slip without an id' })
  writeFileSync(join(dir, 'program.json'), JSON.stringify(slip, null, 2), 'utf8')
  r = run({ evidence: [{ ...p.evidence[0], id: 'ev-new' }] })
  assert.equal(r.status, 0, r.stderr)
  saved = JSON.parse(readFileSync(join(dir, 'program.json'), 'utf8'))
  assert.equal(saved.evidence.length, slip.evidence.length + 1, 'saved evidence was dropped')
  assert.equal(saved.evidence[1].quote, 'slip without an id')
  assert.ok(!readdirSync(dir).some((f) => f.endsWith('.tmp')), 'temporary file left behind')
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

test('completion rejects a valid but unextracted second study, including shared-only coverage', () => {
  const p = JSON.parse(sample)
  p.studies.push({ id: 's2', title: 'Identified but not extracted', type: 'empirical' })
  const dir = project()
  writeFileSync(join(dir, 'program.json'), JSON.stringify(p))
  assert.equal(P.programComplete(dir), false)
  p.nodes.forEach(n => { n.studyIds = [] })
  writeFileSync(join(dir, 'program.json'), JSON.stringify(p))
  assert.equal(P.programComplete(dir), false, 'shared paper facts cannot silently cover an omitted study')
  const { builds } = tracker(); builds.bind('s', dir); builds.start(dir, 's')
  builds.event({ sessionId: 's', type: 'tool', tool: 'bash', input: 'check_program.py program.json', output: 'PASS program.json' })
  builds.event({ sessionId: 's', type: 'done' })
  assert.equal(builds.read(dir).error, 'incomplete', 'generic schema PASS is not completion')
})

test('missing source information with targeted issues is a completed extraction, not a reason to invent', () => {
  const p = JSON.parse(sample)
  for (const n of p.nodes) {
    const f = n.fields[0]; f.value = null; f.state = 'missing'; f.origin = 'unknown'
    p.issues.push({ id: `missing-${n.id}`, title: 'Not reported', severity: 'check', reason: 'Source does not report this.', impact: 'Needs researcher review.', suggestedAction: 'Supply original materials if available.', nodeId: n.id, fieldId: f.id, studyId: 's1', evidenceIds: [] })
  }
  const dir = project(); writeFileSync(join(dir, 'program.json'), JSON.stringify(p))
  assert.equal(P.programComplete(dir), true)
  p.issues.pop(); writeFileSync(join(dir, 'program.json'), JSON.stringify(p))
  assert.equal(P.programComplete(dir), false, 'an untracked missing field cannot finish the build')
})

test('PASS is bound to exact current bytes, even for shell writes and after restart', () => {
  const dir = project(), { builds } = tracker(); builds.bind('s', dir); builds.start(dir, 's')
  writeFileSync(join(dir, 'program.json'), sample)
  builds.event({ sessionId: 's', type: 'tool', input: 'check_program.py program.json', output: 'PASS program.json' })
  const checkedHash = builds.read(dir).validationHash
  assert.match(checkedHash, /^[a-f0-9]{64}$/)
  // A shell write not mentioned in tool metadata, still valid and covered, invalidates the certificate.
  writeFileSync(join(dir, 'program.json'), sample + '\n')
  builds.event({ sessionId: 's', type: 'tool', tool: 'bash', input: 'python custom_script.py', output: 'updated' })
  builds.event({ sessionId: 's', type: 'done' })
  assert.equal(builds.read(dir).status, 'error')
  builds.event({ sessionId: 's', type: 'tool', input: 'check_program.py program.json --complete', output: 'PASS program.json' })
  builds.event({ sessionId: 's', type: 'done' })
  assert.equal(builds.read(dir).status, 'complete')
  assert.notEqual(builds.read(dir).validationHash, checkedHash)
  assert.equal(tracker().builds.read(dir).status, 'complete')
  writeFileSync(join(dir, 'program.json'), sample)
  assert.equal(tracker().builds.read(dir).status, 'error', 'stale completion does not survive reopen')
})

test('Python final-build check and app coverage gate agree', { skip: !python }, () => {
  assert.equal(readFileSync(join(here, '../shared/build-coverage.json'), 'utf8'), readFileSync(join(here, '../../../pack/schema/build-coverage.json'), 'utf8'))
  const dir = project(), path = join(dir, 'program.json')
  const checker = join(here, '../../../pack/skills/build/check_program.py')
  const p = JSON.parse(sample)
  for (const kind of ['complete', 'empty-study', 'analysis-only', 'missing', 'untracked-missing', 'empty-values']) {
    const value = structuredClone(p)
    if (kind === 'empty-study') value.studies.push({ id: 's2', title: 'Empty', type: 'empirical' })
    if (kind === 'analysis-only') { value.studies[0].type = 'analysis'; value.nodes = value.nodes.filter(n => ['analysis','result'].includes(n.kind)) }
    if (kind === 'missing' || kind === 'untracked-missing') {
      value.nodes[0].fields[0].state = 'missing'; value.nodes[0].fields[0].value = null
      if (kind === 'missing') value.issues.push({ id: 'missing', title: 'Missing', severity: 'check', reason: 'Not reported', impact: 'Unknown sample', suggestedAction: 'Review source', nodeId: value.nodes[0].id, fieldId: value.nodes[0].fields[0].id, evidenceIds: [] })
    }
    if (kind === 'empty-values') value.nodes.forEach(n => n.fields.forEach(f => { f.value = '' }))
    writeFileSync(path, JSON.stringify(value))
    const result = spawnSync(python, [checker, path, '--complete'], { encoding: 'utf8' })
    assert.equal(result.status === 0, P.programComplete(dir), `${kind}: ${result.stdout} ${result.stderr}`)
  }
})

test('normal human edits and later agent rechecks do not leave a completed project falsely stuck', () => {
  const dir = project(), { builds } = tracker(); builds.bind('s', dir); builds.start(dir, 's')
  writeFileSync(join(dir, 'program.json'), sample)
  const pass = { sessionId: 's', type: 'tool', input: 'check_program.py program.json --complete', output: 'PASS program.json' }
  builds.event(pass); builds.event({ sessionId: 's', type: 'done' })
  const before = builds.read(dir).validationHash
  const p = JSON.parse(sample); p.nodes[0].fields[0].value = 'Confirmed human correction'
  writeFileSync(join(dir, 'program.json'), JSON.stringify(p))
  builds.humanSaved(dir)
  assert.equal(builds.read(dir).status, 'complete')
  assert.notEqual(builds.read(dir).validationHash, before)
  // A legitimate agent recheck may arrive before the folder watcher invalidates the old hash.
  writeFileSync(join(dir, 'program.json'), sample)
  builds.event(pass)
  assert.equal(builds.read(dir).status, 'complete')
  assert.equal(builds.read(dir).validationHash, before)
})

test('protocol-only drafts finish without a program.json or trusting tool PASS, and survive restart', async()=>{
 const dir=project();let calls=0
 const certify=async dir=>{calls++;return {hash:createHash('sha256').update(readFileSync(join(dir,'protocol.json'))).digest('hex'),problems:[]}}
 const builds=P.createPaperBuilds(()=>{},certify);builds.bind('p',dir);builds.start(dir,'p')
 writeFileSync(join(dir,'protocol.json'),'{"id":"draft","arms":[{"id":"a","runnable":false,"why":"Original material missing"}]}')
 await builds.event({sessionId:'p',type:'done'})
 assert.equal(calls,1);assert.equal(builds.read(dir).status,'complete');assert.equal(builds.read(dir).validationRoute,'protocol')
 assert.equal(existsSync(join(dir,'program.json')),false)
 assert.equal(P.createPaperBuilds(()=>{},certify).read(dir).status,'complete')
 writeFileSync(join(dir,'protocol.json'),'{"id":"changed"}')
 assert.equal(builds.read(dir).status,'error','a stale certificate cannot validate changed bytes')
})
test('protocol check failures, edits during checking and shutdown do not falsely complete',async()=>{
 for(const kind of ['failed','changed','shutdown']){
  const dir=project();writeFileSync(join(dir,'protocol.json'),'{}')
  const builds=P.createPaperBuilds(()=>{},async()=>{
   const hash=createHash('sha256').update(readFileSync(join(dir,'protocol.json'))).digest('hex')
   if(kind==='changed')writeFileSync(join(dir,'protocol.json'),'{"changed":true}')
   return {hash,problems:kind==='failed'?['Missing source references']:[]}
  });builds.bind('p',dir);builds.start(dir,'p')
  await builds.event({sessionId:'p',type:'tool',input:'python -m hsenv.checks .',output:'{"PASS":true}'})
  await builds.event({sessionId:'p',type:'done',...(kind==='shutdown'?{detail:'shutdown'}:{})})
  assert.equal(builds.read(dir).status,'error',kind)
 }
})


test('protocol snapshots independently recheck persisted status after restart and reject forged completion',async()=>{
 const dir=project();writeFileSync(join(dir,'protocol.json'),'{}')
 P.writePaperBuild(dir,{status:'complete',phase:'checking',checked:true,validationRoute:'protocol',validationHash:createHash('sha256').update('{}').digest('hex')})
 let checks=0
 const builds=P.createPaperBuilds(()=>{},async()=>{checks++;return {hash:createHash('sha256').update('{}').digest('hex'),problems:['No protocol structure']}})
 assert.equal((await builds.snapshot(dir)).status,'error')
 assert.equal(checks,1,'a project status file cannot certify its own protocol')
})


test('a checked legacy program still completes when an unfinished protocol file also exists',async()=>{
 const dir=project();let calls=0
 const builds=P.createPaperBuilds(()=>{},async()=>{calls++;return null})
 builds.bind('p',dir);builds.start(dir,'p')
 writeFileSync(join(dir,'program.json'),sample);writeFileSync(join(dir,'protocol.json'),'{}')
 builds.event({sessionId:'p',type:'tool',input:'check_program.py program.json --complete',output:'PASS program.json'})
 await builds.event({sessionId:'p',type:'done'})
 assert.equal(builds.read(dir).status,'complete');assert.equal(builds.read(dir).validationRoute,'program');assert.equal(calls,0)
})


test('only the owning build or an explicit build action selects the build model',()=>{
 const state={status:'running',phase:'writing',sessionId:'build'}
 assert.equal(P.isBuildTurn(state,'build','composer.send'),true)
 assert.equal(P.isBuildTurn(state,'other','composer.send'),false)
 assert.equal(P.isBuildTurn(undefined,'chat','simulation.build'),true)
 assert.equal(P.isBuildTurn(undefined,'chat','paper.build'),true)
 assert.equal(P.isBuildTurn({status:'complete',phase:'checking'},'chat','composer.send'),false)
})

test('paired builds wait for complete research and preview, then bind both without changing run readiness',async()=>{
 const dir=project(), assets=join(here,'../../resources/protocol-sample')
 P.pendingPaperBuild(dir,true)
 const builds=P.createPaperBuilds(()=>{},async()=>({hash,problems:[]}))
 builds.bind('paired',dir);builds.start(dir,'paired')
 writeFileSync(join(dir,'program.json'),sample)
 builds.event({sessionId:'paired',type:'tool',input:'check_program.py program.json --complete',output:'PASS program.json'})
 await builds.event({sessionId:'paired',type:'done'})
 assert.equal(builds.read(dir).status,'error','a fresh paper cannot complete on a legacy program certificate')
 assert.equal(builds.retry(dir),true)
 assert.equal(builds.read(dir).requiresPairedDelivery,true)
 builds.start(dir,'paired')
 const protocol=JSON.parse(readFileSync(join(assets,'protocol.json'),'utf8'));protocol.meta.delivery='research-program-v1'
 const raw=JSON.stringify(protocol),hash=createHash('sha256').update(raw).digest('hex')
 writeFileSync(join(dir,'protocol.json'),raw)
 await builds.event({sessionId:'paired',type:'done'})
 assert.equal(builds.read(dir).status,'error','a protocol-only success is not a complete paired build')
 const research=JSON.parse(readFileSync(join(assets,'program.json'),'utf8'));research.extensions.scholarly.protocol.sha256=hash
 writeFileSync(join(dir,'program.json'),JSON.stringify(research))
 assert.equal(P.programComplete(dir),false,'a scholarly document cannot pass the legacy executable-program route')
 mkdirSync(join(dir,'artifacts'),{recursive:true})
 writeFileSync(join(dir,'artifacts/preview.html'),`<script id="hs-protocol">${JSON.stringify({id:protocol.id,sha256:hash})}</script>`)
 await builds.event({sessionId:'paired',type:'done'})
 assert.equal(builds.read(dir).status,'complete')
 assert.match(builds.read(dir).deliveryHash,/^[a-f0-9]{64}$/)
 research.nodes[0].fields[0].value='A researcher edit';writeFileSync(join(dir,'program.json'),JSON.stringify(research))
 assert.equal(builds.read(dir).status,'error','old completion cannot certify changed scholarly bytes')
})

test('scholarly checkpoint writer refuses stale bytes and keeps the researcher edit', {skip: !python},()=>{
 const dir=project(), file=join(dir,'program.json'), io=join(here,'../../../pack/skills/build/program_io.py')
 const save=(patch,expected)=>spawnSync(python,[io,'-','--expected-hash',expected],{cwd:dir,input:JSON.stringify(patch),encoding:'utf8'})
 const original=save(JSON.parse(sample),'absent');assert.equal(original.status,0,original.stderr)
 const base=createHash('sha256').update(readFileSync(file)).digest('hex')
 const changed=JSON.parse(readFileSync(file,'utf8'));changed.title='Researcher title';writeFileSync(file,JSON.stringify(changed))
 const stale=save({title:'Agent patch'},base);assert.notEqual(stale.status,0);assert.match(stale.stderr,/changed/)
 assert.equal(JSON.parse(readFileSync(file,'utf8')).title,'Researcher title')
})
