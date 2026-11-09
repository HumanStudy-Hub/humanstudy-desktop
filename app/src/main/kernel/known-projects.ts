// Every project folder this app knows (review 7): the projects root, each created project and each folder
// opened with Open, persisted in <userData>/known-projects.json. Both sandbox profiles (kernel and agent
// shell) deny reads of all of them except the current project, and the policy asks about them as
// "another project", wherever they live: under the home folder, /Users/Shared or an external drive.
// Electron-free: main/index.ts points HUMANSTUDY_KNOWN_PROJECTS_FILE at the file and records changes.
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const MAX = 500

/** Real path when it exists (a removed drive keeps its last known spelling). */
const real = (p: string): string => { try { return realpathSync.native(p) } catch { return resolve(p) } } // native: the stored letter case
const key = (p: string): string => p.toLowerCase() // APFS and NTFS ignore case

export const knownProjectsFile = (): string | undefined => process.env.HUMANSTUDY_KNOWN_PROJECTS_FILE?.trim() || undefined

let cache: { file: string; mtime: number; list: string[] } | undefined
/** The persisted list (cached by modification time; a missing or broken file is an empty list). */
export function readKnownProjects(file: string | undefined = knownProjectsFile()): string[] {
  if (!file) return []
  try {
    const mtime = statSync(file).mtimeMs
    if (cache && cache.file === file && cache.mtime === mtime) return cache.list
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { projects?: unknown }
    const list = Array.isArray(raw.projects) ? raw.projects.filter((x): x is string => typeof x === 'string' && (x.startsWith('/') || /^[A-Za-z]:[\\/]/.test(x))) : []
    cache = { file, mtime, list }
    return list
  } catch { return [] }
}

function write(file: string, list: string[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify({ projects: list.slice(-MAX) }, null, 2))
  renameSync(tmp, file)
  cache = undefined
}

/** Record a project folder (created, opened or moved here). */
export function rememberProject(dir: string, file: string | undefined = knownProjectsFile()): void {
  if (!file) return
  const p = real(dir)
  const list = readKnownProjects(file).filter(x => key(x) !== key(p))
  list.push(p)
  write(file, list)
}

/** Forget a project folder (moved away or deleted). */
export function forgetProject(dir: string, file: string | undefined = knownProjectsFile()): void {
  if (!file) return
  const p = real(dir), r = resolve(dir)
  const list = readKnownProjects(file)
  const next = list.filter(x => key(x) !== key(p) && key(x) !== key(r))
  if (next.length !== list.length) write(file, next)
}

const inside = (root: string, p: string): boolean => {
  const a = key(root).replace(/[\\/]+$/, ''), b = key(p)
  return b === a || b.startsWith(a + sep) || b.startsWith(a + '/')
}

/** Folders whose contents are other projects for `project`: the projects root(s) and every known project,
 *  as real paths, without the home folder, "/", this project or anything inside it. A root that contains
 *  this project stays in the list; callers allow the project itself after it. */
export function otherProjectRoots(project: string, opts: { file?: string; projectsRoot?: string; home?: string } = {}): string[] {
  const home = real(opts.home ?? homedir())
  const me = real(project)
  const roots = [opts.projectsRoot ?? process.env.HUMANSTUDY_PROJECTS_ROOT?.trim() ?? join(homedir(), 'HumanStudy Hub'), ...readKnownProjects(opts.file ?? knownProjectsFile())]
  const out = new Map<string, string>()
  for (const r of roots) {
    if (!r) continue
    const p = real(r)
    if (p === '/' || key(p) === key(home) || inside(me, p)) continue
    out.set(key(p), p)
  }
  return [...out.values()]
}

/** Whether `p` (absolute) is inside another project of `project`'s app (see otherProjectRoots). */
export function inOtherProject(project: string, p: string, roots: string[]): boolean {
  const me = real(project)
  if (inside(me, p) || inside(me, real(p))) return false
  return roots.some(r => inside(r, p) || inside(r, real(p)))
}

