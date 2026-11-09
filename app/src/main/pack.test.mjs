// Pack install: the artifact kit lands in .opencode/artifact-kit, stays at the shipped version on refresh,
// Chart.js matches its recorded SHA-256; inline.py inlines the kit and rejects network/unknown ids.
//   node --test src/main/pack.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
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
        (r === 'AGENTS.md' || r === 'PROJECT_FORMAT.md' || r.startsWith('schema/') || r.startsWith('skills/') || /^artifact-kit\/[^/]+$/.test(r) || r.startsWith('runtime/hsenv/'))
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
  assert.deepEqual(P.kitFiles().sort(), readdirSync(join(packDir, 'artifact-kit')).map((f) => 'artifact-kit/' + f).sort())
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
  assert.deepEqual(listed.map(([f]) => f).sort(), ['hsenv/__init__.py', 'hsenv/checks.py', 'hsenv/effects_core.py', 'hsenv/engine.py',
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
  assert.match(page, /Simulation — not human data · offline_report — not a leaderboard/)
  assert.match(page, /id="hs-protocol"/)
  assert.match(page, /treatment 14\/20 vs control 8\/20/, 'the paper side: printed cells')
  assert.match(page, /treatment 5\/5 vs control 5\/5/, 'the AI side: this run')
  // S9: the engine's scores (hsenv.score via run_study), with their labels and not-computable reasons.
  assert.match(page, /Scores \(hsenv\.score\) — offline_report — not a leaderboard/)
  assert.match(page, /significance_match-v1/)
  assert.match(page, /non_official: the AI n differs from the human analysed n, so there is no pass\/fail/, '5 per arm, the paper had 10')
  assert.match(page, /no printed human SD \(1\)/, 'not-computable reasons are shown')
  assert.match(page, /intention-to-treat not applicable/)
  assert.match(page, /human n unverified in control, treatment/)
  assert.equal(JSON.parse(readFileSync(join(proj, run, 'run.json'), 'utf8')).evaluation.rewards['significance_match-v1'].report_scope, 'offline_report — not a leaderboard')
  assert.ok(!existsSync(join(proj, 'artifacts/simulations/.baseline-cache')), 'the baseline cache stays inside the run folder')
  assert.ok(existsSync(join(proj, run, '.baseline-cache')))
  r = spawnSync(python311, ['.opencode/artifact-kit/inline.py', join(run, 'results.html')], { cwd: proj, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout)
  assert.match(r.stdout, /^PASS .*protocol embedded/m)
  const summary = JSON.parse(readFileSync(join(proj, run, 'summary.json'), 'utf8'))
  assert.deepEqual([summary.route, summary.outcome, summary.perCondition, summary.calls], ['protocol', 'not_replicated', 5, 20])
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
const last = (r) => JSON.parse(r.stdout.trim().split('\n').at(-1))

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
  assert.match(summary.paragraph, /^PARTIAL RUN/)
  const page = readFileSync(join(proj, run, 'results.html'), 'utf8')
  assert.match(page, /PARTIAL RUN — not the planned n/)
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
