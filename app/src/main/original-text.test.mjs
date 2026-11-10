// node --test src/main/original-text.test.mjs — a published study's original wording, filled in on this computer
// (original-text.ts over pack/runtime/lib/hs_original_text.py and the bundled hsenv.rehydrate). The fixture is
// invented (pack/runtime/tests/fixtures/original_text): no real study, paper or person.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'original-text-'))
for (const [entry, name] of [['original-text.ts', 'o.mjs'], ['protocol-readiness.ts', 'r.mjs'], ['package-readiness.ts', 'p.mjs']])
  await build({ entryPoints: [join(here, entry)], bundle: true, platform: 'node', format: 'esm', outfile: join(out, name), logLevel: 'error' })
const O = await import(pathToFileURL(join(out, 'o.mjs')).href)
const R = await import(pathToFileURL(join(out, 'r.mjs')).href)
const P = await import(pathToFileURL(join(out, 'p.mjs')).href)

const pack = join(here, '../../../pack')
const FIX = join(pack, 'runtime/tests/fixtures/original_text')
const engineDir = join(pack, 'runtime/hsenv')
// What trustedOriginalTextFiles() hands over: the engine under hsenv/ and the helper.
const FILES = [
  ...['VERSION', ...[...readFileSync(join(engineDir, 'VERSION'), 'utf8').matchAll(/^[0-9a-f]{64} {2}(\S+)$/gm)].map((m) => m[1])]
    .map((rel) => ['hsenv/' + rel, readFileSync(join(engineDir, rel), 'utf8')]),
  ['hs_original_text.py', readFileSync(join(pack, 'runtime/lib/hs_original_text.py'), 'utf8')],
]
const python = [process.env.HUMANSTUDY_TEST_PYTHON, 'python3.12', 'python3.13', 'python3.11', 'python3'].filter(Boolean).map((p) =>
  spawnSync(p, ['-c', 'import sys; print(sys.executable) if sys.version_info >= (3, 11) else sys.exit(1)'], { encoding: 'utf8' }))
  .find((r) => r.status === 0)?.stdout.trim()
const hasPdfium = python ? spawnSync(python, ['-c', 'import pypdfium2'], { encoding: 'utf8' }).status === 0 : false
const sha = (b) => createHash('sha256').update(b).digest('hex')
const HANDOUT_TEXT = 'Thank you for joining this short study about walking before breakfast.'

/** A project holding the published fixture, its link source served by a local "publisher". */
async function publishedProject(files = {}) {
  const server = createServer((req, res) => {
    if (req.url === '/handout.txt') { res.writeHead(200); res.end(readFileSync(join(FIX, 'handout.txt'))) } else { res.writeHead(404); res.end() }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const proj = mkdtempSync(join(tmpdir(), 'published-'))
  const p = JSON.parse(readFileSync(join(FIX, 'protocol.json'), 'utf8'))
  p.meta.sources.handout.distribution.url = `http://127.0.0.1:${server.address().port}/handout.txt`
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  for (const [rel, name] of Object.entries(files)) {
    mkdirSync(dirname(join(proj, rel)), { recursive: true })
    cpSync(join(FIX, name), join(proj, rel))
  }
  return { proj, close: () => server.close() }
}

test('a published study is recognised by its held wording; an ordinary protocol is not', async () => {
  const { proj, close } = await publishedProject()
  close()
  assert.equal(await O.isPublishedStudy(proj), true)
  assert.deepEqual([...await R.heldSources(proj)].sort(), ['booklet', 'handout', 'leaflet'])
  const held = await R.heldTexts(proj)
  assert.deepEqual([[...held.sources].sort(), held.texts], [['booklet', 'handout', 'leaflet'], 4])
  // a held entry that points at real text (not a placeholder) is not counted
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  p.stages.intro.content[0].value = 'x'.repeat(p.distribution.held.h1.length)
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p))
  assert.equal((await R.heldTexts(proj)).texts, 3)
  const plain = mkdtempSync(join(tmpdir(), 'plain-'))
  writeFileSync(join(plain, 'protocol.json'), JSON.stringify({ id: 'x' }))
  assert.equal(await O.isPublishedStudy(plain), false)
  assert.equal(await O.isPublishedStudy(mkdtempSync(join(tmpdir(), 'none-'))), false)
})

test('the engine checks block on unchecked texts only when they cite a source the study does not hold back', () => {
  const report = (unchecked, sources, extra = {}) => JSON.stringify({ refs: [], fuzz: { problems: [] }, PASS: false, ...extra,
    verbatim: { not_found: [], image_unconfirmed: [], bad_source: [], unchecked, unchecked_sources: sources } })
  const held = new Set(['handout', 'booklet'])
  assert.deepEqual(R.parseProtocolReport(report(3, ['handout', 'booklet']), held, 3), [], 'held texts are checked by their own hash instead')
  assert.deepEqual(R.parseProtocolReport(report(3, ['handout', 'survey']), held, 3).map((p) => p.check), ['verbatim'])
  assert.deepEqual(R.parseProtocolReport(report(5, ['handout']), held, 1).map((p) => p.check), ['verbatim'], 'more unverified texts than held placeholders')
  assert.deepEqual(R.parseProtocolReport(report(3, ['handout'])).map((p) => p.check), ['verbatim'], 'an ordinary protocol is unchanged')
  // any other failing finding still blocks, including one the parser lists only since this change
  assert.deepEqual(R.parseProtocolReport(report(3, ['handout'], { fuzz: { problems: [], table_spans_unserved: ['t1'] } }), held, 3).map((p) => p.check), ['fuzz'])
  assert.deepEqual(R.parseProtocolReport(report(0, []), held, 3).map((p) => p.check), ['protocol'], 'an unexplained failure is never a pass')
})

test('problems: one per source, in plain words, with the parts the app translates; none once complete', () => {
  const status = { projection: true, complete: false, sources: [
    { key: 'handout', title: 'Morning Walk Survey handout', tier: 'link', format: 'text', items: 1, restored: 1, screens: 0, file: null },
    { key: 'booklet', title: 'Walking booklet', tier: 'user', format: 'html', items: 2, restored: 0, screens: 1, file: null, need: 'file' },
    { key: 'leaflet', title: 'Water leaflet', tier: 'user', format: 'pdf', items: 1, restored: 0, screens: 1, file: null, need: 'pdf-reader' },
  ] }
  const problems = O.originalTextProblems(status)
  assert.deepEqual(problems.map((p) => [p.check, p.text.need, p.text.title, p.text.format, p.text.screens]),
    [['original-text', 'file', 'Walking booklet', 'html', 1], ['original-text', 'pdf-reader', 'Water leaflet', 'pdf', 1]])
  for (const p of problems) assert.doesNotMatch(p.reason, /rehydrat|projection|sha256|hash|placeholder/i)
  assert.deepEqual(O.originalTextProblems({ ...status, complete: true }), [])
  assert.deepEqual(O.originalTextProblems({ projection: false }), [])
})

test('candidate files: sources/private first, then paper.pdf and the rest of sources/; nothing outside the project', async () => {
  const { proj, close } = await publishedProject({ 'sources/private/booklet.html': 'booklet.html', 'paper.pdf': 'leaflet.pdf', 'sources/open/handout.txt': 'handout.txt' })
  close()
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'not the project')
  symlinkSync(join(outside, 'secret.txt'), join(proj, 'sources/linked.txt'))
  writeFileSync(join(proj, 'sources/SOURCE.json'), '{}')
  const files = (await O.candidateFiles(proj)).map((f) => f.slice(f.indexOf('published-')).split('/').slice(1).join('/'))
  assert.deepEqual(files, ['sources/private/booklet.html', 'paper.pdf', 'sources/open/handout.txt'])
})

test('the run gets the restored copy only for exactly the approved version, and a published study without one is refused', async () => {
  const { proj, close } = await publishedProject()
  close()
  const cache = mkdtempSync(join(tmpdir(), 'text-cache-'))
  const version = sha(readFileSync(join(proj, 'protocol.json')))
  await assert.rejects(O.restoredRunFiles(proj, cache, version), /original wording has not been filled in.*\[text not available\]/)
  const restored = '{"id": "fixture-walk"}\n'
  mkdirSync(join(cache, version))
  writeFileSync(join(cache, version, 'protocol.json'), restored)
  writeFileSync(join(cache, version, 'status.json'), JSON.stringify({ complete: true, projectionSha256: version, restoredSha256: sha(restored) }))
  assert.deepEqual(await O.restoredRunFiles(proj, cache, version), [['restored/protocol.json', restored]])
  writeFileSync(join(cache, version, 'protocol.json'), restored.replace('walk', 'run'))   // changed after it was written
  await assert.rejects(O.restoredRunFiles(proj, cache, version))
  assert.equal(await O.restoredProtocolText(cache, '../' + version), null)
  // an ordinary protocol.json needs nothing
  const plain = mkdtempSync(join(tmpdir(), 'plain-'))
  writeFileSync(join(plain, 'protocol.json'), '{"id": "x"}')
  assert.deepEqual(await O.restoredRunFiles(plain, cache, sha('{"id": "x"}')), [])
})

test('readiness: missing wording blocks a protocol run and comes first; a failed download is checked again', async () => {
  const { proj, close } = await publishedProject()
  close()
  let calls = 0
  P.configureProtocolChecks(async () => [], 'test', async () => ({ arms: { control: { group_size: 1, calls: 2, tokens_per_member: 1000 } }, output_tokens: 512 }))
  P.configureOriginalText(async () => { calls++; return [{ check: 'original-text', reason: 'r', text: { need: 'download', title: 'T', format: 'text', screens: 1 } }] })
  let r = await P.projectPackageReadiness(proj)
  assert.equal(r.protocol.ready, false)
  assert.deepEqual(r.protocol.problems.map((p) => [p.check, p.text?.need]), [['original-text', 'download']])
  await P.projectPackageReadiness(proj)
  assert.equal(calls, 1, 'kept while nothing changes')
  let t = 0
  await P.originalTextProblemsOf(proj, () => t); await P.originalTextProblemsOf(proj, () => t)
  assert.equal(calls, 2)
  t += P.TEXT_RECHECK_MS
  await P.originalTextProblemsOf(proj, () => t)
  assert.equal(calls, 3, 'asked again after ten minutes (a failed download may work later)')
  writeFileSync(join(proj, 'paper.pdf'), 'dropped')
  await P.originalTextProblemsOf(proj, () => t)
  assert.equal(calls, 4, 'a dropped file checks again')
  P.configureOriginalText(async () => [])
  r = await P.projectPackageReadiness(proj)
  assert.equal(r.protocol.ready, true)
})

test('end to end with the bundled engine: downloads the link source, takes the dropped copies, caches the restored study outside the project', { skip: !python || !hasPdfium }, async () => {
  const { proj, close } = await publishedProject({ 'sources/private/booklet.html': 'booklet.html', 'sources/private/leaflet.pdf': 'leaflet.pdf' })
  try {
    const cache = mkdtempSync(join(tmpdir(), 'text-cache-'))
    const status = await O.fillOriginalText(python, FILES, proj, cache, '', { allowLocal: true })
    assert.equal(status.complete, true, JSON.stringify(status))
    assert.equal(status.restored, 4)
    const restored = JSON.parse(readFileSync(status.restoredPath, 'utf8'))
    assert.equal(restored.stages.intro.content[0].value, HANDOUT_TEXT)
    assert.ok(status.restoredPath.startsWith(cache))
    const files = await O.restoredRunFiles(proj, cache, sha(readFileSync(join(proj, 'protocol.json'))))
    assert.equal(JSON.parse(files[0][1]).stages.q.responses[0].prompt, 'How many minutes did you walk this morning?')
    // the project gets a status without any wording or app-storage path
    await O.writeAgentStatus(proj, status)
    const shown = readFileSync(join(proj, '.humanstudy/original-text.json'), 'utf8')
    assert.doesNotMatch(shown, /Thank you|walk this morning/)
    assert.ok(!shown.includes(cache))
    assert.deepEqual(JSON.parse(shown).sources.map((s) => s.file), ['sources/private/booklet.html', null, 'sources/private/leaflet.pdf'])
    assert.equal(JSON.parse(shown).complete, true)
  } finally { close() }
})

test('end to end, nothing dropped: the link source fills its screen, the others say what they need', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  try {
    const cache = mkdtempSync(join(tmpdir(), 'text-cache-'))
    const status = await O.fillOriginalText(python, FILES, proj, cache, '', { allowLocal: true })
    assert.equal(status.complete, false)
    const needs = Object.fromEntries(status.sources.map((s) => [s.key, s.need ?? 'ok']))
    assert.deepEqual(needs, { booklet: 'file', handout: 'ok', leaflet: hasPdfium ? 'file' : 'pdf-reader' })
    assert.equal(status.restoredPath, null)
    assert.equal(existsSync(join(cache, status.projectionSha256, 'protocol.json')), false)
  } finally { close() }
})
