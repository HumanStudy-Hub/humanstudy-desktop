// Installs the research runtime into a folder, outside Electron (developers, CI, smoke tests):
//   node scripts/install-runtime.mjs <dir>
// <dir> becomes the runtime root; <dir>/bin goes on PATH. Same code path as the app's first run.
import { build } from 'esbuild'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pack = resolve(here, '../../pack/runtime')
const out = mkdtempSync(join(tmpdir(), 'hs-runtime-core-'))
await build({ entryPoints: [join(here, '../src/main/runtime-core.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node20', outdir: out, logLevel: 'error' })
const core = await import(pathToFileURL(join(out, 'runtime-core.js')).href)
const root = resolve(process.argv[2] ?? '')
if (!process.argv[2]) throw new Error('usage: node scripts/install-runtime.mjs <dir>')
const lib = Object.fromEntries(readdirSync(join(pack, 'lib')).filter((n) => n.endsWith('.py')).map((n) => [n, readFileSync(join(pack, 'lib', n), 'utf8')]))
const lock = readFileSync(join(pack, 'requirements.lock'), 'utf8')
let last = ''
const t0 = Date.now()
await core.installRuntime({
  root, platform: process.platform, arch: process.arch, lock, lib,
  onProgress: (p) => { const s = `${p.phase} ${p.percent}%`; if (s !== last) { last = s; console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${s}`) } },
})
console.log('installed', core.runtimeVersion(lock), 'into', root)
