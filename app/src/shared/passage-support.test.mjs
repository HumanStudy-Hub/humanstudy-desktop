// A sentence shared by two source documents: the lookup knows which file the selection came from.
// node src/shared/passage-support.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'passage-support-'))
process.on('exit', () => rmSync(out, { recursive: true, force: true }))
await build({ entryPoints: [join(here, 'program-view.ts'), join(here, 'source-target.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error', outExtension: { '.js': '.mjs' } })
const { passageSupport, supportedBy } = await import(pathToFileURL(join(out, 'program-view.mjs')).href)
const { sourceTarget } = await import(pathToFileURL(join(out, 'source-target.mjs')).href)

const shared = 'Participants were told that the wheel had been spun before the estimate was made.'
const program = {
  evidence: [
    { id: 'ea', path: 'sources/document-a.pdf', locator: { page: 1 }, quote: shared, verification: 'unverified' },
    { id: 'eb', path: 'sources/document-b.pdf', locator: { page: 1 }, quote: shared, verification: 'unverified' },
    { id: 'ep', locator: { page: 1 }, quote: shared, verification: 'unverified' },
  ],
  steps: [],
  nodes: [
    { id: 'source-a-only', title: 'SOURCE A ONLY', evidenceIds: ['ea'], fields: [] },
    { id: 'source-b-only', title: 'SOURCE B ONLY', evidenceIds: ['eb'], fields: [] },
    { id: 'paper-only', title: 'PAPER', evidenceIds: ['ep'], fields: [] },
    { id: 'both', title: 'BOTH', evidenceIds: [], fields: [{ id: 'f', evidenceIds: ['eb', 'ea'] }] },
  ],
}
const file = (rel) => ({ name: rel.split('/').pop(), path: `/p/${rel}`, rel, kind: 'file', ext: 'pdf', url: `hsfile://local/${rel}` })
const a = file('sources/document-a.pdf'), b = file('sources/document-b.pdf'), paper = file('paper.pdf')
const project = { dir: '/p', program: null, pdf: { name: 'paper.pdf', path: '/p/paper.pdf', url: 'hsfile://local/paper.pdf', ext: 'pdf' }, tree: [paper, { name: 'sources', path: '/p/sources', rel: 'sources', kind: 'dir', ext: '', children: [a, b] }] }
const resolve = (ref) => sourceTarget(project, ref)?.path ?? null
const selection = { page: 1, text: 'told that the wheel had been spun before the estimate' }

test('selecting the shared sentence in A lists A first and labels B as another source', () => {
  const r = passageSupport(program, { ...selection, source: a.path }, resolve)
  assert.deepEqual(r.same, ['source-a-only', 'both'])
  assert.deepEqual(r.other.map((o) => o.id), ['source-b-only', 'paper-only'])
  assert.equal(r.other.find((o) => o.id === 'source-b-only').file, 'sources/document-b.pdf')
  assert.ok(!r.same.includes('source-b-only'), 'a B-only passage must never count as support for A')
})

test('selecting it in B, or in the paper, swaps the groups', () => {
  assert.deepEqual(passageSupport(program, { ...selection, source: b.path }, resolve).same, ['source-b-only', 'both'])
  const inPaper = passageSupport(program, { ...selection, source: '/p/paper.pdf' }, resolve)
  assert.deepEqual(inPaper.same, ['paper-only'], 'evidence without a path cites paper.pdf')
  assert.deepEqual(inPaper.other.map((o) => o.id).sort(), ['both', 'source-a-only', 'source-b-only'])
})

test('a different page or too short a run is no support at all; old callers keep their behaviour', () => {
  assert.deepEqual(passageSupport(program, { ...selection, page: 2, source: a.path }, resolve), { same: [], other: [] })
  assert.deepEqual(passageSupport(program, { page: 1, text: 'the wheel', source: a.path }, resolve), { same: [], other: [] })
  assert.equal(supportedBy(program, selection).length, 4)
})
