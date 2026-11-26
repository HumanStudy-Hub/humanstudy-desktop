// node --test src/shared/participants-summary.test.mjs — the Simulation tab's one line on who takes part, from the
// app's participants.py check (the one implementation), and the hashes the approval carries.
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
const h = (c) => c.repeat(64)

test('the line shows the check\'s summary, or its problem, and the approval carries the hashes it read', () => {
  const ok = { ok: true, mode: 'paper', summary: 'Sample-matched: 120 US undergraduates, age ~20.4', participantsSha256: null, programSha256: h('a'), protocolSha256: h('b') }
  assert.deepEqual(P.whoLine(ok), { text: 'Sample-matched: 120 US undergraduates, age ~20.4' })
  assert.deepEqual(P.approvedHashes(ok), { participantsSha256: null, programSha256: h('a'), protocolSha256: h('b') })
  const bad = { ok: false, problem: 'the group id text names the condition "control"', participantsSha256: h('c'), programSha256: null, protocolSha256: h('b') }
  assert.equal(P.whoLine(bad).problem, 'the group id text names the condition "control"')
  assert.match(P.whoLine(null).problem, /could not be checked/)
})
