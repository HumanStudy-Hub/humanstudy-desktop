// The main process's side of shared/package-readiness: read package/<slug>/ from disk. Used to refuse
// a simulation approval for a package that is not complete, whatever the renderer showed.
import { readdir, readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, sep } from 'node:path'
import { packageReadiness, type PackageReadiness } from '../shared/package-readiness'

export const COMMUNITY_RUN_NOTICE = "This study's code will run on your computer through a limited model relay (up to 200,000 tokens and 30 minutes)."

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

export const SIMULATION_APPROVAL = '[Simulation scope approved]'

export async function projectPackageReadiness(projectDir: string, studyId?: string): Promise<PackageReadiness> {
  const root = join(projectDir, 'package')
  const slugs = await readdir(root, { withFileTypes: true })
    .then((ds) => ds.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== '__pycache__').map((d) => d.name))
    .catch(() => [] as string[])
  const program = studyId ? JSON.parse(await readFile(join(projectDir, 'program.json'), 'utf8')) : undefined
  const realRoot = await realpath(root).catch(() => root)
  const readiness = await packageReadiness(slugs, async (slug, file) => {
    const p = join(root, slug, ...file.split('/'))
    const real = await realpath(p).catch(() => null)
    if (!real || !real.startsWith(realRoot + sep)) return null
    return readFile(p, 'utf8')
  }, studyId ? { studyId, program } : undefined)
  return { ...readiness, runNotice: await communityRunNotice(projectDir) }
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
    ? r.problems.map((p) => (p.kind === 'missing' ? `${p.file} is missing` : p.kind === 'invalid-json' ? `${p.file} is not valid JSON` : p.kind === 'no-entry' ? `${p.file} does not define ${p.entry}()` : `${p.file}: ${p.kind}`)).join('; ')
    : 'there is no package under package/'
  throw new Error(`The study package is not complete, so the simulation was not started: ${what}. Ask the agent to complete the package first.`)
}
