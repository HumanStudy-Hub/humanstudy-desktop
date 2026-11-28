// node --test src/main/original-text.test.mjs — a published study's original wording, filled in on this computer
// (original-text.ts over pack/runtime/lib/hs_original_text.py and the bundled hsenv.rehydrate). The fixture is
// invented (pack/runtime/tests/fixtures/original_text): no real study, paper or person.
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'original-text-'))
for (const [entry, name] of [['original-text.ts', 'o.mjs'], ['protocol-readiness.ts', 'r.mjs'], ['package-readiness.ts', 'p.mjs'], ['telemetry-core.ts', 't.mjs'], ['../shared/workspace-context.ts', 'w.mjs'], ['private-index.ts', 'pi.mjs']])
  await build({ entryPoints: [join(here, entry)], bundle: true, platform: 'node', format: 'esm', outfile: join(out, name), logLevel: 'error' })
const O = await import(pathToFileURL(join(out, 'o.mjs')).href)
const R = await import(pathToFileURL(join(out, 'r.mjs')).href)
const P = await import(pathToFileURL(join(out, 'p.mjs')).href)
const T = await import(pathToFileURL(join(out, 't.mjs')).href)
const W = await import(pathToFileURL(join(out, 'w.mjs')).href)
const PI = await import(pathToFileURL(join(out, 'pi.mjs')).href)

const pack = join(here, '../../../pack')
const FIX = join(pack, 'runtime/tests/fixtures/original_text')
const engineDir = join(pack, 'runtime/hsenv')
// What trustedOriginalTextFiles() hands over: the engine under hsenv/ and the helper.
const FILES = [
  ...['VERSION', ...[...readFileSync(join(engineDir, 'VERSION'), 'utf8').matchAll(/^[0-9a-f]{64} {2}(\S+)$/gm)].map((m) => m[1])]
    .map((rel) => ['hsenv/' + rel, readFileSync(join(engineDir, rel), 'utf8')]),
  ['hs_original_text.py', readFileSync(join(pack, 'runtime/lib/hs_original_text.py'), 'utf8')],
  ['hs_approx_text.py', readFileSync(join(pack, 'runtime/lib/hs_approx_text.py'), 'utf8')],
]
const python = [process.env.HUMANSTUDY_TEST_PYTHON, 'python3.12', 'python3.13', 'python3.11', 'python3'].filter(Boolean).map((p) =>
  spawnSync(p, ['-c', 'import sys; print(sys.executable) if sys.version_info >= (3, 11) else sys.exit(1)'], { encoding: 'utf8' }))
  .find((r) => r.status === 0)?.stdout.trim()
// pypdfium2 at exactly the version the fixture's PDF locator names (the runtime lock's pin); another version is a
// different extractor, which hsenv refuses by design, so those cases skip.
const pdfLocator = Object.values(JSON.parse(readFileSync(join(FIX, 'protocol.json'), 'utf8')).distribution.held).find((h) => h.locator?.format === 'pdf').locator.extractor
const hasPdfium = python ? spawnSync(python, ['-c', 'import pypdfium2.version as v; print("pypdfium2/%s+pdfium/%s" % (v.PYPDFIUM_INFO, v.PDFIUM_INFO))'], { encoding: 'utf8' }).stdout.trim() === pdfLocator : false
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
  const plain = mkdtempSync(join(tmpdir(), 'plain-'))
  writeFileSync(join(plain, 'protocol.json'), JSON.stringify({ id: 'x' }))
  assert.equal(await O.isPublishedStudy(plain), false)
  assert.equal(await O.isPublishedStudy(mkdtempSync(join(tmpdir(), 'none-'))), false)
})

// The engine's own verbatim rule decides which texts the published study may leave to the per-item hash check: each
// held source is checked against a run of placeholders, so the held placeholders are found and any other text cited
// verbatim from that source is not (review of PR #94, probe q3).
const ENGINE = ['VERSION', ...[...readFileSync(join(engineDir, 'VERSION'), 'utf8').matchAll(/^[0-9a-f]{64} {2}(\S+)$/gm)].map((m) => m[1])]
  .map((rel) => [rel, readFileSync(join(engineDir, rel), 'utf8')])
test('engine checks: a published study passes with its placeholders; an unverified text from a held source still blocks (q3)', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  assert.deepEqual(await R.protocolReadiness(python, ENGINE, proj, ''), [])
  // q3: a held text loses its verbatim cite, and a made-up option label claims to be verbatim from a held source
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  delete p.stages.q.responses[1].prompt_cite
  p.stages.q.responses[1].options[0].cite = { label: 'verbatim', source: 'booklet', page: 1 }
  p.stages.q.responses[1].options[0].label = 'Absolutely, I walked every single day'
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  const problems = await R.protocolReadiness(python, ENGINE, proj, '')
  assert.deepEqual(problems.map((x) => x.check), ['verbatim'])
  assert.match(problems[0].reason, /not found in the source/)
  // an ordinary protocol gets no placeholder text: its unchecked texts block as before
  assert.equal((await R.heldSourceTexts(mkdtempSync(join(tmpdir(), 'none-')))).size, 0)
})

test('engine checks: a published study is checked as released (--public); the researcher\'s own project stays strict', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  // a text the release transcribed from a page image of a held source: its blind readings were never shipped
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  p.stages.intro.content.push({ id: 'scan', value: 'Walk at your own pace.', cite: { label: 'verbatim', source: 'booklet', page: 1, read: 'image' } })
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  assert.deepEqual(await R.publicMode(proj), ['--public'])
  assert.deepEqual(await R.protocolReadiness(python, ENGINE, proj, ''), [])
  // the restored copy is checked the same way
  const restored = structuredClone(p)
  delete restored.distribution
  const texts = { '/stages/intro/content/0/value': HANDOUT_TEXT, '/stages/intro/content/1/value': 'Remember to drink a glass of water first.',
    '/stages/q/responses/0/prompt': 'How many minutes did you walk this morning?', '/stages/q/responses/1/prompt': 'Did you see a neighbour on the way?' }
  for (const [path, text] of Object.entries(texts)) {
    const parts = path.split('/').slice(1); const last = parts.pop()
    parts.reduce((o, k) => o[k], restored)[last] = text
  }
  const work = mkdtempSync(join(tmpdir(), 'restored-check-'))
  assert.deepEqual(await R.restoredReadiness(python, ENGINE, proj, JSON.stringify(restored), work, ''), [])
  // the same protocol as the researcher's own project (no held wording): the strict check still asks for a reading
  const own = mkdtempSync(join(tmpdir(), 'own-'))
  writeFileSync(join(own, 'protocol.json'), JSON.stringify(restored, null, 1))
  assert.deepEqual(await R.publicMode(own), [])
  const strict = await R.protocolReadiness(python, ENGINE, own, '')
  assert.ok(strict.some((x) => x.check === 'verbatim' && /image-read texts without an agreeing blind reading/.test(x.reason)), JSON.stringify(strict))
})

test('engine checks: wording a release cites verbatim from a held source outside the held fields passes as received; a local edit blocks', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  // a short label the release cites verbatim from the held booklet without holding it (Bench checked it privately)
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  p.stages.q.responses[1].options[0].cite = { label: 'verbatim', source: 'booklet', page: 1 }
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  const received = structuredClone(p)
  assert.deepEqual((await R.protocolReadiness(python, ENGINE, proj, '')).map((x) => x.check), ['verbatim'], 'without the received copy it blocked (the bug)')
  R.configureReceivedProtocol(async () => received)
  try {
    assert.deepEqual(await R.protocolReadiness(python, ENGINE, proj, ''), [])
    p.stages.q.responses[1].options[0].label = 'Absolutely, I walked every single day'   // changed on this computer
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    assert.deepEqual([...new Set((await R.protocolReadiness(python, ENGINE, proj, '')).map((x) => x.check))], ['verbatim'])
  } finally { R.configureReceivedProtocol(async () => null) }
})

test('engine checks: a published study\'s image-read text changed on this computer blocks', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  p.stages.intro.content.push({ id: 'scan', value: 'Walk at your own pace.', cite: { label: 'verbatim', source: 'booklet', page: 1, read: 'image' } })
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  const received = structuredClone(p)
  R.configureReceivedProtocol(async () => received)
  try {
    assert.deepEqual(await R.protocolReadiness(python, ENGINE, proj, ''), [])
    p.stages.intro.content.at(-1).value = 'Walk as fast as you can.'
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    const problems = await R.protocolReadiness(python, ENGINE, proj, '')
    assert.deepEqual(problems.map((x) => x.check), ['verbatim'])
    assert.match(problems[0].reason, /read from a page image of the paper were changed on this computer/)
  } finally { R.configureReceivedProtocol(async () => null) }
})

test('engine checks: released wording copied into another verbatim field of a published study blocks; reordering does not', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  p.stages.q.responses[1].options[0].cite = { label: 'verbatim', source: 'booklet', page: 1 }
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  const received = structuredClone(p)
  R.configureReceivedProtocol(async () => received)
  try {
    assert.deepEqual(await R.protocolReadiness(python, ENGINE, proj, ''), [])
    // the released option moved: the same texts with the same cites, in another order, still pass as received
    const moved = structuredClone(p)
    moved.stages.q.responses[1].options.reverse()
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(moved, null, 1))
    assert.deepEqual(await R.protocolReadiness(python, ENGINE, proj, ''), [])
    // a second option given the released option's wording and cite: local wording, so it is verified strictly
    p.stages.q.responses[1].options[1] = { code: 'b', label: 'Yes', cite: { label: 'verbatim', source: 'booklet', page: 1 } }
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    const problems = await R.protocolReadiness(python, ENGINE, proj, '')
    assert.deepEqual(problems.map((x) => x.check), ['verbatim'])
    assert.match(problems.at(-1).reason, /changed on this computer/)
    // wording copied from a released field that is not verbatim at all (an option without a cite) blocks the same way
    p.stages.q.responses[1].options[1] = { code: 'b', label: 'No', cite: { label: 'verbatim', source: 'booklet', page: 1 } }
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    assert.deepEqual((await R.protocolReadiness(python, ENGINE, proj, '')).map((x) => x.check), ['verbatim'])
  } finally { R.configureReceivedProtocol(async () => null) }
})

test('engine checks: a published study\'s text cited from an unshipped source and changed on this computer blocks', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  p.stages.intro.content.push({ id: 'p', value: 'Please walk as you usually do.', cite: { label: 'verbatim', source: 'paper', page: 3 } })
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  const received = structuredClone(p)
  R.configureReceivedProtocol(async () => received)
  try {
    assert.deepEqual(await R.protocolReadiness(python, ENGINE, proj, ''), [])
    p.stages.intro.content.at(-1).value = 'Please walk faster than you usually do.'   // the cite kept, the wording changed
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    const problems = await R.protocolReadiness(python, ENGINE, proj, '')
    assert.deepEqual(problems.map((x) => x.check), ['verbatim'])
    assert.match(problems[0].reason, /changed on this computer/)
    // the cite changed instead (a page of its own choosing): also a local edit
    p.stages.intro.content.at(-1).value = 'Please walk as you usually do.'
    p.stages.intro.content.at(-1).cite.page = 4
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    assert.deepEqual((await R.protocolReadiness(python, ENGINE, proj, '')).map((x) => x.check), ['verbatim'])
  } finally { R.configureReceivedProtocol(async () => null) }
})

test('engine checks: an invented verbatim quote under a nested distribution key is not skipped', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  const received = structuredClone(p)
  R.configureReceivedProtocol(async () => received)
  try {
    p.data = { distribution: { note: { text: 'An invented sentence the paper never printed.', cite: { label: 'verbatim', source: 'paper', page: 2 } } } }
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    const problems = await R.protocolReadiness(python, ENGINE, proj, '')
    assert.ok(problems.some((x) => x.check === 'verbatim' && /changed on this computer/.test(x.reason)), JSON.stringify(problems))
  } finally { R.configureReceivedProtocol(async () => null) }
})

test('engine checks: the same released wording in another field form, or differing only by NFC or whitespace, passes', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  const cite = { label: 'verbatim', source: 'paper', page: 3 }
  p.stages.intro.content.push({ id: 'p', value: 'Please walk as you usually do in the café.', cite })
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  const received = structuredClone(p)
  R.configureReceivedProtocol(async () => received)
  try {
    assert.deepEqual(await R.protocolReadiness(python, ENGINE, proj, ''), [])
    // a stage content value turned into an inline text dict, decomposed é, a line break, doubled spaces, a styling span
    p.stages.intro.content[2] = { id: 'p', value: { text: 'Please walk  as you usually do\nin the cafe\u0301.', spans: [{ start: 0, end: 6, style: 'bold' }] }, cite }
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    assert.deepEqual((await R.protocolReadiness(python, ENGINE, proj, '')).filter((x) => /changed on this computer/.test(x.reason)), [])
    // a tooltip is on-screen wording of its own: one added on this computer is a local text
    p.stages.intro.content[2].value.spans[0].tooltip = 'Walk slowly.'
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    assert.ok((await R.protocolReadiness(python, ENGINE, proj, '')).some((x) => /1 text\(s\) cited word for word/.test(x.reason)))
  } finally { R.configureReceivedProtocol(async () => null) }
})

test('engine checks: a Library study whose release is not confirmed yet has nothing received', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  R.configureReceivedProtocol(async () => O.UNVERIFIED_RELEASE)
  try {
    // only held placeholders are cited verbatim: they are checked by their hash, so nothing blocks
    assert.deepEqual(await R.protocolReadiness(python, ENGINE, proj, ''), [])
    p.stages.intro.content.push({ id: 'p', value: 'Please walk as you usually do.', cite: { label: 'verbatim', source: 'paper', page: 3 } })
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    const problems = await R.protocolReadiness(python, ENGINE, proj, '')
    assert.ok(problems.some((x) => /could not be fetched from the Library yet/.test(x.reason)), JSON.stringify(problems))
  } finally { R.configureReceivedProtocol(async () => null) }
})

/** A Library fork's provenance as forkCommunityStudy writes it: this paper's own revision folder and manifest. */
const forkContext = (assetFiles, id = 'paper_x') => {
  const identity = O.manifestIdentity(assetFiles)
  return { id, commit: 'c'.repeat(40), assetRoot: `community/${id}/revisions/${identity}`, baseRevision: identity, assetFiles }
}

test('study downloads: released is sticky once seen, fails closed on an unreadable or unverified record; ordinary stays ordinary', async () => {
  const { proj, close } = await publishedProject()
  close()
  const cache = mkdtempSync(join(tmpdir(), 'released-'))
  assert.equal(await O.releasedStudy(cache, proj), true, 'holds wording back')
  // the held block removed, then the file broken: it stays released (recorded the first time)
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  delete p.distribution
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p))
  assert.equal(await O.releasedStudy(cache, proj), true)
  writeFileSync(join(proj, 'protocol.json'), '{not json')
  assert.equal(await O.releasedStudy(cache, proj), true)
  // without any record on this computer: the provenance decides, failing closed
  const fresh = mkdtempSync(join(tmpdir(), 'released-none-'))
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p))
  assert.equal(await O.releasedStudy(fresh, proj), false, 'no provenance, nothing held: an ordinary project, as on dev')
  writeFileSync(join(proj, 'protocol.json'), '{not json')
  assert.equal(await O.releasedStudy(fresh, proj), false, 'an ordinary project with a broken protocol.json is still ordinary')
  mkdirSync(join(proj, '.humanstudy'), { recursive: true })
  const files = [{ path: 'program.json', sha256: 'b'.repeat(64) }, { path: 'protocol.json', sha256: 'a'.repeat(64) }]
  const own = forkContext(files)
  for (const [context, why] of [
    [own, 'names a protocol release'],
    [{ ...own, assetFiles: files.slice(0, 1) }, 'its protocol.json entry deleted: the manifest no longer matches its revision'],
    [{ ...own, id: 'paper_other' }, 'another paper id than the revision folder'],
    [{ ...own, baseRevision: 'e'.repeat(64) }, 'another revision'],
  ]) {
    const c = mkdtempSync(join(tmpdir(), 'released-c-'))
    writeFileSync(join(proj, '.humanstudy', 'community.json'), JSON.stringify(context))
    assert.equal(await O.releasedStudy(c, proj), true, why)
  }
  writeFileSync(join(proj, '.humanstudy', 'community.json'), '{broken')
  assert.equal(await O.releasedStudy(mkdtempSync(join(tmpdir(), 'released-b-')), proj), true, 'unreadable')
  // a verified program-only revision and a legacy study are not protocol releases
  writeFileSync(join(proj, '.humanstudy', 'community.json'), JSON.stringify(forkContext(files.slice(0, 1))))
  assert.equal(await O.releasedStudy(mkdtempSync(join(tmpdir(), 'released-p-')), proj), false)
  writeFileSync(join(proj, '.humanstudy', 'community.json'), JSON.stringify({ id: 'study_001' }))
  assert.equal(await O.releasedStudy(mkdtempSync(join(tmpdir(), 'released-l-')), proj), false)
})

test('release baseline: only the official release of this paper and revision, verified; offline then online recovers', async () => {
  const { proj, close } = await publishedProject()
  close()
  const cache = mkdtempSync(join(tmpdir(), 'baseline-'))
  const release = readFileSync(join(proj, 'protocol.json'))
  const assetFiles = [{ path: 'program.json', sha256: 'b'.repeat(64) }, { path: 'protocol.json', sha256: sha(release) }]
  const own = forkContext(assetFiles)
  mkdirSync(join(proj, '.humanstudy'), { recursive: true })
  writeFileSync(join(proj, '.humanstudy', 'community.json'), JSON.stringify(own))
  // the project's own copy edited: it is never the baseline
  const edited = JSON.parse(release.toString('utf8'))
  edited.stages.intro.content.push({ id: 'p', value: 'An added quote.', cite: { label: 'verbatim', source: 'paper', page: 3 } })
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(edited))
  let calls = 0
  const offline = async () => { calls++; return null }
  const online = async (c) => { calls++; return c.id === 'paper_x' ? release : null }
  const t0 = 1_000_000
  assert.equal(await O.releaseBaseline(cache, proj, offline, t0), 'unverified')
  assert.equal(existsSync(join(cache, 'releases')), false, 'nothing is stored while offline')
  assert.equal(await O.releaseBaseline(cache, proj, online, t0 + 1000), 'unverified', 'a failed fetch is not retried at once')
  assert.equal(calls, 1)
  const got = await O.releaseBaseline(cache, proj, online, t0 + O.RELEASE_RETRY_MS + 1)
  assert.ok(got.protocol.equals(release) && got.assetFiles.length === 2, 'recovers on a later check once online')
  assert.ok((await O.releaseBaseline(cache, proj, offline, t0 + 2 * O.RELEASE_RETRY_MS)).protocol.equals(release), 'then kept, offline too')
  assert.equal(calls, 2)
  // a fetch that answers with other bytes is refused
  const other = mkdtempSync(join(tmpdir(), 'baseline-other-'))
  assert.equal(await O.releaseBaseline(other, proj, async () => Buffer.from(JSON.stringify(edited)), t0 + 5 * O.RELEASE_RETRY_MS), 'unverified')
  // a manifest edited to claim the edited copy no longer matches its revision: unconfirmed, no fetch
  const n = calls
  writeFileSync(join(proj, '.humanstudy', 'community.json'), JSON.stringify({ ...own, assetFiles: [{ path: 'protocol.json', sha256: sha(JSON.stringify(edited)) }] }))
  assert.equal(await O.releaseBaseline(cache, proj, online, t0 + 6 * O.RELEASE_RETRY_MS), 'unverified')
  // the same manifest claimed for another paper: its cached release (from paper_x's folder) is not used
  writeFileSync(join(proj, '.humanstudy', 'community.json'), JSON.stringify({ ...own, id: 'paper_y', assetRoot: own.assetRoot.replace('paper_x', 'paper_y') }))
  assert.equal(await O.releaseBaseline(cache, proj, async () => null, t0 + 7 * O.RELEASE_RETRY_MS), 'unverified')
  assert.equal(calls, n)
  // a fork stores its verified release, so it never needs the network
  const forked = mkdtempSync(join(tmpdir(), 'baseline-fork-'))
  await O.storeRelease(forked, assetFiles, release, own.assetRoot)
  writeFileSync(join(proj, '.humanstudy', 'community.json'), JSON.stringify(own))
  assert.ok((await O.releaseBaseline(forked, proj, offline, t0)).protocol.equals(release))
  await O.storeRelease(forked, assetFiles, Buffer.from('{}'), own.assetRoot)   // bytes that are not the manifest's are never stored
  assert.ok((await O.releaseBaseline(forked, proj, offline, t0)).protocol.equals(release))
  // held wording without any provenance: unconfirmed; an ordinary project: none
  const bare = mkdtempSync(join(tmpdir(), 'baseline-bare-'))
  writeFileSync(join(bare, 'protocol.json'), release)
  assert.equal(await O.releaseBaseline(cache, bare, online, t0), 'unverified')
  writeFileSync(join(bare, 'protocol.json'), JSON.stringify({ id: 'x' }))
  assert.equal(await O.releaseBaseline(cache, bare, online, t0), null)
})

test('engine checks: a failure while the release is unconfirmed is marked retry, so the readiness cache never keeps it', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  p.stages.intro.content.push({ id: 'p', value: 'Please walk as you usually do.', cite: { label: 'verbatim', source: 'paper', page: 3 } })
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  let received = O.UNVERIFIED_RELEASE
  R.configureReceivedProtocol(async () => received)
  try {
    const offline = await R.protocolReadiness(python, ENGINE, proj, '')
    assert.ok(offline.length && offline.every((x) => x.retry === true), JSON.stringify(offline))
    // through the readiness cache: the same files, the release now fetched, passes on the next check
    P.configureProtocolChecks((project) => R.protocolReadiness(python, ENGINE, project, ''), 'test-retry')
    received = O.UNVERIFIED_RELEASE
    assert.ok((await P.protocolProblems(proj)).length)
    received = structuredClone(p)
    assert.deepEqual(await P.protocolProblems(proj), [])
  } finally { R.configureReceivedProtocol(async () => null); P.configureProtocolChecks(async () => [], 'unconfigured') }
})

test('engine checks: each anchor is a text of its own with the shared cite, as the engine checks it', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  p.stages.q.responses.push({ id: 'scale', kind: 'scale', prompt: 'How was it?', range: [1, 7], anchors: { '1': 'Not at all', '7': 'Very much' }, anchors_cite: { label: 'verbatim', source: 'paper', page: 3 } })
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  const received = structuredClone(p)
  R.configureReceivedProtocol(async () => received)
  try {
    const before = (await R.protocolReadiness(python, ENGINE, proj, '')).filter((x) => /changed on this computer/.test(x.reason))
    assert.deepEqual(before, [])
    // the same anchor wording under other keys is the same texts; one anchor reworded is one local text
    p.stages.q.responses.at(-1).anchors = { low: 'Not at all', high: 'Very much' }
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    assert.deepEqual((await R.protocolReadiness(python, ENGINE, proj, '')).filter((x) => /changed on this computer/.test(x.reason)), [])
    p.stages.q.responses.at(-1).anchors.high = 'Extremely'
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    assert.ok((await R.protocolReadiness(python, ENGINE, proj, '')).some((x) => /^1 text\(s\) cited word for word/.test(x.reason)))
  } finally { R.configureReceivedProtocol(async () => null) }
})

test('candidate files never follow a link, not even one inside the project', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'links-'))
  mkdirSync(join(proj, 'sources', 'private'), { recursive: true })
  mkdirSync(join(proj, 'notes'))
  writeFileSync(join(proj, 'notes', 'copy.html'), '<p>held wording</p>')
  writeFileSync(join(proj, 'sources', 'private', 'mine.txt'), 'mine')
  symlinkSync(join(proj, 'notes', 'copy.html'), join(proj, 'sources', 'linked.html'))
  symlinkSync(join(proj, 'notes'), join(proj, 'sources', 'notes-dir'))
  symlinkSync(join(proj, 'notes', 'copy.html'), join(proj, 'paper.pdf'))
  const got = (await O.candidateFiles(proj)).map((f) => relative(realpathSync.native(proj), f).split(sep).join('/'))
  assert.deepEqual(got, ['sources/private/mine.txt'])
})

test('research capture never collects what a released study\'s download keeps back, however short its wording', () => {
  const index = T.privateIndexOf(['A restored passage long enough to be indexed by the forty letter window.'])
  // a short restored answer in sources/: shorter than the matching window, still never collected
  assert.equal(T.mayCollectFile({ rel: 'sources/questionnaire.txt', text: 'Yes, daily.', published: true, index }), false)
  assert.equal(T.mayCollectFile({ rel: 'paper.pdf', published: true, index: T.EMPTY_INDEX }), false)
  assert.equal(T.mayCollectFile({ rel: 'notes/figure.dat', bytes: Buffer.from('89504e470d0a1a0a', 'hex'), published: true, index: T.EMPTY_INDEX }), false)
  assert.equal(T.mayCollectFile({ rel: 'artifacts/preview.html', text: '<p>preview</p>', published: true, index: T.EMPTY_INDEX }), false)
  assert.equal(T.mayCollectFile({ rel: 'notes/plan.md', text: 'my plan', published: true, index }), true)
  // an ordinary project keeps collecting its sources and PDFs, as before
  assert.equal(T.mayCollectFile({ rel: 'sources/questionnaire.txt', text: 'Yes, daily.', published: false, index: T.EMPTY_INDEX }), true)
  assert.equal(T.mayCollectFile({ rel: 'paper.pdf', published: false, index: T.EMPTY_INDEX }), true)
  // one predicate for both: what capture refuses by name or content is what a download keeps back
  assert.equal(T.canCarryRestored('sources/a.txt'), true)
  assert.equal(T.canCarryRestored('notes/x', Buffer.from('%PDF-1.7')), true)
  assert.equal(T.canCarryRestored('notes/x.txt', Buffer.from('plain')), false)
})

test('capture checks a file\'s raw bytes for a picture or PDF, never text decoded from them', () => {
  const jpeg = Buffer.concat([Buffer.from('ffd8ffe0', 'hex'), Buffer.from('a scan saved as text')])
  // decoded as UTF-8 the signature is gone; the raw first bytes still show a picture
  assert.equal(T.canCarryRestored('notes/scan.txt', Buffer.from(jpeg.toString('utf8'), 'utf8')), false)
  assert.equal(T.mayCollectFile({ rel: 'notes/scan.txt', text: jpeg.toString('utf8'), bytes: jpeg.subarray(0, 16), published: true, index: T.EMPTY_INDEX }), false)
  assert.equal(T.mayCollectFile({ rel: 'notes/plan.txt', text: 'my plan', bytes: Buffer.from('my plan'), published: true, index: T.EMPTY_INDEX }), true)
})

test('the released record: by id when the project has one (never written here), else by path; pins and old path records count', async () => {
  const { proj, close } = await publishedProject()
  close()
  const cache = mkdtempSync(join(tmpdir(), 'released-id-'))
  // no id: recorded by path, and the classifier never writes .humanstudy/project.json (only project sync assigns ids)
  assert.equal(await O.releasedStudy(cache, proj), true)
  assert.equal(existsSync(join(proj, '.humanstudy', 'project.json')), false)
  const root = await realpath(proj)
  assert.equal(JSON.parse(readFileSync(join(cache, 'released.json'), 'utf8'))[root], true)
  // sync gives it an id: the path record moves to the id key on the next check
  mkdirSync(join(proj, '.humanstudy'), { recursive: true })
  writeFileSync(join(proj, '.humanstudy', 'project.json'), JSON.stringify({ id: 'proj-released-1' }))
  assert.equal(await O.releasedStudy(cache, proj), true)
  assert.deepEqual(JSON.parse(readFileSync(join(cache, 'released.json'), 'utf8')), { 'id:proj-released-1': true })
  // its held block removed and the folder renamed outside the app: still released, by its id
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  delete p.distribution
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p))
  const moved = proj + '-renamed'
  renameSync(proj, moved)
  assert.equal(await O.releasedStudy(cache, moved), true)
  // a new ordinary project at the old path: not released
  mkdirSync(proj)
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify({ id: 'ordinary' }))
  assert.equal(await O.releasedStudy(cache, proj), false)
  // upgrade: an existing held-list pin, or a path record written by an earlier build, counts
  const pinned = mkdtempSync(join(tmpdir(), 'released-pin-'))
  writeFileSync(join(pinned, 'protocol.json'), JSON.stringify({ id: 'x' }))
  writeFileSync(join(cache, 'pins.json'), JSON.stringify({ [await realpath(pinned)]: 'a'.repeat(64) }))
  assert.equal(await O.releasedStudy(cache, pinned), true)
  const legacy = mkdtempSync(join(tmpdir(), 'released-legacy-'))
  writeFileSync(join(legacy, 'protocol.json'), JSON.stringify({ id: 'y' }))
  const sticky = JSON.parse(readFileSync(join(cache, 'released.json'), 'utf8'))
  writeFileSync(join(cache, 'released.json'), JSON.stringify({ ...sticky, [await realpath(legacy)]: true }))
  assert.equal(await O.releasedStudy(cache, legacy), true)
  // the path-keyed pin, released record and received copy move with an app rename and are cleared on delete
  const a = mkdtempSync(join(tmpdir(), 'records-a-')), b = mkdtempSync(join(tmpdir(), 'records-b-'))
  const [ra, rb] = [await realpath(a), await realpath(b)]
  mkdirSync(join(cache, 'received'), { recursive: true })
  writeFileSync(join(cache, 'pins.json'), JSON.stringify({ [ra]: 'f'.repeat(64) }))
  writeFileSync(join(cache, 'released.json'), JSON.stringify({ [ra]: true }))
  writeFileSync(O.receivedPath(cache, ra), '{"received":true}')
  await O.moveProjectRecords(cache, ra, rb)
  assert.deepEqual(JSON.parse(readFileSync(join(cache, 'pins.json'), 'utf8')), { [rb]: 'f'.repeat(64) })
  assert.deepEqual(JSON.parse(readFileSync(join(cache, 'released.json'), 'utf8')), { [rb]: true })
  assert.equal(existsSync(O.receivedPath(cache, ra)), false)
  assert.equal(readFileSync(O.receivedPath(cache, rb), 'utf8'), '{"received":true}')
  await O.moveProjectRecords(cache, rb, null)
  assert.deepEqual(JSON.parse(readFileSync(join(cache, 'pins.json'), 'utf8')), {})
  assert.deepEqual(JSON.parse(readFileSync(join(cache, 'released.json'), 'utf8')), {})
  assert.equal(existsSync(O.receivedPath(cache, rb)), false)
})

test('the fills file is never read through a linked sources/ or sources/private/', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'linked-fills-'))
  mkdirSync(join(proj, 'elsewhere', 'private'), { recursive: true })
  writeFileSync(join(proj, 'elsewhere', 'private', 'original-text-fills.json'), '{}')
  symlinkSync(join(proj, 'elsewhere'), join(proj, 'sources'))
  assert.equal(await O.linkFree(await realpath(proj), O.FILLS_FILE), false)
  const ok = mkdtempSync(join(tmpdir(), 'real-fills-'))
  mkdirSync(join(ok, 'sources', 'private'), { recursive: true })
  writeFileSync(join(ok, O.FILLS_FILE), '{}')
  assert.equal(await O.linkFree(await realpath(ok), O.FILLS_FILE), true)
  const inner = mkdtempSync(join(tmpdir(), 'linked-private-fills-'))
  mkdirSync(join(inner, 'sources')); mkdirSync(join(inner, 'kept'))
  symlinkSync(join(inner, 'kept'), join(inner, 'sources', 'private'))
  assert.equal(await O.linkFree(await realpath(inner), O.FILLS_FILE), false)
})

test('the restore refuses a linked sources/ or sources/private/', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'linked-sources-'))
  const real = join(proj, 'elsewhere')
  mkdirSync(join(real, 'private'), { recursive: true })
  writeFileSync(join(real, 'copy.html'), '<p>held</p>')
  writeFileSync(join(real, 'private', 'mine.txt'), 'mine')
  symlinkSync(real, join(proj, 'sources'))
  assert.deepEqual(await O.candidateFiles(proj), [])
  const other = mkdtempSync(join(tmpdir(), 'linked-private-'))
  mkdirSync(join(other, 'sources'))
  writeFileSync(join(other, 'sources', 'open.txt'), 'open')
  mkdirSync(join(other, 'kept'))
  writeFileSync(join(other, 'kept', 'mine.txt'), 'mine')
  symlinkSync(join(other, 'kept'), join(other, 'sources', 'private'))
  assert.deepEqual((await O.candidateFiles(other)).map((f) => relative(realpathSync.native(other), f).split(sep).join('/')), ['sources/open.txt'])
})

test('engine checks: the retry mark follows the release as it was when the check began', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  p.stages.intro.content.push({ id: 'p', value: 'Please walk as you usually do.', cite: { label: 'verbatim', source: 'paper', page: 3 } })
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  const released = structuredClone(p)
  released.stages.intro.content.pop()
  let calls = 0
  // the first lookup (the snapshot) finds nothing; the release arrives during the check
  R.configureReceivedProtocol(async () => (calls++ === 0 ? O.UNVERIFIED_RELEASE : released))
  try {
    const found = await R.protocolReadiness(python, ENGINE, proj, '')
    assert.ok(found.length && found.every((x) => x.retry === true), JSON.stringify(found))
  } finally { R.configureReceivedProtocol(async () => null) }
})

test('engine checks: an inline label repeating the option\'s cite is one text, as the engine counts it', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  const cite = { label: 'verbatim', source: 'paper', page: 3 }
  p.stages.q.responses[1].options[0] = { code: 'a', label: 'Yes', cite }
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  const received = structuredClone(p)
  R.configureReceivedProtocol(async () => received)
  try {
    p.stages.q.responses[1].options[0] = { code: 'a', label: { text: 'Yes', cite }, cite }
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    assert.deepEqual((await R.protocolReadiness(python, ENGINE, proj, '')).filter((x) => /changed on this computer/.test(x.reason)), [])
  } finally { R.configureReceivedProtocol(async () => null) }
})

test('a hard-linked source, paper or fills file is never a restoration input; capture never collects a file reached through a link', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'hardlinks-'))
  mkdirSync(join(proj, 'sources', 'private'), { recursive: true })
  mkdirSync(join(proj, 'notes'))
  writeFileSync(join(proj, 'sources', 'private', 'mine.txt'), 'mine')
  writeFileSync(join(proj, 'notes', 'copy.html'), '<p>held</p>')
  linkSync(join(proj, 'notes', 'copy.html'), join(proj, 'sources', 'copy.html'))
  writeFileSync(join(proj, 'notes', 'paper.pdf'), '%PDF-1.4')
  linkSync(join(proj, 'notes', 'paper.pdf'), join(proj, 'paper.pdf'))
  const root = await realpath(proj)
  assert.deepEqual((await O.candidateFiles(proj)).map((f) => relative(root, f).split(sep).join('/')), ['sources/private/mine.txt'])
  writeFileSync(join(proj, 'notes', 'fills.json'), '{}')
  linkSync(join(proj, 'notes', 'fills.json'), join(proj, O.FILLS_FILE))
  assert.equal(await O.fillsPath(root), null)
  rmSync(join(proj, O.FILLS_FILE))
  writeFileSync(join(proj, O.FILLS_FILE), '{}')
  assert.equal(await O.fillsPath(root), join(root, ...O.FILLS_FILE.split('/')))
  // capture: a file whose real path is not the path it was named by is never collected
  assert.equal(T.throughLink(join(root, 'notes', 'copy.html'), root, 'sources/copy.html'), true)
  assert.equal(T.throughLink(join(root, 'notes', 'plan.md'), root, 'notes/plan.md'), false)
})

test('a fills file marks held-back wording, so a synced copy with an unreadable protocol.json stays released', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'fills-signal-'))
  writeFileSync(join(proj, 'protocol.json'), '{not json')
  const cache = mkdtempSync(join(tmpdir(), 'fills-signal-cache-'))
  assert.equal(await O.releasedStudy(cache, proj), false, 'no fills file: an ordinary project')
  mkdirSync(join(proj, 'sources', 'private'), { recursive: true })
  writeFileSync(join(proj, O.FILLS_FILE), '{}')
  assert.equal(await O.releasedStudy(mkdtempSync(join(tmpdir(), 'fills-signal-c2-')), proj), true)
  // only a regular file through real folders counts
  const linked = mkdtempSync(join(tmpdir(), 'fills-signal-linked-'))
  writeFileSync(join(linked, 'protocol.json'), '{not json')
  mkdirSync(join(linked, 'elsewhere', 'private'), { recursive: true })
  writeFileSync(join(linked, 'elsewhere', 'private', 'original-text-fills.json'), '{}')
  symlinkSync(join(linked, 'elsewhere'), join(linked, 'sources'))
  assert.equal(await O.releasedStudy(mkdtempSync(join(tmpdir(), 'fills-signal-c3-')), linked), false)
})

test('a name with a line break or a line separator is still matched by the keep-back rule', () => {
  for (const rel of ['sources/a b.txt', 'sources/a\nb.txt', 'sources/a b.txt', 'notes/scan .pdf', 'notes/x\r.png'])
    assert.equal(T.canCarryRestored(rel), true, JSON.stringify(rel))
  assert.equal(T.mayCollectFile({ rel: 'sources/a b.txt', text: 'short', bytes: Buffer.from('short'), published: true, index: T.EMPTY_INDEX }), false)
  assert.equal(T.canCarryRestored('notes/plan .md'), false)
})

test('capture of program.json follows the same rules as every other file', async () => {
  const root = resolve('/p'), prog = join(root, 'program.json')
  assert.equal(T.mayCaptureProgram({ actual: prog, root, published: true, head: Buffer.from('{"source":') }), true)
  assert.equal(T.mayCaptureProgram({ actual: join(root, 'notes', 'real.json'), root, published: false, head: Buffer.from('{}') }), false, 'reached through a link')
  assert.equal(T.mayCaptureProgram({ actual: prog, root, published: true, head: Buffer.from('%PDF-1.7') }), false, 'a released study: bytes that can carry restored wording')
  assert.equal(T.mayCaptureProgram({ actual: prog, root, published: false, head: Buffer.from('%PDF-1.7') }), true, 'an ordinary project as before')
})

test('engine checks: a value added beside a released text is a local text (the engine renders value first)', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  const cite = { label: 'verbatim', source: 'booklet', page: 1, read: 'image' }
  p.stages.intro.content.push({ id: 'scan', text: 'Walk at your own pace.', cite })
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
  const received = structuredClone(p)
  R.configureReceivedProtocol(async () => received)
  try {
    assert.deepEqual((await R.protocolReadiness(python, ENGINE, proj, '')).filter((x) => /changed on this computer/.test(x.reason)), [])
    p.stages.intro.content.at(-1).value = 'Run as fast as you can.'
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    const problems = await R.protocolReadiness(python, ENGINE, proj, '')
    assert.ok(problems.some((x) => /read from a page image of the paper were changed on this computer/.test(x.reason)), JSON.stringify(problems))
    // value and text swapped: the same two strings, but the wording shown changes
    const both = structuredClone(received)
    both.stages.intro.content.at(-1).value = 'Walk slowly.'
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(both, null, 1))
    R.configureReceivedProtocol(async () => structuredClone(both))
    assert.deepEqual((await R.protocolReadiness(python, ENGINE, proj, '')).filter((x) => /changed on this computer/.test(x.reason)), [])
    const swapped = structuredClone(both)
    Object.assign(swapped.stages.intro.content.at(-1), { value: 'Walk at your own pace.', text: 'Walk slowly.' })
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(swapped, null, 1))
    assert.ok((await R.protocolReadiness(python, ENGINE, proj, '')).some((x) => /changed on this computer/.test(x.reason)))
    // the same swap with separately cited inline objects nested in value and text
    const c2 = { label: 'verbatim', source: 'paper', page: 3 }
    const nested = structuredClone(received)
    nested.stages.intro.content.push({ id: 'pair', value: { text: 'Shown wording.', cite: c2 }, text: { text: 'Hidden wording.', cite: c2 } })
    R.configureReceivedProtocol(async () => structuredClone(nested))
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(nested, null, 1))
    assert.deepEqual((await R.protocolReadiness(python, ENGINE, proj, '')).filter((x) => /changed on this computer/.test(x.reason)), [])
    const nestedSwap = structuredClone(nested)
    Object.assign(nestedSwap.stages.intro.content.at(-1), { value: { text: 'Hidden wording.', cite: c2 }, text: { text: 'Shown wording.', cite: c2 } })
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(nestedSwap, null, 1))
    assert.ok((await R.protocolReadiness(python, ENGINE, proj, '')).some((x) => /changed on this computer/.test(x.reason)))
  } finally { R.configureReceivedProtocol(async () => null) }
})

test('held source texts: placeholders before, the restored texts after; a project sourcetext file wins', async () => {
  const { proj, close } = await publishedProject()
  close()
  const before = await R.heldSourceTexts(proj)
  assert.deepEqual([...before.keys()].sort(), ['booklet', 'handout', 'leaflet'])
  assert.match(before.get('booklet'), /^\u2591{43}$/)
  const restored = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  restored.stages.intro.content[0].value = HANDOUT_TEXT
  assert.equal((await R.heldSourceTexts(proj, restored)).get('handout'), HANDOUT_TEXT)
  mkdirSync(join(proj, 'sourcetext'))
  writeFileSync(join(proj, 'sourcetext/handout.txt'), 'own')
  assert.ok(!(await R.heldSourceTexts(proj)).has('handout'))
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

test('problems: approximate and supplied wording unblock; what is still unresolved blocks and says how to proceed', () => {
  const sources = [
    { key: 'handout', title: 'Morning Walk Survey handout', tier: 'link', format: 'text', items: 1, restored: 1, screens: 0, file: null },
    { key: 'leaflet', title: 'Water leaflet', tier: 'user', format: 'pdf', items: 1, restored: 1, screens: 0, file: null, approx: 1 },
    { key: 'booklet', title: 'Walking booklet', tier: 'user', format: 'html', items: 2, restored: 2, screens: 0, file: null, user: 1, reconstructed: 1 },
  ]
  // every item restored (one approximately, two from the fills file): the helper says complete, nothing blocks
  assert.deepEqual(O.originalTextProblems({ projection: true, complete: true, approx: 1, supplied: { user: 1, reconstructed: 1 }, sources }), [])
  // one still unresolved: it blocks, and the reason tells the assistant how to proceed
  const open = O.originalTextProblems({ projection: true, complete: false, sources: [...sources.slice(0, 2),
    { ...sources[2], restored: 1, reconstructed: 0, screens: 1, need: 'reading' }] })
  assert.equal(open.length, 1)
  assert.equal(open[0].text.need, 'reading')
  assert.match(open[0].reason, /paste it into the chat/)
  assert.match(open[0].reason, /reconstruct it with your agreement, labelled as reconstructed/)
  // a held picture: a screenshot or scan of it, put in place by the assistant
  const pic = O.originalTextProblems({ projection: true, complete: false, sources: [{ ...sources[2], restored: 1, screens: 1, need: 'picture' }] })
  assert.match(pic[0].reason, /drop in a screenshot or scan of each picture/)
  assert.match(pic[0].reason, /labelled as supplied by you/)
  // a changed held list: no fill can help, so no such hint
  const changed = O.originalTextProblems({ projection: true, complete: false, sources: [{ ...sources[2], restored: 1, screens: 1, need: 'held-changed' }] })
  assert.doesNotMatch(changed[0].reason, /screenshot|assistant/)
})

test('the fills file is passed to the helper, never tried as a source copy, and its labels reach the run', async () => {
  const { proj, close } = await publishedProject({ 'sources/private/booklet.html': 'booklet.html' })
  close()
  writeFileSync(join(proj, 'sources/private/original-text-fills.json'), JSON.stringify({ h4: { text: 'x', origin: 'user' } }))
  const root = realpathSync.native(proj)
  assert.deepEqual((await O.candidateFiles(proj)).map((f) => relative(root, f).split(sep).join('/')), ['sources/private/booklet.html'])
  assert.equal(O.FILLS_FILE, 'sources/private/original-text-fills.json')
  // the run gets restored/labels.json (ids and labels only) beside the copy when some items are not exact
  const cache = mkdtempSync(join(tmpdir(), 'text-cache-'))
  const version = sha(readFileSync(join(proj, 'protocol.json')))
  const restored = '{"id": "fixture-walk"}\n'
  const slot = await O.restoreSlot(proj, version)
  mkdirSync(join(cache, slot))
  writeFileSync(join(cache, slot, 'protocol.json'), restored)
  writeFileSync(join(cache, slot, 'status.json'), JSON.stringify({ complete: true, projectionSha256: version, restoredSha256: sha(restored),
    labels: { h2: 'approx', h4: 'user', h3: 'reconstructed', bad: 'approx', h1: 'exact' } }))
  const files = await O.restoredRunFiles(proj, cache, version)
  assert.deepEqual(files.map(([n]) => n), ['restored/protocol.json', 'restored/labels.json'])
  assert.deepEqual(JSON.parse(files[1][1]), { labels: { h2: 'approx', h4: 'user', h3: 'reconstructed' } })
})

test('end to end: approximate and supplied wording make a published study runnable, labelled, without text in the status', { skip: !python || !hasPdfium }, async () => {
  const { proj, close } = await publishedProject({ 'sources/private/leaflet.pdf': 'leaflet.pdf' })
  try {
    // h2 as a release whose wording the build team corrected (no exact match), with a fingerprint of the passage
    const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
    const fp = spawnSync(python, ['-c', `import sys, json; sys.path.insert(0, sys.argv[1]); import hs_approx_text as A
print(json.dumps(A.fingerprint("Remember to drink a glass of water first.", [2], salt="ab12")))`, join(pack, 'runtime/lib')], { encoding: 'utf8' })
    p.distribution.held.h2.text_sha256 = '0'.repeat(64)
    p.distribution.held.h2.approx = JSON.parse(fp.stdout)
    writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p, null, 1))
    const cache = mkdtempSync(join(tmpdir(), 'text-cache-'))
    // the booklet (h3, h4) is not on this computer: blocked, and both items are listed for the assistant
    let status = await O.fillOriginalText(python, FILES, proj, cache, '', { allowLocal: true })
    assert.equal(status.complete, false)
    assert.equal(status.approx, 1)
    assert.deepEqual(status.unresolved.map((u) => [u.held, u.source, u.need]), [['h3', 'booklet', 'file'], ['h4', 'booklet', 'file']])
    assert.equal(O.originalTextProblems(status).length, 1)
    await O.writeAgentStatus(proj, status)
    let shown = JSON.parse(readFileSync(join(proj, '.humanstudy/original-text.json'), 'utf8'))
    assert.equal(shown.fillsFile, 'sources/private/original-text-fills.json')
    assert.deepEqual(shown.unresolved.map((u) => u.held), ['h3', 'h4'])
    // the assistant writes what the researcher pasted and a reconstruction they agreed to
    const pasted = 'How many minutes did you walk this morning?'
    const rebuilt = 'Did you meet anyone you know along the way?'
    writeFileSync(join(proj, 'sources/private/original-text-fills.json'), JSON.stringify({
      h3: { text: pasted, origin: 'user' }, h4: { text: rebuilt, origin: 'reconstructed', note: 'not printed in the paper' } }))
    status = await O.fillOriginalText(python, FILES, proj, cache, '', { allowLocal: true })
    assert.equal(status.complete, true, JSON.stringify(status))
    assert.deepEqual([status.exact, status.approx, status.supplied], [2, 1, { user: 0, reconstructed: 1 }])   // h3 pasted exactly
    assert.deepEqual(O.originalTextProblems(status), [])
    await O.writeAgentStatus(proj, status)
    const raw = readFileSync(join(proj, '.humanstudy/original-text.json'), 'utf8')
    for (const t of ['Remember to drink', 'walk this morning', 'meet anyone', 'Thank you']) assert.ok(!raw.includes(t), t)
    shown = JSON.parse(raw)
    assert.deepEqual([shown.complete, shown.approx, shown.supplied, shown.labels], [true, 1, { user: 0, reconstructed: 1 }, { h2: 'approx', h4: 'reconstructed' }])
    const files = await O.restoredRunFiles(proj, cache, sha(readFileSync(join(proj, 'protocol.json'))))
    const copy = JSON.parse(files[0][1])
    assert.equal(copy.stages.intro.content[1].value, 'Remember to drink a glass of water first.')
    assert.equal(copy.stages.q.responses[1].prompt, rebuilt)
    assert.deepEqual(JSON.parse(files[1][1]).labels, { h2: 'approx', h4: 'reconstructed' })
  } finally { close() }
})

test('candidate files: sources/private first, then paper.pdf and the rest of sources/; nothing outside the project', async () => {
  const { proj, close } = await publishedProject({ 'sources/private/booklet.html': 'booklet.html', 'paper.pdf': 'leaflet.pdf', 'sources/open/handout.txt': 'handout.txt' })
  close()
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'not the project')
  // a link that leads out of the project (Windows may refuse to create one without the privilege: then nothing to test)
  try { symlinkSync(join(outside, 'secret.txt'), join(proj, 'sources/linked.txt')) } catch { /* no symlink privilege */ }
  writeFileSync(join(proj, 'sources/SOURCE.json'), '{}')
  const root = realpathSync.native(proj)   // the form fs/promises realpath gives (not the JS one: Windows short names)
  const files = (await O.candidateFiles(proj)).map((f) => relative(root, f).split(sep).join('/'))
  assert.deepEqual(files, ['sources/private/booklet.html', 'paper.pdf', 'sources/open/handout.txt'])
})

test('the run gets the restored copy only for exactly the approved version, and a published study without one is refused', async () => {
  const { proj, close } = await publishedProject()
  close()
  const cache = mkdtempSync(join(tmpdir(), 'text-cache-'))
  const version = sha(readFileSync(join(proj, 'protocol.json')))
  await assert.rejects(O.restoredRunFiles(proj, cache, version), /original wording has not been filled in.*\[text not available\]/)
  const restored = '{"id": "fixture-walk"}\n'
  const slot = await O.restoreSlot(proj, version)
  mkdirSync(join(cache, slot))
  writeFileSync(join(cache, slot, 'protocol.json'), restored)
  writeFileSync(join(cache, slot, 'status.json'), JSON.stringify({ complete: true, projectionSha256: version, restoredSha256: sha(restored) }))
  assert.deepEqual(await O.restoredRunFiles(proj, cache, version), [['restored/protocol.json', restored]])
  // another project with the same published protocol.json never runs from this project's copy (fills are per project)
  const { proj: other, close: close2 } = await publishedProject()
  close2()
  assert.notEqual(await O.restoreSlot(other, version), slot)
  await assert.rejects(O.restoredRunFiles(other, cache, version), /original wording has not been filled in/)
  writeFileSync(join(cache, slot, 'protocol.json'), restored.replace('walk', 'run'))   // changed after it was written
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
    // the helper indexed the private copies, the download and the restored wording for research capture (hashes
    // only): the app's capture recognises a quote of any of them
    const index = T.mergePrivateIndex(readdirSync(join(cache, 'redact')).filter((f) => f.endsWith('.bin')).map((f) => readFileSync(join(cache, 'redact', f))))
    assert.ok(index.size > 0)
    for (const f of readdirSync(join(cache, 'redact')).filter((f) => f.endsWith('.bin'))) assert.ok(!readFileSync(join(cache, 'redact', f)).includes('walk'), 'hashes only')
    assert.equal(T.containsPrivateRun('the booklet asks: how many MINUTES did you walk this morning, did you see a neighbour', index), true)
    assert.equal(T.containsPrivateRun('Thank you for joining this short study about walking before breakfast.', index), true)
    assert.equal(T.containsPrivateRun('A summary in my own words about a study of morning walks and breakfast habits.', index), false)
  } finally { close() }
})

test('end to end, nothing dropped: the link source fills its screen, the others say what they need', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  try {
    const cache = mkdtempSync(join(tmpdir(), 'text-cache-'))
    const status = await O.fillOriginalText(python, FILES, proj, cache, '', { allowLocal: true })
    assert.equal(status.complete, false)
    const needs = Object.fromEntries(status.sources.map((s) => [s.key, s.need ?? 'ok']))
    assert.equal(needs.booklet, 'file'); assert.equal(needs.handout, 'ok')
    assert.ok(['file', 'pdf-reader', 'app-version'].includes(needs.leaflet))
    assert.equal(status.restoredPath, null)
    assert.equal(existsSync(join(cache, status.projectionSha256, 'protocol.json')), false)
  } finally { close() }
})

test('the held list is pinned when the study is first seen: an edited or removed list blocks the run', async () => {
  const { proj, close } = await publishedProject()
  close()
  const cache = mkdtempSync(join(tmpdir(), 'text-cache-'))
  assert.equal(await O.heldPinProblem(cache, proj), null, 'first sight pins it')
  assert.equal(await O.heldPinProblem(cache, proj), null, 'unchanged')
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  const edited = structuredClone(p)
  edited.distribution.held.h3.text_sha256 = 'f'.repeat(64)   // another span of the real source under a new hash
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(edited))
  const changed = await O.heldPinProblem(cache, proj)
  assert.equal(changed?.text?.need, 'held-changed')
  assert.doesNotMatch(changed.reason, /hash|sha|projection|placeholder|rehydrat/i)
  delete edited.distribution   // removed: the placeholders would show
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(edited))
  assert.equal((await O.heldPinProblem(cache, proj))?.text?.need, 'held-changed')
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p))
  assert.equal(await O.heldPinProblem(cache, proj), null, 'the pinned version is fine again')
  // an import path that writes a new published version accepts it explicitly
  const update = structuredClone(p)
  update.distribution.held.h3.text_sha256 = 'e'.repeat(64)
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(update))
  assert.equal((await O.heldPinProblem(cache, proj))?.text?.need, 'held-changed')
  await O.repinHeld(cache, proj)
  assert.equal(await O.heldPinProblem(cache, proj), null)
  assert.match(O.restoredChecksProblem('T').reason, /put back the versions you received/)
  assert.doesNotMatch(O.restoredChecksProblem('T').reason, /verbatim|fuzz|keyed|refs|leaks/)
  // never pinned: an ordinary protocol is fine; one that still holds placeholder runs is not
  const plain = mkdtempSync(join(tmpdir(), 'plain-'))
  writeFileSync(join(plain, 'protocol.json'), JSON.stringify({ id: 'x', stages: { a: { content: [{ id: 't', value: 'Hello' }] } } }))
  assert.equal(await O.heldPinProblem(cache, plain), null)
  writeFileSync(join(plain, 'protocol.json'), JSON.stringify({ id: 'x', stages: { a: { content: [{ id: 't', value: '░'.repeat(12) }] } } }))
  assert.equal((await O.heldPinProblem(cache, plain))?.text?.need, 'held-changed')
})

test('the engine checks run on the restored copy in app storage; their findings never quote it', { skip: !python }, async () => {
  const { proj, close } = await publishedProject()
  close()
  const restored = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  delete restored.distribution
  restored.stages.intro.content[0].value = HANDOUT_TEXT
  restored.stages.intro.content[1].value = 'Remember to drink a glass of water first.'
  restored.stages.q.responses[0].prompt = 'How many minutes did you walk this morning?'
  restored.stages.q.responses[1].prompt = 'Did you see a neighbour on the way?'
  const work = mkdtempSync(join(tmpdir(), 'text-cache-'))
  assert.deepEqual(await R.restoredReadiness(python, ENGINE, proj, JSON.stringify(restored), work, ''), [])
  // a restored text that shows an unresolved expression is a leak the placeholders hid
  const leaky = structuredClone(restored)
  leaky.stages.q.responses[0].prompt = "How many minutes {answer('q.pick')} did you walk this morning?"
  const found = await R.restoredReadiness(python, ENGINE, proj, JSON.stringify(leaky), work, '')
  assert.ok(found.length > 0)
  for (const f of found) assert.ok(!f.reason.includes('walk this morning'), f.reason)
  assert.deepEqual(readdirSync(work), [], 'the scratch copy is removed')
})

test('a drop into a published study tells the agent, in the prompt only, not to open the file', () => {
  const odd = 'sources/private/Walk, booklet [v2].pdf'
  const text = `[Attached: ${odd}, notes.txt]\nHere is my copy`
  assert.deepEqual(W.privateAttachments(text, [odd, 'sources/private/other.pdf']), [odd], 'commas and ] in a name')
  assert.deepEqual(W.privateAttachments('[Attached: sources/private/a.pdf.bak]', ['sources/private/a.pdf']), [], 'exact tokens only')
  const prompt = W.withPrivateCopyNote('PROMPT', text, [odd])
  assert.ok(prompt.startsWith('PROMPT'))
  assert.match(prompt, /Walk, booklet \[v2\]\.pdf was received to fill in the study's original wording.*Do not open, read, extract or move this file/)
  assert.equal(W.withPrivateCopyNote('P', '[Attached: sources/open/a.pdf]\nhi', [odd]), 'P')
  assert.equal(W.withWorkspaceContext(text), text, 'the researcher\'s message itself is unchanged')
  assert.match(readFileSync(join(here, 'index.ts'), 'utf8'), /withPrivateCopyNote\(threads\(\)\.beforeSend\(id, text, workspace\), text,/)
  const chat = readFileSync(join(here, '../renderer/components/Chat.tsx'), 'utf8')
  assert.doesNotMatch(chat, /Do not open/, 'the chat bubble carries no agent instruction')
})

test('the redaction index leaves out what the project shows publicly, and is written before any download', { skip: !python }, async () => {
  const { proj, close } = await publishedProject({ 'sources/private/booklet.html': 'booklet.html' })
  close()
  // a private copy with two long sentences; the study as received shows the first (public); the project's own
  // effects.json quoting the second does not make it public (written on this computer)
  const A = 'The first invented sentence of this private copy is long enough to count as a quote.'
  const B = 'The second invented sentence of this private copy stays private and must be recognised.'
  writeFileSync(join(proj, 'sources/private/notes.txt'), A + '\n' + B + '\n')
  writeFileSync(join(proj, 'effects.json'), JSON.stringify({ effects: [{ id: 'e', quote: B }] }))
  const p = JSON.parse(readFileSync(join(proj, 'protocol.json'), 'utf8'))
  p.meta.note_shown = A
  writeFileSync(join(proj, 'protocol.json'), JSON.stringify(p))
  const cache = mkdtempSync(join(tmpdir(), 'text-cache-'))
  assert.equal(await O.heldPinProblem(cache, proj), null, 'first sight: pinned, and the received copy kept')
  await O.indexPrivateCopies(python, FILES, proj, cache, '')
  assert.ok(!existsSync(join(cache, 'downloads')), 'index-only: nothing downloaded')
  const index = T.mergePrivateIndex(readdirSync(join(cache, 'redact')).filter((f) => f.endsWith('.bin')).map((f) => readFileSync(join(cache, 'redact', f))))
  assert.equal(T.containsPrivateRun('the notes say: ' + B, index), true)
  assert.equal(T.containsPrivateRun('the received protocol shows: ' + A, index), false, 'public: the study as received ships it')
  assert.equal(T.containsPrivateRun('How many minutes did you walk this morning? Did you see a neighbour on the way?', index), true, 'the dropped booklet')
  // the file's windows are kept by its sha256: a second index does not extract it again
  const windows = readdirSync(join(cache, 'windows'))
  assert.ok(windows.length >= 1)
  const before = windows.map((f) => statSync(join(cache, 'windows', f)).mtimeMs)
  await O.indexPrivateCopies(python, FILES, proj, cache, '')
  assert.deepEqual(readdirSync(join(cache, 'windows')).map((f) => statSync(join(cache, 'windows', f)).mtimeMs), before)
})

test('the merged index matches a sorted build, and a stale project index is pruned', async () => {
  const a = T.privateIndexOf(['First invented private sentence long enough to make several windows here.'])
  const b = T.privateIndexOf(['Second invented private sentence long enough to make several windows too.'])
  void a; void b
  // build two sorted helper-style files and merge them
  const toBin = (texts) => { const idx = []; for (const t of texts) { const cps = T.skeleton(t); for (let i = 0; i + T.PRIVATE_RUN <= cps.length; i++) idx.push(T.windowPair(cps, i)) }
    idx.sort((x, y) => x[0] - y[0] || x[1] - y[1]); const buf = Buffer.alloc(idx.length * 8); idx.forEach(([x, y], i) => { buf.writeUInt32BE(x, i * 8); buf.writeUInt32BE(y, i * 8 + 4) }); return buf }
  const t1 = 'First invented private sentence long enough to make several windows here.'
  const t2 = 'Second invented private sentence long enough to make several windows too.'
  const merged = T.mergePrivateIndex([toBin([t1]), toBin([t2]), toBin([t1])])
  assert.equal(T.containsPrivateRun(t1, merged), true)
  assert.equal(T.containsPrivateRun(t2, merged), true)
  assert.equal(T.containsPrivateRun('An unrelated public sentence that is also long enough to check.', merged), false)
  assert.equal(merged.size, T.privateIndexOf([t1, t2]).size, 'duplicates dropped')
  const src = readFileSync(join(here, 'telemetry.ts'), 'utf8')
  assert.match(src, /privateIndex = await loadPrivateIndexDir\(dir\)/, 'the app loads the index through the tested loader')
})

test('index format upgrade: v1 files are dropped and the project is indexed again in v2; stale folders pruned', { skip: !python }, async () => {
  const { proj, close } = await publishedProject({ 'sources/private/booklet.html': 'booklet.html' })
  close()
  const cache = mkdtempSync(join(tmpdir(), 'text-cache-'))
  const redact = join(cache, 'redact'), windows = join(cache, 'windows')
  mkdirSync(redact, { recursive: true }); mkdirSync(windows, { recursive: true })
  // what a v1 build left behind: an index and a cached file without the version suffix
  writeFileSync(join(redact, 'a'.repeat(64) + '.bin'), Buffer.alloc(16, 7))
  writeFileSync(join(windows, 'b'.repeat(64) + '.bin'), Buffer.alloc(16, 7))
  // and the index of a project folder that is gone
  writeFileSync(join(redact, 'c'.repeat(64) + `.v${T.INDEX_FORMAT}.bin`), Buffer.alloc(8, 1))
  writeFileSync(join(redact, 'c'.repeat(64) + '.path'), join(tmpdir(), 'no-such-project-folder-xyz'))
  let index = await PI.loadPrivateIndexDir(redact)
  assert.equal(index.size, 0)
  assert.deepEqual(readdirSync(redact), [], 'the v1 index and the stale project are gone')
  await O.indexPrivateCopies(python, FILES, proj, cache, '')
  assert.ok(!readdirSync(windows).some((f) => !f.endsWith(`.v${T.INDEX_FORMAT}.bin`)), 'old cached windows pruned')
  index = await PI.loadPrivateIndexDir(redact)
  assert.ok(readdirSync(redact).some((f) => f.endsWith(`.v${T.INDEX_FORMAT}.bin`)))
  assert.equal(T.containsPrivateRun('How many minutes did you walk this morning? Did you see a neighbour on the way?', index), true)
})


test('concurrent community imports keep both received originals and both held-list pins',async()=>{
 const cache=mkdtempSync(join(tmpdir(),'pin-concurrent-'))
 const dirs=[0,1].map(i=>{const dir=mkdtempSync(join(tmpdir(),'published-'+i+'-'));writeFileSync(join(dir,'protocol.json'),JSON.stringify({meta:{title:'Fixture '+i},distribution:{held:{['h'+i]:{text_sha256:String(i).repeat(64)}}}}));return dir})
 await Promise.all(dirs.map(dir=>O.repinHeld(cache,dir)))
 const pins=JSON.parse(readFileSync(join(cache,'pins.json'),'utf8'))
 assert.equal(Object.keys(pins).length,2)
 // Use the same asynchronous canonicalization as production: Windows' sync JS
 // fallback can preserve a different drive-letter case than libuv's realpath.
 for(const dir of dirs){const root=await realpath(dir);assert.ok(pins[root]);assert.equal(await O.heldPinProblem(cache,dir),null);assert.equal(readFileSync(O.receivedPath(cache,root),'utf8'),readFileSync(join(dir,'protocol.json'),'utf8'))}
})
