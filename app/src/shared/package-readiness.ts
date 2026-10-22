// Is the replay package under package/<slug>/ complete enough to run? The static part of
// pack/skills/build/check_package.py (the agent's full check): the eight required files exist, every
// required JSON file parses, task/adapter.py defines run_sessions() and evaluation/evaluation.py defines
// evaluate(). The bindings and the adapter smoke test stay with the agent's check; this only decides
// whether the app may offer a run at all. The renderer (Simulation tab) and the main process (refusing
// a run approval) both use it, so they cannot disagree.

/** Same list and order as REQUIRED in pack/skills/build/check_package.py (a test keeps them equal). */
export const PACKAGE_FILES = [
  'study.json',
  'source/paper_metadata.json',
  'source/evidence.json',
  'materials/materials.json',
  'task/task.json',
  'task/adapter.py',
  'evaluation/evaluation.py',
  'audit/missing_information.json',
] as const
export type PackageFile = (typeof PACKAGE_FILES)[number]

/** The functions the simulate skill calls (build skill section 3). */
export const PACKAGE_ENTRY_POINTS: Partial<Record<PackageFile, string>> = {
  'task/adapter.py': 'run_sessions',
  'evaluation/evaluation.py': 'evaluate',
}

export type PackageProblem =
  | { file: PackageFile; kind: 'missing' }
  | { file: PackageFile; kind: 'invalid-json' }
  | { file: PackageFile; kind: 'no-entry'; entry: string }

export interface PackageReadiness {
  /** At least one folder under package/. */
  exists: boolean
  ready: boolean
  /** The package checked (the ready one, else the most complete one). */
  slug: string | null
  problems: PackageProblem[]
}

/** File text, `null` when the file does not exist, `undefined` when it exists but was not read
 *  (too large to read here; the agent's check covers it). */
export type ReadPackageFile = (file: PackageFile) => Promise<string | null | undefined>

const defines = (source: string, name: string) =>
  new RegExp(`^(?:async[ \\t]+)?def[ \\t]+${name}[ \\t]*\\(`, 'm').test(source)

/** Problems of one package folder, in PACKAGE_FILES order. */
export async function packageProblems(read: ReadPackageFile): Promise<PackageProblem[]> {
  const texts = await Promise.all(PACKAGE_FILES.map((f) => read(f).catch(() => null)))
  const problems: PackageProblem[] = []
  PACKAGE_FILES.forEach((file, i) => {
    const text = texts[i]
    if (text === null) return void problems.push({ file, kind: 'missing' })
    if (text === undefined) return
    if (file.endsWith('.json')) {
      try { JSON.parse(text) } catch { problems.push({ file, kind: 'invalid-json' }) }
      return
    }
    const entry = PACKAGE_ENTRY_POINTS[file]
    if (entry && !defines(text, entry)) problems.push({ file, kind: 'no-entry', entry })
  })
  return problems
}

/** Check every package folder; ready when one of them passes. */
export async function packageReadiness(slugs: string[], read: (slug: string, file: PackageFile) => Promise<string | null | undefined>): Promise<PackageReadiness> {
  if (!slugs.length) return { exists: false, ready: false, slug: null, problems: [] }
  const checked = await Promise.all([...slugs].sort().map(async (slug) => ({ slug, problems: await packageProblems((f) => read(slug, f)) })))
  const best = checked.reduce((a, b) => (b.problems.length < a.problems.length ? b : a))
  return { exists: true, ready: best.problems.length === 0, slug: best.slug, problems: best.problems }
}

/** A one-line fingerprint of the package files (names, sizes, times), to recheck when they change. */
export function packageStamp(entries: { rel: string; size?: number; mtime?: number }[]): string {
  return entries.filter((e) => e.rel === 'package' || e.rel.startsWith('package/')).map((e) => `${e.rel}:${e.size ?? ''}:${e.mtime ?? ''}`).sort().join('|')
}
