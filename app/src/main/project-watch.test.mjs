// paper.pdf replaced at the same path (A → B) must be noticed: by the folder watcher, and by the
// version stamp the renderer compares on every re-read (focus, tab switch) when an event is missed.
// node src/main/project-watch.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'project-watch-'))
process.on('exit', () => rmSync(out, { recursive: true, force: true }))
await build({ entryPoints: [join(here, 'project-watch.ts'), join(here, '../shared/file-version.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error', outExtension: { '.js': '.mjs' } })
// The same watcher over a fake fs.watch, to drive event bursts and errors deterministically.
await build({ entryPoints: [join(here, 'project-watch.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'fake-watch.mjs'), logLevel: 'error', plugins: [{ name: 'fake-fs', setup(b) {
  b.onResolve({ filter: /^node:fs$/ }, () => ({ path: 'fs', namespace: 'fake' }))
  b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ loader: 'js', contents: `import { EventEmitter } from 'node:events'
    export function watch(dir, opts, cb) { const w = new EventEmitter(); w.closed = false; w.close = () => { w.closed = true }; w.fire = (e, f) => cb(e, f); globalThis.__watchers.push(w); return w }` }))
} }] })
const { watchFolder } = await import(pathToFileURL(join(out, 'main/project-watch.mjs')).href)
const { fileVersion, versionedUrl, replacedOnDisk } = await import(pathToFileURL(join(out, 'shared/file-version.mjs')).href)
globalThis.__watchers = []
const fake = await import(pathToFileURL(join(out, 'fake-watch.mjs')).href)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const pdf = (label, pad = 0) => `%PDF-1.4\n% DOCUMENT ${label}\n${'x'.repeat(pad)}\n%%EOF\n`

test('a rename-replace of paper.pdf is reported once the folder settles, with a new version stamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-replace-'))
  try {
    const paper = join(dir, 'paper.pdf')
    writeFileSync(paper, pdf('A'))
    const before = fileVersion(statSync(paper))
    let settled = 0
    const files = []
    const w = watchFolder(dir, { onFile: (f) => files.push(f), onSettled: () => settled++, debounceMs: 150 })
    await wait(100)
    // An editor's way: write a temporary file, then rename it over the original.
    writeFileSync(join(dir, '.paper.pdf.tmp'), pdf('B'))
    renameSync(join(dir, '.paper.pdf.tmp'), paper)
    for (let i = 0; i < 40 && !settled; i++) await wait(50)
    w.close()
    assert.ok(settled >= 1, 'the replacement was not reported')
    assert.ok(files.some((f) => f.includes('paper.pdf')), JSON.stringify(files))
    assert.notEqual(fileVersion(statSync(paper)), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the version stamp changes even when a copy keeps the same size and modified time (Windows copy)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-stamp-'))
  try {
    const paper = join(dir, 'paper.pdf'), other = join(dir, 'b.pdf')
    writeFileSync(paper, pdf('A'))
    writeFileSync(other, pdf('B'))
    const a = statSync(paper)
    utimesSync(other, a.atime, a.mtime)
    await wait(20)
    copyFileSync(other, paper)
    utimesSync(paper, a.atime, a.mtime)
    const b = statSync(paper)
    assert.equal(b.size, a.size)
    assert.equal(Math.round(b.mtimeMs), Math.round(a.mtimeMs))
    assert.notEqual(fileVersion(b), fileVersion(a), 'same size and mtime must still be a new version')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a burst of events is one notice; a watcher error closes it and reports instead of crashing', async () => {
  let settled = 0, errors = 0
  const w = fake.watchFolder('/p', { onSettled: () => settled++, onError: () => errors++, ignore: (f) => f.startsWith('.humanstudy'), debounceMs: 30 })
  const raw = globalThis.__watchers.at(-1)
  for (const [e, f] of [['rename', 'paper.pdf'], ['rename', '~paper.tmp'], ['change', 'paper.pdf'], ['rename', 'paper.pdf']]) raw.fire(e, f)
  raw.fire('change', '.humanstudy/state.json')
  await wait(80)
  assert.equal(settled, 1)
  raw.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' }))
  assert.equal(errors, 1)
  assert.equal(raw.closed, true)
  raw.fire('change', 'paper.pdf')
  await wait(60)
  assert.equal(settled, 1, 'a closed watcher must not report')
  w.close()
})

test('the viewer reloads a new version of the same file, under a new URL', () => {
  assert.equal(versionedUrl('hsfile://local/%2Fp%2Fpaper.pdf', '10-20-30-40'), 'hsfile://local/%2Fp%2Fpaper.pdf?v=10-20-30-40')
  assert.equal(versionedUrl('hsfile://local/x.pdf'), 'hsfile://local/x.pdf')
  assert.equal(replacedOnDisk({ path: '/p/paper.pdf', version: 'a' }, { path: '/p/paper.pdf', version: 'b' }), true)
  assert.equal(replacedOnDisk({ path: '/p/paper.pdf', version: 'a' }, { path: '/p/paper.pdf', version: 'a' }), false)
  assert.equal(replacedOnDisk({ path: '/p/paper.pdf', version: 'a' }, { path: '/p/other.pdf', version: 'b' }), false, 'another file is not a replacement')
  assert.equal(replacedOnDisk(null, { path: '/p/paper.pdf', version: 'b' }), false)
})
