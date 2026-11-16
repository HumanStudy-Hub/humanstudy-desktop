// Study transfer ("Download this study" / "Open a downloaded study"), against real temp folders, no network:
//   node --test src/main/study-transfer.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'study-transfer-'))
process.on('exit', () => rmSync(temp, { recursive: true, force: true }))
await build({
  entryPoints: [join(here, 'study-transfer.ts'), join(here, 'threads-core.ts'), join(here, 'telemetry-core.ts')],
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outdir: join(temp, 'out'), logLevel: 'error',
})
const S = await import(pathToFileURL(join(temp, 'out', 'study-transfer.js')).href)
const T = await import(pathToFileURL(join(temp, 'out', 'threads-core.js')).href)
const TC = await import(pathToFileURL(join(temp, 'out', 'telemetry-core.js')).href)

const NOW = new Date(2026, 10, 16, 10, 30) // Nov 16
const SOURCE = { platform: 'desktop', appVersion: '0.8.2' }
const sha = (b) => createHash('sha256').update(b).digest('hex')
let n = 0
const fresh = (label) => { const d = join(temp, `${label}-${++n}`); mkdirSync(d, { recursive: true }); return d }
function put(root, rel, data) {
  const p = join(root, ...rel.split('/'))
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, data)
}
/** Every file under `root` as rel -> bytes (links skipped). */
function tree(root) {
  const out = new Map()
  const walk = (dir) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name)
      if (d.isDirectory()) walk(p)
      else if (d.isFile()) out.set(relative(root, p).split(sep).join('/'), readFileSync(p))
    }
  }
  walk(root)
  return out
}
const thread = (id, sid, text) => JSON.stringify({
  id, title: text, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:01:00.000Z', kernel: 'opencode', kernelSessionId: sid,
  messages: [
    { id: 'm1', role: 'user', parts: [{ kind: 'text', text }], at: '2026-11-01T00:00:00.000Z' },
    { id: 'm2', role: 'assistant', parts: [{ kind: 'text', text: 'Here is the design.' }], at: '2026-11-01T00:00:30.000Z' },
  ],
  usage: { input: 10, output: 20, cost: 0 },
}, null, 2)

/** A project as the app makes it, with every kind of file. */
function project(projectsRoot, name = 'Moral Luck', id = 'proj-1234-abcd') {
  const root = join(projectsRoot, name)
  put(root, '.humanstudy/project.json', JSON.stringify({ format: 1, createdAt: '2026-11-01T00:00:00.000Z', id }, null, 2) + '\n')
  put(root, '.humanstudy/community.json', '{"id":"study_001"}\n')
  put(root, '.humanstudy/threads/thr_a.json', thread('thr_a', 'ses_native_a', 'Summarise the study design'))
  put(root, '.humanstudy/threads/thr_b.json', thread('thr_b', '', 'Second'))
  put(root, '.humanstudy/thread-history/thr_a/history_1.json', '{"old":true}')
  put(root, 'program.json', JSON.stringify({ source: { title: 'Moral luck' }, evidence: [] }, null, 2))
  put(root, 'protocol.json', '{"schema_version":"1","meta":{"title":"Moral luck"}}')
  put(root, 'paper.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(40_000)]))
  put(root, 'package/task/adapter.py', 'def run():\n    return 1\n'.repeat(500))
  put(root, 'artifacts/simulations/2026-11-02-1000/results.html', '<h1>Results</h1>'.repeat(200))
  put(root, 'artifacts/notes.md', '# Notes\nÜmlaut ✓ 中文\n')
  put(root, 'sources/study.json', '{}')
  put(root, 'sources/private/my copy.pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), randomBytes(3000)]))
  put(root, 'sources/researcher/booklet.txt', 'private wording')
  put(root, 'AGENTS.md', '# custom instructions\n')
  put(root, 'exports/agent-package.zip', randomBytes(500))
  return root
}
const exportTo = async (root, o = {}) => {
  const out = join(fresh('downloads'), S.packageName('Moral Luck'))
  const r = await S.exportStudy(root, out, { conversations: true, source: SOURCE, now: NOW, ...o })
  return { ...r, zip: out }
}

// ---- a minimal zip writer for hand-made (hostile) study files --------------------------------
function zip(entries) {
  const locals = [], centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const data = Buffer.from(e.data ?? '')
    const body = e.body ?? (e.method === 8 ? deflateRawSync(data) : data)
    const usize = e.usize ?? data.length
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(e.method ?? 0, 8)
    local.writeUInt32LE(S.crc32(data), 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(usize, 22); local.writeUInt16LE(name.length, 26)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE((3 << 8) | 20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(e.method ?? 0, 10)
    cen.writeUInt32LE(S.crc32(data), 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(usize, 24); cen.writeUInt16LE(name.length, 28)
    cen.writeUInt32LE(((e.mode ?? 0o100644) << 16) >>> 0, 38); cen.writeUInt32LE(offset, 42)
    locals.push(local, name, body)
    centrals.push(cen, name)
    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}
/** A study file with these files; `listed` overrides the manifest's file list, `extra` adds unlisted entries. */
function hostile(files, { listed, extra = [], manifest = {} } = {}) {
  const m = {
    format: 'humanstudy-study', version: 1, projectId: 'hostile-0001', name: 'Hostile', source: { platform: 'online', appVersion: '0.8.2' },
    exportedAt: NOW.toISOString(), includes: { conversations: false, privateFiles: [] },
    files: listed ?? files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.data), sha256: sha(Buffer.from(f.data)) })),
    ...manifest,
  }
  const p = join(fresh('hostile'), 'x.humanstudy.zip')
  writeFileSync(p, zip([...files.map((f) => ({ name: 'study/' + f.path, ...f })), ...extra, { name: 'humanstudy-study.json', data: JSON.stringify(m) }]))
  return p
}
const rejects = async (zipPath, code, file, limits) => {
  const projects = fresh('projects')
  await assert.rejects(S.importStudy(zipPath, projects, { now: NOW, ...(limits ? { limits } : {}) }), (e) => {
    assert.equal(e.name, 'TransferError', String(e))
    assert.equal(e.code, code, `${e.code}: ${e.message}`)
    if (file !== undefined) assert.equal(e.file, file)
    return true
  })
  assert.deepEqual(readdirSync(projects), [], 'nothing written, not even a hidden folder')
}
const small = (o) => ({ ...S.LIMITS, ...o })

// ---- tests ----------------------------------------------------------------------------------

test('round trip: every study file arrives byte for byte; the native session is dropped; the id is kept', async () => {
  const root = project(fresh('desk'))
  const before = tree(root)
  const r = await exportTo(root)
  assert.ok(r.zip.endsWith('Moral Luck.humanstudy.zip'))
  assert.deepEqual(tree(root), before, 'exporting never changes the project (it already had an id)')
  const online = fresh('online-projects')
  const imp = await S.importStudy(r.zip, online, { now: NOW })
  assert.equal(imp.name, 'Moral Luck')
  assert.equal(imp.renamed, false)
  assert.equal(imp.id, 'proj-1234-abcd')
  assert.equal(imp.conversations, 2)
  assert.equal(imp.privateFiles, 2)
  const after = tree(imp.dir)
  for (const [rel, bytes] of before) {
    if (rel === '.humanstudy/project.json' || rel === '.humanstudy/threads/thr_a.json') continue
    assert.ok(after.has(rel), `missing ${rel}`)
    assert.ok(after.get(rel).equals(bytes), `bytes differ: ${rel}`)
  }
  assert.equal(after.get('sources/researcher/booklet.txt').toString(), 'private wording', 'private files travel: it is the researcher\'s own copy')
  const a = JSON.parse(after.get('.humanstudy/threads/thr_a.json'))
  const orig = JSON.parse(before.get('.humanstudy/threads/thr_a.json'))
  assert.equal(a.kernelSessionId, '', 'the native model session belongs to the other computer')
  assert.deepEqual({ ...a, kernelSessionId: orig.kernelSessionId }, orig, 'the conversation itself is unchanged')
  const meta = JSON.parse(after.get('.humanstudy/project.json'))
  assert.equal(meta.id, 'proj-1234-abcd')
  assert.equal(meta.importedFrom, 'desktop')
  assert.equal(meta.createdAt, '2026-11-01T00:00:00.000Z')
  // and back again: the file made by the imported project matches the first one's contents
  const back = await S.exportStudy(imp.dir, join(fresh('dl'), 'b.humanstudy.zip'), { conversations: true, source: { platform: 'online', appVersion: '0.8.2' }, now: NOW })
  const strip = (m) => m.files.filter((f) => f.path !== '.humanstudy/project.json')
  assert.deepEqual(strip(back.manifest), strip(r.manifest))
  assert.equal(back.manifest.source.platform, 'online')
})

test('the study file: a manifest with sizes and SHA-256 of every file, files under study/', async () => {
  const root = project(fresh('desk'))
  const r = await exportTo(root)
  const m = r.manifest
  assert.equal(m.format, 'humanstudy-study')
  assert.equal(m.version, 1)
  assert.equal(m.projectId, 'proj-1234-abcd')
  assert.equal(m.name, 'Moral Luck')
  assert.deepEqual(m.source, SOURCE)
  assert.equal(m.exportedAt, NOW.toISOString())
  assert.deepEqual(m.includes, { conversations: true, privateFiles: ['sources/private/my copy.pdf', 'sources/researcher/booklet.txt'] })
  for (const f of m.files) {
    const bytes = f.path.startsWith('.humanstudy/threads/') ? null : readFileSync(join(root, ...f.path.split('/')))
    if (bytes) { assert.equal(f.size, bytes.length, f.path); assert.equal(f.sha256, sha(bytes), f.path) }
  }
  assert.deepEqual(await S.verifyPackage(r.zip), m)
  const raw = readFileSync(r.zip)
  assert.ok(raw.includes(Buffer.from('study/program.json')) && raw.includes(Buffer.from('humanstudy-study.json')))
})

test('private files are listed by name and included by default (no per-file opt-in)', async () => {
  const root = project(fresh('desk'))
  const preview = await S.previewExport(root)
  assert.deepEqual(preview.privateFiles.map((f) => f.path).sort(), ['sources/private/my copy.pdf', 'sources/researcher/booklet.txt'])
  assert.equal(preview.hasPaper, true)
  assert.equal(preview.conversations.count, 2)
  assert.ok(preview.study.files > 5 && preview.study.bytes > 40_000)
  const all = await exportTo(root)
  assert.deepEqual(all.manifest.files.filter((f) => /^sources\/(private|researcher)\//.test(f.path)).map((f) => f.path).sort(), ['sources/private/my copy.pdf', 'sources/researcher/booklet.txt'])
  assert.deepEqual(all.manifest.includes.privateFiles, ['sources/private/my copy.pdf', 'sources/researcher/booklet.txt'])
  // An old caller's list of ticked files no longer narrows anything.
  const old = await exportTo(root, { privateFiles: [] })
  assert.equal(old.manifest.files.length, all.manifest.files.length)
})

test('chat history: included by default, left out entirely when unticked', async () => {
  const root = project(fresh('desk'))
  const without = await exportTo(root, { conversations: false })
  assert.equal(without.manifest.files.some((f) => f.path.startsWith('.humanstudy/thread')), false)
  assert.equal(without.manifest.includes.conversations, false)
  const imp = await S.importStudy(without.zip, fresh('projects'), { now: NOW })
  assert.equal(existsSync(join(imp.dir, '.humanstudy', 'threads')), false)
  assert.equal(imp.conversations, 0)
  const withChats = await exportTo(root)
  assert.deepEqual(withChats.manifest.files.filter((f) => f.path.startsWith('.humanstudy/thread')).map((f) => f.path).sort(),
    ['.humanstudy/thread-history/thr_a/history_1.json', '.humanstudy/threads/thr_a.json', '.humanstudy/threads/thr_b.json'])
})

test('never included: hidden files, tools, caches, app state, agent config, other study files, links', async () => {
  const projects = fresh('desk')
  const root = project(projects)
  const outside = join(fresh('secret'), 'keys.txt')
  writeFileSync(outside, 'sk-secret')
  const never = ['.git/config', '.git/objects/ab/cdef', '.env', '.env.local', '.DS_Store', 'artifacts/.DS_Store', '._paper.pdf',
    'node_modules/x/index.js', 'package/node_modules/y.js', '__pycache__/a.cpython-312.pyc', 'package/task/adapter.pyc',
    '.venv/bin/python', '.ipynb_checkpoints/a.ipynb', '.opencode/opencode.json', '.opencode/skills/build/SKILL.md', 'opencode.json',
    '.humanstudy/original-text.json', '.humanstudy/tmp/llm-usage.jsonl', '.humanstudy/versions/program.json/1', '.humanstudy/state.json',
    '.humanstudy/threads/.DS_Store', 'Thumbs.db', 'artifacts/desktop.ini', 'program.json.123.0123456789abcdef0123456789abcdef.tmp',
    'exports/older.humanstudy.zip', 'old copy.HumanStudy.zip']
  for (const rel of never) put(root, rel, 'x')
  symlinkSync(outside, join(root, 'linked-keys.txt'))
  symlinkSync(dirname(outside), join(root, 'linked-folder'))
  for (const rel of never) assert.equal(S.classify(rel), 'never', rel)
  const r = await exportTo(root)
  const paths = r.manifest.files.map((f) => f.path)
  for (const rel of [...never, 'linked-keys.txt']) assert.equal(paths.includes(rel), false, rel)
  assert.equal(paths.some((p) => p.startsWith('linked-folder')), false)
  assert.equal(readFileSync(r.zip).includes(Buffer.from('sk-secret')), false)
  for (const rel of ['program.json', 'protocol.json', 'paper.pdf', 'AGENTS.md', 'package/task/adapter.py', 'artifacts/notes.md',
    'artifacts/simulations/2026-11-02-1000/results.html', 'exports/agent-package.zip', '.humanstudy/project.json', '.humanstudy/community.json'])
    assert.ok(paths.includes(rel), `should include ${rel}`)
  // and a hand-made file that carries one of them is refused
  await rejects(hostile([{ path: 'program.json', data: '{}' }, { path: '.git/config', data: '[core]' }]), 'unsafe', '.git/config')
  await rejects(hostile([{ path: '.humanstudy/original-text.json', data: '{}' }]), 'unsafe', '.humanstudy/original-text.json')
})

test('classify: the private rule is research capture\'s rule; app state is a short allow list', () => {
  assert.equal(S.classify('sources/private/x.pdf'), 'private')
  assert.equal(S.classify('sources/quarantine/x.txt'), 'private')
  assert.equal(S.classify('package/original-text/a.txt'), 'private')
  assert.equal(S.classify('sources/privateer.txt'), 'study')
  assert.equal(S.classify('.humanstudy/threads/thr_1.json'), 'conversation')
  assert.equal(S.classify('.humanstudy/program-conflicts/a.json'), 'study')
  assert.equal(S.classify('.humanstudy/project.json'), 'study')
  assert.equal(S.classify('.humanstudy/whatever.json'), 'never')
})

test('a changed file is refused, naming the file; nothing is written', async () => {
  const root = project(fresh('desk'))
  const r = await exportTo(root)
  const raw = readFileSync(r.zip)
  // paper.pdf does not compress, so it is stored: change one byte of it inside the study file
  const pdf = readFileSync(join(root, 'paper.pdf'))
  const at = raw.indexOf(pdf.subarray(1000, 1064))
  assert.ok(at > 0)
  raw[at + 10] ^= 0xff
  const bad = join(fresh('dl'), 'tampered.humanstudy.zip')
  writeFileSync(bad, raw)
  await rejects(bad, 'damaged', 'paper.pdf')
  // a listed digest that does not match
  await rejects(hostile([{ path: 'a.txt', data: 'hello' }], { listed: [{ path: 'a.txt', size: 5, sha256: sha('HELLO') }] }), 'damaged', 'a.txt')
  // a listed size that does not match
  await rejects(hostile([{ path: 'a.txt', data: 'hello' }], { listed: [{ path: 'a.txt', size: 4, sha256: sha('hello') }] }), 'damaged', 'a.txt')
  // a listed file that is missing
  await rejects(hostile([], { listed: [{ path: 'gone.txt', size: 1, sha256: sha('x') }] }), 'damaged', 'gone.txt')
  // not a study file at all
  const junk = join(fresh('dl'), 'junk.zip')
  writeFileSync(junk, randomBytes(5000))
  await rejects(junk, 'not-package')
  await rejects(hostile([{ path: 'a.txt', data: 'x' }], { manifest: { format: 'something-else' } }), 'not-package')
  await rejects(hostile([{ path: 'a.txt', data: 'x' }], { manifest: { version: 2 } }), 'newer')
})

test('unsafe names are refused: .., absolute paths, drive letters, unlisted entries, Windows names', async () => {
  for (const path of ['../evil.txt', 'a/../../evil.txt', '/etc/passwd', 'C:/Windows/x', 'a\\..\\b', 'a//b', './a', 'con.txt', 'a/aux', 'name.', 'trail ', 'a:b'])
    await rejects(hostile([{ path, data: 'x' }]), 'unsafe', path)
  // an entry outside the list, and one outside study/
  await rejects(hostile([{ path: 'a.txt', data: 'x' }], { extra: [{ name: 'study/extra.txt', data: 'y' }] }), 'unsafe', 'extra.txt')
  await rejects(hostile([{ path: 'a.txt', data: 'x' }], { extra: [{ name: 'elsewhere.txt', data: 'y' }] }), 'unsafe', 'elsewhere.txt')
  // a folder entry
  await rejects(hostile([{ path: 'a.txt', data: 'x' }], { extra: [{ name: 'study/dir/', data: '' }] }), 'unsafe')
})

test('links and special files are refused', async () => {
  await rejects(hostile([{ path: 'link.txt', data: '/etc/passwd', mode: 0o120777 }]), 'unsafe', 'link.txt')
  await rejects(hostile([{ path: 'fifo', data: '', mode: 0o010644 }]), 'unsafe', 'fifo')
})

test('duplicates are refused: the same entry twice, names that differ only in case, a file over a folder', async () => {
  const one = { path: 'a.txt', data: 'x' }
  await rejects(hostile([one], { extra: [{ name: 'study/a.txt', data: 'x' }] }), 'unsafe', 'a.txt')
  await rejects(hostile([one, { path: 'A.txt', data: 'y' }]), 'unsafe', 'A.txt')
  await rejects(hostile([{ path: 'n/x.txt', data: 'x' }, { path: 'n', data: 'y' }]), 'unsafe')
  await rejects(hostile([one], { extra: [{ name: 'humanstudy-study.json', data: '{}' }] }), 'unsafe')
})

test('size limits: a large file, too much in all, too many files, a zip bomb', async () => {
  await rejects(hostile([{ path: 'big.bin', data: 'x'.repeat(2000) }]), 'too-large', 'big.bin', small({ maxFileBytes: 1000 }))
  await rejects(hostile([{ path: 'a', data: 'x'.repeat(600) }, { path: 'b', data: 'x'.repeat(600) }]), 'too-large', undefined, small({ maxTotalBytes: 1000 }))
  await rejects(hostile([{ path: 'a', data: '1' }, { path: 'b', data: '2' }, { path: 'c', data: '3' }]), 'too-large', undefined, small({ maxFiles: 2 }))
  // a bomb: the entry says 10 bytes, the list says 10 bytes, but it inflates to 50 MB; decompression stops at 10
  const bomb = Buffer.alloc(50 * 1024 * 1024)
  const p = hostile([{ path: 'bomb.bin', data: bomb.subarray(0, 10), body: deflateRawSync(bomb), method: 8, usize: 10 }],
    { listed: [{ path: 'bomb.bin', size: 10, sha256: sha(bomb.subarray(0, 10)) }] })
  await rejects(p, 'damaged', 'bomb.bin')
  // the export side keeps the same limits, so every study file that downloads also opens
  await assert.rejects(exportTo(project(fresh('desk'))).then(() => S.exportStudy(project(fresh('desk2')), join(fresh('dl'), 'x.humanstudy.zip'),
    { conversations: true, privateFiles: [], source: SOURCE, limits: small({ maxFileBytes: 10_000 }) })), (e) => e.code === 'too-large')
})

test('a study already here is never overwritten: the copy gets its own id and a name that says where it came from', async () => {
  const projects = fresh('desk')
  const root = project(projects)
  const r = await exportTo(root)
  const before = tree(root)
  const imp = await S.importStudy(r.zip, projects, { now: NOW })
  assert.equal(imp.renamed, true)
  assert.equal(imp.name, 'Moral Luck (from this computer, Nov 16)')
  assert.notEqual(imp.id, 'proj-1234-abcd')
  const meta = JSON.parse(readFileSync(join(imp.dir, '.humanstudy', 'project.json'), 'utf8'))
  assert.equal(meta.copyOf, 'proj-1234-abcd')
  assert.equal(meta.id, imp.id)
  assert.deepEqual(tree(root), before, 'the existing project is untouched')
  // the same again on the same day: a third folder, never the second one
  const again = await S.importStudy(r.zip, projects, { now: NOW })
  assert.equal(again.name, 'Moral Luck (from this computer, Nov 16) 2')
  // from online, said so; matching is by id, never by folder name
  const online = await S.exportStudy(imp.dir, join(fresh('dl'), 'o.humanstudy.zip'), { conversations: true, privateFiles: [], source: { platform: 'online', appVersion: '0.8.2' }, now: NOW })
  const third = await S.importStudy(online.path, projects, { now: new Date(2026, 11, 2) })
  assert.equal(third.name, 'Moral Luck (from this computer, Nov 16) (from online, Dec 2)')
  const other = fresh('other-projects')
  mkdirSync(join(other, 'Moral Luck', '.humanstudy'), { recursive: true })
  writeFileSync(join(other, 'Moral Luck', '.humanstudy', 'project.json'), '{"format":1,"id":"someone-else-1"}')
  const byName = await S.importStudy(r.zip, other, { now: NOW })
  assert.equal(byName.renamed, false, 'a folder with the same name is a different study')
  assert.equal(byName.name, 'Moral Luck 2')
  assert.equal(byName.id, 'proj-1234-abcd')
})

test('a project without an id gets one, written to .humanstudy/project.json and kept', async () => {
  const root = project(fresh('desk'), 'No Id')
  writeFileSync(join(root, '.humanstudy', 'project.json'), '{"format":1,"createdAt":"2026-01-01T00:00:00.000Z"}\n')
  const first = await exportTo(root)
  const meta = JSON.parse(readFileSync(join(root, '.humanstudy', 'project.json'), 'utf8'))
  assert.match(meta.id, /^[0-9a-f-]{36}$/)
  assert.equal(meta.createdAt, '2026-01-01T00:00:00.000Z')
  assert.equal(first.manifest.projectId, meta.id)
  assert.equal((await exportTo(root)).manifest.projectId, meta.id)
})

test('a failure leaves no partial project and no partial download', async () => {
  const projects = fresh('projects')
  mkdirSync(join(projects, 'Existing'))
  writeFileSync(join(projects, 'Existing', 'keep.txt'), 'keep')
  const files = Array.from({ length: 30 }, (_, i) => ({ path: `artifacts/f${i}.txt`, data: `file ${i}` }))
  const listed = files.map((f) => ({ path: f.path, size: f.data.length, sha256: sha(f.data) }))
  listed[29] = { ...listed[29], sha256: sha('something else') }
  await assert.rejects(S.importStudy(hostile(files, { listed }), projects, { now: NOW }), (e) => e.code === 'damaged' && e.file === 'artifacts/f29.txt')
  assert.deepEqual(readdirSync(projects), ['Existing'])
  // a leftover hidden folder from a crash is swept
  mkdirSync(join(projects, '.importing-crashed'))
  await S.sweepImports(projects)
  assert.deepEqual(readdirSync(projects), ['Existing'])
  // export: an unreadable file midway leaves no file behind
  const root = project(fresh('desk'))
  const dl = fresh('dl')
  await assert.rejects(S.exportStudy(root, join(dl, 'x.humanstudy.zip'), { conversations: true, privateFiles: [], source: SOURCE, limits: small({ maxFileBytes: 30_000 }) }))
  assert.deepEqual(readdirSync(dl), [])
})

test('an imported conversation continues: it resumes as a fresh session that is given its history', async () => {
  const root = project(fresh('desk'))
  const r = await exportTo(root)
  const imp = await S.importStudy(r.zip, fresh('online'), { now: NOW })
  const calls = []
  const host = {
    kernelName: () => 'mock',
    start: async (dir) => { calls.push(['start', dir]); return 'ses_new' },
    resume: async (dir, sid) => { calls.push(['resume', sid]); return null },
  }
  const mgr = new T.ThreadManager(host, () => undefined, { saveDelayMs: 0 })
  const list = await mgr.list(imp.dir)
  assert.deepEqual(list.map((x) => x.id).sort(), ['thr_a', 'thr_b'])
  const t = await mgr.resume(imp.dir, 'thr_a')
  assert.deepEqual(calls, [['start', imp.dir]], 'the old native session is never asked for')
  assert.equal(t.kernelSessionId, 'ses_new')
  assert.equal(t.resumedWithContext, true)
  const prompt = mgr.beforeSend('ses_new', 'And next?')
  assert.match(prompt, /Summarise the study design[\s\S]*And next\?$/)
  await mgr.flush()
})

test('names: a download is offered as <name>.humanstudy.zip; an imported folder name is always safe', () => {
  assert.equal(S.packageName('Moral Luck'), 'Moral Luck.humanstudy.zip')
  assert.equal(S.packageName('a/b:c'), 'a-b-c.humanstudy.zip')
  const long = 'x'.repeat(200)
  const name = S.importName({ name: long, source: { platform: 'online' } }, true, NOW)
  assert.ok(name.length <= 80 && name.endsWith('(from online, Nov 16)'), name)
  assert.equal(S.importName({ name: '../../etc', source: { platform: 'desktop' } }, false, NOW), 'etc')
  assert.ok(statSync(temp).isDirectory())
})

test('research data never collects a study file, wherever it is saved in a project', () => {
  const index = TC.EMPTY_INDEX
  for (const rel of ['exports/Moral Luck.humanstudy.zip', 'sources/x.HumanStudy.zip', 'artifacts/a%20b.humanstudy.zip'])
    assert.equal(TC.mayCollectFile({ rel, published: false, index }), false, rel)
  assert.equal(TC.mayCollectFile({ rel: 'exports/agent-package.zip', published: false, index }), true, 'other files keep the existing rules')
})

test('a study made on Linux with names that collide elsewhere fails when downloaded, not when opened', () => {
  for (const paths of [['Data.csv', 'data.csv'], ['café.txt', 'café.txt'], ['A', 'a/b.txt']])
    assert.throws(() => S.checkCollisions(paths), (e) => e.code === 'unsafe', paths.join(' / '))
  S.checkCollisions(['a/b.txt', 'a/c.txt', 'ab'])
})

test('a published study: run outputs count as private files and are included like the rest', async () => {
  const root = project(fresh('desk'))
  assert.equal(S.kindOf('artifacts/simulations/run/results.html', true), 'private')
  assert.equal(S.kindOf('artifacts/simulations/run/results.html', false), 'study')
  assert.equal(S.kindOf('artifacts/notes.md', true), 'study')
  const preview = await S.previewExport(root, { published: true })
  assert.ok(preview.privateFiles.some((f) => f.path === 'artifacts/simulations/2026-11-02-1000/results.html'))
  const r = await exportTo(root, { published: true })
  assert.ok(r.manifest.includes.privateFiles.includes('artifacts/simulations/2026-11-02-1000/results.html'))
})

test('the download is written through a save temporary that file watching and research data skip', async () => {
  assert.equal(S.classify('exports/x.humanstudy.zip.123.0b6c2f4e-1d2a-4c3b-9e8f-112233445566.tmp'), 'never')
  // an unreadable marker is never replaced by a download
  const root = project(fresh('desk'), 'Broken marker')
  writeFileSync(join(root, '.humanstudy', 'project.json'), '{not json')
  const r = await exportTo(root)
  assert.match(r.manifest.projectId, /^[0-9a-f-]{36}$/)
  assert.equal(readFileSync(join(root, '.humanstudy', 'project.json'), 'utf8'), '{not json')
})
