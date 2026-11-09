// node --test src/main/run-stop.test.mjs — the researcher's Stop closes the run's model access at once (v0.8).
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'run-stop-'))
await build({ entryPoints: [join(here, 'run-stop.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 's.mjs'), logLevel: 'error' })
const S = await import(pathToFileURL(join(out, 's.mjs')).href)

test('only the STOP file of a run folder is a stop', () => {
  const p = '/u/proj'
  assert.equal(S.isRunStop(p, '/u/proj/artifacts/simulations/2026-11-09-0100/STOP'), true)
  for (const q of ['/u/proj/artifacts/simulations/STOP', '/u/proj/artifacts/simulations/r/sub/STOP', '/u/proj/STOP',
    '/u/proj/artifacts/simulations/r/STOP.md', '/u/other/artifacts/simulations/r/STOP', '/u/proj/artifacts/simulations/r/stop'])
    assert.equal(S.isRunStop(p, q), false, q)
})

test('Stop closes every relay of that project and no other', async () => {
  const relays = new Map([['a', { project: '/u/proj' }], ['b', { project: '/u/other' }], ['c', { project: '/u/proj/' }]])
  const closed = []
  const ids = await S.closeProjectRelays('/u/proj', relays, async (id) => { closed.push(id); relays.delete(id) })
  assert.deepEqual(ids, ['a', 'c'])
  assert.deepEqual(closed, ['a', 'c'])
  assert.deepEqual([...relays.keys()], ['b'])
})

test('the Stop path of project:writeText closes the relays (wiring)', async () => {
  const { readFileSync } = await import('node:fs')
  const index = readFileSync(join(here, 'index.ts'), 'utf8')
  const handler = index.slice(index.indexOf("ipcMain.handle('project:writeText'"), index.indexOf("ipcMain.handle('project:importFiles'"))
  assert.match(handler, /if \(stopRoot && isRunStop\(stopRoot, q\)\) await closeProjectRelays\(stopRoot, runRelays, closeRunRelay\)/)
  const panel = readFileSync(join(here, '../renderer/components/Workbench.tsx'), 'utf8')
  assert.match(panel, /window\.humanstudy\.project\.writeText\(`\$\{dir\}\/STOP`/, 'the Stop button writes STOP through that handler')
})

test('Stop matches projects by real path: a symlinked projects folder still closes the relay', async () => {
  const base = mkdtempSync(join(tmpdir(), 'run-stop-real-'))
  mkdirSync(join(base, 'real/proj'), { recursive: true })
  symlinkSync(join(base, 'real'), join(base, 'link'))
  const relays = new Map([['a', { project: join(base, 'link/proj') }], ['b', { project: join(base, 'real/other') }]])
  assert.deepEqual(await S.closeProjectRelays(join(base, 'real/proj'), relays, async (id) => { relays.delete(id) }), ['a'])
})
