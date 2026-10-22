// Located is not verified: numbers, decimals, signs and comparison operators are compared exactly.
// node src/shared/significant-tokens.test.mjs
import { build } from 'esbuild'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'significant-'))
process.on('exit', () => rmSync(out, { recursive: true, force: true }))
await build({ entryPoints: [join(here, 'significant-tokens.ts'), join(here, 'source-anchor.ts')], bundle: true, platform: 'node', format: 'esm', outdir: out, logLevel: 'error', outExtension: { '.js': '.mjs' } })
const { significantTokens, compareSignificant } = await import(pathToFileURL(join(out, 'significant-tokens.mjs')).href)
const { findQuote, quoteRects, locateQuote } = await import(pathToFileURL(join(out, 'source-anchor.mjs')).href)
const page = (text, n = 1) => ({ page: n, words: text.split(/\s+/).filter(Boolean).map((t, i) => ({ t, x: (i % 10) * 9, y: 10 + Math.floor(i / 10) * 3, w: 8, h: 2 })) })
const changed = (parts) => parts.filter((p) => p.changed).map((p) => p.t)
const source = page('Participants in the anchoring condition gave higher estimates, t(38) = 2.45, p<.001, d = 0.78, with 45% choosing the high option.')

test('a quote with a reversed comparison sign is located but flagged, with the differing tokens', () => {
  const right = findQuote([source], 'gave higher estimates, t(38) = 2.45, p<.001, d = 0.78', 1)
  assert.equal(right.page, 1)
  assert.equal(right.differs, undefined, 'an exact quote must not be flagged')
  const wrong = findQuote([source], 'gave higher estimates, t(38) = 2.45, p>.001, d = 0.78', 1)
  assert.ok(wrong && wrong.rects.length, 'the passage is still located')
  assert.ok(wrong.differs, 'p>.001 against p<.001 must be flagged')
  assert.deepEqual(changed(wrong.differs.quote), ['>'])
  assert.deepEqual(changed(wrong.differs.source), ['<'])
})

test('numbers, decimals, minus signs and percentages are compared exactly', () => {
  for (const [quote, q, s] of [
    ['gave higher estimates, t(38) = 24.5, p<.001', ['24.5'], ['2.45']],
    ['with 4.5% choosing the high option', ['4.5%'], ['45%']],
    ['d = 0.78, with 45 choosing', ['45'], ['45%']],
    ['gave higher estimates, t(38) = -2.45, p<.001', ['-2.45'], ['2.45']],
  ]) {
    const hit = findQuote([source], quote, 1)
    assert.ok(hit, quote)
    assert.ok(hit.differs, `not flagged: ${quote}`)
    assert.deepEqual(changed(hit.differs.quote), q, quote)
    assert.deepEqual(changed(hit.differs.source), s, quote)
  }
  // Digits that differ are not the same passage at all: nothing is located.
  assert.equal(findQuote([source], 'gave higher estimates, t(38) = 2.54, p<.001', 1), null)
  // A quote that stops inside a number does not silently agree with the longer source value.
  const cut = findQuote([page('the effect was p = .045 overall in both samples')], 'the effect was p = .04', 1)
  assert.ok(cut?.differs, 'a truncated number must be flagged')
  assert.deepEqual(changed(cut.differs.source), ['.045'])
})

test('PDF extraction quirks are normalised without conflating < and >', () => {
  // Unicode minus, ligature, ≤ spelled two ways, a split decimal, a spaced percent sign.
  const pdf = page('the ﬁrst effect was r = −0.21, p ≤ .05, and 12 % of the sample reported it')
  const hit = findQuote([pdf], 'the first effect was r = -0.21, p <= .05, and 12% of the sample', 1)
  assert.ok(hit, 'located across a ligature')
  assert.equal(hit.differs, undefined, JSON.stringify(hit.differs))
  assert.equal(findQuote([page('scores were p < . 001 in all conditions')], 'scores were p < .001 in all', 1).differs, undefined)
  assert.notDeepEqual(significantTokens('p < .001'), significantTokens('p > .001'))
  assert.notDeepEqual(significantTokens('p ≤ .05'), significantTokens('p ≥ .05'))
  assert.deepEqual(significantTokens('ages 18–25 and a t-test'), ['18', '25'], 'range dash and hyphen are not minus signs')
  assert.deepEqual(significantTokens('M = 3.2 ± 0.4, η² = .12'), ['=', '3.2', '±', '0.4', 'η', '2', '=', '.12'])
  assert.equal(compareSignificant('η² = .12', 'η2 = .12'), null)
})

test('text without significant tokens and abbreviated quotes still behave as before', () => {
  const words = page('This is a long original sentence about anchoring. Later on, a second long sentence closes it.').words
  assert.ok(quoteRects(words, 'long original sentence about anchoring').length)
  const parts = locateQuote(words, 'This is a long original sentence … a second long sentence closes it')
  assert.equal(parts.parts.length, 2)
  const abbreviated = findQuote([page('first we saw p<.01 here and then later we saw p<.05 there')], 'first we saw p<.01 here … later we saw p>.05 there', 1)
  assert.ok(abbreviated?.differs, 'each ellipsis part is compared')
  assert.deepEqual(changed(abbreviated.differs.quote), ['>'])
})
