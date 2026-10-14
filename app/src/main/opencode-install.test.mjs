// Managed opencode download (opencode-install-core.ts): asset choice, resume, checksum retry, cancel.
//   node --test src/main/opencode-install.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'oc-install-test-'))
await build({ entryPoints: [join(here, 'opencode-install-core.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outdir: out, logLevel: 'error' })
const core = await import(pathToFileURL(join(out, 'opencode-install-core.js')).href)

const body = Buffer.alloc(300_000, 7)
const sha = createHash('sha256').update(body).digest('hex')

function serve(handler) {
  return new Promise((resolve) => {
    const srv = createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/f.zip` }))
  })
}
const plain = (req, res) => {
  const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
  const from = m ? Number(m[1]) : 0
  res.writeHead(m ? 206 : 200)
  res.end(body.subarray(from))
}

test('asset selection', () => {
  assert.equal(core.pickAsset('darwin', 'arm64', false).name, 'opencode-humanstudy-darwin-arm64.zip')
  assert.equal(core.pickAsset('darwin', 'x64', true).name, 'opencode-humanstudy-darwin-x64.zip')
  assert.equal(core.pickAsset('darwin', 'x64', false).name, 'opencode-humanstudy-darwin-x64-baseline.zip')
  assert.equal(core.pickAsset('win32', 'x64', true).name, 'opencode-humanstudy-windows-x64.zip')
  assert.equal(core.pickAsset('win32', 'x64', false).name, 'opencode-humanstudy-windows-x64-baseline.zip')
  assert.equal(core.pickAsset('win32', 'arm64', true).name, 'opencode-humanstudy-windows-arm64.zip')
  assert.equal(core.pickAsset('linux', 'x64', true), null)
  assert.equal(core.binaryName('win32'), 'opencode.exe')
  assert.equal(core.KERNEL_TAG, 'hs-v1.19.0')
  assert.equal(core.KERNEL_VERSION, '1.19.0')
  assert.equal(core.RELEASE_BASE, 'https://github.com/HumanStudy-Hub/opencode/releases/download/hs-v1.19.0')
  assert.equal(core.assetUrl({ name: 'a.zip' }), `${core.RELEASE_BASE}/a.zip`)
})

test('SHA256SUMS lookup', async () => {
  const sums = `${'a'.repeat(64)}  opencode-humanstudy-darwin-arm64.zip\n${'B'.repeat(64)} *opencode-humanstudy-windows-x64.zip\r\n`
  assert.equal(core.parseChecksum(sums, 'opencode-humanstudy-darwin-arm64.zip'), 'a'.repeat(64))
  assert.equal(core.parseChecksum(sums, 'opencode-humanstudy-windows-x64.zip'), 'b'.repeat(64))
  assert.equal(core.parseChecksum(sums, 'opencode-humanstudy-darwin-x64.zip'), null)
  const srv = createServer((req, res) => {
    res.writeHead(req.url === '/SHA256SUMS.txt' ? 200 : 404)
    res.end(sums)
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  assert.equal(await core.fetchChecksum('opencode-humanstudy-darwin-arm64.zip', { base }), 'a'.repeat(64))
  await assert.rejects(core.fetchChecksum('nope.zip', { base }), /no entry/)
  await assert.rejects(core.fetchChecksum('x.zip', { base: base + '/missing' }), /HTTP 404/)
  srv.close()
})

test('size comes from Content-Length when not given', async () => {
  const { srv, url } = await serve((req, res) => {
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    const from = m ? Number(m[1]) : 0
    res.writeHead(m ? 206 : 200, { 'content-length': body.length - from })
    res.end(body.subarray(from))
  })
  const dir = mkdtempSync(join(tmpdir(), 'dl-'))
  const dest = join(dir, 'f.zip')
  const totals = new Set()
  writeFileSync(dest + '.part', body.subarray(0, 100_000))
  await core.downloadVerified({ url, dest, sha256: sha, onProgress: (_r, t) => totals.add(t) })
  assert.ok(readFileSync(dest).equals(body))
  assert.deepEqual([...totals], [body.length])
  srv.close()
})

test('downloads and verifies', async () => {
  const { srv, url } = await serve(plain)
  const dir = mkdtempSync(join(tmpdir(), 'dl-'))
  const dest = join(dir, 'f.zip')
  const seen = []
  await core.downloadVerified({ url, dest, size: body.length, sha256: sha, onProgress: (r) => seen.push(r) })
  assert.ok(readFileSync(dest).equals(body))
  assert.ok(!existsSync(dest + '.part'))
  assert.equal(seen.at(-1), body.length)
  srv.close()
})

test('resumes a partial file with a Range request', async () => {
  let ranged = ''
  const { srv, url } = await serve((req, res) => {
    ranged = req.headers.range ?? ''
    plain(req, res)
  })
  const dir = mkdtempSync(join(tmpdir(), 'dl-'))
  const dest = join(dir, 'f.zip')
  writeFileSync(dest + '.part', body.subarray(0, 100_000))
  await core.downloadVerified({ url, dest, size: body.length, sha256: sha })
  assert.equal(ranged, 'bytes=100000-')
  assert.ok(readFileSync(dest).equals(body))
  srv.close()
})

test('a corrupt partial file is discarded and re-downloaded', async () => {
  const { srv, url } = await serve(plain)
  const dir = mkdtempSync(join(tmpdir(), 'dl-'))
  const dest = join(dir, 'f.zip')
  writeFileSync(dest + '.part', Buffer.alloc(100_000, 9)) // wrong bytes
  await core.downloadVerified({ url, dest, size: body.length, sha256: sha })
  assert.ok(readFileSync(dest).equals(body))
  srv.close()
})

test('a wrong checksum fails after one retry and leaves nothing behind', async () => {
  let hits = 0
  const { srv, url } = await serve((req, res) => {
    hits++
    plain(req, res)
  })
  const dir = mkdtempSync(join(tmpdir(), 'dl-'))
  const dest = join(dir, 'f.zip')
  await assert.rejects(core.downloadVerified({ url, dest, size: body.length, sha256: 'ab'.repeat(32) }), /SHA-256/)
  assert.equal(hits, 2)
  assert.ok(!existsSync(dest) && !existsSync(dest + '.part'))
  srv.close()
})

test('cancel keeps the partial file for a later resume', async () => {
  const { srv, url } = await serve((req, res) => {
    res.writeHead(200)
    res.write(body.subarray(0, 50_000))
    setTimeout(() => res.end(body.subarray(50_000)), 400)
  })
  const dir = mkdtempSync(join(tmpdir(), 'dl-'))
  const dest = join(dir, 'f.zip')
  const ac = new AbortController()
  const p = core.downloadVerified({ url, dest, size: body.length, sha256: sha, signal: ac.signal, onProgress: () => ac.abort() })
  await assert.rejects(p, (e) => e instanceof core.InstallCancelled)
  assert.ok(existsSync(dest + '.part'))
  srv.closeAllConnections()
  srv.close()
})

test('cleanup', () => rmSync(out, { recursive: true, force: true }))
