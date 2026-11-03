// The main process's side of shared/package-readiness: read package/<slug>/ from disk. Used to refuse
// a simulation approval for a package that is not complete, whatever the renderer showed.
import { readdir, readFile, realpath, lstat, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { packageReadiness, type PackageReadiness, type PackageFile } from '../shared/package-readiness'

export const COMMUNITY_RUN_NOTICE = "This study's code will run on your computer with access to your model key."

/** Local community provenance is informational, not a security attestation. Until the catalog
 * provides authenticated review state, conservatively show the notice for every revision fork. */
export async function communityRunNotice(projectDir: string): Promise<string | undefined> {
  try {
    await readFile(join(projectDir, '.humanstudy/community.json'), 'utf8')
    return COMMUNITY_RUN_NOTICE
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return COMMUNITY_RUN_NOTICE
  }
}

export interface ScientificProblem { check: string; reason: string }
type ScientificCheck = (project: string, slug: string) => Promise<ScientificProblem[]>
const NOT_CONFIGURED: ScientificProblem = { check: 'runtime', reason: 'The build checks are not available yet, so the package cannot be confirmed.' }
const CHANGED: ScientificProblem = { check: 'changed', reason: 'The study changed while the build checks ran. They run again once edits finish.' }
const UNREADABLE: ScientificProblem = { check: 'runtime', reason: 'The study files could not be listed for the build checks. Retry.' }
// Fails closed until the app configures the real checker (index.ts): nothing is ready unchecked.
let scientificCheck: ScientificCheck = async () => [NOT_CONFIGURED]
let checkVersion = 'unconfigured'
/** Finished results by [project, slug, checker version, input stamp]; a changed input is a new key. */
const results = new Map<string, ScientificProblem[]>()
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
  for (const dir of ['package', 'sources', 'human-data']) await walk(join(project, dir))
  for (const name of (await readdir(project)).sort())
    if (STAMPED_BESIDE.includes(name) || /[.]pdf$/i.test(name)) await walk(join(project, name))
  try {
    const program = JSON.parse(await readFile(join(project, 'program.json'), 'utf8'))
    const root = resolve(project)
    const paths = [program?.source?.filename, ...(Array.isArray(program?.evidence) ? program.evidence.map((e: { path?: unknown }) => e?.path) : [])]
    for (const rel of paths) {
      const p = typeof rel === 'string' ? resolve(root, rel) : null
      if (p && p.startsWith(root + sep)) await walk(p)
    }
  } catch { /* no readable program: the checks report it */ }
  return JSON.stringify(rows)
}
/** Files beside program.json that the checks read or copy next to the package (check_package BESIDE_PROGRAM). */
const STAMPED_BESIDE = ['program.json', 'effects.json', 'capabilities.json', 'README.md']

/** The build checks for one package, run once per input state. */
export async function scientificProblems(project: string, slug: string): Promise<ScientificProblem[]> {
  const lane = JSON.stringify([project, slug])
  const previous = lanes.get(lane) ?? Promise.resolve()
  const mine = previous.catch(() => undefined).then(async (): Promise<ScientificProblem[]> => {
    // An agent may still be writing: a check whose inputs changed under it is repeated, a few times at most.
    for (let attempt = 0; attempt < 3; attempt++) {
      let before: string
      try { before = await scientificStamp(project) } catch { return [UNREADABLE] }
      const key = JSON.stringify([project, slug, checkVersion, before])
      const known = results.get(key)
      if (known) return known
      const version = checkVersion
      let problems: ScientificProblem[]
      try { problems = await scientificCheck(project, slug) } catch { problems = [{ check: 'runtime', reason: 'The build checks could not complete. Retry.' }] }
      let after: string | null = null
      try { after = await scientificStamp(project) } catch { /* treated as changed */ }
      if (after !== before) continue
      // A runtime that was missing may be installed later without any study file changing: never keep that.
      if (version === checkVersion && !problems.some((p) => p.check === 'runtime')) {
        if (results.size > 200) results.clear()
        results.set(key, problems)
      }
      return problems
    }
    return [CHANGED]
  })
  lanes.set(lane, mine)
  void mine.finally(() => { if (lanes.get(lane) === mine) lanes.delete(lane) })
  return mine
}

export const SIMULATION_APPROVAL = '[Simulation scope approved]'

/** Ready = the static package contract (shared/package-readiness) AND every build check (check_readiness.py).
 *  The build checks run only for a package that already passes the static part. */
export async function projectPackageReadiness(projectDir: string, studyId?: string): Promise<PackageReadiness> {
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

/** Throws when `text` approves a simulation and the project's package cannot run. */
export async function assertRunnablePackage(projectDir: string | undefined, text: string): Promise<void> {
  if (!text.startsWith(SIMULATION_APPROVAL)) return
  if (!projectDir) throw new Error('The conversation has no project. Reopen the project before starting a simulation.')
  let approved: { studyId?: string; programId?: string; programHash?: string }
  try { approved = JSON.parse(text.split('\n')[1] ?? '') } catch { throw new Error('Simulation approval is unreadable. Review the simulation scope again.') }
  const bytes = await readFile(join(projectDir, 'program.json'))
  const program = JSON.parse(bytes.toString('utf8'))
  if (!approved || typeof approved.studyId !== 'string' || !program.studies?.some((s: { id: string }) => s.id === approved.studyId))
    throw new Error('The selected study is unavailable. Review the simulation scope again.')
  if (approved.programId !== program.id || approved.programHash !== createHash('sha256').update(bytes).digest('hex'))
    throw new Error('The study changed after approval. Review the simulation scope again.')
  const r = await projectPackageReadiness(projectDir, approved.studyId)
  if (r.ready) {
    const latest = await readFile(join(projectDir, 'program.json'))
    if (approved.programHash !== createHash('sha256').update(latest).digest('hex'))
      throw new Error('The study changed during package validation. Review the simulation scope again.')
    return
  }
  const what = r.exists
    ? r.problems.map((p) => (p.kind === 'scientific' ? `${p.check}: ${p.reason}` : p.kind === 'missing' ? `${p.file} is missing` : p.kind === 'invalid-json' ? `${p.file} is not valid JSON` : p.kind === 'no-entry' ? `${p.file} does not define ${p.entry}()` : `${p.file}: ${p.kind}`)).join('; ')
    : 'there is no package under package/'
  throw new Error(`The study package is not complete, so the simulation was not started: ${what}. Ask the agent to complete the package first.`)
}
