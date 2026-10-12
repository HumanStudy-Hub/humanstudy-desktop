// node src/shared/display-path.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'display-path-'))
await build({ entryPoints: [join(here, 'display-path.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error' })
const { displayPath: d } = await import(pathToFileURL(join(out, 'display-path.js')).href)

const proj = '/Users/me/HumanStudy/paper'
const home = '/Users/me'
assert.equal(d(`${proj}/notes/a.md`, proj, home), 'notes/a.md')
assert.equal(d(`${proj}/`, proj, home), '.')
assert.equal(d('/Users/me/Downloads/x.pdf', proj, home), '~/Downloads/x.pdf')
assert.equal(d('/etc/hosts', proj, home), '/etc/hosts')
assert.equal(d('src/a.ts', proj, home), 'src/a.ts')
assert.equal(d('Users/me/HumanStudy/paper/program.json', proj, home), 'program.json') // leading slash lost upstream
assert.equal(d('Users/me/Downloads/x.pdf', proj, home), '~/Downloads/x.pdf')
assert.equal(d('/Users/me/HumanStudy/paper2/a', proj, home), '~/HumanStudy/paper2/a') // sibling, not inside
assert.equal(d('/tmp/x', null, null), '/tmp/x')
console.log('display-path ok')
