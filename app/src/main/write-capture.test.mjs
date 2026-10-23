// Integration of #31's locked atomic program save with #28's program/artifact version capture:
//   node src/main/write-capture.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'write-capture-tests-'))
for (const name of ['write-capture', 'program-save']) await build({ entryPoints: [join(here, `${name}.ts`)], bundle: true, platform: 'node', format: 'esm', outfile: join(out, `${name}.mjs`), logLevel: 'error' })
const { createSerial, createWriteAttribution, isSaveTemp, HUMAN_WINDOW_MS } = await import(pathToFileURL(join(out, 'write-capture.mjs')))
const { saveProjectText } = await import(pathToFileURL(join(out, 'program-save.mjs')))
const python = ['python3', 'python'].find(p => spawnSync(p, ['--version']).status === 0)
const helper = join(here, '../../../pack/skills/build/program_io.py')
const fixture = JSON.parse(readFileSync(join(here, 'fixtures/complete-program.json'), 'utf8'))

test('temporary files of both atomic writers are never captured as artifact versions', () => {
  assert.ok(isSaveTemp(`artifacts/table.csv.4242.${'0123456789abcdef'.repeat(2)}.tmp`), 'program_io.py uuid4().hex')
  assert.ok(isSaveTemp('artifacts/notes.md.77.1b4e28ba-2fa1-11d2-883f-0016d3cca427.tmp'), 'app randomUUID()')
  assert.ok(!isSaveTemp('artifacts/notes.tmp'))
  assert.ok(!isSaveTemp('artifacts/run.2026.tmp'))
  assert.ok(!isSaveTemp('program.json'))
})

test('a version the agent writes right after a researcher save is attributed to the agent', () => {
  let clock = 1_000_000
  const who = createWriteAttribution(() => clock)
  who.note('/p/program.json', 'human text')
  assert.equal(who.by('/p/program.json', 'human text'), 'human')
  assert.equal(who.by('/p/program.json', 'merged by agent'), 'agent')
  assert.equal(who.by('/p/other.json', 'human text'), 'agent')
  who.note('/p/artifacts/x.bin') // unknown content (binary): time window only
  assert.equal(who.by('/p/artifacts/x.bin'), 'human')
  clock += HUMAN_WINDOW_MS + 1
  assert.equal(who.by('/p/program.json', 'human text'), 'agent')
})

test('captures for one file run in order and never claim the same version', async () => {
  const serial = createSerial()
  let version = 0
  const seen = []
  const capture = (label, delay) => serial('k', async () => {
    const next = version + 1
    await new Promise(r => setTimeout(r, delay))
    version = next
    seen.push([label, next])
  })
  await Promise.all([capture('slow', 30), capture('fast', 0), serial('k', async () => { throw new Error('one failure') }).catch(() => undefined), capture('after-failure', 0)])
  assert.deepEqual(seen, [['slow', 1], ['fast', 2], ['after-failure', 3]])
})

test('the exact bytes of a locked app save and of the following helper merge are both captured, each by its writer', { skip: !python }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'write-capture-'))
  const target = join(dir, 'program.json')
  writeFileSync(target, JSON.stringify(fixture))
  const who = createWriteAttribution()
  const serial = createSerial()
  const versions = []
  const seenHashes = new Set()
  // Mirrors telemetry.snapshotProgram: explicit capture of written bytes, or a later disk read for helper writes.
  const snapshot = (written) => serial(target, async () => {
    const raw = written ?? readFileSync(target, 'utf8')
    if (seenHashes.has(raw)) return
    seenHashes.add(raw)
    versions.push({ version: versions.length + 1, raw, by: who.by(target, raw) })
  })

  const human = structuredClone(fixture)
  Object.assign(human.nodes[0].fields[0], { value: 'Researcher wording', origin: 'researcher', state: 'confirmed' })
  const humanText = JSON.stringify(human, null, 2)
  await saveProjectText(target, humanText, { ifUnchanged: readFileSync(target, 'utf8'), beforeWrite: async () => who.note(target, humanText) })
  await snapshot(humanText)

  writeFileSync(join(dir, 'batch.json'), JSON.stringify({ nodes: [{ id: 'participants', fields: [{ id: 'sample', value: 'Agent proposal', origin: 'reported', state: 'check' }] }] }))
  const run = spawnSync(python, [helper, 'batch.json'], { cwd: dir, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  await snapshot() // the watcher's debounced read after the helper's atomic replace
  await snapshot(humanText) // a stale duplicate of the researcher's version is not a new version

  assert.equal(versions.length, 2)
  assert.equal(versions[0].raw, humanText, 'the researcher version is the exact text saved')
  assert.equal(versions[0].by, 'human')
  assert.equal(versions[1].raw, readFileSync(target, 'utf8'), 'the agent version is what the helper committed')
  assert.equal(versions[1].by, 'agent')
  assert.equal(JSON.parse(versions[1].raw).nodes[0].fields[0].value, 'Researcher wording', 'helper kept the confirmed field')
  assert.deepEqual(versions.map(v => v.version), [1, 2])
})
