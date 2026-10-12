// node src/main/updates.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'updates-test-'))
await build({ entryPoints: [join(here, 'updates-core.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error' })
const U = await import(pathToFileURL(join(out, 'updates-core.js')).href)
assert.ok(U.isNoReleaseError('No published versions on GitHub'))
assert.ok(U.isNoReleaseError('Error: No published versions on GitHub\n  at foo'))
assert.ok(!U.isNoReleaseError('net::ERR_INTERNET_DISCONNECTED'))
assert.equal(U.shortError('net::ERR_INTERNET_DISCONNECTED\n    at x'), 'net::ERR_INTERNET_DISCONNECTED')
console.log('updates ok')
