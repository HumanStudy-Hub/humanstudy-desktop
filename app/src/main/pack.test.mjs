// Pack install: the artifact kit lands in .opencode/artifact-kit, stays at the shipped version on refresh,
// Chart.js matches its recorded SHA-256; inline.py inlines the kit and rejects network/unknown ids.
//   node --test src/main/pack.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packDir = join(here, '../../../pack')
const out = mkdtempSync(join(tmpdir(), 'pack-test-'))

// esbuild has no import.meta.glob: expand it the way Vite does (eager, ?raw) from the pack on disk.
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
const globPlugin = {
  name: 'glob',
  setup(b) {
    b.onLoad({ filter: /pack\.ts$/ }, (args) => {
      let src = readFileSync(args.path, 'utf8')
      const included = walk(packDir).map((f) => relative(packDir, f).split('\\').join('/')).filter((r) =>
        (r === 'AGENTS.md' || r === 'PROJECT_FORMAT.md' || r.startsWith('schema/') || r.startsWith('skills/') || /^artifact-kit\/[^/]+$/.test(r) || r.startsWith('runtime/hsenv/') || r === 'runtime/lib/hs_original_text.py')
        && !r.split('/').includes('__pycache__') && !r.endsWith('.pyc'))
      const obj = Object.fromEntries(included.map((r) => ['../../../pack/' + r, readFileSync(join(packDir, r), 'utf8')]))
      src = src.replace(/import\.meta\.glob\([\s\S]*?\)\s*as Record<string, string>/, () => JSON.stringify(obj)) // no $ patterns
      return { contents: src, loader: 'ts' }
    })
  },
}
await build({ entryPoints: [join(here, 'pack.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'pack.mjs'), plugins: [globPlugin], logLevel: 'error' })
const P = await import(pathToFileURL(join(out, 'pack.mjs')).href)
const kit = JSON.parse(readFileSync(join(packDir, 'artifact-kit/kit.json'), 'utf8'))
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

test('installPack puts the artifact kit in .opencode/artifact-kit', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-'))
  await P.installPack(proj)
  for (const f of ['hs-kit.js', 'hs-kit.css', 'inline.py', 'chart.umd.min.js', 'kit.json', 'LICENSE.chartjs.md'])
    assert.ok(existsSync(join(proj, '.opencode/artifact-kit', f)), f)
  assert.ok(existsSync(join(proj, '.opencode/skills/visualize/SKILL.md')))
  assert.equal(sha(join(proj, '.opencode/artifact-kit/chart.umd.min.js')), kit.files['chart.umd.min.js'].sha256)
  assert.deepEqual(P.kitFiles().sort(), readdirSync(join(packDir, 'artifact-kit')).filter((f) => f !== '__pycache__').map((f) => 'artifact-kit/' + f).sort())
})

test('refreshPack installs a missing kit and restores a changed kit file', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-'))
  await P.refreshPack(proj)
  assert.ok(existsSync(join(proj, '.opencode/artifact-kit/hs-kit.js')))
  writeFileSync(join(proj, '.opencode/artifact-kit/hs-kit.js'), '// stale')
  await P.refreshPack(proj)
  assert.equal(readFileSync(join(proj, '.opencode/artifact-kit/hs-kit.js'), 'utf8'), readFileSync(join(packDir, 'artifact-kit/hs-kit.js'), 'utf8'))
})

test('the protocol engine is vendored as listed in VERSION and installed, app-owned, in .opencode/hsenv', async () => {
  const version = readFileSync(join(packDir, 'runtime/hsenv/VERSION'), 'utf8')
  assert.ok(!/(^|\s)\/(Users|home)\/|[A-Z]:\\/m.test(version), 'VERSION records hashes and a label, no local paths')
  const listed = [...version.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)].map((m) => [m[2], m[1]])
  assert.deepEqual(listed.map(([f]) => f).sort(), ['hsenv/__init__.py', 'hsenv/checks.py', 'hsenv/distribution.py', 'hsenv/effects_core.py', 'hsenv/engine.py',
    'hsenv/evaldata.py', 'hsenv/expr.py', 'hsenv/rewards.py', 'hsenv/schema_check.py', 'hsenv/score.py', 'hsenv/serve.py',
    'schema/protocol.v1.json', 'schema/run.v1.json', 'schema/study.v1.json'])
  assert.ok(!existsSync(join(packDir, 'runtime/hsenv/tests')), 'upstream tests name real studies: never vendored')
  assert.match(readFileSync(join(packDir, 'runtime/hsenv/LICENSE'), 'utf8'), /^MIT License/)
  for (const [f, hash] of listed) assert.equal(sha(join(packDir, 'runtime/hsenv', f)), hash, f + ' matches VERSION (run scripts/sync_hsenv.sh)')
  assert.deepEqual(P.trustedEngineFiles().map(([rel]) => rel).sort(), ['LICENSE', 'VERSION', ...listed.map(([f]) => f)].sort())
  const proj = mkdtempSync(join(tmpdir(), 'proj-'))
  await P.installPack(proj)
  const checks = join(proj, '.opencode/hsenv/hsenv/checks.py')
  assert.equal(sha(checks), Object.fromEntries(listed)['hsenv/checks.py'])
  writeFileSync(checks, '# edited in the project')
  await P.refreshPack(proj)
  assert.equal(sha(checks), Object.fromEntries(listed)['hsenv/checks.py'], 'refreshPack restores the shipped engine')
})

test('refreshPack upgrades an untouched previous visualize skill but keeps a customised one', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-'))
  const prev = spawnSync('git', ['show', '8a280df:pack/skills/visualize/SKILL.md'], { cwd: packDir, encoding: 'utf8' })
  if (prev.status !== 0) return // shallow checkout without the base commit
  const dest = join(proj, '.opencode/skills/visualize/SKILL.md')
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, prev.stdout)
  await P.refreshPack(proj)
  assert.equal(readFileSync(dest, 'utf8'), readFileSync(join(packDir, 'skills/visualize/SKILL.md'), 'utf8'))
  writeFileSync(dest, 'my own visualize rules')
  await P.refreshPack(proj)
  assert.equal(readFileSync(dest, 'utf8'), 'my own visualize rules')
})

test('refreshPack always upgrades the app-owned simulation security entry point', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-'))
  const prev = spawnSync('git', ['show', 'fc0c465:pack/skills/simulate/simkit.py'], { cwd: packDir, encoding: 'utf8' })
  if (prev.status !== 0) return // shallow checkout without the base commit
  const dest = join(proj, '.opencode/skills/simulate/simkit.py')
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, prev.stdout)
  await P.refreshPack(proj)
  assert.equal(readFileSync(dest, 'utf8'), readFileSync(join(packDir, 'skills/simulate/simkit.py'), 'utf8'))
  assert.match(readFileSync(dest, 'utf8'), /heartbeatAt/)
  writeFileSync(dest, '# my own runner')
  await P.refreshPack(proj)
  assert.equal(readFileSync(dest, 'utf8'), readFileSync(join(packDir, 'skills/simulate/simkit.py'), 'utf8'))
})

test('every shipped human-program schema is upgraded in existing projects (evidence note, #65)', async () => {
  const log = spawnSync('git', ['log', '--format=%H', '--', 'schema/human-program.schema.json'], { cwd: packDir, encoding: 'utf8' })
  const commits = log.status === 0 ? log.stdout.split('\n').filter(Boolean) : []
  if (commits.length < 2) return // shallow checkout without history
  const current = readFileSync(join(packDir, 'schema/human-program.schema.json'), 'utf8')
  const sha = (s) => createHash('sha256').update(s).digest('hex')
  const listed = JSON.parse(readFileSync(join(here, 'previous-pack-hashes.json'), 'utf8'))['schema/human-program.schema.json']
  for (const c of commits) {
    const old = spawnSync('git', ['show', `${c}:pack/schema/human-program.schema.json`], { cwd: packDir, encoding: 'utf8' }).stdout
    if (old === current) continue
    assert.ok(listed.includes(sha(old)), `previous-pack-hashes.json lacks the schema shipped at ${c.slice(0, 7)}`)
    const proj = mkdtempSync(join(tmpdir(), 'proj-'))
    const dest = join(proj, 'schema/human-program.schema.json')
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, old)
    await P.refreshPack(proj)
    assert.equal(readFileSync(dest, 'utf8'), current, `schema from ${c.slice(0, 7)} is upgraded`)
  }
})

const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0)
test('inline.py inlines the kit, embeds the program and checks the page', { skip: !python }, () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-'))
  mkdirSync(join(proj, 'artifacts'))
  writeFileSync(join(proj, 'program.json'), JSON.stringify({
    id: 'p', title: 'T', studies: [{ id: 'study1', title: 'Study 1' }],
    nodes: [{ id: 'n1', kind: 'result', title: 'R', studyIds: ['study1'], fields: [{ id: 'effect', label: 'Effect', value: 'x', origin: 'reported', state: 'confirmed', evidenceIds: ['e1'] }], evidenceIds: ['e1'] }],
    steps: [], evidence: [{ id: 'e1', sourceId: 'paper', locator: { page: 4 }, quote: 'q </script> q' + ' complete quoted context'.repeat(100) + 'END-OF-QUOTE' }], issues: [],
  }))
  const page = join(proj, 'artifacts/v.html')
  writeFileSync(page, '<!doctype html><html lang="en"><head><title>V</title><link rel="stylesheet" href="hs-kit.css"><script src="hs-kit.js"></script></head><body><div data-program-id="n1/effect" data-page="4"></div><div id="c"></div><script>HS.results("#c",{groups:[{label:"A",id:"n1",human:{mean:1}}]})</script></body></html>')
  const run = () => spawnSync(python, [join(packDir, 'artifact-kit/inline.py'), 'artifacts/v.html'], { cwd: proj, encoding: 'utf8' })
  let r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^PASS/)
  let html = readFileSync(page, 'utf8')
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none';/)
  assert.ok(html.includes('data-hs-kit="css"') && html.includes('data-hs-kit="js"') && html.includes('id="hs-program"'))
  assert.ok(!html.includes('data-hs-kit="chart"'), 'Chart.js only when referenced')
  assert.ok(!/<link[^>]*hs-kit\.css/.test(html) && !/src="hs-kit\.js"/.test(html))
  assert.ok(!html.includes('q </script> q'), 'embedded JSON escapes </script>')
  assert.ok(html.includes('END-OF-QUOTE'),'citation context is not clipped at 500 characters')
  // idempotent: a second run keeps exactly one copy of the kit
  r = run(); html = readFileSync(page, 'utf8')
  assert.equal(r.status, 0)
  assert.equal(html.split('data-hs-kit="js"').length, 2)
  // network references, unknown ids and wrong pages fail the check
  writeFileSync(page, '<html><head></head><body><img src="https://x.example/a.png"><i data-program-id="nope"></i><i data-program-id="n1" data-page="9"></i><script>fetch("/x")</script></body></html>')
  r = run()
  assert.equal(r.status, 1)
  assert.match(r.stdout, /loads a URL/)
  assert.match(r.stdout, /network call in script/)
  assert.match(r.stdout, /"nope" is not an id/)
  assert.match(r.stdout, /data-page="9" on n1 but its evidence is on p\. 4/)
})

test('existing projects get the shared lock/checker/policy and old default build prompts are upgraded', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-safe-program-'))
  const original = spawnSync('git', ['show', '815242a:pack/skills/build/SKILL.md'], { cwd: packDir, encoding: 'utf8' })
  const skill = join(proj, '.opencode/skills/build/SKILL.md')
  mkdirSync(dirname(skill), { recursive: true })
  if (original.status === 0) writeFileSync(skill, original.stdout)
  await P.refreshPack(proj)
  for (const rel of ['.opencode/skills/build/program_io.py', '.opencode/skills/build/program_lock.py', '.opencode/skills/build/check_program.py', 'schema/build-coverage.json'])
    assert.ok(existsSync(join(proj, rel)), rel)
  assert.match(readFileSync(skill, 'utf8'), /program.json --complete/)
  writeFileSync(skill, 'Researcher custom instructions')
  await P.refreshPack(proj)
  assert.equal(readFileSync(skill, 'utf8'), 'Researcher custom instructions')
})

// T11: the readiness gate runs the app's bundled checkers (scientific-readiness.ts + check_readiness.py).
await build({ entryPoints: [join(here, 'scientific-readiness.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'science.mjs'), logLevel: 'error' })
const SR = await import(pathToFileURL(join(out, 'science.mjs')).href)
// A python with jsonschema, as the research runtime has (HUMANSTUDY_TEST_PYTHON on CI).
// The real interpreter path (not a version-manager shim), since the checker runs with a minimal PATH.
const sciencePython = [process.env.HUMANSTUDY_TEST_PYTHON, 'python3', 'python'].filter(Boolean)
  .map((p) => spawnSync(p, ['-I', '-c', 'import jsonschema, sys; print(sys.executable)'], { encoding: 'utf8' }))
  .find((r) => r.status === 0 && r.stdout.trim())?.stdout.trim()

test('T11: the trusted checker set holds every script check_readiness.py needs', () => {
  const rels = P.trustedCheckFiles().map(([rel]) => rel)
  for (const rel of ['skills/build/check_readiness.py', 'skills/build/check_package.py', 'skills/build/check_validity.py', 'skills/build/check_verbatim.py',
    'skills/build/check_results.py', 'skills/build/effects.py', 'skills/build/sources.py', 'skills/build/check_program.py', 'skills/build/check_quotes.py',
    'skills/build/sandbox_run.py', 'skills/export/agent/effects_core.py', 'schema/human-program.schema.json', 'schema/build-coverage.json', 'schema/effects.schema.json'])
    assert.ok(rels.includes(rel), rel)
  assert.ok(rels.every((rel) => !rel.startsWith('skills/simulate/')), 'only the checks, not the runners')
})

test('T11: no runtime or an unreadable report never passes', async () => {
  assert.deepEqual(await SR.scientificReadiness(null, P.trustedCheckFiles(), '/nowhere', 'k', ''), [SR.RUNTIME_MISSING])
  assert.throws(() => SR.parseScientificReport('PASS'))
  assert.throws(() => SR.parseScientificReport('{"problems": [{"check": 1}]}'))
  assert.deepEqual(SR.parseScientificReport('noise\n{"problems": []}\n'), [])
  const fake = process.platform === 'win32' ? 'C:\\nonexistent\\python.exe' : '/nonexistent/python3'
  assert.deepEqual(await SR.scientificReadiness(fake, P.trustedCheckFiles(), '/nowhere', 'k', ''), [SR.CHECKS_FAILED])
})

test('T11: end to end, a good package passes and a failed check blocks, whatever the project\'s own checker says', { skip: !sciencePython, timeout: 600_000 }, async () => {
  const fixture = (args) => {
    const r = spawnSync(sciencePython, ['-c', `import sys, json; sys.path.insert(0, sys.argv[1]); import test_check_readiness as T; print(T.make_project(**json.loads(sys.argv[2])))`,
      join(packDir, 'runtime/tests'), JSON.stringify(args)], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  const good = fixture({})
  assert.deepEqual(await SR.scientificReadiness(sciencePython, P.trustedCheckFiles(), good, 'fixture', ''), [])
  const bad = fixture({ effects: false })
  mkdirSync(join(bad, '.opencode/skills/build'), { recursive: true })
  writeFileSync(join(bad, '.opencode/skills/build/check_readiness.py'), 'print(\'{"problems": []}\')\n')
  writeFileSync(join(bad, '.opencode/skills/build/effects.py'), 'def build_rules(*a):\n    return []\n')
  const problems = await SR.scientificReadiness(sciencePython, P.trustedCheckFiles(), bad, 'fixture', '')
  assert.deepEqual(problems, [{ check: 'effects', reason: 'effects.json is missing' }])
})

// v0.8 protocol route: skills/run plays protocol.json with an f; skills/preview renders it. Python 3.11+ (the app
// bundles 3.12). A made-up fixture protocol only (protocols are private).
const python311 = ['python3.12', 'python3.13', 'python3.11', 'python3'].map((p) =>
  spawnSync(p, ['-c', 'import sys; print(sys.executable) if sys.version_info >= (3, 11) else sys.exit(1)'], { encoding: 'utf8' }))
  .find((r) => r.status === 0)?.stdout.trim()
const protocolProject = async () => {
  const proj = mkdtempSync(join(tmpdir(), 'protocol-proj-'))
  await P.installPack(proj)
  for (const rel of ['protocol.json', 'sourcetext/survey.txt']) {
    mkdirSync(dirname(join(proj, rel)), { recursive: true })
    writeFileSync(join(proj, rel), readFileSync(join(here, 'fixtures/protocol-mini', rel)))
  }
  return proj
}

test('skills/run and the engine are installed where run_study.py looks for them (.opencode/skills/run, .opencode/hsenv)', async () => {
  const proj = await protocolProject()
  for (const rel of ['.opencode/skills/run/run_study.py', '.opencode/skills/run/app_run.py', '.opencode/skills/run/protocol_report.py',
    '.opencode/skills/run/SKILL.md', '.opencode/hsenv/hsenv/engine.py', '.opencode/skills/preview/make_preview.py'])
    assert.ok(existsSync(join(proj, rel)), rel)
  for (const skill of ['run', 'preview']) {
    const vendored = readFileSync(join(packDir, 'skills', skill, 'VENDORED'), 'utf8')
    assert.ok(!/\/Users\/|\/home\//.test(vendored))
    const listed = [...vendored.matchAll(/^([0-9a-f]{64}) {2}(\S+)$/gm)]
    assert.ok(listed.length >= 3, skill)
    for (const [, hash, f] of listed) {
      assert.equal(sha(join(packDir, 'skills', skill, f)), hash, `${skill}/${f} matches VENDORED (run scripts/sync_hsenv.sh)`)
      assert.ok(!/\/Users\/|\/home\//.test(readFileSync(join(packDir, 'skills', skill, f), 'utf8')), `${skill}/${f}: no local paths`)
    }
  }
})

test('a protocol run with a stub f ends to end: records, effects, a results page that passes the kit checks, summary', { skip: !python311 }, async () => {
  const proj = await protocolProject()
  const run = 'artifacts/simulations/2026-11-09-0100'
  const hash = sha(join(proj, 'protocol.json'))
  let r = spawnSync(python311, ['-B', '.opencode/skills/run/app_run.py', 'new', run, '--per-arm', '5', '--protocol-hash', 'f'.repeat(64)], { cwd: proj, encoding: 'utf8' })
  assert.notEqual(r.status, 0, 'a changed protocol is refused')
  assert.match(r.stderr, /changed after approval/)
  r = spawnSync(python311, ['-B', '.opencode/skills/run/app_run.py', 'new', run, '--per-arm', '5', '--protocol-hash', hash], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(readFileSync(join(proj, run, 'run.py'), 'utf8'), /app_run\.main_run\(RUN, PROJECT/)
  // The stub stands in for the relay-backed model: it answers the one question with the first option, as JSON.
  const stub = `import sys, json; from pathlib import Path
sys.path.insert(0, '.opencode/skills/run'); import app_run
def complete(messages):
    assert messages[0]['role'] == 'system' and 'JSON' in messages[0]['content']
    return '{"r1": "o1"}' if 'r1' in messages[-1]['content'] else '{}'
run = Path(sys.argv[1]).resolve()
app_run.main_run(run, Path('.').resolve(), trial=True, complete=complete, model='stub')
meta = app_run.main_run(run, Path('.').resolve(), complete=complete, model='stub')
print(json.dumps({'status': meta['status'], 'completed': meta['participants']['completed']}))`
  r = spawnSync(python311, ['-B', '-c', stub, run], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').at(-1)), { status: 'done', completed: 10 })
  for (const f of ['run.json', 'progress.json', 'records.jsonl', 'operator.jsonl', 'effects.json', 'results.html', 'summary.json', 'trial/records.jsonl'])
    assert.ok(existsSync(join(proj, run, f)), f)
  const meta = JSON.parse(readFileSync(join(proj, run, 'run.json'), 'utf8'))
  assert.equal(meta.protocol_sha256, hash)
  assert.equal(meta.f.model, 'stub')
  assert.equal(JSON.parse(readFileSync(join(proj, run, 'progress.json'), 'utf8')).stage, 'done')
  const page = readFileSync(join(proj, run, 'results.html'), 'utf8')
  assert.match(page, /Simulation with AI participants — not data from people\. A comparison with the paper(?:'|&#x27;)s printed numbers, not a leaderboard\./)
  assert.match(page, /id="hs-protocol"/)
  assert.match(page, /treatment 14\/20 vs control 8\/20/, 'the paper side: printed cells')
  // Plain words up front; every code string lives under "Technical details" (UX check, blocker 3).
  const [front, tech] = page.split('<details class="hs-card"><summary>Technical details</summary>')
  assert.ok(tech, 'the scores and "What ran" sit under Technical details')
  const visible = front.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
  for (const code of ['offline_report', 'hsenv', 'n_paper', 'significance_match', 'risk_difference', 'SHA-256', 'Kind B', 'official n', 'prefer_a'])
    assert.ok(!visible.includes(code), code + ' is shown outside Technical details')
  assert.match(visible, /Unofficial comparison: values only, no pass or fail\./)
  assert.match(visible, /difference in proportions/)
  assert.match(page, /treatment 5\/5 vs control 5\/5/, 'the AI side: this run')
  // S9: the engine's scores (hsenv.score via run_study), with their labels and not-computable reasons.
  assert.match(tech, /Scores — offline report, not a leaderboard/)
  assert.match(tech, /<b>Significance agreement<\/b>/, 'reward names in words')
  assert.match(tech, /<code class="hs-code">engine code: significance_match-v1<\/code>/, 'raw codes only in a labelled code line')
  assert.match(page, /significance_match-v1/)
  assert.match(tech, /unofficial comparison: values only, no pass or fail/, '5 per arm, the paper had 10')
  assert.match(page, /no printed human SD \(1\)/, 'not-computable reasons are shown')
  assert.match(page, /intention-to-treat not applicable/)
  assert.match(tech, /human n unverified in control, treatment \(printed n, no analysed n\)/)
  assert.ok(!/>official</.test(tech) && !/· official ·/.test(tech), 'never "official" outside the strict definition')
  assert.equal(JSON.parse(readFileSync(join(proj, run, 'run.json'), 'utf8')).evaluation.rewards['significance_match-v1'].report_scope, 'offline_report — not a leaderboard')
  assert.ok(!existsSync(join(proj, 'artifacts/simulations/.baseline-cache')), 'the baseline cache stays inside the run folder')
  assert.ok(existsSync(join(proj, run, '.baseline-cache')))
  r = spawnSync(python311, ['.opencode/artifact-kit/inline.py', join(run, 'results.html')], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /^PASS .*protocol embedded/m)
  const summary = JSON.parse(readFileSync(join(proj, run, 'summary.json'), 'utf8'))
  // 5 per arm against the paper's 10: non_official, so the tab's headline is the neutral "Finished" (review 3, M1).
  assert.deepEqual([summary.route, summary.outcome, summary.official, summary.perCondition, summary.calls], ['protocol', 'unknown', false, 5, 20])
  // A record holds only what f saw and did; the arm stays on the operator side.
  const record = JSON.parse(readFileSync(join(proj, run, 'records.jsonl'), 'utf8').split('\n')[0])
  assert.ok(!JSON.stringify(record).includes('treatment') && !JSON.stringify(record).includes('"arm"'))
})

test('inline.py checks a protocol artifact against protocol.json: a participant preview keeps its own page', { skip: !python }, async () => {
  const proj = await protocolProject()
  mkdirSync(join(proj, 'artifacts'))
  const preview = '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="hs-artifact" content="participant-preview">\n' +
    '<title>Participant preview</title>\n<style>.p{color:#123}</style>\n</head>\n<body>\n<div class="p" data-program-id="q.pick">Which do you prefer?</div>\n' +
    '<script type="application/json" id="hs-preview">{"arms":[]}</script>\n<script>document.title += ""</script>\n</body>\n</html>\n'
  const file = join(proj, 'artifacts/preview.html')
  writeFileSync(file, preview)
  let r = spawnSync(python, [join(proj, '.opencode/artifact-kit/inline.py'), 'artifacts/preview.html'], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /protocol embedded/)
  const once = readFileSync(file, 'utf8')
  assert.ok(!once.includes('data-hs-kit="js"'), 'the kit is not added to a self-contained preview')
  assert.match(once, /id="hs-protocol" data-hs-kit="protocol">\{"id": "fixture-mini", "sha256": "[0-9a-f]{64}"/)
  assert.ok(!once.includes('Which do you prefer?</script>'), 'the protocol block carries ids, not screen text')
  r = spawnSync(python, [join(proj, '.opencode/artifact-kit/inline.py'), 'artifacts/preview.html'], { cwd: proj, encoding: 'utf8' })
  assert.equal(readFileSync(file, 'utf8'), once, 'idempotent')
  writeFileSync(file, preview.replace('data-program-id="q.pick"', 'data-program-id="q.nothing"'))
  r = spawnSync(python, [join(proj, '.opencode/artifact-kit/inline.py'), 'artifacts/preview.html'], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /data-program-id="q\.nothing" is not a protocol ref/)
  writeFileSync(file, preview.replace('</style>', '</style>\n<img src="https://example.org/x.png">'))
  r = spawnSync(python, [join(proj, '.opencode/artifact-kit/inline.py'), 'artifacts/preview.html'], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 1, 'offline rules still apply')
  const bare = mkdtempSync(join(tmpdir(), 'no-protocol-'))
  writeFileSync(join(bare, 'p.html'), preview)
  r = spawnSync(python, [join(proj, '.opencode/artifact-kit/inline.py'), join(bare, 'p.html')], { cwd: bare, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /checked against protocol\.json, and none was found/)
})

const previewVendored = existsSync(join(packDir, 'skills/preview/build_preview.py'))
test('skills/preview builds the participant view of the fixture and it passes the kit checks', { skip: !python311 ? 'needs Python 3.11+' : !previewVendored }, async () => {
  const proj = await protocolProject()
  const r = spawnSync(python311, ['-B', '.opencode/skills/preview/make_preview.py', '--out', 'artifacts/preview.html'], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /^PASS /m)
  assert.match(readFileSync(join(proj, 'artifacts/preview.html'), 'utf8'), /id="hs-protocol" data-hs-kit="protocol">\{"id": "fixture-mini"/)
  const again = spawnSync(python311, ['.opencode/artifact-kit/inline.py', 'artifacts/preview.html'], { cwd: proj, encoding: 'utf8' })
  assert.equal(again.status, 0, again.stdout)
  // The page's own words follow the app's UI language (the workspace context's uiLanguage); screens keep theirs.
  const zh = spawnSync(python311, ['-B', '.opencode/skills/preview/make_preview.py', '--out', 'artifacts/preview-zh.html', '--lang', 'zh-CN'], { cwd: proj, encoding: 'utf8' })
  assert.equal(zh.status, 0, zh.stdout + zh.stderr)
  assert.match(readFileSync(join(proj, 'artifacts/preview-zh.html'), 'utf8'), /data-ui-lang="zh"/)
  assert.match(readFileSync(join(proj, 'artifacts/preview.html'), 'utf8'), /data-ui-lang="en"/)
  assert.match(readFileSync(join(here, '../renderer/components/Workbench.tsx'), 'utf8'), /uiLanguage: getLang\(\),/)
})

// Review 2 (S10): app_run.py, protocol_report.py and the relay binding, on the made-up fixture with a fake model.
const runFixture = async (perArm = 3) => {
  const proj = await protocolProject()
  const run = 'artifacts/simulations/2026-11-09-0200'
  const r = spawnSync(python311, ['-B', '.opencode/skills/run/app_run.py', 'new', run, '--per-arm', String(perArm), '--protocol-hash', sha(join(proj, 'protocol.json'))], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return { proj, run }
}
// A fake model: answers the question; `fail` makes the n-th call raise (a relay refusal) from then on.
const play = (proj, run, { env = {}, fail = 0, trial = false } = {}) => spawnSync(python311, ['-B', '-c', `import sys, json; from pathlib import Path
sys.path.insert(0, '.opencode/skills/run'); import app_run
calls = [0]
def complete(messages):
    calls[0] += 1
    if ${fail} and calls[0] >= ${fail}:
        raise RuntimeError('model call failed: HTTP 402 Run token cap reached.')
    return '{"r1": "o1"}' if 'r1' in messages[-1]['content'] else '{}'
try:
    meta = app_run.main_run(Path(sys.argv[1]).resolve(), Path('.').resolve(), trial=${trial ? 'True' : 'False'}, complete=complete, model='stub')
    print(json.dumps({'status': meta.get('status'), 'app': meta.get('app')}))
except SystemExit as e:
    print(json.dumps({'refused': str(e)}))`, run], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
const last = (r) => { try { return JSON.parse(r.stdout.trim().split('\n').at(-1)) } catch { throw Error('no result: ' + r.stdout.slice(-500) + r.stderr.slice(-1500)) } }

test('review 2 M3: a failed model call makes the run partial: stage failed, page and summary labelled, never done', { skip: !python311 }, async () => {
  const { proj, run } = await runFixture(3)
  const r = play(proj, run, { fail: 7 })
  assert.equal(r.status, 0, r.stderr)
  const out = last(r)
  assert.equal(out.status, 'partial')
  assert.ok(out.app.valid < out.app.planned && out.app.failed_calls > 0 && out.app.token_cap, JSON.stringify(out.app))
  const progress = JSON.parse(readFileSync(join(proj, run, 'progress.json'), 'utf8'))
  assert.equal(progress.stage, 'failed')
  assert.match(progress.message, /Partial run: \d of 6 planned participants finished; the run reached its approved token budget/)
  const summary = JSON.parse(readFileSync(join(proj, run, 'summary.json'), 'utf8'))
  assert.deepEqual([summary.outcome, summary.partial], ['not_ready', true])
  assert.match(summary.paragraph, /Only part of the planned run finished, so this is not the planned comparison\./)
  assert.equal(summary.facts.partial, true); assert.equal(summary.facts.official, false, 'a partial run is never official')
  const page = readFileSync(join(proj, run, 'results.html'), 'utf8')
  assert.match(page, /Partial run: not the planned number of participants\./)
  assert.equal(JSON.parse(readFileSync(join(proj, run, 'run.json'), 'utf8')).status, 'partial')
})

test('review 2 S6/S7: the run follows the app binding, and a stopped run needs a fresh approval', { skip: !python311 }, async () => {
  const { proj, run } = await runFixture(2)
  const hash = sha(join(proj, 'protocol.json'))
  const bound = (runId, extra = {}, at = Date.now()) => ({ HUMANSTUDY_RUN_ROUTE: 'protocol', HUMANSTUDY_RUN_ID: runId, HUMANSTUDY_RUN_PROTOCOL_SHA256: hash, HUMANSTUDY_RUN_APPROVED_AT: String(at), ...extra })
  assert.match(last(play(proj, run, { env: bound('a', { HUMANSTUDY_RUN_ROUTE: 'package' }) })).refused, /approved for the package/)
  assert.match(last(play(proj, run, { env: bound('a', { HUMANSTUDY_RUN_PROTOCOL_SHA256: 'f'.repeat(64) }) })).refused, /another version of protocol\.json/)
  writeFileSync(join(proj, run, 'STOP'), 'Stopped by the researcher\n')
  assert.match(last(play(proj, run, { env: bound('a', {}, Date.now() - 60_000) })).refused, /stopped this run/, 'an approval given before the stop')
  assert.match(last(play(proj, run)).refused, /stopped this run/, 'no relay binding: never resumed')
  assert.ok(existsSync(join(proj, run, 'STOP')), 'STOP is never deleted silently')
  const resumed = last(play(proj, run, { env: bound('b', {}, Date.now() + 1000) }))
  assert.equal(resumed.status, 'done', JSON.stringify(resumed))
  const plan = JSON.parse(readFileSync(join(proj, run, 'plan.json'), 'utf8'))
  assert.deepEqual(plan.runIds, ['b'])
  assert.equal(plan.resumedAfterStop[0].runId, 'b')
  writeFileSync(join(proj, run, 'STOP'), 'Stopped by the researcher\n')
  assert.match(last(play(proj, run, { env: bound('b', {}, Date.now() + 5000) })).refused, /stopped this run/, 'the same approval cannot restart it')
  // A changed protocol.json is refused whatever the binding says.
  writeFileSync(join(proj, 'protocol.json'), readFileSync(join(proj, 'protocol.json'), 'utf8') + '\n')
  assert.match(last(play(proj, run, { env: bound('c') })).refused, /changed after approval/)
})

test('review 2 S10: run outputs carry no key-like strings; a planted key in the environment appears nowhere', { skip: !python311 }, async () => {
  const { proj, run } = await runFixture(2)
  const planted = 'sk-or-v1-' + 'a'.repeat(48)
  assert.equal(last(play(proj, run, { env: { OPENROUTER_API_KEY: planted } })).status, 'done')
  const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]))
  for (const f of walk(join(proj, run))) {
    const text = readFileSync(f, 'utf8')
    assert.ok(!text.includes(planted), f)
    assert.ok(!/\b(sk-[A-Za-z0-9-]{20,}|AIza[0-9A-Za-z_-]{20,}|ghp_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9._-]{20,})/.test(text), f)
  }
})

test('review 2 S8: the direction is compared for like metrics only; otherwise "not compared (different metric)"', { skip: !python311 }, async () => {
  const proj = await protocolProject()
  const r = spawnSync(python311, ['-B', '-c', `import sys, json; sys.path.insert(0, '.opencode/skills/run'); import protocol_report as P
e = {"id": "e", "contrast": {"treatment": "t", "reference": "r"}}
ai = {"effects": [], "per_seed": {"1": [{"effectId": "e", "status": "computed", "metric": "risk_difference", "value": -0.2, "cells": {}}]}, "pooled": None}
out = {}
for name, rep in [("cells", {"cells": {"t": {"k": 7, "n": 10}, "r": {"k": 3, "n": 10}}}),
                  ("odds_ratio", {"value": 2.5, "metric": "odds_ratio"}),
                  ("no_metric", {"value": 0.3}),
                  ("estimate", {"estimates": [{"metric": "risk_difference", "value": 0.1}]})]:
    row = P.rows({"analysis": {"effects": [dict(e, reported=rep)]}}, ai)[0]
    out[name] = [row["same_direction"], row["not_compared"], row["human_metric"]]
cramer = P.rows({"analysis": {"effects": [dict(e, reported={"value": 0.3, "metric": "cramers_v"})]}}, {"per_seed": {"1": [{"effectId": "e", "status": "computed", "metric": "cramers_v", "value": 0.2}]}})[0]
out["unsigned"] = [cramer["same_direction"], cramer["not_compared"], cramer["human_metric"]]
print(json.dumps(out))`], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), {
    cells: [false, null, 'risk_difference'], odds_ratio: [null, 'different metric', 'odds_ratio'],
    no_metric: [null, 'different metric', null], estimate: [false, null, 'risk_difference'], unsigned: [null, 'different metric', 'cramers_v'],
  })
})

test('review 2: sync_hsenv.sh refuses a file naming an upstream study folder (any case), and refuses without that folder', () => {
  const up = mkdtempSync(join(tmpdir(), 'sandbox-'))
  mkdirSync(join(up, 'skills/run'), { recursive: true })
  mkdirSync(join(up, 'hsenv/studies/manylabs9'), { recursive: true })
  for (const f of ['run_study.py', 'fspec.py', 'render.py']) writeFileSync(join(up, 'skills/run', f), '# clean\n')
  writeFileSync(join(up, 'skills/run/fspec.py'), '# legacy exemption for ManyLabs9\n')
  const script = join(packDir, '../scripts/sync_hsenv.sh')
  let r = spawnSync('bash', [script, 'run', join(up, 'skills')], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /fspec\.py:1: study folder name ManyLabs9/)
  writeFileSync(join(up, 'skills/run/fspec.py'), 'LEGACY_PINS = {"abc": 1}\nLEGACY_OK = {k: v for k, v in PRIVATE.items()}\n')
  r = spawnSync('bash', [script, 'run', join(up, 'skills')], { encoding: 'utf8' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /fspec\.py: LEGACY_PINS is not empty/)
  assert.ok(!/LEGACY_OK/.test(r.stderr), 'a table read from the private sidecar holds no data')
  r = spawnSync('bash', [script, 'run', join(up, 'skills')], { encoding: 'utf8', env: { ...process.env, STUDIES_DIR: join(up, 'nowhere') } })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /no upstream studies folder/)
  assert.equal(readFileSync(join(packDir, 'skills/run/fspec.py'), 'utf8').includes('ManyLabs9'), false, 'nothing was copied')
})

test('Stop: the relay closes mid-run; the run ends stopped, records what finished and what was in progress as partial', { skip: !python311 }, async () => {
  const { proj, run } = await runFixture(4)
  // The fake model: at the 5th call the researcher presses Stop (STOP is written and the app closes the relay),
  // so this and every later call fails as the closed relay refuses it.
  const r = spawnSync(python311, ['-B', '-c', `import sys, json; from pathlib import Path
sys.path.insert(0, '.opencode/skills/run'); import app_run
run = Path(sys.argv[1]).resolve(); calls = [0]
def complete(messages):
    calls[0] += 1
    if calls[0] >= 5:
        (run / 'STOP').write_text('Stopped by the researcher')
        raise RuntimeError('model call failed: the approved model access for this run has ended')
    return '{"r1": "o1"}' if 'r1' in messages[-1]['content'] else '{}'
meta = app_run.main_run(run, Path('.').resolve(), complete=complete, model='stub')
print(json.dumps({'status': meta['status'], 'app': meta.get('app')}))`, run], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const outp = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.equal(outp.status, 'stopped')
  assert.ok(outp.app.stopped && outp.app.valid < outp.app.planned, JSON.stringify(outp.app))
  const progress = JSON.parse(readFileSync(join(proj, run, 'progress.json'), 'utf8'))
  assert.equal(progress.stage, 'stopped')
  assert.match(progress.message, /Stopped by the researcher: \d+ of 8 planned participants finished; \d+ in progress are recorded as partial/)
  assert.ok(existsSync(join(proj, run, 'partial.jsonl')))
  for (const line of readFileSync(join(proj, run, 'partial.jsonl'), 'utf8').split('\n').filter(Boolean))
    assert.equal(JSON.parse(line).status, 'partial')
  assert.ok(!existsSync(join(proj, run, 'results.html')), 'no comparison is drawn from a stopped run')
  assert.ok(existsSync(join(proj, run, 'STOP')), 'STOP stays')
  assert.match(last(play(proj, run)).refused, /stopped this run/, 'and the run does not restart without a new approval')
})

// Review 3.
test('review 3 M2: the budget counts the exact JSON body humanstudy_llm sends (CJK escaped), as the relay charges it', { skip: !python311 }, async () => {
  const proj = await protocolProject()
  const r = spawnSync(python311, ['-B', '-c', `import sys, json; sys.path.insert(0, '.opencode/skills/run'); sys.path.insert(0, '.opencode/../' + sys.argv[1])
import budget
page_en, page_zh = 'Which do you prefer?' * 10, '你更喜欢哪一个？' * 10
body = lambda page: json.dumps({"model": budget.MODEL_PLACEHOLDER, "messages": [{"role": "system", "content": "S"}, {"role": "user", "content": page}], "temperature": 1.0, "max_tokens": 512}).encode("utf-8")
print(json.dumps({"zh": budget.call_charge("S", page_zh), "zh_body": len(body(page_zh)), "zh_utf8": len(page_zh.encode("utf-8")), "en": budget.call_charge("S", page_en), "en_body": len(body(page_en))}))`, ''], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const b = JSON.parse(r.stdout)
  assert.equal(b.zh, b.zh_body + 2 * 256 + 512, 'exactly the body the relay sees, + messages + output')
  assert.equal(b.en, b.en_body + 2 * 256 + 512)
  assert.ok(b.zh_body - b.en_body > b.zh_utf8, 'a CJK page costs its \\uXXXX escapes (6 bytes a character), not its 3 UTF-8 bytes')
  // The same serialisation as the runtime's client: humanstudy_llm.chat sends json.dumps(body) with ensure_ascii on.
  assert.match(readFileSync(join(packDir, 'runtime/lib/humanstudy_llm.py'), 'utf8'), /data = json\.dumps\(body\)\.encode\("utf-8"\)/)
  // A CJK protocol measures larger than the same protocol in English.
  const zh = await protocolProject()
  const p = JSON.parse(readFileSync(join(zh, 'protocol.json'), 'utf8'))
  p.stages.q.responses[0].prompt = '你更喜欢哪一个？'.repeat(20)
  writeFileSync(join(zh, 'protocol.json'), JSON.stringify(p))
  const measure = (dir) => {
    const scratch = mkdtempSync(join(tmpdir(), 'budget-'))
    const m = spawnSync(python311, ['-B', '.opencode/skills/run/budget.py', dir, scratch], { cwd: dir, encoding: 'utf8' })
    assert.equal(m.status, 0, m.stderr)
    return JSON.parse(m.stdout.trim().split('\n').at(-1)).arms.control.tokens_per_member
  }
  const en = await protocolProject()
  const pe = JSON.parse(readFileSync(join(en, 'protocol.json'), 'utf8'))
  pe.stages.q.responses[0].prompt = 'Which do you prefer?'.repeat(20)
  writeFileSync(join(en, 'protocol.json'), JSON.stringify(pe))
  assert.ok(measure(zh) > measure(en) + 20 * 8 * 2, 'each of 160 CJK characters costs 6 bytes on every page that shows it')
})

test('review 3 M1/S7: the headline follows hsenv.score: Finished unless official; official = direction agreement; partial shows no verdicts', { skip: !python311 }, async () => {
  const proj = await protocolProject()
  const r = spawnSync(python311, ['-B', '-c', `import sys, json; sys.path.insert(0, '.opencode/skills/run'); import protocol_report as P
table = [{"same_direction": True}]
reward = lambda passed: {"evaluation": {"plan": {"official": True}, "rewards": {"direction_match-v2": {"passed": passed, "value": 1.0}}}}
out = {"non_official": P.outcome(table, {"evaluation": {"plan": {"official": False}}}),
       "no_plan": P.outcome(table, {}),
       "official_pass": P.outcome(table, reward(True)), "official_fail": P.outcome(table, reward(False)),
       "official_none": P.outcome(table, reward(None)), "partial": P.outcome(table, reward(True), partial=True),
       "para_non_official": P.paragraph([], {"evaluation": {"plan": {"official": False}}}),
       "card_partial": P.scores_card({"evaluation": {"plan": {"official": True}, "rewards": {"direction_match-v2": {"passed": True, "value": 1.0}}, "text_report": ["passed=True"]}}, None, partial=True)}
print(json.dumps(out))`], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const o = JSON.parse(r.stdout)
  // table: one comparison in the paper's direction. The engine's direction check failing there means "not significant".
  assert.deepEqual([o.non_official, o.no_plan, o.official_pass, o.official_fail, o.official_none, o.partial], ['unknown', 'unknown', 'same', 'same_ns', 'same_ns', 'not_ready'])
  assert.match(o.para_non_official, /Unofficial comparison: values only, no pass or fail\./)
  assert.match(o.card_partial, /no verdict \(partial run\)/)
  assert.ok(!/>passed</.test(o.card_partial) && !o.card_partial.includes('passed=True'), 'no pass/fail on a partial run')
  // The tab words agree/disagree as direction agreement, never as "showed the effect".
  const dictOut = mkdtempSync(join(tmpdir(), 'dict-'))
  await build({ entryPoints: [join(here, '../renderer/i18n-dict.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dictOut, 'dict.mjs'), logLevel: 'error' })
  await build({ entryPoints: [join(here, '../shared/simulation-run.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dictOut, 'sim.mjs'), logLevel: 'error' })
  const { EN, ZH } = await import(pathToFileURL(join(dictOut, 'dict.mjs')).href)
  const SR = await import(pathToFileURL(join(dictOut, 'sim.mjs')).href)
  assert.equal(EN['sim.outcome.same'], 'Same direction as the paper')
  assert.equal(ZH['sim.outcome.same'], '方向与论文一致')
  assert.ok(!/effect/.test(EN['sim.outcome.same'] + EN['sim.outcome.differs']))
  assert.equal(SR.parseSummary(JSON.stringify({ outcome: 'same', paragraph: 'x' })).outcome, 'same')
  assert.equal(SR.parseSummary(JSON.stringify({ outcome: 'agree', paragraph: 'x' })).outcome, 'same', 'an older summary\'s wording maps across')
})

test('review 3 S6/S8: a partial run is never "done" (even when its page fails); the cap is HTTP 402, not any 402', { skip: !python311 }, async () => {
  const { proj, run } = await runFixture(2)
  const r = spawnSync(python311, ['-B', '-c', `import sys, json; from pathlib import Path
sys.path.insert(0, '.opencode/skills/run'); import app_run, protocol_report
run = Path(sys.argv[1]).resolve(); seen = []
orig = app_run.write_progress
app_run.write_progress = lambda d, stage, msg: (seen.append(stage), orig(d, stage, msg))
def boom(*a, **k): raise RuntimeError('page failed')
protocol_report.build = boom
calls = [0]
def complete(messages):
    calls[0] += 1
    if calls[0] == 3: raise RuntimeError('LLMError: model call failed after 1 attempt(s): HTTP 402: Run token cap reached.')
    return '{"r1": "o1"}' if 'r1' in messages[-1]['content'] else '{}'
try:
    app_run.main_run(run, Path('.').resolve(), complete=complete, model='stub')
except RuntimeError:
    pass
p = json.loads((run / 'progress.json').read_text())
print(json.dumps({'seen': seen, 'stage': p['stage'], 'message': p['message'],
  'cap': [bool(app_run.TOKEN_CAP.search(t)) for t in ('HTTP 402: Run token cap reached.', 'item 1402 failed', 'HTTP 4020', 'token cap')]}))`, run], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const o = JSON.parse(r.stdout.trim().split('\n').at(-1))
  assert.ok(!o.seen.includes('done'))
  assert.equal(o.stage, 'failed')
  assert.match(o.message, /Partial run: .*approved token budget.*The results page could not be written: page failed/)
  assert.deepEqual(o.cap, [true, false, false, true])
  const progress = readFileSync(join(proj, run, 'progress.json'), 'utf8')
  assert.ok(!/"stage": "done"/.test(progress))
})

test('review 3 S2 / review 4 M1: one runner per run folder; a resume right after Stop waits for the stopped process and runs', { skip: !python311 || process.platform === 'win32' }, async () => {
  const { proj, run } = await runFixture(2)
  const hash = sha(join(proj, 'protocol.json'))
  // A first process holds the run, as a live run does; on STOP it ends the way app_run.stopped does: it writes
  // `stopped` (with when the researcher asked) a few seconds later, then exits and frees the lock.
  const holder = spawn(python311, ['-B', '-c', `import sys, time; from pathlib import Path
sys.path.insert(0, '.opencode/skills/run'); import app_run
run = Path(sys.argv[1]).resolve()
with app_run.RunLock(run):
    print('held', flush=True)
    while not (run / 'STOP').exists(): time.sleep(0.1)
    time.sleep(3)   # the old process keeps retrying its closed relay for a while
    app_run.write_progress(run, 'stopped', 'Stopped by the researcher', stopRequestedAt=(run / 'STOP').stat().st_mtime)`, run], { cwd: proj })
  await new Promise((res) => holder.stdout.once('data', res))
  assert.match(readFileSync(join(proj, run, 'run.lock'), 'utf8'), /"pid": \d+, "startedAt": "\d{4}-/)
  const bound = (runId, at = Date.now()) => ({ HUMANSTUDY_RUN_ROUTE: 'protocol', HUMANSTUDY_RUN_ID: runId, HUMANSTUDY_RUN_PROTOCOL_SHA256: hash, HUMANSTUDY_RUN_APPROVED_AT: String(at) })
  const busy = last(play(proj, run, { env: bound('a') })).refused
  assert.match(busy, /this run is still running \(process \d+, started \d{4}-[^)]*\): it was not started again/, 'same approval')
  assert.ok(!busy.includes('{'), 'a clean message')
  assert.match(last(play(proj, run, { env: bound('b') })).refused, /still running/, 'a new approval')
  // The researcher presses Stop, then Run again right away: the approval is dated now, before the stopped
  // process writes `stopped`. The resume waits for that process to exit, and then runs.
  writeFileSync(join(proj, run, 'STOP'), 'Stopped by the researcher\n')
  await new Promise((res) => setTimeout(res, 50))
  const started = Date.now()
  const resumed = last(play(proj, run, { env: bound('c', Date.now()) }))
  assert.equal(resumed.status, 'done', JSON.stringify(resumed))
  assert.ok(Date.now() - started >= 2500, 'it waited for the stopped process')
  const plan = JSON.parse(readFileSync(join(proj, run, 'plan.json'), 'utf8'))
  assert.equal(plan.resumedAfterStop.at(-1).runId, 'c')
  holder.kill()
})

test('review 3 S4: every desktop path sets HSENV_PRIVATE_CONFIG empty', { skip: !python311 }, async () => {
  const proj = await protocolProject()
  for (const mod of ['run/app_run', 'run/budget', 'preview/make_preview']) {
    const [dir, name] = mod.split('/')
    const r = spawnSync(python311, ['-B', '-c', `import os, sys; sys.path.insert(0, '.opencode/skills/${dir}'); import ${name}; print(repr(os.environ['HSENV_PRIVATE_CONFIG']))`],
      { cwd: proj, encoding: 'utf8', env: { ...process.env, HSENV_PRIVATE_CONFIG: '/planted/engine-private.json' } })
    assert.equal(r.stdout.trim(), "''", mod + ': ' + r.stderr)
  }
  for (const [file, pattern] of [['skills/simulate/run_confined.py', /'HSENV_PRIVATE_CONFIG': ''\}\)/], ['skills/simulate/simkit.py', /'HSENV_PRIVATE_CONFIG': ''\}\)/]])
    assert.match(readFileSync(join(packDir, file), 'utf8'), pattern, file)
  assert.match(readFileSync(join(here, 'kernel/opencode.ts'), 'utf8'), /HSENV_PRIVATE_CONFIG: '',/)
  assert.match(readFileSync(join(here, 'protocol-readiness.ts'), 'utf8'), /HSENV_PRIVATE_CONFIG: '',/)
})

test('review 3 S3: app-owned files are put back before a run; the approval path calls it before the relay', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'proj-'))
  await P.installPack(proj)
  const app = join(proj, '.opencode/skills/run/app_run.py')
  writeFileSync(app, 'def check_approval(*a): return "anything"\n')
  writeFileSync(join(proj, '.opencode/hsenv/hsenv/score.py'), '# edited')
  const own = join(proj, '.opencode/skills/visualize/SKILL.md')
  writeFileSync(own, 'my own rules')
  await P.refreshAppOwned(proj)
  assert.equal(readFileSync(app, 'utf8'), readFileSync(join(packDir, 'skills/run/app_run.py'), 'utf8'))
  assert.equal(readFileSync(join(proj, '.opencode/hsenv/hsenv/score.py'), 'utf8'), readFileSync(join(packDir, 'runtime/hsenv/hsenv/score.py'), 'utf8'))
  assert.equal(readFileSync(own, 'utf8'), 'my own rules', 'researcher instructions are not touched')
  const index = readFileSync(join(here, 'index.ts'), 'utf8')
  const send = index.slice(index.indexOf("ipcMain.handle('kernel:send'"))
  assert.ok(send.indexOf('await refreshAppOwned(projectDir)') > 0 && send.indexOf('await refreshAppOwned(projectDir)') < send.indexOf('startModelRelay('))
})

test('review 4 S3: the sync guard refuses study surnames and id shapes anywhere in a vendored file', () => {
  const up = mkdtempSync(join(tmpdir(), 'sandbox-'))
  mkdirSync(join(up, 'skills/run'), { recursive: true })
  mkdirSync(join(up, 'hsenv/studies/zorbel2019widgets'), { recursive: true })
  mkdirSync(join(up, 'hsenv/studies/wu2020spoons'), { recursive: true })
  const script = join(packDir, '../scripts/sync_hsenv.sh')
  const guard = (text) => {
    for (const f of ['run_study.py', 'fspec.py', 'render.py']) writeFileSync(join(up, 'skills/run', f), '# clean\n')
    writeFileSync(join(up, 'skills/run/render.py'), text)
    return spawnSync('bash', [script, '--check', 'run', join(up, 'skills')], { encoding: 'utf8' })
  }
  // Each false negative of review 4, one at a time.
  for (const [text, expected] of [
    ['raise ValueError("label (Zorbel S2b)")\n', /study surname Zorbel/],             // a string literal
    ['zorbel_items = []\n', /study surname zorbel/],                                  // an identifier
    ['x = 1  # zorbel_s2b\n', /study surname zorbel/],                                // _ ends the surname
    ['n = 3  # as in Wu 2020\n', /study surname Wu 2020/],                            // a short surname with a year
    ['s = "wu2020"\n', /study id shape wu2020/],                                       // an id with no topic
    ['K = "Zorbel2019Widgets"\n', /study surname Zorbel|study id shape Zorbel2019Widgets/], // CamelCase
    ['msg = "Zorbel (2019) found"\n', /study surname Zorbel/],                         // "Surname (year)"
    ["q = '\"\"\"'\nnote = 'see zorbel'\n", /render\.py:2: study surname zorbel/],     // after an odd triple quote
    ['{"description": "after Zorbel et al."}\n', /study surname Zorbel/],             // JSON text
    ['def getZorbel(): pass\n', /study surname Zorbel/],                              // CamelCase, after
    ['ZorbelItems = []\n', /study surname Zorbel/],                                   // CamelCase, before
    ['zorbelScore = 0\n', /study surname zorbel/],                                    // lowerCamel (review 6 S1)
    ['zorbelData = {}\n', /study surname zorbel/],
    ['IDZorbel = 1\n', /study surname Zorbel/],                                       // ID<Surname>
    ['ZORBELItems = []\n', /study surname ZORBEL/],                                   // <SURNAME>Items
  ]) {
    const r = guard(text)
    assert.notEqual(r.status, 0, text)
    assert.match(r.stderr, expected, text)
  }
  // Ordinary words and tags are not flagged: a short surname alone, <li>, ids without a year.
  const ok = guard('html = "<li>wu</li>"\nwidgets = 2\nutf8 = "x"\nnote = "THE SOFTWARE SHALL BE"  # BEZORBELT\n')
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /guard passed/, '--check copies nothing')
  // The folder-name rule stays the hard gate (any case), and no studies folder means no sync.
  assert.match(guard('X = "ZORBEL2019WIDGETS"\n').stderr, /study folder name ZORBEL2019WIDGETS/)
  const none = spawnSync('bash', [script, '--check', 'run', join(up, 'skills')], { encoding: 'utf8', env: { ...process.env, STUDIES_DIR: join(up, 'nowhere') } })
  assert.match(none.stderr, /no upstream studies folder/)
  assert.equal(readFileSync(join(packDir, 'skills/run/render.py'), 'utf8').includes('zorbel'), false, 'nothing was copied')
})

test('review 4 S1: the trusted run copy holds the engine, the run skill, the sandbox launcher and the kit; the app starts it', () => {
  const rels = P.trustedRunFiles().map(([rel]) => rel)
  for (const rel of ['hsenv/hsenv/engine.py', 'hsenv/hsenv/score.py', 'hsenv/schema/protocol.v1.json', 'skills/run/launch.py', 'skills/run/app_run.py',
    'skills/run/run_study.py', 'skills/run/protocol_report.py', 'skills/build/sandbox_run.py', 'artifact-kit/inline.py', 'artifact-kit/hs-kit.js'])
    assert.ok(rels.includes(rel), rel)
  assert.ok(rels.every((rel) => !rel.startsWith('skills/simulate/')), 'not the package runners')
  const index = readFileSync(join(here, 'index.ts'), 'utf8')
  const send = index.slice(index.indexOf("ipcMain.handle('kernel:send'"))
  assert.match(send, /if \(route === 'protocol'\) await startProtocolRun\(projectDir, approved, binding as ProtocolBinding, relay,/)
  assert.match(send, /await startProtocolRun\(projectDir, approved, binding, undefined,/, 'the pre-relay path too')
  assert.match(index, /files: \[\.\.\.trustedRunFiles\(\), \.\.\.restored\], codeDir: join\(app\.getPath\('userData'\), 'protocol-runs', binding\.runId\)/, 'code outside the project')
  // a published study's restored wording travels with the trusted code (app storage), never through the project
  assert.match(index, /const restored = await restoredRunFiles\(projectDir, originalTextCache\(\), binding\.protocolSha256\)/)
  const skill = readFileSync(join(packDir, 'skills/run/SKILL.md'), 'utf8')
  assert.match(skill, /Do not start, restart or copy a protocol run yourself/)
})

test('review 4 S2 / review 5: an official verdict on an unverified human n says so, consistently, in the headline and the paragraph', { skip: !python311 }, async () => {
  const proj = await protocolProject()
  const r = spawnSync(python311, ['-B', '-c', `import sys, json; sys.path.insert(0, '.opencode/skills/run'); import protocol_report as P
run = lambda arms, passed: {"evaluation": {"plan": {"official": True, "n_unverified_arms": arms}, "rewards": {"direction_match-v2": {"passed": passed}}}}
print(json.dumps({"verified": P.outcome([], run([], True)), "unverified": P.outcome([], run(["control"], True)),
  "unverified_no": P.outcome([], run(["control"], False)), "para": P.paragraph([], run(["control", "treatment"], True)),
  "para_verified": P.paragraph([], run([], False)), "para_zh": P.paragraph([], run(["control"], True), lang="zh-CN"),
  "facts_unverified": P.facts([], run(["control"], True), False), "facts_verified": P.facts([], run([], True), False),
  "facts_partial": P.facts([], run([], True), True)}))`], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const o = JSON.parse(r.stdout)
  // The headline never says more than the text: on an unverified n it is the neutral "Finished" (UX re-check).
  // No comparison at all (an empty table): nothing to say about direction, so "Finished".
  assert.deepEqual([o.verified, o.unverified, o.unverified_no], ['unknown', 'unknown', 'unknown'])
  // "official" only when the plan is official AND the human n is verified AND the run is complete.
  assert.match(o.para, /Unofficial comparison: values only, no pass or fail\. The paper's sample size is taken as printed and has not been checked yet\./)
  assert.match(o.para_verified, /Official comparison: the sample size matches the paper's analysed sample in every condition\./)
  assert.match(o.para_zh, /非正式比较：只给出数值，不判定通过与否。样本量按论文印出的数字，尚未核对。/)
  assert.deepEqual([o.facts_unverified.official, o.facts_verified.official, o.facts_partial.official], [false, true, false])
  const dictOut = mkdtempSync(join(tmpdir(), 'dict-'))
  await build({ entryPoints: [join(here, '../renderer/i18n-dict.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(dictOut, 'dict.mjs'), logLevel: 'error' })
  const { EN, ZH } = await import(pathToFileURL(join(dictOut, 'dict.mjs')).href)
  for (const k of ['sim.outcome.agree_unverified', 'sim.outcome.disagree_unverified']) assert.equal(EN[k], undefined, k + ' is gone')
  const css = readFileSync(join(here, '../renderer/styles.css'), 'utf8')
  for (const c of ['o-same', 'o-differs', 'o-mixed']) assert.ok(css.includes('.sim-outcome.' + c), c)
  assert.ok(!/\.sim-outcome\.o-same_ns/.test(css), 'same direction but not significant stays neutral, never red')
})

test('review 5 M1/S3: app_run plays the plan the app approved, refuses another plan.json, and refuses a protocol swapped before the engine loads it', { skip: !python311 }, async () => {
  const { proj, run } = await runFixture(2)
  const hash = sha(join(proj, 'protocol.json'))
  const approvedPlan = JSON.stringify({ route: 'protocol', protocolSha256: hash, perArm: 2, arms: null, seeds: [1], temperature: 1 })
  const bound = { HUMANSTUDY_RUN_ROUTE: 'protocol', HUMANSTUDY_RUN_ID: 'm1', HUMANSTUDY_RUN_PROTOCOL_SHA256: hash, HUMANSTUDY_RUN_APPROVED_AT: String(Date.now()), HUMANSTUDY_RUN_PLAN: approvedPlan }
  const plan = JSON.parse(readFileSync(join(proj, run, 'plan.json'), 'utf8'))
  writeFileSync(join(proj, run, 'plan.json'), JSON.stringify({ ...plan, perArm: 7, seeds: [1, 2, 3], temperature: 0 }))
  assert.match(last(play(proj, run, { env: bound })).refused, /plan\.json in the run folder is not the approved plan/)
  writeFileSync(join(proj, run, 'plan.json'), JSON.stringify(plan))
  // The engine loads protocol.json again after the hash check: a swap in between is caught and nothing is reported.
  const r = spawnSync(python311, ['-B', '-c', `import sys, json; from pathlib import Path
sys.path.insert(0, '.opencode/skills/run'); import app_run, run_study
orig = run_study.load_protocol
def swapped(arg):
    p, sha, d, v = orig(arg)
    return p, 'f' * 64, d, v
run_study.load_protocol = swapped
try:
    app_run.main_run(Path(sys.argv[1]).resolve(), Path('.').resolve(), complete=lambda m: '{}', model='stub')
except SystemExit as e:
    print(json.dumps({'refused': str(e)}))`, run], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, ...bound } })
  assert.match(last(r).refused, /protocol\.json changed while the run started/)
  assert.equal(JSON.parse(readFileSync(join(proj, run, 'progress.json'), 'utf8')).stage, 'failed')
  assert.ok(!existsSync(join(proj, run, 'results.html')))
  // A variant is not part of the approval.
  writeFileSync(join(proj, 'variant.json'), '{}')
  const { proj: p2, run: r2 } = { proj, run: 'artifacts/simulations/other' }
  mkdirSync(join(p2, r2), { recursive: true }); writeFileSync(join(p2, r2, 'plan.json'), JSON.stringify(plan))
  assert.match(last(play(p2, r2, { env: bound })).refused, /variant/)
})

test('review 6 S2: a variant that appears after the approval check ends the run failed, unreported', { skip: !python311 }, async () => {
  const { proj, run } = await runFixture(2)
  const hash = sha(join(proj, 'protocol.json'))
  const bound = { HUMANSTUDY_RUN_ROUTE: 'protocol', HUMANSTUDY_RUN_ID: 'v', HUMANSTUDY_RUN_PROTOCOL_SHA256: hash, HUMANSTUDY_RUN_APPROVED_AT: String(Date.now()) }
  const r = spawnSync(python311, ['-B', '-c', `import sys, json; from pathlib import Path
sys.path.insert(0, '.opencode/skills/run'); import app_run, run_study
orig = run_study.load_protocol
def with_variant(arg):
    p, sha, d, v = orig(arg)
    return p, sha, d, {"variant_of": {"study_dir": "/elsewhere"}}
run_study.load_protocol = with_variant
try:
    app_run.main_run(Path(sys.argv[1]).resolve(), Path('.').resolve(), complete=lambda m: '{"r1": "o1"}' if 'r1' in m[-1]['content'] else '{}', model='stub')
except SystemExit as e:
    print(json.dumps({'refused': str(e)}))`, run], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, ...bound } })
  assert.match(last(r).refused, /a variant \(variant\.json\) appeared while the run started/)
  assert.equal(JSON.parse(readFileSync(join(proj, run, 'progress.json'), 'utf8')).stage, 'failed')
  assert.ok(!existsSync(join(proj, run, 'results.html')))
})

test('UX: the results page and progress messages come in the app\'s language', { skip: !python311 }, async () => {
  const { proj, run } = await runFixture(2)
  const r = play(proj, run, { env: { HUMANSTUDY_LANG: 'zh-CN' } })
  assert.equal(last(r).status, 'done', r.stderr)
  const page = readFileSync(join(proj, run, 'results.html'), 'utf8')
  assert.match(page, /<html lang="zh-CN">/)
  assert.match(page, /AI 参与者的模拟实验——不是真人数据。这是与论文印出数字的比较，不是排行榜。/)
  assert.match(page, /<summary>技术细节<\/summary>/)
  assert.match(page, /比例之差/)
  assert.match(JSON.parse(readFileSync(join(proj, run, 'progress.json'), 'utf8')).message, /计划 4 名参与者中完成了 4 名；\d+ 次模型调用。/)
  const summary = JSON.parse(readFileSync(join(proj, run, 'summary.json'), 'utf8'))
  assert.deepEqual(Object.keys(summary.facts).sort(), ['compared', 'done', 'engineDirection', 'failedCalls', 'official', 'partial', 'planned', 'same', 'tokenCap', 'unverified'])
  assert.ok(summary.paragraph_zh)
})

test('UX re-check: an unverified n and a small same-direction run that is not significant headline "Finished", never a verdict', { skip: !python311 }, async () => {
  const { proj, run } = await runFixture(3)
  // Same direction on every participant except one: a small run, not significant. The fixture's n is printed only.
  let k = 0
  const r = spawnSync(python311, ['-B', '-c', `import sys, json; from pathlib import Path
sys.path.insert(0, '.opencode/skills/run'); import app_run
seen = {}
def complete(messages):
    page = messages[-1]['content']
    if 'r1' not in page: return '{}'
    n = seen.setdefault('n', 0); seen['n'] = n + 1
    return '{"r1": "o1"}' if n % 3 else '{"r1": "o2"}'
meta = app_run.main_run(Path(sys.argv[1]).resolve(), Path('.').resolve(), complete=complete, model='stub')
print(json.dumps({'status': meta['status']}))`, run], { cwd: proj, encoding: 'utf8' })
  assert.equal(last(r).status, 'done', r.stderr)
  const summary = JSON.parse(readFileSync(join(proj, run, 'summary.json'), 'utf8'))
  assert.equal(summary.outcome, 'unknown', 'no direction verdict on an unverified n')
  assert.equal(summary.facts.official, false)
  assert.equal(summary.facts.unverified, true)
  const page = readFileSync(join(proj, run, 'results.html'), 'utf8')
  const front = page.split('<details class="hs-card">')[0]
  assert.ok(!/Official comparison/.test(front))
  assert.match(front, /Unofficial comparison/)
  // The tab's headline rule is the same for any summary with facts, whatever outcome a file claims.
  const out = mkdtempSync(join(tmpdir(), 'sim-'))
  await build({ entryPoints: [join(here, '../shared/simulation-run.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 's.mjs'), logLevel: 'error' })
  const SR = await import(pathToFileURL(join(out, 's.mjs')).href)
  const base = { done: 9, planned: 9, same: 1, compared: 1, official: true, unverified: false, partial: false, failedCalls: 0, tokenCap: false, engineDirection: true }
  assert.equal(SR.headline({ outcome: 'same', facts: base }), 'same')
  assert.equal(SR.headline({ outcome: 'same', facts: { ...base, unverified: true } }), 'unknown')
  assert.equal(SR.headline({ outcome: 'same', facts: { ...base, official: false } }), 'unknown')
  assert.equal(SR.headline({ outcome: 'same', facts: { ...base, partial: true } }), 'not_ready')
  assert.equal(SR.headline({ outcome: 'replicated' }), 'replicated', 'package summaries keep their own outcome')
  assert.equal(SR.parseSummary(JSON.stringify({ outcome: 'agree_unverified', paragraph: 'x' })).outcome, 'unknown')
})

test('UX re-check: a partial run says why and what to do next, in zh and en', { skip: !python311 }, async () => {
  const { proj, run } = await runFixture(3)
  const r = play(proj, run, { fail: 7, env: { HUMANSTUDY_LANG: 'zh-CN' } })
  assert.equal(last(r).status, 'partial', r.stderr)
  const progress = JSON.parse(readFileSync(join(proj, run, 'progress.json'), 'utf8'))
  assert.match(progress.message, /部分运行：.*点击“运行模拟”可重新运行。/)
  const summary = JSON.parse(readFileSync(join(proj, run, 'summary.json'), 'utf8'))
  assert.ok(summary.facts.failedCalls > 0 && summary.facts.tokenCap)
  assert.match(summary.paragraph_zh, /原因：运行用完了批准的模型用量。下一步：点击“运行模拟”重新运行。/)
  assert.match(summary.paragraph, /Why: the run used up its approved model limit\. Next: press Run simulation to run it again\./)
  const page = readFileSync(join(proj, run, 'results.html'), 'utf8')
  assert.match(page, /<summary>技术细节<\/summary>/)
  assert.match(page, /评分 — 离线报告，不是排行榜/)
  assert.match(page, /不判定（部分运行）/)
  assert.match(page, /\.hs-results th, \.hs-results td \{ text-align: left; vertical-align: top;/, 'table columns align')
  const panel = readFileSync(join(here, '../renderer/components/SimulationPanel.tsx'), 'utf8')
  assert.match(panel, /t\(f\.tokenCap \? 'sim\.p\.why_cap' : f\.failedCalls \? 'sim\.p\.why_calls' : 'sim\.p\.why_unfinished', \{ n: f\.failedCalls \}\)/)
  assert.match(panel, /className="ghost" disabled=\{!canRun\} title=\{canRun \? undefined : t\('sim\.sign_in_to_run'\)\}/, 'Ask the agent while signed out')
})

test('UX round 3: the headline follows the per-comparison direction count, in four cases, en and zh', { skip: !python311 }, async () => {
  const proj = await protocolProject()
  const r = spawnSync(python311, ['-B', '-c', `import sys, json; sys.path.insert(0, '.opencode/skills/run'); import protocol_report as P
run = lambda passed: {"evaluation": {"plan": {"official": True, "n_unverified_arms": []}, "rewards": {"direction_match-v2": {"passed": passed}}}}
row = lambda same: {"same_direction": same}
print(json.dumps({
  "same": P.outcome([row(True), row(True)], run(True)),
  "same_ns": P.outcome([row(True), row(True)], run(False)),
  "differs": P.outcome([row(False), row(False)], run(False)),
  "mixed": P.outcome([row(True), row(False), row(None)], run(False)),
  "facts": P.facts([row(True), row(False)], run(False), False)}))`], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const o = JSON.parse(r.stdout)
  assert.deepEqual([o.same, o.same_ns, o.differs, o.mixed], ['same', 'same_ns', 'differs', 'mixed'])
  assert.deepEqual([o.facts.same, o.facts.compared, o.facts.engineDirection], [1, 2, false])
  const out = mkdtempSync(join(tmpdir(), 'h-'))
  await build({ entryPoints: [join(here, '../shared/simulation-run.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 's.mjs'), logLevel: 'error' })
  await build({ entryPoints: [join(here, '../renderer/i18n-dict.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'd.mjs'), logLevel: 'error' })
  const SR = await import(pathToFileURL(join(out, 's.mjs')).href)
  const { EN, ZH } = await import(pathToFileURL(join(out, 'd.mjs')).href)
  const f = (same, compared, engineDirection) => ({ facts: { done: 20, planned: 20, same, compared, official: true, unverified: false, partial: false, failedCalls: 0, tokenCap: false, engineDirection }, outcome: 'unknown' })
  assert.equal(SR.headline(f(1, 1, true)), 'same')
  assert.equal(SR.headline(f(1, 1, false)), 'same_ns', 'same direction, engine check failed on significance: never "did not agree"')
  assert.equal(SR.headline(f(0, 1, false)), 'differs')
  assert.equal(SR.headline(f(2, 3, false)), 'mixed')
  assert.equal(EN['sim.outcome.same'], 'Same direction as the paper'); assert.equal(ZH['sim.outcome.same'], '方向与论文一致')
  assert.equal(EN['sim.outcome.same_ns'], 'Same direction as the paper, but not significant in this run'); assert.equal(ZH['sim.outcome.same_ns'], '方向与论文相同，但本次运行不显著')
  assert.equal(EN['sim.outcome.differs'], 'Direction differs from the paper'); assert.equal(ZH['sim.outcome.differs'], '方向与论文不一致')
  assert.equal(EN['sim.outcome.mixed'], "Mixed: {k} of {n} comparisons in the paper's direction")
  const panel = readFileSync(join(here, '../renderer/components/SimulationPanel.tsx'), 'utf8')
  assert.match(panel, /t\(`sim\.outcome\.\$\{headline\(summary\)\}`, \{ k: summary\.facts\?\.same \?\? 0, n: summary\.facts\?\.compared \?\? 0 \}\)/)
  assert.match(panel, /\.join\(getLang\(\) === 'zh-CN' \? '' : ' '\)/, 'zh sentences without stray spaces')
  assert.match(panel, /disabled=\{!canAsk\} title=\{canAsk \? undefined : t\('sim\.sign_in_to_run'\)\} onClick=\{onAsk\}/, 'Ask about this result while signed out')
  assert.match(panel, /!built && hasProtocolFile \? \(/, 'no "Build the study first" for a protocol project still being checked')
})

// A published study (hsenv 0.8.1 distribution): protocol.json holds placeholders where wording is held back. The run
// plays only the copy restored on this computer, read from the code folder (<code>/restored/protocol.json, written by
// the app beside its trusted code); never the placeholders, never wording that does not hash to the published value,
// never a copy that changes anything else, and its records keep no screens.
test('a published study runs only from its restored wording, and its records keep no screens', { skip: !python311 }, async () => {
  const proj = await protocolProject()
  const fixture = join(packDir, 'runtime/tests/fixtures/original_text/protocol.json')
  writeFileSync(join(proj, 'protocol.json'), readFileSync(fixture))
  const projection = JSON.parse(readFileSync(fixture, 'utf8'))
  const texts = {
    '/stages/intro/content/0/value': 'Thank you for joining this short study about walking before breakfast.',
    '/stages/intro/content/1/value': 'Remember to drink a glass of water first.',
    '/stages/q/responses/0/prompt': 'How many minutes did you walk this morning?',
    '/stages/q/responses/1/prompt': 'Did you see a neighbour on the way?',
  }
  const fill = (extra = () => undefined) => {
    const p = structuredClone(projection)
    delete p.distribution
    for (const [path, text] of Object.entries(texts)) {
      const parts = path.split('/').slice(1)
      const last = parts.pop()
      parts.reduce((o, k) => o[k], p)[last] = text
    }
    extra(p)
    const file = join(proj, '.opencode/restored/protocol.json')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(p))
    return {}
  }
  const run = 'artifacts/simulations/2026-11-10-0100'
  let r = spawnSync(python311, ['-B', '.opencode/skills/run/app_run.py', 'new', run, '--per-arm', '2', '--protocol-hash', sha(join(proj, 'protocol.json'))], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  const seen = []
  const go = (env) => spawnSync(python311, ['-B', '-c', `import sys, json; from pathlib import Path
sys.path.insert(0, '.opencode/skills/run'); import app_run
seen = []
def complete(messages):
    seen.append(messages[-1]['content'])
    c = messages[-1]['content']
    return '{"r1": 20, "r2": "o1"}' if 'r2' in c else '{"r1": 20}' if 'r1' in c else '{}'
try:
    meta = app_run.main_run(Path(sys.argv[1]).resolve(), Path('.').resolve(), complete=complete, model='stub')
    print(json.dumps({'status': meta.get('status'), 'sha': meta.get('protocol_sha256'), 'seen': seen}))
except SystemExit as e:
    print(json.dumps({'refused': str(e)}))`, run], { cwd: proj, encoding: 'utf8', env: { PATH: process.env.PATH, ...env } })
  const result = (x) => JSON.parse(x.stdout.trim().split('\n').at(-1) || '{}')
  // no restored copy: refused, in plain words
  r = go({})
  assert.match(result(r).refused ?? r.stderr, /original wording has not been filled in on this computer.*\[text not available\]/)
  // a copy that also changes something outside the held texts: refused
  r = go(fill((p) => { p.stages.q.responses[1].options[0].label = 'Sure' }))
  assert.match(result(r).refused ?? r.stderr, /another version of this study/)
  // a copy that keeps the placeholders (protocol.json minus its distribution block), or with wording someone typed
  r = go((() => { const file = join(proj, '.opencode/restored/protocol.json'); const p = structuredClone(projection); delete p.distribution; writeFileSync(file, JSON.stringify(p)); return {} })())
  assert.match(result(r).refused ?? r.stderr, /another version of this study/)
  r = go(fill((p) => { p.stages.intro.content[0].value = 'FORGED TEXT' }))
  assert.match(result(r).refused ?? r.stderr, /another version of this study/)
  r = go(fill((p) => { p.distribution = projection.distribution }))
  assert.match(result(r).refused ?? r.stderr, /another version of this study/)
  // an environment variable cannot point the run at another copy
  rmSync(join(proj, '.opencode/restored'), { recursive: true })
  r = go({ HUMANSTUDY_RUN_RESTORED: join(proj, 'elsewhere.json') })
  assert.match(result(r).refused ?? r.stderr, /original wording has not been filled in/)
  // the restored copy: plays the wording, records the published version's hash, keeps no screens in the project
  r = go(fill())
  const out = result(r)
  assert.equal(out.status, 'done', r.stdout.slice(-800) + r.stderr.slice(-1500))
  assert.equal(out.sha, sha(join(proj, 'protocol.json')))
  assert.ok(out.seen.some((c) => c.includes('walking before breakfast')), 'the model saw the restored wording')
  assert.ok(!out.seen.some((c) => c.includes('░')), 'never a placeholder')
  for (const f of ['records.jsonl', 'steps.jsonl', 'run.json', 'results.html', 'summary.json', 'operator.jsonl', 'effects.json'])
    if (existsSync(join(proj, run, f))) assert.ok(!readFileSync(join(proj, run, f), 'utf8').includes('walking before breakfast'), f + ' holds no restored wording')
  void seen
})

test('the preview of a published study says "[text not available]" where wording is held back', { skip: !python311 }, async () => {
  const proj = await protocolProject()
  writeFileSync(join(proj, 'protocol.json'), readFileSync(join(packDir, 'runtime/tests/fixtures/original_text/protocol.json')))
  const r = spawnSync(python311, ['-B', '.opencode/skills/preview/make_preview.py', '--out', 'artifacts/preview.html', '--lang', 'en'], { cwd: proj, encoding: 'utf8' })
  const page = readFileSync(join(proj, 'artifacts/preview.html'), 'utf8')
  assert.ok(page.includes('[text not available]'), r.stdout + r.stderr)
  assert.ok(!page.includes('░'))
})
