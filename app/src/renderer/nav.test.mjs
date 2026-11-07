// Back (nav.ts): newest place first, skips places that no longer exist, never records while restoring.
//   node src/renderer/nav.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const out = mkdtempSync(join(tmpdir(), 'nav-'))
await build({ entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'nav.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'nav.mjs'), logLevel: 'error' })
const nav = await import(pathToFileURL(join(out, 'nav.mjs')).href)
let clock = 0
const realNow = Date.now
Date.now = () => (clock += 1000)

test('back returns to the newest place first', () => {
  nav.resetNav()
  const seen = []
  nav.remember('project', () => seen.push('study'))
  nav.remember('project', () => seen.push('paper p.4'))
  assert.equal(nav.goBack(), true)
  assert.equal(nav.goBack(), true)
  assert.equal(nav.goBack(), false)
  assert.deepEqual(seen, ['paper p.4', 'study'])
})

test('a place that no longer exists is skipped in the same keypress', () => {
  nav.resetNav()
  const seen = []
  nav.remember('app', () => seen.push('projects'))
  nav.remember('library', () => false)
  assert.equal(nav.goBack(), true)
  assert.deepEqual(seen, ['projects'])
})

test('restoring a place records nothing, and forget drops one scope', () => {
  nav.resetNav()
  const seen = []
  nav.remember('app', () => seen.push('projects'))
  nav.remember('project', () => { nav.remember('project', () => seen.push('ghost')); seen.push('tab') })
  nav.remember('project', () => seen.push('citation'))
  nav.forget('project')
  assert.equal(nav.goBack(), true)
  assert.deepEqual(seen, ['projects'])
  nav.remember('project', () => { nav.remember('project', () => seen.push('ghost')); seen.push('tab') })
  nav.goBack()
  assert.equal(nav.goBack(), false, 'the place recorded during a restore was ignored')
  assert.deepEqual(seen, ['projects', 'tab'])
})

test('a declined place stays for the next Back', () => {
  nav.resetNav()
  let tries = 0
  nav.remember('app', () => (++tries === 1 ? 'keep' : true))
  assert.equal(nav.goBack(), true)
  assert.equal(nav.goBack(), true)
  assert.equal(nav.goBack(), false)
  assert.equal(tries, 2)
})

test('one ⌘[ seen by both the menu and the page moves back once', () => {
  nav.resetNav()
  let t = 0
  Date.now = () => t
  const seen = []
  nav.remember('project', () => seen.push('a'))
  nav.remember('project', () => seen.push('b'))
  t = 1000; nav.goBack()
  t = 1050; nav.goBack()
  assert.deepEqual(seen, ['b'], 'within 120 ms: one Back')
  t = 1300; nav.goBack()
  assert.deepEqual(seen, ['b', 'a'], 'a quick second press still moves back')
  Date.now = realNow
})
