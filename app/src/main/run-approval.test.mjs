// The relay's cap comes from what the main process can verify, so an edited approval cannot raise it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'run-approval-'))
await build({ entryPoints: [join(here, 'run-approval.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'a.mjs'), logLevel: 'error' })
const { approvedRunLimits } = await import(pathToFileURL(join(temp, 'a.mjs')).href)
const bytes = await readFile(join(here, '../shared/sample-program.json'))
await writeFile(join(temp, 'program.json'), bytes)
const programHash = createHash('sha256').update(bytes).digest('hex')
const approval = (plan, extra = {}) => `[Simulation scope approved]\n${JSON.stringify({ programId: 'x', programHash, studyId: 'exp-1', scope: [], plan, ...extra })}\nRun it`
test.after(() => rm(temp, { recursive: true, force: true }))

test('limits use the program\'s conditions and the chosen participants per condition', async () => {
  // sample-program.json: two conditions in exp-1.
  assert.deepEqual(await approvedRunLimits(temp, approval({ perCondition: 60, conditions: ['condition-harm', 'condition-help'], model: 'm' })), { participants: 120, tokens: 4_800_000, minutes: 30 })
})

test('a forged plan cannot raise the cap', async () => {
  const many = Array.from({ length: 50 }, (_, i) => `forged-${i}`)
  const honest = await approvedRunLimits(temp, approval({ perCondition: 60, conditions: ['condition-harm', 'condition-help'] }))
  assert.deepEqual(await approvedRunLimits(temp, approval({ perCondition: 60, conditions: many })), honest, 'extra conditions in the text are ignored')
  assert.deepEqual(await approvedRunLimits(temp, approval({ perCondition: 60 })), honest)
  for (const perCondition of [10000, 61, 0, -1, 2.5, '60', null])
    await assert.rejects(approvedRunLimits(temp, approval({ perCondition, conditions: many })), /whole number from 1 to 60/, String(perCondition))
  await assert.rejects(approvedRunLimits(temp, approval({ perCondition: 10 }, { programHash: 'f'.repeat(64) })), /changed after approval/)
  await assert.rejects(approvedRunLimits(temp, approval({ perCondition: 10 }, { studyId: 'nope' })), /unavailable/)
  await assert.rejects(approvedRunLimits(temp, '[Simulation scope approved]\nnot json'), /unreadable/)
})

test('v0.8: a protocol approval is capped by the arms of the hashed protocol.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'run-approval-protocol-'))
  try {
    const proto = await readFile(join(here, 'fixtures/protocol-mini/protocol.json')) // two arms
    await writeFile(join(dir, 'protocol.json'), proto)
    const protocolHash = createHash('sha256').update(proto).digest('hex')
    const text = (plan, extra = {}) => `[Simulation scope approved]\n${JSON.stringify({ protocolHash, plan, ...extra })}\nRun it`
    const honest = await approvedRunLimits(dir, text({ perCondition: 60 }))
    assert.equal(honest.participants, 120)
    assert.deepEqual(await approvedRunLimits(dir, text({ perCondition: 60, conditions: Array.from({ length: 50 }, (_, i) => `f${i}`) })), honest)
    await assert.rejects(approvedRunLimits(dir, text({ perCondition: 61 })), /whole number from 1 to 60/)
    await assert.rejects(approvedRunLimits(dir, text({ perCondition: 10 }, { protocolHash: 'f'.repeat(64) })), /changed after approval/)
    await assert.rejects(approvedRunLimits(dir, text({ perCondition: 10 }, { protocolHash: 7 })), /changed after approval/)
    await writeFile(join(dir, 'protocol.json'), '{"arms": []}')
    const empty = createHash('sha256').update('{"arms": []}').digest('hex')
    await assert.rejects(approvedRunLimits(dir, text({ perCondition: 10 }, { protocolHash: empty })), /no arms/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
