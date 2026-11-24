import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { KernelEvent } from './kernel-types'
import { validateHumanProgram } from '../shared/human-program'
import type { PaperBuildState } from '../preload/types'
export const BUILD_PROMPT = 'Build the Human Program from paper.pdf now. Read the full paper locally, identify all studies, and save program.json incrementally using the build skill and program_io.py. Validate it before reporting completion. Record unstated facts as review issues; do not ask me again whether to begin. Do not run a simulation.'
const file = (dir: string) => join(dir, '.humanstudy', 'paper-build.json')
export function readPaperBuild(dir: string): PaperBuildState | undefined {
  try { return JSON.parse(readFileSync(file(dir), 'utf8')) } catch { return undefined }
}
export function writePaperBuild(dir: string, state: PaperBuildState): void {
  const target = file(dir)
  writeFileSync(target + '.tmp', JSON.stringify(state))
  renameSync(target + '.tmp', target)
}
export function pendingPaperBuild(dir: string): void { writePaperBuild(dir, { status: 'pending', phase: 'reading' }) }
export function createPaperBuilds(changed: (dir: string) => void) {
  const projects = new Map<string, string>()
  const activeClaims = new Set<string>()
  const running = new Set<string>()
  const save = (dir: string, state: PaperBuildState) => { writePaperBuild(dir, state); changed(dir) }
  return {
    bind: (session: string, dir: string) => { projects.set(session, dir) },
    claim(dir: string, sessionId: string) {
      if (projects.get(sessionId) !== dir) throw new Error('The study session belongs to a different project.')
      const state = readPaperBuild(dir)
      if (!state) return null
      const abandonedClaim = state.status === 'claimed' && (!activeClaims.has(state.claimId ?? '') || (state.expiresAt ?? 0) < Date.now())
      const interrupted = state.status === 'running' && !running.has(state.sessionId ?? '')
      if (state.status !== 'pending' && !abandonedClaim && !interrupted) return null
      const claimId = randomUUID()
      activeClaims.add(claimId)
      save(dir, { status: 'claimed', phase: 'reading', sessionId, claimId, expiresAt: Date.now() + 30_000 })
      return { claimId, prompt: BUILD_PROMPT }
    },
    release(dir: string, claimId: string) {
      const state = readPaperBuild(dir)
      if (state?.status === 'claimed' && state.claimId === claimId) { activeClaims.delete(claimId); pendingPaperBuild(dir); changed(dir) }
    },
    sent(sessionId: string, prompt = '') {
      const dir = projects.get(sessionId), state = dir ? readPaperBuild(dir) : undefined
      if (dir && state && state.sessionId === sessionId && (state.status === 'claimed' || (state.status === 'error' && /build|program/i.test(prompt)))) { activeClaims.delete(state.claimId ?? ''); running.add(sessionId); save(dir, { ...state, status: 'running', expiresAt: undefined, error: undefined }) }
    },
    event(event: KernelEvent) {
      const dir = projects.get(event.sessionId), state = dir ? readPaperBuild(dir) : undefined
      if (!dir || !state || state.sessionId !== event.sessionId || state.status !== 'running') return
      if (event.type === 'error' || event.type === 'done') running.delete(event.sessionId)
      if (event.type === 'error') save(dir, { ...state, status: 'error', error: /413|entity too large/i.test(event.text ?? '') ? 'The paper request was too large. Keep the PDF local and retry using page text.' : 'The build stopped. Saved work is preserved; see the agent message.' })
      else if (event.type === 'done') {
        try {
          if (event.detail === 'shutdown') throw Error('Build stopped before completion. Saved work is preserved.')
          if (!existsSync(join(dir, 'program.json'))) throw Error('The agent stopped before saving the Human Program.')
          const program = validateHumanProgram(JSON.parse(readFileSync(join(dir, 'program.json'), 'utf8')))
          if (!program.studies.length || !program.nodes.length || !program.evidence.length) throw Error('The program is still an extraction checkpoint, not a complete study.')
          save(dir, { ...state, status: 'complete', phase: 'checking' })
        } catch (error) { save(dir, { ...state, status: 'error', error: error instanceof Error ? error.message : 'The program needs repair.' }) }
      } else if (event.type === 'tool') {
        const command = JSON.stringify(event.input ?? '')
        const phase = /check_program/.test(command) ? 'checking' : /program_io|program.json/.test(command) && !/check_program/.test(command) ? 'writing' : state.phase
        if (phase !== state.phase) save(dir, { ...state, phase })
      }
    },
  }
}
