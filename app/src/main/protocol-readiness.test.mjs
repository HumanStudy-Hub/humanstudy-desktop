// node --test src/main/protocol-readiness.test.mjs — the protocol route's gate (v0.8): hsenv.checks from the
// app's bundled engine, run confined, on a project's protocol.json. Fail-closed: no report, no pass.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'protocol-readiness-'))
await build({ entryPoints: [join(here, 'protocol-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'p.mjs'), logLevel: 'error' })
const R = await import(pathToFileURL(join(out, 'p.mjs')).href)

const engineDir = join(here, '../../../pack/runtime/hsenv')
// Every vendored engine file (VERSION lists them), as the app's trustedEngineFiles() hands them over.
const ENGINE = ['VERSION', ...[...readFileSync(join(engineDir, 'VERSION'), 'utf8').matchAll(/^[0-9a-f]{64} {2}(\S+)$/gm)].map((m) => m[1])]
  .map((rel) => [rel, readFileSync(join(engineDir, rel), 'utf8')])
// hsenv.checks needs Python 3.11+ (the app bundles 3.12).
// An absolute path, as the app passes it (the confined PATH holds only system folders).
const python = ['python3.12', 'python3.13', 'python3.11', 'python3'].map((p) =>
  spawnSync(p, ['-c', 'import sys; print(sys.executable) if sys.version_info >= (3, 11) else sys.exit(1)'], { encoding: 'utf8' }))
  .find((r) => r.status === 0)?.stdout.trim()
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-project-'))
  cpSync(join(here, 'fixtures/protocol-mini'), dir, { recursive: true })
  return dir
}

test('a passing report has no problems; a failing one lists each blocking finding, one line each', () => {
  assert.deepEqual(R.parseProtocolReport('{\n "refs": [],\n "fuzz": {"problems": []},\n "PASS": true\n}'), [])
  const failed = R.parseProtocolReport(JSON.stringify({
    refs: ['flow -> nowhere'], fuzz: { problems: [], unreached_stages: ['orphan'], n_unanswerable: 0, leaks: [], effects_not_computed: ['e1'] },
    verbatim: { not_found: [], image_unconfirmed: [], bad_source: [], unchecked: 3 }, coding: { c1: { mismatches: [1, 2] } },
    keyed: { problems: [], excluded_share: 0, signs: [{ effect: 'e2', same_sign: false }] }, PASS: false,
  }))
  assert.deepEqual(failed.map((p) => p.check), ['refs', 'fuzz', 'effects', 'keyed', 'verbatim', 'coding'])
  assert.match(failed.find((p) => p.check === 'verbatim').reason, /3 served text.*sourcetext/)
})

test('anything but a report with PASS: true never passes', () => {
  assert.throws(() => R.parseProtocolReport('no json'))
  assert.throws(() => R.parseProtocolReport('{"refs": []}'), /Invalid/)
  assert.deepEqual(R.parseProtocolReport('{"PASS": false}').map((p) => p.check), ['protocol'])
  assert.equal(R.parseProtocolReport('{"refs": ["x"], "PASS": true}').length, 1, 'a report that contradicts itself is not a pass')
  assert.throws(() => R.protocolOutcome('', ''))
  assert.deepEqual(R.protocolOutcome('', 'Traceback (most recent call last):\n  ...\nKeyError: \'nowhere\'').map((p) => [p.check, p.reason]),
    [['protocol', "The engine stopped on this protocol: KeyError: 'nowhere'"]])
})

test('no runtime or no engine: fail closed', async () => {
  assert.deepEqual(await R.protocolReadiness(null, ENGINE, fixture(), ''), [R.ENGINE_MISSING])
  assert.deepEqual(await R.protocolReadiness(python ?? 'python3', [], fixture(), ''), [R.ENGINE_FAILED])
  assert.deepEqual(await R.protocolReadiness('/nonexistent/python', ENGINE, fixture(), ''), [R.ENGINE_FAILED])
})

test('source texts inside the project are passed to the verbatim check; links out of it are not', async () => {
  const dir = fixture()
  const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'secret.txt')
  writeFileSync(outside, 'x')
  symlinkSync(outside, join(dir, 'sourcetext/linked.txt'))
  writeFileSync(join(dir, 'sourcetext/notes.md'), 'not a source text')
  const args = await R.sourceTextArgs(dir)
  assert.equal(args.length, 2)
  assert.equal(args[0], '--source-text')
  assert.match(args[1], /^survey=.*sourcetext[/\\]survey\.txt$/)
})

test('the bundled engine passes a sound protocol and blocks a broken one, confined and without keys', { skip: !python }, async () => {
  process.env.OPENROUTER_API_KEY = 'must-not-reach-the-engine'
  try {
    const ok = fixture()
    assert.deepEqual(await R.protocolReadiness(python, ENGINE, ok, ''), [])
    const orphan = fixture()
    const p = JSON.parse(readFileSync(join(orphan, 'protocol.json'), 'utf8'))
    p.stages.orphan = { responses: [{ id: 'z', kind: 'number', range: [0, 10] }] }
    writeFileSync(join(orphan, 'protocol.json'), JSON.stringify(p))
    const problems = await R.protocolReadiness(python, ENGINE, orphan, '')
    assert.ok(problems.length && problems.every((x) => x.check !== 'runtime'), JSON.stringify(problems))
    assert.ok(problems.some((x) => /orphan/.test(x.reason)))
    const broken = fixture()
    p.flow.seq.push({ stage: 'nowhere' })
    delete p.stages.orphan
    writeFileSync(join(broken, 'protocol.json'), JSON.stringify(p))
    const crash = await R.protocolReadiness(python, ENGINE, broken, '')
    assert.equal(crash.length, 1)
    assert.notEqual(crash[0].check, 'runtime')
  } finally { delete process.env.OPENROUTER_API_KEY }
})

test('review 1 S1: an expression too large to check stops at the CPU or memory bound and blocks', { skip: !python || process.platform === 'win32' }, async () => {
  const bomb = (expr) => {
    const dir = fixture()
    const p = JSON.parse(readFileSync(join(dir, 'protocol.json'), 'utf8'))
    p.units.s.fields.bomb = expr
    writeFileSync(join(dir, 'protocol.json'), JSON.stringify(p))
    return dir
  }
  const started = Date.now()
  // The engine's own expression limits (pass 2) now refuse most of these first; either way it blocks as a
  // property of the protocol, quickly, never as a broken runtime.
  const blocked = (problems) => problems.length === 1 && (problems[0].check === 'limits' || (problems[0].check === 'protocol' && /limit/.test(problems[0].reason)))
  const cpu = await R.protocolReadiness(python, ENGINE, bomb('10**10**8 > 0'), '', 60_000, { cpuSeconds: 2 })
  assert.ok(blocked(cpu), JSON.stringify(cpu))
  assert.ok(Date.now() - started < 30_000, 'stopped by the CPU bound, not the wall clock')
  const memStart = Date.now()
  const mem = await R.protocolReadiness(python, ENGINE, bomb('len([0]*(4*10**8))'), '', 60_000, { memoryBytes: 512 * 1024 ** 2 })
  assert.ok(blocked(mem), JSON.stringify(mem))
  assert.ok(Date.now() - memStart < 30_000, 'stopped by the memory bound (rlimit, or the RSS watch on macOS), not the wall clock')
  assert.deepEqual(await R.protocolReadiness(python, ENGINE, fixture(), '', 60_000, { cpuSeconds: 30, memoryBytes: 1024 ** 3 }), [], 'a sound protocol passes under the bounds')
  assert.match(R.runner(), /RLIMIT_CPU", 120\).*RLIMIT_AS", 2147483648\)/s)
})

const packRoot = join(here, '../../../pack')
const BUDGET_FILES = [
  ...ENGINE.map(([rel, text]) => ['hsenv/' + rel, text]),
  ...['run_study.py', 'fspec.py', 'render.py', 'budget.py'].map((f) => ['skills/run/' + f, readFileSync(join(packRoot, 'skills/run', f), 'utf8')]),
]

test('review 2 M3: the budget line is parsed strictly; anything malformed is an error, never a small budget', () => {
  const b = R.parseBudget('noise\n{"arms": {"a": {"group_size": 4, "calls": 30, "tokens_per_member": 90000}}, "output_tokens": 512}')
  assert.deepEqual(b, { arms: { a: { group_size: 4, calls: 30, tokens_per_member: 90000 } }, output_tokens: 512 })
  for (const bad of ['', '{}', '{"arms": {}}', '{"arms": {"a": {"group_size": 0, "calls": 1, "tokens_per_member": 1}}}',
    '{"arms": {"a": {"group_size": 1, "calls": 1.5, "tokens_per_member": 1}}}', '{"arms": {"a": {"group_size": 1, "calls": 1}}}'])
    assert.throws(() => R.parseBudget(bad), bad)
})

test('review 2 M3: the budget is measured from the protocol with the bundled runner, confined', { skip: !python }, async () => {
  assert.deepEqual(await R.protocolBudget(null, BUDGET_FILES, fixture(), ''), [R.ENGINE_MISSING])
  assert.deepEqual(await R.protocolBudget(python, ENGINE, fixture(), ''), [R.ENGINE_FAILED], 'no runner, no budget')
  const b = await R.protocolBudget(python, BUDGET_FILES, fixture(), '')
  assert.ok(!Array.isArray(b), JSON.stringify(b))
  assert.deepEqual(Object.keys(b.arms).sort(), ['control', 'treatment'])
  for (const a of Object.values(b.arms)) {
    assert.equal(a.group_size, 1)
    assert.ok(a.calls >= 2, 'two pages, with the margin')
    assert.ok(a.tokens_per_member > 2 * (512 + 512), 'every call reserves the output and message overhead')
  }
  // More pages, more tokens: a third page that shows the earlier ones again grows every later prompt.
  const longer = fixture()
  const p = JSON.parse(readFileSync(join(longer, 'protocol.json'), 'utf8'))
  p.stages.q2 = { responses: [{ id: 'again', kind: 'choice', prompt: 'And now?', options: [{ code: 'a', label: 'Option A' }, { code: 'b', label: 'Option B' }] }] }
  p.flow.seq.push({ stage: 'q2' })
  writeFileSync(join(longer, 'protocol.json'), JSON.stringify(p))
  const b2 = await R.protocolBudget(python, BUDGET_FILES, longer, '')
  assert.ok(b2.arms.control.tokens_per_member > b.arms.control.tokens_per_member)
})
