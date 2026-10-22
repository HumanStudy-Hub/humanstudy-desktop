// The automatic first build after a paper import (issue #15). Importing a paper authorizes building its
// study, so a new project with a paper starts `pending`; the renderer starts the build in the project's
// conversation as soon as the agent is ready, and the Study view shows the state below while program.json
// fills in from the agent's checkpoints. Building never authorizes a simulation.
//
//   pending ──start()──▶ running ──done──▶ complete   (program.json readable, with studies, nodes, evidence)
//      ▲                    │       └────▶ error      (stopped, failed, closed or incomplete; work is kept)
//      └──release()/retry()─┴──────────────────┘
//
// State lives in <project>/.humanstudy/paper-build.json so it survives restarts. A `running` build whose
// conversation is not live in this app process was interrupted (crash, forced quit) and reads as `error`,
// so the researcher gets a retry instead of a spinner that never ends; it is never resumed silently.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { KernelEvent } from './kernel-types'
import { readHumanProgram } from '../shared/human-program'
import type { PaperBuildError, PaperBuildState } from '../preload/types'

const file = (dir: string): string => join(dir, '.humanstudy', 'paper-build.json')

export function readPaperBuild(dir: string): PaperBuildState | undefined {
  try {
    const state = JSON.parse(readFileSync(file(dir), 'utf8')) as PaperBuildState
    return state && typeof state.status === 'string' ? state : undefined
  } catch {
    return undefined
  }
}

export function writePaperBuild(dir: string, state: PaperBuildState): void {
  const target = file(dir)
  mkdirSync(join(dir, '.humanstudy'), { recursive: true })
  writeFileSync(target + '.tmp', JSON.stringify(state, null, 2) + '\n')
  renameSync(target + '.tmp', target)
}

/** Mark a freshly imported paper for its automatic first build. */
export function pendingPaperBuild(dir: string): void {
  writePaperBuild(dir, { status: 'pending', phase: 'reading' })
}


/** Is program.json a Study with content (not only a first checkpoint)? Small slips are fine: the Study
 *  view lists them with its own fix action. */
export function programComplete(dir: string): boolean {
  try {
    const { program } = readHumanProgram(JSON.parse(readFileSync(join(dir, 'program.json'), 'utf8')))
    return program.studies.length > 0 && program.nodes.length > 0 && program.evidence.length > 0
  } catch {
    return false
  }
}

/** Which part of the build a tool call belongs to, from its input (the build skill's own commands). */
export function buildPhase(input: unknown): PaperBuildState['phase'] | null {
  let text: string
  try { text = typeof input === 'string' ? input : JSON.stringify(input ?? '') } catch { return null }
  if (/check_package|package[\\/]/.test(text)) return 'packaging'
  if (/check_program/.test(text)) return 'checking'
  if (/program_io|program\.json/.test(text)) return 'writing'
  return null
}

export function createPaperBuilds(changed: (dir: string) => void) {
  const projects = new Map<string, string>() // kernel session -> project dir
  const live = new Set<string>() // sessions running a build in this process
  const lastError = new Map<string, string>()
  const save = (dir: string, state: PaperBuildState): void => {
    writePaperBuild(dir, state)
    changed(dir)
  }
  const fail = (dir: string, state: PaperBuildState, error: PaperBuildError): void => {
    if (state.sessionId) live.delete(state.sessionId)
    save(dir, { status: 'error', phase: state.phase, sessionId: state.sessionId, error })
  }

  /** The state as the app should show it now (an orphaned `running` build becomes an interrupted error). */
  function read(dir: string): PaperBuildState | undefined {
    const state = readPaperBuild(dir)
    if (state?.status === 'running' && !live.has(state.sessionId ?? '')) {
      const next: PaperBuildState = { status: 'error', phase: state.phase, sessionId: state.sessionId, error: 'interrupted' }
      try { writePaperBuild(dir, next) } catch { /* shown either way */ }
      return next
    }
    // Finished by hand after a failure (in the chat or another conversation): nothing is left to retry.
    if (state?.status === 'error' && state.checked && programComplete(dir)) {
      const next: PaperBuildState = { status: 'complete', phase: state.phase }
      try { writePaperBuild(dir, next) } catch { /* shown either way */ }
      return next
    }
    return state
  }

  return {
    read,
    bind(sessionId: string, dir: string): void {
      projects.set(sessionId, resolve(dir))
    },
    /** Claim a pending build for this conversation. True: the caller sends the build request now. */
    start(dir: string, sessionId: string): boolean {
      dir = resolve(dir)
      if (projects.get(sessionId) !== dir) throw new Error('This conversation belongs to a different project.')
      if (read(dir)?.status !== 'pending') return false
      live.add(sessionId)
      lastError.delete(sessionId)
      save(dir, { status: 'running', phase: 'reading', sessionId })
      return true
    },
    /** The caller could not send after start() (project or conversation changed): back to pending. */
    release(dir: string, sessionId: string): void {
      const state = readPaperBuild(dir)
      if (state?.status !== 'running' || state.sessionId !== sessionId) return
      live.delete(sessionId)
      save(dir, { status: 'pending', phase: 'reading' })
    },
    /** The researcher asked to build: again after a failure, or for the first time in a project that has
     *  a paper but no study and was made before automatic builds (those never start on their own). */
    retry(dir: string): boolean {
      const state = read(dir)
      const firstBuild = !state && existsSync(join(dir, 'paper.pdf')) && !existsSync(join(dir, 'program.json'))
      if (state?.status !== 'error' && !firstBuild) return false
      save(dir, { status: 'pending', phase: 'reading' })
      return true
    },
    /** Sending the build request itself failed. */
    sendFailed(sessionId: string, error: unknown): void {
      const dir = projects.get(sessionId)
      const state = dir ? readPaperBuild(dir) : undefined
      if (dir && state?.status === 'running' && state.sessionId === sessionId) fail(dir, state, tooLarge(String(error)) ? 'too_large' : 'failed')
    },
    event(e: KernelEvent): void {
      if (e.type !== 'error' && e.type !== 'tool' && e.type !== 'done') return // text deltas: no file read
      const dir = projects.get(e.sessionId)
      if (!dir) return
      const state = readPaperBuild(dir)
      if (!state) return
      // A build that failed and was then finished in the chat by hand counts as built.
      // The program check passing after the last write is what makes a study complete; a first
      // checkpoint already has a study, a node and evidence.
      const check = e.type === 'tool' ? checkResult(e) : null
      if (check !== null && (state.status === 'running' || state.status === 'error') && Boolean(state.checked) !== check)
        save(dir, { ...state, checked: check })
      const checked = check ?? state.checked
      if (state.status === 'error' && e.type === 'done' && e.detail !== 'shutdown') {
        if (checked && programComplete(dir)) save(dir, { status: 'complete', phase: state.phase })
        return
      }
      if (state.status !== 'running' || state.sessionId !== e.sessionId) return
      if (e.type === 'error') lastError.set(e.sessionId, e.text ?? '')
      else if (e.type === 'tool') {
        const phase = buildPhase(e.input ?? e.detail)
        if (phase && phase !== state.phase) save(dir, { ...state, checked, phase })
      } else if (e.type === 'done') {
        const error = lastError.get(e.sessionId)
        lastError.delete(e.sessionId)
        if (e.detail === 'shutdown') return fail(dir, state, 'closed')
        if (checked && programComplete(dir)) {
          live.delete(e.sessionId)
          return save(dir, { status: 'complete', phase: state.phase })
        }
        fail(dir, state, error === undefined ? 'incomplete' : tooLarge(error) ? 'too_large' : 'failed')
      }
    },
  }
}

/** A finished program or package check: true when it printed PASS, false when it failed; a write to
 *  program.json is false too (it needs checking again). null: says nothing about the check. */
export function checkResult(e: Pick<KernelEvent, 'tool' | 'input' | 'detail' | 'output'>): boolean | null {
  let text: string
  try { text = typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? e.detail ?? '') } catch { return null }
  if (/check_program|check_package/.test(text)) {
    if (e.output === undefined) return null
    return /^PASS\b/m.test(e.output) && !/^FAIL\b/m.test(e.output)
  }
  if (/program_io/.test(text) || (/^(write|edit|patch|multiedit)$/i.test(e.tool ?? '') && /program\.json/.test(text))) return false
  return null
}

const tooLarge = (text: string): boolean => /\b413\b|entity too large|payload too large|request too large/i.test(text)
