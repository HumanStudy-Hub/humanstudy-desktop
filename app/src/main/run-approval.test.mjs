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
// One bundle, so the test configures the same protocol checks the approval reads.
await writeFile(join(temp, 'entry.ts'), `export { approvedRunLimits } from ${JSON.stringify(join(here, 'run-approval.ts'))}\nexport { configureProtocolChecks } from ${JSON.stringify(join(here, 'package-readiness.ts'))}\n`)
await build({ entryPoints: [join(temp, 'entry.ts')], bundle: true, platform: 'node', format: 'esm', outfile: join(temp, 'a.mjs'), logLevel: 'error' })
const { approvedRunLimits, configureProtocolChecks } = await import(pathToFileURL(join(temp, 'a.mjs')).href)
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

test('review 2 M3: a protocol approval is capped by the measured budget of the hashed protocol.json, for the approved figure only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'run-approval-protocol-'))
  // Two arms; one with groups of 3. Per member: 30 calls, 100,000 tokens.
  configureProtocolChecks(async () => [], 't', async () => ({ arms: { control: { group_size: 1, calls: 30, tokens_per_member: 100_000 }, team: { group_size: 3, calls: 30, tokens_per_member: 100_000 } }, output_tokens: 512 }))
  try {
    const proto = await readFile(join(here, 'fixtures/protocol-mini/protocol.json'))
    await writeFile(join(dir, 'protocol.json'), proto)
    const protocolHash = createHash('sha256').update(proto).digest('hex')
    const text = (plan, extra = {}) => `[Simulation scope approved]\n${JSON.stringify({ route: 'protocol', protocolHash, plan, ...extra })}\nRun it`
    // 10 per arm: 10 + 30 members x 100,000 + a 4-member trial = 4,400,000 tokens.
    const limits = await approvedRunLimits(dir, text({ perCondition: 10, tokenBudget: 4_400_000 }))
    assert.deepEqual([limits.participants, limits.tokens], [40, 4_400_000])
    await assert.rejects(approvedRunLimits(dir, text({ perCondition: 10, tokenBudget: 16_000_000 })), /approved token budget is not this run's/)
    await assert.rejects(approvedRunLimits(dir, text({ perCondition: 10 })), /approved token budget/)
    await assert.rejects(approvedRunLimits(dir, text({ perCondition: 60, tokenBudget: 16_000_000 })), /would need 24,400,000 tokens/)
    await assert.rejects(approvedRunLimits(dir, text({ perCondition: 61 })), /whole number from 1 to 60/)
    await assert.rejects(approvedRunLimits(dir, text({ perCondition: 10, tokenBudget: 4_400_000 }, { protocolHash: 'f'.repeat(64) })), /changed after approval/)
    await assert.rejects(approvedRunLimits(dir, text({ perCondition: 10, tokenBudget: 4_400_000 }, { protocolHash: 7 })), /changed after approval/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
