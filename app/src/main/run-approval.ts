// The relay's limits for an approved simulation, from what the main process can verify: the
// participants per condition the researcher chose (only values the Simulation tab offers) and the
// conditions of the hashed program.json (or the arms of the hashed protocol.json), never the condition list or
// numbers in the approval text.
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { approvalRoute, approvedProtocolLimits, protocolBudgetFor } from './package-readiness'
import { simulationPlan } from '../shared/simulation-run'
import { MAX_PER_CONDITION, runLimits, type RunLimits } from '../shared/run-limits'

export async function approvedRunLimits(projectDir: string, approvalText: string): Promise<RunLimits> {
  let approved: { route?: unknown; studyId?: unknown; programHash?: unknown; protocolHash?: unknown; plan?: { perCondition?: unknown; tokenBudget?: unknown } }
  try { approved = JSON.parse(approvalText.split('\n')[1] ?? '') } catch { throw Error('Simulation approval is unreadable. Review the simulation scope again.') }
  const per = approved?.plan?.perCondition
  if (!Number.isSafeInteger(per) || (per as number) < 1 || (per as number) > MAX_PER_CONDITION)
    throw Error(`Participants per condition must be a whole number from 1 to ${MAX_PER_CONDITION}. Review the simulation scope again.`)
  // A protocol approval (protocol route, v0.8): limits from the measured budget of the hashed protocol.json, and only
  // for the token figure the researcher approved (review 2, M3).
  if (approvalRoute(approved ?? {}) === 'protocol') {
    const bytes = await readFile(join(projectDir, 'protocol.json')).catch(() => null)
    if (!bytes || typeof approved.protocolHash !== 'string' || approved.protocolHash !== createHash('sha256').update(bytes).digest('hex'))
      throw Error('The study changed after approval. Review the simulation scope again.')
    return approvedProtocolLimits(await protocolBudgetFor(projectDir), approved.plan)
  }
  const bytes = await readFile(join(projectDir, 'program.json'))
  if (typeof approved.programHash !== 'string' || approved.programHash !== createHash('sha256').update(bytes).digest('hex'))
    throw Error('The study changed after approval. Review the simulation scope again.')
  const program = JSON.parse(bytes.toString('utf8'))
  if (typeof approved.studyId !== 'string' || !program.studies?.some((s: { id: string }) => s.id === approved.studyId))
    throw Error('The selected study is unavailable. Review the simulation scope again.')
  const conditions = [...new Set(simulationPlan(program, approved.studyId).conditions.map((c) => c.id))]
  return runLimits({ conditions, perCondition: per })
}

