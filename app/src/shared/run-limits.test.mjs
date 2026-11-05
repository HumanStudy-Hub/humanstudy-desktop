// The relay's run limits follow the approved plan; the main process passes them to the relay and the
// Simulation tab states the same figures in the run confirmation.
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'run-limits-'))
await build({ entryPoints: [join(here, 'run-limits.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'l.mjs'), logLevel: 'error' })
const L = await import(pathToFileURL(join(out, 'l.mjs')).href)

test('limits scale with the approved participants, between a floor and a ceiling', () => {
  assert.deepEqual(L.runLimits({ conditions: ['a', 'b'], perCondition: 2 }), { participants: 4, tokens: 200_000, minutes: 30 })
  assert.deepEqual(L.runLimits({ conditions: ['a', 'b'], perCondition: 60 }), { participants: 120, tokens: 4_800_000, minutes: 30 })
  assert.deepEqual(L.runLimits({ conditions: ['a', 'b', 'c', 'd', 'e'], perCondition: 60 }), { participants: 300, tokens: 12_000_000, minutes: 60 })
  assert.deepEqual(L.runLimits({ conditions: Array(10).fill('x'), perCondition: 60 }), { participants: 600, tokens: L.MAX_RUN_TOKENS, minutes: L.MAX_RUN_MINUTES })
  assert.deepEqual(L.runLimits({ conditions: [], perCondition: 20 }), { participants: 20, tokens: 800_000, minutes: 30 }, 'one group')
})

test('an unreadable plan gets the floor, never more', () => {
  for (const plan of [null, undefined, {}, { perCondition: '999' }, { perCondition: -5 }, { perCondition: 1.5 }, { perCondition: 1e300 }, { conditions: 'abc', perCondition: 1 }])
    assert.deepEqual(L.runLimits(plan), { participants: 1, tokens: L.MIN_RUN_TOKENS, minutes: L.MIN_RUN_MINUTES }, JSON.stringify(plan))
  assert.ok(L.runLimits({ conditions: Array(1e5).fill('x'), perCondition: 1e6 }).tokens <= L.MAX_RUN_TOKENS)
  assert.equal(L.formatTokens(7_500_000), '7,500,000')
})

test('the main process starts the relay with the plan limits', () => {
  const main = readFileSync(join(here, '../main/index.ts'), 'utf8')
  assert.match(main, /const limits = runLimits\(approved\.plan\)/)
  assert.match(main, /tokenCap: limits\.tokens, expiryMinutes: limits\.minutes/)
})
