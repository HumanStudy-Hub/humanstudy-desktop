//   node --test src/main/notify.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'notify-test-'))
await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'notify-core.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error' })
const { shouldNotify, notifyTitle } = await import(pathToFileURL(join(out, 'notify-core.js')).href)
rmSync(out, { recursive: true, force: true })

test('only a finished turn in the background notifies', () => {
  assert.equal(shouldNotify({ enabled: true, anyWindowFocused: false, eventType: 'done' }), true)
  assert.equal(shouldNotify({ enabled: true, anyWindowFocused: true, eventType: 'done' }), false)
  assert.equal(shouldNotify({ enabled: false, anyWindowFocused: false, eventType: 'done' }), false)
  assert.equal(shouldNotify({ enabled: true, anyWindowFocused: false, eventType: 'text' }), false)
})
test('title', () => assert.equal(notifyTitle('Study A'), 'Agent finished · Study A'))
