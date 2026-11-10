// The main process's side of shared/package-readiness: read package/<slug>/ from disk. Used to refuse
// a simulation approval for a package that is not complete, whatever the renderer showed.
import { readdir, readFile, realpath, lstat, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { packageReadiness, type OriginalTextNeed, type PackageReadiness, type PackageFile } from '../shared/package-readiness'
import { formatTokens, MAX_PER_CONDITION, MAX_RUN_TOKENS, protocolRunLimits, type ProtocolBudget, type RunLimits } from '../shared/run-limits'

export const COMMUNITY_RUN_NOTICE = "This study's code will run on your computer with access to your model key."
import { looksLikeRevision } from './run-notice' // run-notice.ts imports nothing from here; kept next to its only use

/** Local community provenance is informational, not a security attestation. Until the catalog
 * provides authenticated review state, conservatively show the notice for every revision fork. */
export async function communityRunNotice(projectDir: string): Promise<string | undefined> {
  try {
    await readFile(join(projectDir, '.humanstudy/community.json'), 'utf8')
    return COMMUNITY_RUN_NOTICE
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return (await looksLikeRevision(projectDir)) ? COMMUNITY_RUN_NOTICE : undefined
    return COMMUNITY_RUN_NOTICE
  }
}

export interface ScientificProblem { check: string; reason: string; text?: OriginalTextNeed }
type ScientificCheck = (project: string, slug: string) => Promise<ScientificProblem[]>
const NOT_CONFIGURED: ScientificProblem = { check: 'runtime', reason: 'The build checks are not available yet, so the package cannot be confirmed.' }
const CHANGED: ScientificProblem = { check: 'changed', reason: 'The study changed while the build checks ran. They run again once edits finish.' }
const UNREADABLE: ScientificProblem = { check: 'runtime', reason: 'The study files could not be listed for the build checks. Retry.' }
// Fails closed until the app configures the real checker (index.ts): nothing is ready unchecked.
let scientificCheck: ScientificCheck = async () => [NOT_CONFIGURED]
let checkVersion = 'unconfigured'
/** Finished results by [project, slug, checker version, input stamp]; a changed input is a new key. */
const results = new Map<string, Outcome>()
/** One check at a time per package; later requests wait and then usually find the result above. */
const lanes = new Map<string, Promise<unknown>>()

/** Install the checker the gate runs (the app's bundled check_readiness.py). Tests pass a stub. */
export function configureScientificChecks(check: ScientificCheck, version: string): void {
  scientificCheck = check; checkVersion = version; results.clear()
}

/** What the build checks read, as metadata: package/, sources/, human-data/, the files beside program.json,
 *  the paper (`source.filename`) and every evidence `path`. ctime and inode are included, so restoring a size and mtime cannot bring
 *  back an earlier pass. Throws when the inputs cannot be listed. */
export async function scientificStamp(project: string): Promise<string> {
  const paths = ['package', 'sources', 'human-data'].map((dir) => join(project, dir))
  for (const name of (await readdir(project)).sort())
    if (STAMPED_BESIDE.includes(name) || /[.]pdf$/i.test(name)) paths.push(join(project, name))
  try {
    const program = JSON.parse(await readFile(join(project, 'program.json'), 'utf8'))
    const root = resolve(project)
    const refs = [program?.source?.filename, ...(Array.isArray(program?.evidence) ? program.evidence.map((e: { path?: unknown }) => e?.path) : [])]
    for (const rel of refs) {
      const p = typeof rel === 'string' ? resolve(root, rel) : null
      if (p && p.startsWith(root + sep)) paths.push(p)
    }
  } catch { /* no readable program: the checks report it */ }
  return stampOf(paths)
}

/** Metadata rows of every path, walked into folders (and through links, once each). */
async function stampOf(paths: string[]): Promise<string> {
  const rows: unknown[] = []
  const seen = new Set<string>()
  const walk = async (path: string): Promise<void> => {
    if (seen.has(path)) return
    seen.add(path)
    if (rows.length > 50_000) throw Error('Too many files for the build checks')
    try {
      const link = await lstat(path)
      const info = link.isSymbolicLink() ? await stat(path) : link
      rows.push([path, info.size, info.mtimeMs, info.ctimeMs, info.ino, info.mode, link.isSymbolicLink() ? await realpath(path) : ''])
      // A linked folder is walked too (sources.py lists and hashes through it); `seen` stops link loops.
      const real = link.isSymbolicLink() ? await realpath(path) : path
      if (info.isDirectory() && !seen.has('dir:' + real)) {
        seen.add('dir:' + real)
        for (const name of (await readdir(path)).sort()) if (name !== '__pycache__' && name !== '.git') await walk(join(path, name))
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      rows.push([path, 'missing'])
    }
  }
  for (const path of paths) await walk(path)
  return JSON.stringify(rows)
}
/** Files beside program.json that the checks read or copy next to the package (check_package BESIDE_PROGRAM). */
const STAMPED_BESIDE = ['program.json', 'effects.json', 'capabilities.json', 'README.md']

type Outcome = ScientificProblem[] | ProtocolBudget
// A failed download of a published study's source may succeed later without any study file changing (the
// helper itself waits ten minutes before asking the publisher again): never kept either.
const isRuntime = (o: Outcome): boolean => Array.isArray(o) && o.some((p) => p.check === 'runtime' || p.text?.need === 'download')

/** One check run once per input state: `stamp` lists its inputs, `version` names the checker, `run` checks. */
function cachedCheck<T extends Outcome>(lane: string, stamp: () => Promise<string>, version: () => string, run: () => Promise<T>): Promise<T | ScientificProblem[]> {
  const previous = lanes.get(lane) ?? Promise.resolve()
  const mine = previous.catch(() => undefined).then(async (): Promise<T | ScientificProblem[]> => {
    // An agent may still be writing: a check whose inputs changed under it is repeated, a few times at most.
    for (let attempt = 0; attempt < 3; attempt++) {
      let before: string
      try { before = await stamp() } catch { return [UNREADABLE] }
      const checker = version()
      const key = JSON.stringify([lane, checker, before])
      const known = results.get(key) as T | ScientificProblem[] | undefined
      if (known) return known
      let outcome: T | ScientificProblem[]
      try { outcome = await run() } catch { outcome = [{ check: 'runtime', reason: 'The build checks could not complete. Retry.' }] }
      let after: string | null = null
      try { after = await stamp() } catch { /* treated as changed */ }
      if (after !== before) continue
      // A runtime that was missing may be installed later without any study file changing: never keep that.
      if (checker === version() && !isRuntime(outcome)) {
        if (results.size > 200) results.clear()
        results.set(key, outcome)
      }
      return outcome
    }
    return [CHANGED]
  })
  lanes.set(lane, mine)
  void mine.finally(() => { if (lanes.get(lane) === mine) lanes.delete(lane) })
  return mine
}

/** The build checks for one package, run once per input state. */
export function scientificProblems(project: string, slug: string): Promise<ScientificProblem[]> {
  return cachedCheck<ScientificProblem[]>(JSON.stringify(['package', project, slug]), () => scientificStamp(project), () => checkVersion, () => scientificCheck(project, slug))
}

// The protocol route (v0.8): protocol.json run by the bundled engine (protocol-readiness.ts, hsenv.checks).
type ProtocolCheck = (project: string) => Promise<ScientificProblem[]>
type BudgetCheck = (project: string) => Promise<ProtocolBudget | ScientificProblem[]>
const PROTOCOL_NOT_CONFIGURED: ScientificProblem = { check: 'runtime', reason: 'The protocol checks are not available yet, so the protocol cannot be confirmed.' }
// Fails closed until the app configures the real engine (index.ts).
let protocolCheck: ProtocolCheck = async () => [PROTOCOL_NOT_CONFIGURED]
let budgetCheck: BudgetCheck = async () => [PROTOCOL_NOT_CONFIGURED]
let protocolVersion = 'unconfigured'

/** Install the protocol checker the gate runs (the app's bundled hsenv.checks) and the budget measurement a run is
 *  sized with (skills/run/budget.py). Tests pass stubs. */
export function configureProtocolChecks(check: ProtocolCheck, version: string, budget: BudgetCheck = async () => [PROTOCOL_NOT_CONFIGURED]): void {
  protocolCheck = check; budgetCheck = budget; protocolVersion = version; results.clear()
}

/** What hsenv.checks reads, as metadata: protocol.json, study.json, sourcetext/ (the --source-text files),
 *  sources/, assets/ and every local `src` the protocol serves. Throws when the inputs cannot be listed. */
export async function protocolStamp(project: string): Promise<string> {
  const root = resolve(project)
  const paths = ['protocol.json', 'study.json', 'sourcetext', 'sources', 'assets'].map((rel) => join(root, rel))
  try {
    const srcs: string[] = []
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(visit)
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'src' && typeof x === 'string') srcs.push(x); else visit(x) }
    }
    visit(JSON.parse(await readFile(join(root, 'protocol.json'), 'utf8')))
    for (const rel of srcs) {
      if (/^https?:/i.test(rel)) continue
      const p = resolve(root, rel)
      if (p.startsWith(root + sep)) paths.push(p)
    }
  } catch { /* no readable protocol: the checks report it */ }
  return stampOf(paths)
}

/** The protocol checks for one project, run once per input state. */
export function protocolProblems(project: string): Promise<ScientificProblem[]> {
  return cachedCheck<ScientificProblem[]>(JSON.stringify(['protocol', project]), () => protocolStamp(project), () => protocolVersion, () => protocolCheck(project))
}

/** The measured model budget of a protocol run, once per input state (problems when it cannot be measured). */
export function protocolBudgetOf(project: string): Promise<ProtocolBudget | ScientificProblem[]> {
  return cachedCheck<ProtocolBudget | ScientificProblem[]>(JSON.stringify(['budget', project]), () => protocolStamp(project), () => protocolVersion, () => budgetCheck(project))
}

// A published study's original wording (original-text.ts): filled in on this computer before it can run.
type TextCheck = (project: string) => Promise<ScientificProblem[]>
let textCheck: TextCheck = async () => []
/** Install the check that fills in a published study's original wording (index.ts); tests pass stubs. Without
 *  it, an ordinary protocol.json is unaffected and a published one is refused at run time (app_run). */
export function configureOriginalText(check: TextCheck): void { textCheck = check; results.clear() }
/** The original-wording problems of one project, once per input state: protocol.json, sources/ (where a dropped
 *  copy lands) and paper.pdf. */
export function originalTextProblemsOf(project: string): Promise<ScientificProblem[]> {
  return cachedCheck<ScientificProblem[]>(JSON.stringify(['text', project]), async () => (await protocolStamp(project)) + await stampOf([join(resolve(project), 'paper.pdf')]),
    () => protocolVersion, () => textCheck(project))
}

const hasProtocol = (project: string): Promise<boolean> => lstat(join(project, 'protocol.json')).then((s) => s.isFile(), () => false)

export const SIMULATION_APPROVAL = '[Simulation scope approved]'

/** Two separate results, never merged (review 1, M2):
 *  - the package route decides `ready`: the static package contract (shared/package-readiness) AND every build
 *    check (check_readiness.py), which run only for a package that already passes the static part. This is the
 *    only form the agent can run today, so nothing else may make it ready;
 *  - the protocol route (protocol.json + the bundled engine's checks, hsenv.checks) is reported beside it as
 *    `protocol`, when protocol.json exists. A protocol approval runs protocol.json through the engine
 *    (skills/run), never package/, and needs this result. */
export async function projectPackageReadiness(projectDir: string, studyId?: string): Promise<PackageReadiness> {
  // A project with only protocol.json has no program to bind a package to: the package route is checked statically
  // (and is not ready without a package); the protocol route decides what can run.
  const hasProgram = await lstat(join(projectDir, 'program.json')).then((st) => st.isFile(), () => false)
  const pkg = await packageRouteReadiness(projectDir, hasProgram ? studyId : undefined)
  if (!(await hasProtocol(projectDir))) return pkg
  const protocol = await protocolRouteReadiness(projectDir)
  return { ...pkg, protocol: { ready: protocol.ready, problems: protocol.problems, arms: await protocolArms(projectDir), budget: protocol.budget } }
}

/** The runnable arms of protocol.json (the conditions of a protocol run); [] when it cannot be read. */
export async function protocolArms(projectDir: string): Promise<string[]> {
  try {
    const arms: unknown = JSON.parse(await readFile(join(projectDir, 'protocol.json'), 'utf8'))?.arms
    return [...new Set((Array.isArray(arms) ? arms : []).filter((a) => a?.runnable !== false).map((a) => a?.id)
      .filter((id): id is string => typeof id === 'string' && id !== ''))]
  } catch { return [] }
}

/** The protocol route alone: protocol.json and the bundled engine's checks. */
async function protocolRouteReadiness(projectDir: string): Promise<PackageReadiness & { budget?: ProtocolBudget }> {
  // A published study whose screens still lack their original wording opens as a preview but never runs: its
  // participants would see placeholders. Those problems come first; the engine's checks follow.
  let problems = [...await originalTextProblemsOf(projectDir), ...await protocolProblems(projectDir)]
  let budget: ProtocolBudget | undefined
  // A run is sized from what it will send the model (review 2, M3): no measured budget, no protocol run.
  if (!problems.length) {
    const b = await protocolBudgetOf(projectDir)
    if (Array.isArray(b)) problems = b
    else budget = b
  }
  return { exists: true, ready: !problems.length, slug: null, runNotice: await communityRunNotice(projectDir), budget,
    problems: problems.map((p) => ({ file: 'protocol.json' as const, kind: 'scientific' as const, check: p.check, reason: p.reason, ...(p.text ? { text: p.text } : {}) })) }
}

async function packageRouteReadiness(projectDir: string, studyId?: string): Promise<PackageReadiness> {
  const root = join(projectDir, 'package')
  const slugs = await readdir(root, { withFileTypes: true })
    .then((ds) => ds.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== '__pycache__').map((d) => d.name))
    .catch(() => [] as string[])
  const program = studyId ? JSON.parse(await readFile(join(projectDir, 'program.json'), 'utf8')) : undefined
  const realRoot = await realpath(root).catch(() => root)
  const read = async (slug: string, file: PackageFile) => {
    const p = join(root, slug, ...file.split('/'))
    const real = await realpath(p).catch(() => null)
    if (!real || !real.startsWith(realRoot + sep)) return null
    return readFile(p, 'utf8')
  }
  const runNotice = await communityRunNotice(projectDir)
  if (!slugs.length) return { exists: false, ready: false, slug: null, problems: [], runNotice }
  const checked: PackageReadiness[] = []
  for (const slug of [...slugs].sort()) {
    const r = await packageReadiness([slug], read, studyId ? { studyId, program } : undefined)
    if (r.ready) {
      const science = await scientificProblems(projectDir, slug)
      if (science.length) r.problems = science.map((p) => ({ file: 'study.json' as const, kind: 'scientific' as const, check: p.check, reason: p.reason }))
      r.ready = r.problems.length === 0
      if (r.ready) return { ...r, runNotice }
    }
    checked.push(r)
  }
  // None is ready: report the one closest to it, preferring a package that passed the static part.
  const rank = (r: PackageReadiness) => (r.problems.some((p) => p.kind !== 'scientific') ? 1000 : 0) + r.problems.length
  const best = checked.reduce((a, b) => (rank(b) < rank(a) ? b : a))
  return { ...best, runNotice }
}

/** Throws when `text` approves a simulation and the project cannot run it. The approval names its route: a
 *  package approval (studyId, programId, programHash of program.json; the Simulation tab's, route absent or
 *  'package') needs the package route; a protocol approval (route 'protocol', protocolHash of protocol.json)
 *  needs the protocol route and runs protocol.json through the engine (skills/run). */
export async function assertRunnablePackage(projectDir: string | undefined, text: string): Promise<void> {
  if (!text.startsWith(SIMULATION_APPROVAL)) return
  if (!projectDir) throw new Error('The conversation has no project. Reopen the project before starting a simulation.')
  let approved: { route?: unknown; studyId?: string; programId?: string; programHash?: string; protocolHash?: unknown }
  try { approved = JSON.parse(text.split('\n')[1] ?? '') } catch { throw new Error('Simulation approval is unreadable. Review the simulation scope again.') }
  if (!approved || typeof approved !== 'object') throw new Error('Simulation approval is unreadable. Review the simulation scope again.')
  // The approval names the form it runs: 'package' (absent in approvals from the Simulation tab) or 'protocol'.
  const route = approvalRoute(approved)
  if (route === 'protocol') return assertRunnableProtocol(projectDir, approved as Parameters<typeof assertRunnableProtocol>[1])
  const bytes = await readFile(join(projectDir, 'program.json'))
  const program = JSON.parse(bytes.toString('utf8'))
  if (typeof approved.studyId !== 'string' || !program.studies?.some((s: { id: string }) => s.id === approved.studyId))
    throw new Error('The selected study is unavailable. Review the simulation scope again.')
  if (approved.programId !== program.id || approved.programHash !== createHash('sha256').update(bytes).digest('hex'))
    throw new Error('The study changed after approval. Review the simulation scope again.')
  // A program approval runs package/: only the package route (with check_readiness) can make it runnable.
  const r = await packageRouteReadiness(projectDir, approved.studyId)
  if (r.ready) {
    const latest = await readFile(join(projectDir, 'program.json'))
    if (approved.programHash !== createHash('sha256').update(latest).digest('hex'))
      throw new Error('The study changed during package validation. Review the simulation scope again.')
    return
  }
  throw notRunnable(r)
}

/** The route an approval names; an unknown route, or a package approval carrying a protocol hash, is refused. */
export function approvalRoute(approved: { route?: unknown; protocolHash?: unknown }): 'package' | 'protocol' {
  const route = approved.route ?? (approved.protocolHash !== undefined ? 'protocol' : 'package')
  if (route === 'protocol') return 'protocol'
  if (route === 'package' && approved.protocolHash === undefined) return 'package'
  throw new Error('Simulation approval names no runnable form. Review the simulation scope again.')
}

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

async function assertRunnableProtocol(projectDir: string, approved: { protocolHash?: unknown; plan?: { perCondition?: unknown; tokenBudget?: unknown } }): Promise<void> {
  const notRunnable = (r: PackageReadiness) => new Error(`The study protocol did not pass its checks, so the simulation was not started: ${problemsText(r)}. Ask the agent to fix protocol.json first.`)
  const bytes = await readFile(join(projectDir, 'protocol.json')).catch(() => null)
  if (!bytes) throw new Error('The study has no protocol.json. Review the simulation scope again.')
  if (typeof approved.protocolHash !== 'string' || approved.protocolHash !== sha256(bytes))
    throw new Error('The study changed after approval. Review the simulation scope again.')
  const r = await protocolRouteReadiness(projectDir)
  if (!r.ready) throw notRunnable(r)
  approvedProtocolLimits(r.budget, approved.plan)
  if (approved.protocolHash !== sha256(await readFile(join(projectDir, 'protocol.json'))))
    throw new Error('The study changed during protocol validation. Review the simulation scope again.')
}

/** The relay limits of an approved protocol run: computed from the measured budget, and only when the researcher
 *  approved exactly that token figure (`plan.tokenBudget`) and it is under the hard ceiling (review 2, M3). */
export function approvedProtocolLimits(budget: ProtocolBudget | undefined, plan: { perCondition?: unknown; tokenBudget?: unknown } | undefined): RunLimits {
  const per = plan?.perCondition
  if (!Number.isSafeInteger(per) || (per as number) < 1 || (per as number) > MAX_PER_CONDITION)
    throw new Error(`Participants per condition must be a whole number from 1 to ${MAX_PER_CONDITION}. Review the simulation scope again.`)
  if (!budget) throw new Error('The model budget of this protocol is not measured yet. Review the simulation scope again.')
  const limits = protocolRunLimits(budget, per)
  if (!limits.fits)
    throw new Error(`This run would need ${formatTokens(limits.needed)} tokens, more than the limit of ${formatTokens(MAX_RUN_TOKENS)}. Choose fewer participants per condition.`)
  if (plan?.tokenBudget !== limits.tokens)
    throw new Error(`The approved token budget is not this run's (${formatTokens(limits.tokens)} tokens). Review the simulation scope again.`)
  return { participants: limits.participants, tokens: limits.tokens, minutes: limits.minutes }
}

/** The measured budget of the project's protocol (cached), or undefined when it does not pass. */
export async function protocolBudgetFor(projectDir: string): Promise<ProtocolBudget | undefined> {
  return (await protocolRouteReadiness(projectDir)).budget
}

const problemsText = (r: PackageReadiness): string =>
  r.problems.map((p) => (p.kind === 'scientific' ? `${p.check}: ${p.reason}` : p.kind === 'missing' ? `${p.file} is missing` : p.kind === 'invalid-json' ? `${p.file} is not valid JSON` : p.kind === 'no-entry' ? `${p.file} does not define ${p.entry}()` : `${p.file}: ${p.kind}`)).join('; ')

function notRunnable(r: PackageReadiness): Error {
  const what = r.exists ? problemsText(r) : 'there is no package under package/'
  return new Error(`The study package is not complete, so the simulation was not started: ${what}. Ask the agent to complete the package first.`)
}
