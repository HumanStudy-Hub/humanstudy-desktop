import { build } from 'esbuild'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const temp = await mkdtemp(join(tmpdir(), 'artifact-guard-'))
await build({
  entryPoints: [fileURLToPath(new URL('artifact-interaction-guard.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'bundle.mjs'),
})
const { artifactVocabulary, screenInteraction, createInteractionGuard, DROPPED_INTERACTION, MAX_EVENTS_PER_REVISION } =
  await import(pathToFileURL(join(temp, 'bundle.mjs')).href)
test.after(() => rm(temp, { recursive: true, force: true }))

const event = (fields = {}) => ({ action: 'choose', controlId: 'colour', label: 'colour', step: null, arm: null, valueKind: 'choice', ...fields })
const page = `<!doctype html><body>
<select data-hs-control="colour" data-hs-label="Colour" data-hs-action="choose" data-hs-step="2" data-hs-arm="treatment"></select>
<button data-hs-control='next-step'>Next</button><span class="hs-cite" data-page="12">p. 12</span>
<script>var kit = { label: 'source-citation' }</script></body>`

test('declared ids, labels, arms and steps pass unchanged', () => {
  const v = artifactVocabulary(page)
  for (const e of [event(), event({ label: 'Colour', arm: 'treatment', step: 2 }), event({ action: 'submit', controlId: 'next-step', label: 'next-step' }),
    event({ action: 'navigate', controlId: 'source-page-12', label: 'source-citation' })])
    assert.deepEqual(screenInteraction(v, e), e)
})

test('a hostile artifact cannot spell typed text through the fields', () => {
  const v = artifactVocabulary(page)
  // Not declared anywhere in the file: kept only as an anonymous event.
  assert.deepEqual(screenInteraction(v, event({ controlId: 'my-password-is-hunter2', label: 'hunter2', arm: 'secret', step: 7 })),
    event({ controlId: 'unknown', label: 'unknown', arm: null, step: null }))
  // A declared control cannot carry free text in its label, arm or step.
  assert.deepEqual(screenInteraction(v, event({ label: 'typed-text', arm: 'typed', step: 99 })), event({ label: 'unknown' }))
  // Substrings of the code are not declarations, and neither are pages the file never cites.
  assert.equal(screenInteraction(v, event({ controlId: 'olou' })).controlId, 'unknown')
  // A citation to a page the file never names keeps the click but not the number.
  assert.deepEqual(screenInteraction(v, event({ action: 'navigate', controlId: 'source-page-13', label: 'source-citation', valueKind: 'none' })),
    event({ action: 'navigate', controlId: 'source-page', label: 'source-citation', valueKind: 'none' }))
  // Over-long labels are refused even when they appear in the file.
  const long = 'x'.repeat(41)
  assert.equal(screenInteraction(artifactVocabulary(`${page}<i data-x="${long}"></i>`), event({ label: long })).label, 'unknown')
  // Shape errors are still dropped.
  assert.equal(screenInteraction(v, { ...event(), extra: 1 }), null)
})

test('the experiment preview accepts only response and arm ids from its embedded protocol', async () => {
  const html = await readFile(fileURLToPath(new URL('../../resources/protocol-sample/artifacts/preview.html', import.meta.url)), 'utf8')
  const v = artifactVocabulary(html)
  assert.ok(v.preview, 'recognised as a participant preview')
  const data = JSON.parse(html.match(/id="hs-preview">([\s\S]*?)<\/script>/)[1])
  const arm = data.arms[0].id
  const response = Object.values(data.screens).flatMap(s => s.responses.map(r => r.id))[0]
  assert.ok(response && arm)
  const answer = { action: 'answer', controlId: response, label: 'response', step: 0, arm, valueKind: 'choice' }
  assert.deepEqual(screenInteraction(v, answer), answer)
  for (const e of [{ action: 'navigate', controlId: 'next', label: 'next', step: 1, arm, valueKind: 'choice' },
    { action: 'choose', controlId: 'arm', label: 'condition', step: null, arm: null, valueKind: 'choice' },
    { action: 'view', controlId: 'conditions', label: 'conditions', step: null, arm: null, valueKind: 'choice' },
    { action: 'toggle', controlId: 'technical-details', label: 'details', step: null, arm: null, valueKind: 'boolean' }])
    assert.deepEqual(screenInteraction(v, e), e)
  // An answer to something the protocol does not ask, or a preview-code literal used as an answer id.
  assert.equal(screenInteraction(v, { ...answer, controlId: 'not-a-response' }).controlId, 'unknown')
  assert.equal(screenInteraction(v, { ...answer, controlId: 'next' }).controlId, 'unknown')
  // Protocol text is not a vocabulary for labels; arms must be protocol arms; steps stay in range.
  assert.equal(screenInteraction(v, { ...answer, arm: 'next' }).arm, null)
  assert.equal(screenInteraction(v, { ...answer, step: 100000 }).step, null)

  // The compressed data block is read the same way.
  const raw = html.match(/<script type="application\/json" id="hs-preview">([\s\S]*?)<\/script>/)
  const blob = gzipSync(Buffer.from(raw[1].replace(/\\u003c/g, '<'))).toString('base64')
  const zipped = html.replace(raw[0], `<script type="application/json" id="hs-preview" data-encoding="gzip+base64">"${blob}"</script>`)
  assert.deepEqual(screenInteraction(artifactVocabulary(zipped), answer), answer)
})

test('the guard reads each revision once, caps volume and drops quick duplicates', async () => {
  let reads = 0, clock = 0
  const guard = createInteractionGuard(async () => { reads++; return page }, () => clock)
  assert.deepEqual(await guard('/p', 'artifacts/a.html', 'r1', event()), event())
  assert.equal(await guard('/p', 'artifacts/a.html', 'r1', event()), DROPPED_INTERACTION, 'duplicate within 1 s')
  clock += 999
  assert.equal(await guard('/p', 'artifacts/a.html', 'r1', event()), DROPPED_INTERACTION, 'a held repeat stays one event')
  clock += 1000
  assert.deepEqual(await guard('/p', 'artifacts/a.html', 'r1', event()), event(), 'after a pause it counts again')
  assert.equal(reads, 1)

  for (let i = 2; i < MAX_EVENTS_PER_REVISION; i++) {
    clock += 1
    assert.ok(await guard('/p', 'artifacts/a.html', 'r1', event({ step: i % 2 ? null : 2 })), `event ${i}`)
  }
  clock += 5000
  assert.equal(await guard('/p', 'artifacts/a.html', 'r1', event({ controlId: 'next-step', label: 'next-step' })), DROPPED_INTERACTION, 'cap reached')
  // A new revision is read again and has its own allowance.
  assert.deepEqual(await guard('/p', 'artifacts/a.html', 'r2', event()), event())
  assert.equal(reads, 2)
  // An unreadable artifact reports nothing.
  assert.equal(await createInteractionGuard(async () => null)('/p', 'artifacts/b.html', 'r1', event()), DROPPED_INTERACTION)
})

test('the shipped sample results page: citations built at runtime by HS.cite are kept', async () => {
  const html = await readFile(fileURLToPath(new URL('../../resources/sample/example-simulation/results.html', import.meta.url)), 'utf8')
  const v = artifactVocabulary(html)
  assert.equal(v.preview, undefined)
  const cite = (controlId) => ({ action: 'navigate', controlId, label: 'source-citation', step: null, arm: null, valueKind: 'none' })
  // A program item's citation posts its program id, which the embedded program declares.
  const pid = html.match(/"id": ?"(exp-1)"/)[1]
  assert.deepEqual(screenInteraction(v, cite(pid)), cite(pid))
  // The sample's evidence has no page numbers, so a page-only citation keeps only that it was a citation.
  assert.deepEqual(screenInteraction(v, cite('source-page-5')), cite('source-page'))
  // Pages and steps named in embedded JSON (rendered into data-page / data-hs-step at runtime) are kept.
  const withPages = html.replace('"page": null', '"page": 7').replace('</body>', '<script type="application/json">{"pages":[9, 10],"step":4}</script></body>')
  const w = artifactVocabulary(withPages)
  for (const page of [7, 9, 10]) assert.deepEqual(screenInteraction(w, cite(`source-page-${page}`)), cite(`source-page-${page}`))
  assert.deepEqual(screenInteraction(w, cite('source-page-8')), cite('source-page'))
  assert.equal(screenInteraction(w, { ...cite(pid), step: 4 }).step, 4)
  assert.equal(screenInteraction(w, { ...cite(pid), step: 5 }).step, null)
})

test('draft and history views report nothing, and a failed read is retried', async () => {
  let reads = 0, text = null
  const guard = createInteractionGuard(async () => { reads++; return text })
  assert.equal(await guard('/p', 'artifacts/a.html', 'draft', event()), DROPPED_INTERACTION)
  assert.equal(await guard('/p', 'artifacts/a.html', 'history:abc', event()), DROPPED_INTERACTION)
  assert.equal(reads, 0, 'the on-disk file is never read for in-memory text')
  assert.equal(await guard('/p', 'artifacts/a.html', 'r1', event()), DROPPED_INTERACTION, 'unreadable')
  await new Promise(resolve => setImmediate(resolve))
  text = page
  assert.deepEqual(await guard('/p', 'artifacts/a.html', 'r1', event()), event(), 'read again after a failure')
  assert.equal(reads, 2)
})

test('a compressed preview block cannot expand without bound', () => {
  const huge = gzipSync(Buffer.from(JSON.stringify({ arms: [{ id: 'a', pad: 'x'.repeat(9 * 1024 * 1024) }], screens: {} })))
  const html = `<meta name="hs-artifact" content="participant-preview"><script type="application/json" id="hs-preview" data-encoding="gzip+base64">"${huge.toString('base64')}"</script>`
  assert.equal(artifactVocabulary(html).preview, undefined, 'over the limit: treated as an ordinary page')
})

test('a replay preserves the guard decision after the dedupe window', async () => {
  let now = 0
  const guard = createInteractionGuard(async () => page, () => now)
  const deliver = id => guard('/p', 'artifacts/a.html', 'r1', event(), id)
  assert.deepEqual(await deliver('first'), event())
  assert.equal(await deliver('duplicate'), DROPPED_INTERACTION)
  now += 2000
  assert.equal(await deliver('duplicate'), DROPPED_INTERACTION)
  assert.deepEqual(await deliver('first'), event())
  assert.deepEqual(await deliver('new-event'), event())
})
