// node --test src/shared/participants-summary.test.mjs — the Simulation tab's one line on who takes part.
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'participants-summary-'))
await build({ entryPoints: [join(here, 'participants-summary.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(out, 'p.mjs'), logLevel: 'error' })
const P = await import(pathToFileURL(join(out, 'p.mjs')).href)

test('no file: sample-matched to the paper, from its own description', () => {
  const protocol = { meta: { sample: '120 US undergraduates (M age = 20.4, SD = 1.8; 62% female).' } }
  assert.deepEqual(P.participantsSummary(null, protocol), { mode: 'paper', text: 'Sample-matched: US undergraduates, age ~20.4' })
  const mturk = { meta: { sample: { n_analysed: 586, population: 'Amazon Mechanical Turk workers (Study 1: 228 men, 171 women, mean age 32.3; Study 2: 230 men)' } } }
  assert.equal(P.participantsSummary(null, mturk).text, 'Sample-matched: Amazon Mechanical Turk workers')
  const program = { nodes: [{ kind: 'participants', fields: [{ id: 'n-analysed', value: '78' }, { id: 'population', value: 'People in a Manhattan park.', state: 'check' }] }] }
  assert.equal(P.participantsSummary(null, { meta: {} }, program).text, 'Sample-matched: People in a Manhattan park')
  assert.equal(P.participantsSummary(null, null).text, 'Sample-matched: the paper does not describe its participants')
  assert.equal(P.participantsSummary('{"mode":"paper","system":"Be {{persona}}"}', protocol).text, 'Sample-matched: US undergraduates, age ~20.4; own system prompt')
})

test('the shown summary carries the hashes of the files it was read from', async () => {
  const { createHash } = await import('node:crypto')
  const h = (t) => createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex')
  const spec = JSON.stringify({ mode: 'blank' }) + '\n'
  const program = '{"nodes": [{"kind": "participants", "fields": [{"id": "population", "value": "Nurses in Lyon é."}]}]}'
  const shown = await P.shownParticipants({ participants: spec, protocol: '{"meta": {}}', program }, 'stamp-1')
  assert.deepEqual(shown, { mode: 'blank', text: 'Blank: the model with no persona (for comparison)', stamp: 'stamp-1', participantsSha256: h(spec), programSha256: h(program) })
  const paper = await P.shownParticipants({ participants: null, protocol: null, program }, 's')
  assert.equal(paper.text, 'Sample-matched: Nurses in Lyon é')
  assert.equal(paper.participantsSha256, null)
  assert.equal(await P.sha256Hex('é'), h('é'))
})

test('custom groups, blank, and a file with a problem', () => {
  const spec = { mode: 'custom', groups: [{ id: 'students', label: 'Students', weight: 3, persona: 'x' }, { id: 'retirees', weight: 1, persona: 'y' }] }
  assert.deepEqual(P.participantsSummary(JSON.stringify(spec), null), { mode: 'custom', text: 'Custom: 2 groups (Students 75%, retirees 25%)' })
  assert.equal(P.participantsSummary('{"mode":"blank"}', null).text, 'Blank: the model with no persona (for comparison)')
  assert.match(P.participantsSummary('{oops', null).problem, /not valid JSON/)
  assert.match(P.participantsSummary('{"mode":"crowd"}', null).problem, /unknown mode/)
  assert.match(P.participantsSummary('{"mode":"custom","groups":[]}', null).problem, /no groups/)
})
