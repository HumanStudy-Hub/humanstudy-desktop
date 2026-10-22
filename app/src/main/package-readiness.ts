// The main process's side of shared/package-readiness: read package/<slug>/ from disk. Used to refuse
// a simulation approval for a package that is not complete, whatever the renderer showed.
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { packageReadiness, type PackageReadiness } from '../shared/package-readiness'

const READ_LIMIT = 4 * 1024 * 1024

export const SIMULATION_APPROVAL = '[Simulation scope approved]'

export async function projectPackageReadiness(projectDir: string): Promise<PackageReadiness> {
  const root = join(projectDir, 'package')
  const slugs = await readdir(root, { withFileTypes: true })
    .then((ds) => ds.filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== '__pycache__').map((d) => d.name))
    .catch(() => [] as string[])
  return packageReadiness(slugs, async (slug, file) => {
    const p = join(root, slug, ...file.split('/'))
    const st = await stat(p).catch(() => null)
    if (!st?.isFile()) return null
    if (st.size > READ_LIMIT) return undefined
    return readFile(p, 'utf8')
  })
}

/** Throws when `text` approves a simulation and the project's package cannot run. */
export async function assertRunnablePackage(projectDir: string | undefined, text: string): Promise<void> {
  if (!projectDir || !text.startsWith(SIMULATION_APPROVAL)) return
  const r = await projectPackageReadiness(projectDir)
  if (r.ready) return
  const what = r.exists
    ? r.problems.map((p) => (p.kind === 'missing' ? `${p.file} is missing` : p.kind === 'invalid-json' ? `${p.file} is not valid JSON` : `${p.file} does not define ${p.entry}()`)).join('; ')
    : 'there is no package under package/'
  throw new Error(`The study package is not complete, so the simulation was not started: ${what}. Ask the agent to complete the package first.`)
}
