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
// so the researcher gets a retry instead of a spinner that never ends. Desktop never resumes it silently; the
// web edition continues a build its session limit stopped once, when the project is opened again
// (renderer Workbench, WEB_EDITION).
import { createHash } from 'node:crypto'
import { buildCoverageProblems } from '../shared/build-completion'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { KernelEvent } from './kernel-types'
import { validateHumanProgram } from '../shared/human-program'
import { scholarlyDeliveryHash, scholarlyDeliveryProblems } from './scholarly-delivery'
import { scholarlyProfile } from '../shared/scholarly-program'
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


/**
 * Independently validate the exact on-disk bytes, rather than trusting a tool's PASS text. The
 * headless worker (scripts/opencode-assets.mjs) certifies its builds with this same function.
 */
export function programCertificate(dir: string): { hash: string; problems: string[] } | null {
  try {
    const bytes = readFileSync(join(dir, 'program.json'))
    const program = validateHumanProgram(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')))
    if (scholarlyProfile(program)) return null // paired research completes through the protocol route only
    return { hash: createHash('sha256').update(bytes).digest('hex'), problems: buildCoverageProblems(program) }
  } catch { return null }
}
export function programComplete(dir: string): boolean {
  const result = programCertificate(dir)
  return result !== null && result.problems.length === 0
}
const currentCertificate = (dir: string, state: PaperBuildState): boolean => {
  if (!state.checked || !state.validationHash) return false
  if (state.validationRoute === 'protocol') {
    try {
      const raw = readFileSync(join(dir, 'protocol.json'), 'utf8')
      return createHash('sha256').update(raw).digest('hex') === state.validationHash && scholarlyDeliveryHash(dir, raw) === state.deliveryHash && !scholarlyDeliveryProblems(dir, raw).length
    } catch { return false }
  }
  const current = programCertificate(dir)
  return current !== null && current.hash === state.validationHash && !current.problems.length
}

/** Explicit build actions use the build model; ordinary messages never rely on language guessing. */
export function isBuildTurn(state: PaperBuildState | undefined, sessionId: string, action?: string): boolean {
  return (state?.status === 'running' && state.sessionId === sessionId) || action === 'paper.build' || action === 'simulation.build'
}

const WRITE_TOOLS = /^(write|edit|patch|multiedit|apply_patch)$/i

/** What a tool call actually did, as text: the shell command it ran, or the file it wrote. Null for
 *  everything else (to-do lists, reads, searches), whose text can mention check_program or package/
 *  without running or writing anything: a to-do item "run check_program" is not a failed check. */
export function toolAction(tool: string | undefined, input: unknown): string | null {
  if (typeof input === 'string') return input // a bare command (older events)
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  if (typeof o.command === 'string' && (!tool || /^(bash|shell|sh)$/i.test(tool))) return o.command
  if (tool && WRITE_TOOLS.test(tool)) {
    const path = o.filePath ?? o.path ?? o.file_path
    if (typeof path === 'string') return path
    if (typeof o.patchText === 'string') return o.patchText
  }
  return null
}

/** Which part of the build a tool call belongs to, from what it ran or wrote (the build skill's commands). */
export function buildPhase(tool: string | undefined, input: unknown): PaperBuildState['phase'] | null {
  const text = toolAction(tool, input)
  if (text === null) return null
  // The runnable form: package/<slug>/ (check_package) or, on the protocol route, protocol.json (hsenv.checks).
  if (/check_package|package[\\/]|hsenv[.\\/]checks|build_protocol[.]py|(^|[\\/\s'"])protocol[.]json\b/.test(text)) return 'packaging'
  if (/check_program/.test(text)) return 'checking'
  if (/program_io|program\.json/.test(text)) return 'writing'
  return null
}

export function createPaperBuilds(changed: (dir: string) => void, checkProtocol?: (dir: string) => Promise<{ hash: string; problems: string[] } | null>) {
  const checking = new Map<string, Promise<void>>()
  // Project status files are editable. Only certificates issued in this app process are trusted
  // for a protocol snapshot; a restart rechecks it with this build's bundled engine.
  const protocolProofs = new Map<string, string>()
  const projects = new Map<string, string>() // kernel session -> project dir
  const live = new Set<string>() // sessions running a build in this process
  const lastError = new Map<string, string>()
  const save = (dir: string, state: PaperBuildState): void => {
    writePaperBuild(dir, state)
    changed(dir)
  }
  const fail = (dir: string, state: PaperBuildState, error: PaperBuildError): void => {
    if (state.sessionId) live.delete(state.sessionId)
    save(dir, { ...state, status: 'error', error })
  }

  /** The state as the app should show it now (an orphaned `running` build becomes an interrupted error). */
  function read(dir: string): PaperBuildState | undefined {
    const state = readPaperBuild(dir)
    if (state?.status === 'running' && !live.has(state.sessionId ?? '')) {
      const next: PaperBuildState = { status: 'error', phase: state.phase, sessionId: state.sessionId, error: 'interrupted' }
      try { writePaperBuild(dir, next) } catch { /* shown either way */ }
      return next
    }
    if (state?.status === 'complete' && !currentCertificate(dir, state)) {
      const next: PaperBuildState = { ...state, status: 'error', checked: false, error: 'incomplete' }
      try { writePaperBuild(dir, next) } catch { /* shown either way */ }
      return next
    }
    // Finished by hand after a failure (in the chat or another conversation): nothing is left to retry.
    if (state?.status === 'error' && currentCertificate(dir, state)) {
      const next: PaperBuildState = { ...state, status: 'complete', error: undefined }
      try { writePaperBuild(dir, next) } catch { /* shown either way */ }
      return next
    }
    return state
  }

  function finishProtocol(dir: string, state: PaperBuildState): Promise<void> {
    const pending = checking.get(dir)
    if (pending) return pending
    let before: string
    let deliveryBefore: string | undefined
    try {
      const raw = readFileSync(join(dir, 'protocol.json'), 'utf8')
      before = createHash('sha256').update(raw).digest('hex')
      deliveryBefore = scholarlyDeliveryHash(dir, raw)
    } catch { fail(dir, state, 'incomplete'); return Promise.resolve() }
    if (state.status !== 'complete') save(dir, { ...state, phase: 'checking' })
    const mine = (async () => {
      let result: { hash: string; problems: string[] } | null = null
      try { result = await checkProtocol!(dir) } catch { /* failed closed */ }
      const now = readPaperBuild(dir)
      if (!now || now.sessionId !== state.sessionId || now.startedAt !== state.startedAt || (now.status !== state.status && !(state.status === 'complete' && now.status === 'error' && now.error === 'incomplete'))) return
      let after = ''
      let deliveryAfter: string | undefined, deliveryProblems: string[] = ['The study files changed during checking.']
      try {
        const raw = readFileSync(join(dir, 'protocol.json'), 'utf8')
        after = createHash('sha256').update(raw).digest('hex')
        deliveryAfter = scholarlyDeliveryHash(dir, raw)
        deliveryProblems = scholarlyDeliveryProblems(dir, raw)
      } catch { /* fail closed */ }
      if (before !== after || deliveryBefore !== deliveryAfter || result?.hash !== after || result.problems.length || deliveryProblems.length) {
        protocolProofs.delete(dir)
        return fail(dir, { ...now, checked: false, validationHash: undefined }, 'incomplete')
      }
      protocolProofs.set(dir, `${result.hash}:${deliveryAfter ?? ''}`)
      if (state.sessionId) live.delete(state.sessionId)
      save(dir, { ...now, status: 'complete', error: undefined, checked: true, validationRoute: 'protocol', validationHash: result.hash, deliveryHash: deliveryAfter })
    })().finally(() => { if (checking.get(dir) === mine) checking.delete(dir) })
    checking.set(dir, mine)
    return mine
  }

  return {
    read,
    async snapshot(dir: string): Promise<PaperBuildState | undefined> {
      const state = readPaperBuild(dir)
      if (state?.status === 'complete' && state.validationRoute === 'protocol' && checkProtocol) {
        let hash = ''
        try { hash = createHash('sha256').update(readFileSync(join(dir, 'protocol.json'))).digest('hex') } catch { /* read() invalidates it */ }
        let delivery: string | undefined
        try { delivery = scholarlyDeliveryHash(dir, readFileSync(join(dir, 'protocol.json'), 'utf8')) } catch { /* read invalidates it */ }
        if (hash && protocolProofs.get(dir) !== `${hash}:${delivery ?? ''}`) await finishProtocol(dir, state)
      }
      return read(dir)
    },
    /** A successful app field/file save is independently checked immediately; normal human edits
     * keep a completed extraction completed without a new agent turn. */
    humanSaved(dir: string): void {
      const state = readPaperBuild(dir)
      if (state?.status !== 'complete') return
      if (state.validationRoute === 'protocol' && checkProtocol) { void finishProtocol(dir, state); return }
      const result = programCertificate(dir)
      if (result && !result.problems.length) save(dir, { ...state, checked: true, validationHash: result.hash })
    },
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
      save(dir, { status: 'running', phase: 'reading', sessionId, startedAt: Date.now() })
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
      if (checking.has(dir) || (state?.status !== 'error' && !firstBuild)) return false
      save(dir, { status: 'pending', phase: 'reading' })
      return true
    },
    /** Sending the build request itself failed. */
    sendFailed(sessionId: string, error: unknown): void {
      const dir = projects.get(sessionId)
      const state = dir ? readPaperBuild(dir) : undefined
      if (dir && state?.status === 'running' && state.sessionId === sessionId) fail(dir, state, tooLarge(String(error)) ? 'too_large' : 'failed')
    },
    event(e: KernelEvent): void | Promise<void> {
      if (e.type !== 'error' && e.type !== 'tool' && e.type !== 'done') return // text deltas: no file read
      const dir = projects.get(e.sessionId)
      if (!dir) return
      const state = readPaperBuild(dir)
      if (!state) return
      // A build that failed and was then finished in the chat by hand counts as built.
      // The program check passing after the last write is what makes a study complete; a first
      // checkpoint already has a study, a node and evidence.
      // A protocol draft is certified from its bytes by the app's bundled validator, not tool PASS text.
      if (e.type === 'done' && e.detail !== 'shutdown' && checkProtocol && existsSync(join(dir, 'protocol.json'))
          && !(state.validationRoute !== 'protocol' && currentCertificate(dir, state))
          && ((state.status === 'running' && state.sessionId === e.sessionId) || state.status === 'error' || (state.status === 'complete' && !currentCertificate(dir, state)))) return finishProtocol(dir, state)
      const check = e.type === 'tool' ? checkResult(e) : null
      let certificate = state
      if (check !== null && (state.status === 'running' || state.status === 'error' || state.status === 'complete')) {
        const result = check ? programCertificate(dir) : null
        certificate = { ...state, checked: Boolean(result && !result.problems.length), validationRoute: 'program', validationHash: result?.hash }
        save(dir, certificate)
      }
      const checked = currentCertificate(dir, certificate)
      if (state.status === 'error' && e.type === 'done' && e.detail !== 'shutdown') {
        if (checked && programComplete(dir)) save(dir, { ...certificate, status: 'complete', error: undefined })
        return
      }
      if (state.status !== 'running' || state.sessionId !== e.sessionId) return
      if (e.type === 'error') lastError.set(e.sessionId, e.text ?? '')
      else if (e.type === 'tool') {
        const phase = buildPhase(e.tool, e.input ?? e.detail)
        if (phase && phase !== state.phase) save(dir, { ...certificate, checked, phase })
      } else if (e.type === 'done') {
        const error = lastError.get(e.sessionId)
        lastError.delete(e.sessionId)
        if (e.detail === 'shutdown') return fail(dir, state, 'closed')
        if (checked && programComplete(dir)) {
          live.delete(e.sessionId)
          return save(dir, { ...certificate, status: 'complete', error: undefined })
        }
        fail(dir, state, error === undefined ? 'incomplete' : tooLarge(error) ? 'too_large' : 'failed')
      }
    },
  }
}

/** A finished program, package or protocol check: true when it printed PASS, false when it failed; a write to
 *  program.json is false too (it needs checking again). null: says nothing about the check. */
export function checkResult(e: Pick<KernelEvent, 'tool' | 'input' | 'detail' | 'output'>): boolean | null {
  const text = toolAction(e.tool, e.input ?? e.detail)
  if (text === null) return null
  // A check is a command whose output has the checker's verdict line; `grep check_program` or reading the
  // script mentions it without running it.
  if (/check_program|check_package/.test(text) && e.output !== undefined && /^(PASS|FAIL)\b/m.test(e.output)) {
    return /^PASS\b/m.test(e.output) && !/^FAIL\b/m.test(e.output)
  }
  // The protocol engine's checks print one JSON report whose top-level "PASS" is the verdict.
  if (/hsenv[.\\/]checks/.test(text) && e.output !== undefined && /^ ?"PASS": (true|false)\b/m.test(e.output)) {
    return /^ ?"PASS": true\b/m.test(e.output) && !/^ ?"PASS": false\b/m.test(e.output)
  }
  if (/hsenv[.\\/]checks/.test(text)) return null
  if (/check_program|check_package/.test(text) && !/program_io/.test(text)) return null
  if (/program_io/.test(text) || (WRITE_TOOLS.test(e.tool ?? '') && /program\.json/.test(text))) return false
  return null
}

const tooLarge = (text: string): boolean => /\b413\b|entity too large|payload too large|request too large/i.test(text)
