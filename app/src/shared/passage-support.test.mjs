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
const { pdfAnnotationPath, resolveSource, sourceTarget } = await import(pathToFileURL(join(out, 'source-target.mjs')).href)

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

test('Windows paths compare without case or separator differences; unresolved evidence never matches a displayed source', () => {
  const upper = (p) => p.replace('/p/sources/document-a.pdf', 'C:\\P\\Sources\\Document-A.pdf')
  const winResolve = (ref) => { const p = resolve(ref); return p && upper(p) }
  assert.deepEqual(passageSupport(program, { ...selection, source: 'c:/p/sources/document-a.pdf' }, winResolve).same, ['source-a-only', 'both'])
  const r = passageSupport(program, { ...selection, source: a.path }, (ref) => (ref.file || ref.sourceId ? resolve(ref) : null))
  assert.ok(!r.same.includes('paper-only'), 'unresolved evidence must not support the displayed file')
})

test('a named attachment stays missing, and only a unique matching digest restores a renamed file', () => {
  const digest = 'a'.repeat(64)
  const old = 'sources/old-name.pdf'
  const reference = { file: old, sourceSha256: digest }
  assert.equal(sourceTarget(project, { file: old, sourceId: 'paper' }), null)
  const renamed = { ...a, sha256: digest }
  const changed = { ...file(old), sha256: 'b'.repeat(64) }
  assert.deepEqual(resolveSource({ ...project, tree: [renamed] }, reference), { file: renamed, pending: false, changed: false })
  assert.deepEqual(resolveSource({ ...project, tree: [changed] }, reference), { file: changed, pending: true, changed: true })
  assert.equal(resolveSource({ ...project, tree: [renamed, { ...b, sha256: digest }] }, reference).file, null)
  const legacy = resolveSource({ ...project, tree: [renamed], sourceDigests: { [old]: digest } }, { file: old })
  assert.deepEqual(legacy, { file: renamed, pending: true, changed: false })
})

test('a renamed PDF can retain its uniquely identified notes sidecar', () => {
  const digest = 'a'.repeat(64)
  const renamed = { ...a, sha256: digest }
  const sidecar = file('sources/old.pdf.annotations.json')
  const snap = { ...project, tree: [renamed, sidecar], sourceDigests: { 'sources/old.pdf': digest } }
  assert.equal(pdfAnnotationPath(snap, renamed), sidecar.path)
  assert.equal(pdfAnnotationPath({ ...snap, tree: [renamed, sidecar, { ...b, sha256: digest }] }, renamed), renamed.path + '.annotations.json')
  assert.equal(pdfAnnotationPath(snap, { ...renamed, sha256: 'b'.repeat(64) }), renamed.path + '.annotations.json')
})
