// The main process's side of shared/package-readiness: read package/<slug>/ from disk. Used to refuse
// a simulation approval for a package that is not complete, whatever the renderer showed.
import { readdir, readFile, realpath, lstat, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, sep } from 'node:path'
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

type ScientificCheck = (project: string, slug: string) => Promise<{ check: string; reason: string }[]>
let scientificCheck: ScientificCheck = async () => [{ check: 'runtime', reason: 'The research runtime is unavailable. Install it before validating this package.' }]
let checkVersion = 'unavailable'
const cache = new Map<string, Promise<{ check: string; reason: string }[]>>()
export function configureScientificChecks(check: ScientificCheck, version: string): void {
  scientificCheck = check; checkVersion = version; cache.clear()
}

/** Async metadata only: includes ctime/inode so preserved size/mtime cannot revive a stale pass. */
async function checkStamp(project: string): Promise<string> {
  const rows: unknown[] = []
  const walk = async (path: string): Promise<void> => {
    if (rows.length > 10000) throw Error('Too many scientific inputs')
    try {
      const link = await lstat(path)
      const info = link.isSymbolicLink() ? await stat(path) : link
      rows.push([path, info.size, info.mtimeMs, info.ctimeMs, info.ino, info.mode, link.isSymbolicLink() ? await realpath(path) : ''])
      if (info.isDirectory() && !link.isSymbolicLink())
        for (const name of (await readdir(path)).sort()) if (!['__pycache__', '.git'].includes(name)) await walk(join(path, name))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; rows.push([path, 'missing']) }
  }
  await walk(join(project, 'package')); await walk(join(project, 'sources'))
  for (const name of (await readdir(project)).sort())
    if (['program.json', 'effects.json', 'capabilities.json'].includes(name) || /[.]pdf$/i.test(name)) await walk(join(project, name))
  return JSON.stringify(rows)
}

async function checkedScience(project: string, slug: string, fresh: boolean) {
  try {
    const before = await checkStamp(project)
    const key = JSON.stringify([project, slug, checkVersion, before])
    let pending = fresh ? undefined : cache.get(key)
    if (!pending) {
      pending = scientificCheck(project, slug)
      if (cache.size > 100) cache.clear()
      cache.set(key, pending)
    }
    const problems = await pending
    if (before !== await checkStamp(project)) return [{ check: 'changed', reason: 'The study changed during scientific validation. Retry after edits finish.' }]
    // Runtime installation may finish without a project file changing.
    if (problems.some(p => p.check === 'runtime')) cache.delete(key)
    return problems
  } catch { return [{ check: 'runtime', reason: 'Scientific checks could not complete. Check the research runtime and retry.' }] }
}

export const SIMULATION_APPROVAL = '[Simulation scope approved]'

export async function projectPackageReadiness(projectDir: string, studyId?: string, fresh = false): Promise<PackageReadiness> {
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
  const candidates = await Promise.all(slugs.sort().map(async slug => {
    const result = await packageReadiness([slug], read, studyId ? { studyId, program } : undefined)
    if (result.ready) {
      const science = await checkedScience(projectDir, slug, fresh)
      result.problems.push(...science.map(p => ({ file: 'study.json' as const, kind: 'scientific' as const, ...p })))
      result.ready = result.problems.length === 0
    }
    return result
  }))
  const readiness = candidates.reduce((best, current) => current.problems.length < best.problems.length ? current : best, { exists: false, ready: false, slug: null, problems: [] } as PackageReadiness)
  const best = candidates.length ? candidates.reduce((a, b) => b.problems.length < a.problems.length ? b : a) : readiness
  return { ...best, runNotice: await communityRunNotice(projectDir) }
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
  const r = await projectPackageReadiness(projectDir, approved.studyId, true)
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
