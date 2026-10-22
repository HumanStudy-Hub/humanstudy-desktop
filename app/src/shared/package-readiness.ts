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
  | { file: PackageFile; kind: 'unvalidated' | 'wrong-study' | 'stale-program' | 'bindings' }
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
 *  (unvalidated files cannot enable Run). */
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
    if (text === undefined) return void problems.push({ file, kind: 'unvalidated' })
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
export async function packageReadiness(slugs: string[], read: (slug: string, file: PackageFile) => Promise<string | null | undefined>, context?: { studyId: string; program: unknown }): Promise<PackageReadiness> {
  if (!slugs.length) return { exists: false, ready: false, slug: null, problems: [] }
  const checked = await Promise.all([...slugs].sort().map(async (slug) => {
    const cache = new Map<PackageFile, Promise<string | null | undefined>>()
    const once = (file: PackageFile) => {
      if (!cache.has(file)) cache.set(file, read(slug, file).catch(() => null))
      return cache.get(file)!
    }
    const problems = await packageProblems(once)
    if (context) {
      try {
        const study = JSON.parse((await once('study.json')) ?? '')
        if (!study.program?.studies?.some((s: { id: string }) => s.id === context.studyId))
          problems.push({ file: 'study.json', kind: 'wrong-study' })
        if (canonical(study.program) !== canonical(context.program)) problems.push({ file: 'study.json', kind: 'stale-program' })
        const program = context.program as { id: string; steps: { id: string }[]; nodes: { id: string; kind: string }[] }
        const expected = {
          programId: program.id,
          stepIds: program.steps.map(s => s.id),
          recordNodeIds: program.nodes.filter(n => ['record', 'variable'].includes(n.kind)).map(n => n.id),
          analysisNodeIds: program.nodes.filter(n => n.kind === 'analysis').map(n => n.id),
        }
        const task = JSON.parse((await once('task/task.json')) ?? '')
        if (canonical(task?.programBindings) !== canonical(expected)) problems.push({ file: 'task/task.json', kind: 'bindings' })
      } catch {
        if (!problems.length) problems.push({ file: 'study.json', kind: 'unvalidated' })
      }
    }
    return { slug, problems }
  }))
  const best = checked.reduce((a, b) => (b.problems.length < a.problems.length ? b : a))
  return { exists: true, ready: best.problems.length === 0, slug: best.slug, problems: best.problems }
}

function canonical(value: unknown): string {
  const sorted = (v: unknown): unknown => Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sorted(x)])) : v
  return JSON.stringify(sorted(value)) ?? 'null'
}

/** A one-line fingerprint of the package files (names, sizes, times), to recheck when they change. */
export function packageStamp(entries: { rel: string; size?: number; mtime?: number }[]): string {
  return entries.filter((e) => e.rel === 'package' || e.rel.startsWith('package/')).map((e) => `${e.rel}:${e.size ?? ''}:${e.mtime ?? ''}`).sort().join('|')
}
