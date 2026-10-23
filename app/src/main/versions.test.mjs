// node src/main/versions.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'versions-test-'))
await build({ entryPoints: [join(here, 'versions.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'versions.mjs'), logLevel: 'error' })
const V = await import(pathToFileURL(join(out, 'versions.mjs')).href)

const root = mkdtempSync(join(tmpdir(), 'proj-'))
mkdirSync(join(root, 'artifacts'))
const f = join(root, 'artifacts', 'flow.html')
assert.equal(V.isVersioned('artifacts/flow.html'), true)
assert.equal(V.isVersioned('AGENTS.md'), false)
assert.equal(V.isVersioned('artifacts/simulations/2026-10-22-1000/progress.json'), false, 'run heartbeat is not a version')
assert.equal(V.isVersioned('artifacts/simulations/2026-10-22-1000/report.md'), true)
assert.equal(V.isVersioned('program.json.tmp'), false)
writeFileSync(f, '<h1>one</h1>')
assert.equal((await V.snapshot(root, 'artifacts/flow.html', 1000)).id.endsWith('.html'), true)
assert.equal(await V.snapshot(root, 'artifacts/flow.html', 2000), null) // unchanged: no new version
writeFileSync(f, '<h1>two</h1>')
await V.snapshot(root, 'artifacts/flow.html', 3000)
writeFileSync(f, '<h1>three</h1>')
await V.snapshot(root, 'artifacts/flow.html', 3000) // same millisecond still gets its own id
const list = await V.versionsOf(root, 'artifacts/flow.html')
assert.equal(list.length, 3)
assert.equal(await V.readVersion(root, 'artifacts/flow.html', list[0].id), '<h1>one</h1>')
await assert.rejects(V.readVersion(root, 'artifacts/flow.html', '../../x'))
// a file that had no history gets its current state as v1 on first look
writeFileSync(join(root, 'artifacts', 'old.md'), '# old')
assert.equal((await V.versionsOf(root, 'artifacts/old.md')).length, 1)
console.log('versions tests passed')
