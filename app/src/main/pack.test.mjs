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
        r === 'AGENTS.md' || r === 'PROJECT_FORMAT.md' || r.startsWith('schema/') || r.startsWith('skills/') || /^artifact-kit\/[^/]+$/.test(r))
      const obj = Object.fromEntries(included.map((r) => ['../../../pack/' + r, readFileSync(join(packDir, r), 'utf8')]))
      src = src.replace(/import\.meta\.glob\([\s\S]*?\)\s*as Record<string, string>/, JSON.stringify(obj))
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

test('refreshPack upgrades an untouched previous simkit.py (run heartbeat, #16) but keeps an edited one', async () => {
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
  assert.equal(readFileSync(dest, 'utf8'), '# my own runner')
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
