// Unsaved drafts outlive the editor (issue #17): store, dirty detection, line endings, Windows paths.
// Second half drives the real FileView in Electron: type, switch away, come back, fail a save, retry.
//   node src/renderer/drafts.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'drafts-test-'))
await build({ entryPoints: [join(here, 'drafts.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error', outExtension: { '.js': '.mjs' } })
const D = await import(pathToFileURL(join(out, 'drafts.mjs')).href)

test('a draft is kept by path and dropped once it equals the disk text', () => {
  let changes = 0
  const off = D.onDraftsChange(() => changes++)
  D.setDraft('/p/a/notes.txt', 'typed', 'on disk')
  assert.deepEqual(D.getDraft('/p/a/notes.txt'), { path: '/p/a/notes.txt', text: 'typed', base: 'on disk' })
  D.setDraft('/p/a/notes.txt', 'typed more', 'on disk')
  assert.equal(changes, 1, 'listeners hear when a file gains or loses a draft, not on every key')
  assert.deepEqual(D.draftsIn('/p/a').map((d) => d.path), ['/p/a/notes.txt'])
  assert.deepEqual(D.draftsIn('/p/ab'), [], 'a sibling folder with a common prefix is another project')
  D.setDraft('/p/a/notes.txt', 'on disk', 'on disk')
  assert.equal(D.getDraft('/p/a/notes.txt'), undefined)
  assert.equal(changes, 2)
  D.setDraft('/p/a/x.md', '1', '0')
  D.setDraft('/p/b/y.md', '1', '0')
  D.clearDraftsIn('/p/a')
  assert.equal(D.draftCount(), 1)
  D.clearDraft('/p/b/y.md')
  assert.equal(D.draftCount(), 0)
  off()
})

test('CRLF files are not dirty because the textarea reports LF, and saves keep CRLF', () => {
  const disk = 'line one\r\nline two\r\n'
  assert.equal(D.isDirty('line one\nline two\n', disk), false)
  assert.equal(D.isDirty('line one\nline 2\n', disk), true)
  assert.equal(D.isDirty('anything', null), false, 'nothing loaded yet is not an edit')
  assert.equal(D.toDisk('line one\nline 2\n', disk), 'line one\r\nline 2\r\n')
  assert.equal(D.toDisk('a\nb', 'a\nc'), 'a\nb', 'LF files stay LF')
})

test('Windows paths: one file is one draft whatever the casing or separator', () => {
  D.setDraft('C:\\Users\\Me\\Proj\\review_notes.txt', 'draft', '')
  assert.equal(D.getDraft('c:/users/me/proj/REVIEW_NOTES.txt')?.text, 'draft')
  assert.equal(D.draftsIn('C:\\Users\\me\\proj').length, 1)
  D.clearDraft('c:\\users\\me\\proj\\review_notes.txt')
  assert.equal(D.draftCount(), 0)
  assert.notEqual(D.pathKey('/Users/Me/a'), D.pathKey('/users/me/a'), 'POSIX paths stay case-sensitive')
})

test('FileView: a draft survives switching away and back, a failed save keeps it, the status is truthful', async () => {
  const ui = mkdtempSync(join(tmpdir(), 'drafts-ui-'))
  try {
    await build({
      stdin: {
        resolveDir: here, loader: 'tsx', contents: `
import React, { useState } from 'react'; import { createRoot } from 'react-dom/client'; import { FileView } from './components/FileView';
const disk = { text: 'first line\\r\\nsecond line\\r\\n' };
window.fixture = { disk, writes: [], failNext: false, dirty: {} };
window.humanstudy = { telemetry: { track: async () => {} }, project: {
  readText: async () => disk.text, versions: async () => [], readVersion: async () => '', saveCopy: async () => null, reveal: async () => {},
  writeText: async (p, t) => { if (window.fixture.failNext) { window.fixture.failNext = false; throw new Error('disk is full') } window.fixture.writes.push(t); disk.text = t },
} };
const file = { kind: 'file', name: 'review_notes.txt', path: '/proj/review_notes.txt', rel: 'review_notes.txt', ext: 'txt', url: '' };
function Fixture() { const [view, setView] = useState('file'); window.fixture.show = setView;
  // The Paper pane can hold a second, hidden editor of the same file; it sees every project change.
  const [pane, setPane] = useState(false), [version, setVersion] = useState(0); window.fixture.pane = setPane; window.fixture.bump = () => setVersion((v) => v + 1);
  return <>{view === 'file' ? <FileView file={file} dir="/proj" version={version} onDirty={(p, d) => { window.fixture.dirty[p] = d }} /> : <p id="study">Study</p>}
    {pane && <div id="pane"><FileView file={file} dir="/proj" version={version} onDirty={() => {}} /></div>}</> }
createRoot(document.getElementById('root')).render(<Fixture />);
` },
      bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', outfile: join(ui, 'fixture.js'), define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error', loader: { '.css': 'empty' },
    })
    writeFileSync(join(ui, 'index.html'), '<div id="root"></div><script src="fixture.js"></script>')
    writeFileSync(join(ui, 'runner.cjs'), `
const { app, BrowserWindow } = require('electron'), assert = require('node:assert/strict');
app.setPath('userData', ${JSON.stringify(join(ui, 'userdata'))});
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  const js = (x) => w.webContents.executeJavaScript(x, true), wait = () => new Promise((r) => setTimeout(r, 120));
  const type = (v) => js("(() => { const el = document.querySelector('textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, " + JSON.stringify(v) + "); el.dispatchEvent(new Event('input', { bubbles: true })) })()");
  const button = () => js("[...document.querySelectorAll('.file-bar button')].map((b) => b.textContent).find((t) => /^(Save|Saved|Saving…)$/.test(t)) ?? null");
  try {
    await w.loadFile(${JSON.stringify(join(ui, 'index.html'))}); await wait();
    assert.equal(await button(), 'Saved', 'a CRLF file that was not touched is not dirty');
    await type('first line\\nsecond line\\nmy review note\\n'); await wait();
    assert.equal(await button(), 'Save');
    await js("window.fixture.show('study')"); await wait();
    await js("window.fixture.show('file')"); await wait();
    assert.equal(await js("document.querySelector('textarea').value"), 'first line\\nsecond line\\nmy review note\\n', 'the draft came back');
    assert.equal(await button(), 'Save', 'the status says unsaved, not Saved');
    assert.equal(await js("window.fixture.dirty['/proj/review_notes.txt']"), true);
    await js("window.fixture.failNext = true; document.querySelector('.file-editor').dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }))"); await wait();
    assert.ok(await js("document.querySelector('.file-error')?.textContent.includes('disk is full')"));
    assert.equal(await js("document.querySelector('textarea').value"), 'first line\\nsecond line\\nmy review note\\n', 'a failed save keeps the text');
    assert.equal(await button(), 'Save', 'and lets the researcher retry');
    await js("[...document.querySelectorAll('.file-bar button')].find((b) => b.textContent === 'Save').click()"); await wait();
    assert.deepEqual(await js('window.fixture.writes'), ['first line\\r\\nsecond line\\r\\nmy review note\\r\\n'], 'saved once, with the file’s CRLF line ends');
    assert.equal(await button(), 'Saved');
    assert.equal(await js("window.fixture.dirty['/proj/review_notes.txt']"), false);
    await js("window.fixture.show('study')"); await wait(); await js("window.fixture.show('file')"); await wait();
    assert.equal(await button(), 'Saved', 'no stale draft after the save');
    // A clean second editor of the same file reloads on a disk change; it must not drop the draft
    // typed in the tab.
    await js("window.fixture.pane(true)"); await wait();
    await type('a draft typed in the tab\\n'); await wait();
    await js("window.fixture.disk.text = 'the agent rewrote it'; window.fixture.bump()"); await wait(); await wait();
    await js("window.fixture.show('study')"); await wait(); await js("window.fixture.show('file')"); await wait();
    assert.equal(await js("document.querySelector('textarea').value"), 'a draft typed in the tab\\n', 'the clean copy dropped the draft');
    console.log('draft UI ok');
  } catch (e) { console.error(e); process.exitCode = 1 } finally { w.destroy(); app.exit(process.exitCode || 0) }
});
`)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const bin = process.platform === 'darwin' ? '../../node_modules/electron/dist/Electron.app/Contents/MacOS/Electron' : process.platform === 'win32' ? '../../node_modules/electron/dist/electron.exe' : '../../node_modules/electron/dist/electron'
    const code = await new Promise((resolve, reject) => {
      const c = spawn(join(here, bin), [join(ui, 'runner.cjs')], { stdio: 'inherit', env })
      const timer = setTimeout(() => { c.kill('SIGTERM'); reject(Error('draft UI test timed out')) }, 30000)
      c.on('error', reject)
      c.on('exit', (n) => { clearTimeout(timer); resolve(n) })
    })
    assert.equal(code, 0)
  } finally {
    rmSync(ui, { recursive: true, force: true })
  }
})
