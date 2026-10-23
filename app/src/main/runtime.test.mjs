// Research runtime (runtime-core.ts + pack/runtime): pins, shims, PATH composition, install flow against a
// local server (checksum failure, resume, pip retry, marker), progress merge, and the python unit tests.
//   node --test src/main/runtime.test.mjs
// Python tests run with HUMANSTUDY_TEST_PYTHON (a runtime python, runs the PDF shim tests too), else the
// system python3 (LLM client tests only; the PDF tests skip themselves).
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '../../..')
const out = mkdtempSync(join(tmpdir(), 'rt-test-'))
await build({ entryPoints: [join(here, 'runtime-core.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outdir: out, logLevel: 'error' })
const core = await import(pathToFileURL(join(out, 'runtime-core.js')).href)
const posix = process.platform !== 'win32'

const lockText = readFileSync(join(repo, 'pack/runtime/requirements.lock'), 'utf8')
const libDir = join(repo, 'pack/runtime/lib')
const lib = Object.fromEntries(readdirSync(libDir).filter((n) => n.endsWith('.py')).map((n) => [n, readFileSync(join(libDir, n), 'utf8')]))

test('pins: every target has a python build with a 64-hex digest and a release URL', () => {
  for (const [p, a] of [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64']]) {
    const asset = core.pickPython(p, a)
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, `${p}-${a}`)
    assert.ok(asset.size > 15e6 && asset.size < 40e6)
    assert.match(asset.name, /^cpython-3\.12\.\d+\+\d{8}-.*-install_only_stripped\.tar\.gz$/)
    assert.match(core.pythonUrl(asset), /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\/\d{8}\/cpython-3\.12\.\d+%2B\d{8}-/)
  }
  assert.equal(core.pickPython('linux', 'x64'), null)
  assert.equal(core.pickPython('win32', 'arm64'), null)
})

test('lock file: hash-pinned, binary-only content, covers the required packages', () => {
  const reqs = lockText.split(/\r?\n/).filter((l) => /^[A-Za-z0-9][A-Za-z0-9._-]*==/.test(l))
  assert.equal(reqs.length, core.lockSize(lockText))
  assert.ok(reqs.length >= 25)
  for (const name of ['numpy', 'scipy', 'pandas', 'statsmodels', 'matplotlib', 'pingouin', 'pypdf', 'pdfplumber', 'openpyxl', 'python-docx', 'pyreadstat', 'jinja2', 'jsonschema'])
    assert.ok(reqs.some((r) => r.toLowerCase().startsWith(name + '==')), name)
  // every requirement block has at least one sha256
  const blocks = lockText.split(/\n(?=[A-Za-z0-9][A-Za-z0-9._-]*==)/).slice(1)
  assert.equal(blocks.length, reqs.length)
  for (const b of blocks) assert.match(b, /--hash=sha256:[0-9a-f]{64}/, b.split('\n')[0])
  assert.match(core.runtimeVersion(lockText), /^py3\.12\.\d+-\d{8}-[0-9a-f]{10}$/)
  assert.notEqual(core.runtimeVersion(lockText), core.runtimeVersion(lockText + '\n# x'))
})

test('shims: unix scripts find the runtime relative to themselves; windows .cmd', () => {
  const unix = Object.fromEntries(core.shimFiles('darwin').map((f) => [f.rel, f]))
  assert.deepEqual(Object.keys(unix).sort(), ['bin/hs-pdf', 'bin/pdfinfo', 'bin/pdftotext', 'bin/pip', 'bin/pip3', 'bin/python', 'bin/python3'])
  assert.ok(unix['bin/python'].exec)
  assert.match(unix['bin/python'].content, /^#!\/bin\/sh\n/)
  assert.match(unix['bin/python'].content, /exec "\$d\/\.\.\/python\/bin\/python3" "\$@"\n$/)
  assert.match(unix['bin/pip'].content, /python3" -m pip "\$@"/)
  assert.match(unix['bin/pdftotext'].content, /-E -s -m hs_pdf_tools pdftotext "\$@"/)
  const win = Object.fromEntries(core.shimFiles('win32').map((f) => [f.rel, f]))
  assert.ok(win['bin/python.cmd'] && win['bin/pdftotext.cmd'] && !win['bin/python'])
  assert.match(win['bin/python.cmd'].content, /"%~dp0\.\.\\python\\python\.exe" %\*/)
  assert.match(win['bin/hs-pdf.cmd'].content, /python\.exe" -E -s -m hs_pdf_tools hs-pdf %\*/)
  assert.ok(win['bin/pip.cmd'].content.includes('-m pip %*'))
  // the stubs shadow the same names and never run anything
  for (const f of core.stubFiles('darwin')) assert.match(f.content, /exit 127/)
  assert.equal(core.stubFiles('win32').length, core.SHIM_NAMES.length)
})

test('PATH composition: runtime bin first, no duplicates, python env scrubbed', () => {
  const env = core.runtimeEnv({ PATH: ['/usr/bin', '/rt/bin', '/bin'].join(delimiter), PYTHONHOME: '/x', PYTHONPATH: '/y', VIRTUAL_ENV: '/v', HOME: '/h' }, '/rt/bin', 'darwin')
  assert.equal(env.PATH, ['/rt/bin', '/usr/bin', '/bin'].join(delimiter))
  assert.equal(env.PYTHONNOUSERSITE, '1')
  assert.equal(env.MPLBACKEND, 'Agg')
  assert.equal(env.PIP_DISABLE_PIP_VERSION_CHECK, '1')
  assert.equal(env.PYTHONHOME, undefined)
  assert.equal(env.PYTHONPATH, undefined)
  assert.equal(env.VIRTUAL_ENV, undefined)
  assert.equal(env.HOME, '/h')
  // a copied Windows environment has `Path`, and entries are ;-separated
  const w = core.runtimeEnv({ Path: 'C:\\Windows;C:\\git' }, 'C:\\rt\\bin', 'win32')
  assert.equal(w.Path, 'C:\\rt\\bin;C:\\Windows;C:\\git')
  assert.equal(w.PATH, undefined)
  // empty PATH still works
  assert.equal(core.runtimeEnv({}, '/rt/bin', 'darwin').PATH, '/rt/bin')
  // input untouched
  const src = { PATH: '/usr/bin' }
  core.runtimeEnv(src, '/rt/bin', 'darwin')
  assert.equal(src.PATH, '/usr/bin')
})

test('kernelRuntimeEnv: only acts when the app published HUMANSTUDY_RUNTIME_BIN', () => {
  const plain = { PATH: '/usr/bin' }
  assert.equal(core.kernelRuntimeEnv(plain, 'darwin'), plain)
  const e = core.kernelRuntimeEnv({ PATH: '/usr/bin', HUMANSTUDY_RUNTIME_BIN: '/rt/bin' }, 'darwin')
  assert.ok(e.PATH.startsWith('/rt/bin' + delimiter))
})

test('combined install status: one bar for kernel + runtime', () => {
  const c = core.combineInstall
  assert.equal(c({ state: 'ready' }, { state: 'ready' }).state, 'ready')
  assert.equal(c({ state: 'ready' }, { state: 'checking' }).state, 'checking')
  const half = c({ state: 'downloading', percent: 100 }, { state: 'downloading', percent: 0 })
  assert.equal(half.state, 'downloading')
  assert.equal(half.percent, Math.round(core.KERNEL_WEIGHT * 100))
  assert.equal(c({ state: 'ready' }, { state: 'downloading', percent: 50 }).phase, 'runtime')
  assert.equal(c({ state: 'downloading', percent: 10 }, { state: 'downloading', percent: 0 }).phase, 'kernel')
  assert.ok(c({ state: 'downloading', percent: 100 }, { state: 'downloading', percent: 100 }).percent <= 99)
  assert.deepEqual(c({ state: 'ready' }, { state: 'error', error: 'boom' }), { state: 'error', error: 'boom' })
  assert.equal(c({ state: 'error', error: 'k' }, { state: 'downloading', percent: 5 }).error, 'k')
})

// ---- install flow against a local server -------------------------------------------------------

function makeTarball() {
  const src = mkdtempSync(join(tmpdir(), 'rt-src-'))
  mkdirSync(join(src, 'python', 'bin'), { recursive: true })
  writeFileSync(join(src, 'python', 'bin', 'python3'), '#!/bin/sh\necho fake\n', { mode: 0o755 })
  writeFileSync(join(src, 'python', 'filler.bin'), Buffer.alloc(400_000, 3)) // random-ish size for resume
  const tgz = join(src, 'py.tar.gz')
  const r = spawnSync(core.tarCommand(), ['-czf', tgz, '-C', src, 'python'])
  assert.equal(r.status, 0, String(r.stderr))
  const data = readFileSync(tgz)
  return { data, sha: createHash('sha256').update(data).digest('hex') }
}

function serve(handler) {
  return new Promise((resolve) => {
    const hits = []
    const srv = createServer((req, res) => {
      hits.push({ url: req.url, range: req.headers.range })
      handler(req, res, hits)
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, hits, base: `http://127.0.0.1:${srv.address().port}/rel` }))
  })
}
const fileHandler = (data) => (req, res) => {
  const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
  const from = m ? Number(m[1]) : 0
  res.writeHead(m ? 206 : 200, { 'content-length': data.length - from })
  res.end(data.subarray(from))
}

/** deps: real tar extraction; python() is a fake that records calls. */
function fakeDeps(opts = {}) {
  const calls = []
  let pipFails = opts.pipFailures ?? 0
  return {
    calls,
    deps: {
      extract: core.defaultDeps.extract,
      python: async (py, args, env, onLine) => {
        calls.push({ py, args, env })
        if (args[0] === '-m' && args[1] === 'pip') {
          if (pipFails-- > 0) throw new Error('pip: network down')
          for (const l of ['Collecting numpy==1 (from -r x)', 'Collecting scipy==1 (from -r x)']) onLine(l)
        } else if (args[0] === '-I') onLine(opts.verifyOutput ?? 'runtime-ok')
      },
    },
  }
}

test('tar: Windows uses System32 bsdtar, never whichever tar is first on PATH', () => {
  assert.equal(core.tarCommand('darwin', {}), 'tar')
  assert.equal(core.tarCommand('win32', { SystemRoot: 'C:\\Windows' }), 'C:\\Windows\\System32\\tar.exe')
  assert.equal(core.tarCommand('win32', { windir: 'D:\\WINNT\\' }), 'D:\\WINNT\\System32\\tar.exe')
  assert.equal(core.tarCommand('win32', {}), 'C:\\Windows\\System32\\tar.exe')
})

test('extract: a drive-letter path extracts with GNU tar (Git for Windows) first on PATH', { skip: posix ? 'Windows only' : false }, async () => {
  const gnu = ['C:\\Program Files\\Git\\usr\\bin', 'C:\\msys64\\usr\\bin'].find((d) => existsSync(join(d, 'tar.exe')))
  const saved = process.env.PATH
  if (gnu) process.env.PATH = gnu + delimiter + saved
  try {
    const t = makeTarball()
    const dir = mkdtempSync(join(tmpdir(), 'rt-x-'))
    writeFileSync(join(dir, 'py.tar.gz'), t.data)
    mkdirSync(join(dir, 'out'))
    await core.defaultDeps.extract(join(dir, 'py.tar.gz'), join(dir, 'out'))
    assert.ok(existsSync(join(dir, 'out', 'python', 'filler.bin')))
  } finally {
    process.env.PATH = saved
  }
})

const lockSmall = 'numpy==2.0.0 \\\n    --hash=sha256:' + 'a'.repeat(64) + '\nscipy==1.0.0 \\\n    --hash=sha256:' + 'b'.repeat(64) + '\n'
const skip = posix ? false : 'needs bsdtar + sh semantics'

test('install: download, extract, shims, pip args, marker; second run is a no-op that refreshes support files', { skip }, async () => {
  const t = makeTarball()
  const asset = { name: 'cpython-test.tar.gz', sha256: t.sha, size: t.data.length }
  const { srv, hits, base } = await serve(fileHandler(t.data))
  const root = join(mkdtempSync(join(tmpdir(), 'rt-root-')), 'v')
  const f = fakeDeps()
  const seen = []
  const run = (extraLib = {}) =>
    core.installRuntime({ root, platform: process.platform, arch: process.arch, lock: lockSmall, lib: { 'humanstudy_llm.py': '# v1', ...extraLib }, asset, baseUrl: base, deps: f.deps, onProgress: (p) => seen.push(p.percent) })
  try {
    const rt = await run()
    assert.equal(readFileSync(rt.ok, 'utf8'), core.runtimeVersion(lockSmall))
    assert.ok(existsSync(join(root, 'python', 'bin', 'python3')))
    assert.ok(statSync(join(root, 'bin', 'python3')).mode & 0o100)
    assert.ok(existsSync(join(root, 'bin', 'pdftotext')))
    assert.equal(readFileSync(join(rt.sitePackages, 'humanstudy_llm.py'), 'utf8'), '# v1')
    assert.ok(!existsSync(join(root, 'download')), 'download folder removed')
    assert.equal(hits.length, 1)
    assert.equal(hits[0].url, '/rel/cpython-test.tar.gz')
    const pip = f.calls.find((c) => c.args[1] === 'pip').args
    for (const a of ['--require-hashes', '--only-binary', ':all:', '--no-deps']) assert.ok(pip.includes(a), a)
    assert.equal(pip[pip.indexOf('--only-binary') + 1], ':all:')
    assert.ok(readFileSync(pip.at(-1), 'utf8') === lockSmall)
    const env = f.calls.find((c) => c.args[1] === 'pip').env
    assert.equal(env.PYTHONNOUSERSITE, '1')
    assert.ok(env.PATH.startsWith(join(root, 'bin')))
    assert.ok(env.PIP_CACHE_DIR.startsWith(root))
    assert.deepEqual(seen, [...seen].sort((a, b) => a - b), 'progress never goes backwards')
    assert.ok(seen.at(-1) >= 99 && seen.at(-1) <= 99)

    // second run: marker matches -> no download, no pip; support files are rewritten
    f.calls.length = 0
    await run({ 'humanstudy_llm.py': '# v2' })
    assert.equal(hits.length, 1)
    assert.equal(f.calls.length, 0)
    assert.equal(readFileSync(join(rt.sitePackages, 'humanstudy_llm.py'), 'utf8'), '# v2')
    assert.equal(await core.isInstalled(root, process.platform, lockSmall), true)
    assert.equal(await core.isInstalled(root, process.platform, lockSmall + '#'), false)
  } finally {
    srv.close()
  }
})

test('install: wrong checksum fails twice, leaves no marker, nothing half-installed counts as installed', { skip }, async () => {
  const t = makeTarball()
  const bad = Buffer.from(t.data)
  bad[100] ^= 0xff
  const { srv, hits, base } = await serve(fileHandler(bad))
  const root = join(mkdtempSync(join(tmpdir(), 'rt-root-')), 'v')
  const f = fakeDeps()
  try {
    await assert.rejects(
      core.installRuntime({ root, platform: process.platform, arch: process.arch, lock: lockSmall, lib: {}, asset: { name: 'x.tar.gz', sha256: t.sha, size: bad.length }, baseUrl: base, deps: f.deps }),
      /SHA-256/
    )
    assert.equal(hits.length, 2, 'one retry from byte 0')
    assert.ok(!existsSync(join(root, '.ok')))
    assert.equal(f.calls.length, 0)
    assert.ok(!existsSync(join(root, 'download', 'x.tar.gz.part')))
  } finally {
    srv.close()
  }
})

test('install: resumes a partial download with a Range request', { skip }, async () => {
  const t = makeTarball()
  const { srv, hits, base } = await serve(fileHandler(t.data))
  const root = join(mkdtempSync(join(tmpdir(), 'rt-root-')), 'v')
  mkdirSync(join(root, 'download'), { recursive: true })
  const half = Math.floor(t.data.length / 2)
  writeFileSync(join(root, 'download', 'y.tar.gz.part'), t.data.subarray(0, half))
  try {
    await core.installRuntime({ root, platform: process.platform, arch: process.arch, lock: lockSmall, lib: {}, asset: { name: 'y.tar.gz', sha256: t.sha, size: t.data.length }, baseUrl: base, deps: fakeDeps().deps })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].range, `bytes=${half}-`)
    assert.ok(existsSync(join(root, '.ok')))
  } finally {
    srv.close()
  }
})

test('install: pip is retried once, a second failure leaves no marker; failed import check is an error', { skip }, async () => {
  const t = makeTarball()
  const { srv, base } = await serve(fileHandler(t.data))
  const asset = { name: 'z.tar.gz', sha256: t.sha, size: t.data.length }
  const mk = () => join(mkdtempSync(join(tmpdir(), 'rt-root-')), 'v')
  const go = (root, f) => core.installRuntime({ root, platform: process.platform, arch: process.arch, lock: lockSmall, lib: {}, asset, baseUrl: base, deps: f.deps })
  try {
    const r1 = mk()
    const f1 = fakeDeps({ pipFailures: 1 })
    await go(r1, f1)
    assert.equal(f1.calls.filter((c) => c.args[1] === 'pip').length, 2)
    assert.ok(existsSync(join(r1, '.ok')))
    const r2 = mk()
    await assert.rejects(go(r2, fakeDeps({ pipFailures: 5 })), /network down/)
    assert.ok(!existsSync(join(r2, '.ok')))
    const r3 = mk()
    await assert.rejects(go(r3, fakeDeps({ verifyOutput: 'nope' })), /import check/)
    assert.ok(!existsSync(join(r3, '.ok')))
  } finally {
    srv.close()
  }
})

test('install: cancel aborts the download and keeps the partial file for next time', { skip }, async () => {
  const t = makeTarball()
  const { srv, base } = await serve((req, res) => {
    res.writeHead(200, { 'content-length': t.data.length })
    res.write(t.data.subarray(0, 100_000)) // then stall
  })
  const root = join(mkdtempSync(join(tmpdir(), 'rt-root-')), 'v')
  const ac = new AbortController()
  try {
    const p = core.installRuntime({ root, platform: process.platform, arch: process.arch, lock: lockSmall, lib: {}, asset: { name: 'c.tar.gz', sha256: t.sha, size: t.data.length }, baseUrl: base, deps: fakeDeps().deps, signal: ac.signal, onProgress: () => ac.abort() })
    await assert.rejects(p, /cancelled/)
    assert.ok(!existsSync(join(root, '.ok')))
  } finally {
    srv.closeAllConnections?.()
    srv.close()
  }
})

test('python unit tests (LLM client always; PDF shims when run with the runtime python)', () => {
  const py = process.env.HUMANSTUDY_TEST_PYTHON || 'python3'
  const probe = spawnSync(py, ['-c', 'import sys; print(sys.version_info >= (3, 9))'], { encoding: 'utf8' })
  if (probe.status !== 0 || !probe.stdout.includes('True')) return console.log('  (no python >= 3.9; skipped)')
  const r = spawnSync(py, ['-m', 'unittest', 'discover', '-s', join(repo, 'pack/runtime/tests')], { encoding: 'utf8', cwd: repo })
  assert.equal(r.status, 0, r.stderr)
})
