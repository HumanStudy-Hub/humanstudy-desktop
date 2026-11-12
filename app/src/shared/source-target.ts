import type { ProjectEntry, ProjectFile, ProjectSnapshot } from '../preload/types'
import type { SourceRef } from './program-view'

type Reference = Pick<SourceRef, 'file' | 'sourceId' | 'sourceSha256'>
type SourceFile = ProjectEntry | ProjectFile
const projectFiles = (entries: ProjectEntry[]): ProjectEntry[] =>
  entries.flatMap(e => e.kind === 'dir' ? projectFiles(e.children ?? []) : [e])
const normalize = (s: string) => s.replace(/\\/g, '/').replace(/^\.\//, '')
export const validSourceDigest = (s: unknown): s is string => typeof s === 'string' && /^[a-f\d]{64}$/i.test(s)

export function manifestSourceDigests(raw: string): Record<string, string> {
  const { pdf, files } = JSON.parse(raw) as { pdf?: { filename?: string; sha256?: string }; files?: { path?: string; sha256?: string }[] }
  const digests = new Map<string, string>()
  for (const entry of Array.isArray(files) ? files : []) {
    if (typeof entry?.path === 'string' && validSourceDigest(entry.sha256)) digests.set(normalize(entry.path), entry.sha256.toLowerCase())
  }
  if (typeof pdf?.filename === 'string' && validSourceDigest(pdf.sha256)) {
    digests.set(normalize(pdf.filename), pdf.sha256.toLowerCase())
  }
  return Object.fromEntries(digests)
}

export function protocolSourceDigests(raw: string): Record<string, string> {
  const { meta } = JSON.parse(raw) as { meta?: { sources?: Record<string, { file?: string; sha256?: string }> } }
  const digests = new Map<string, string>()
  for (const [id, entry] of Object.entries(meta?.sources ?? {})) {
    if (!validSourceDigest(entry?.sha256)) continue
    digests.set(id, entry.sha256.toLowerCase())
    if (typeof entry.file === 'string') digests.set(normalize(entry.file), entry.sha256.toLowerCase())
  }
  return Object.fromEntries(digests)
}

/** Preserve the named file and its recorded identity. A different path is used only for an
 * unambiguous content match, or for the canonical paper.pdf name used by imports. */
export function resolveSource(project: ProjectSnapshot, ref: Reference): { file: SourceFile | null; pending: boolean; changed: boolean } {
  const all = projectFiles(project.tree)
  const paperName = (project.program as { source?: { filename?: string } } | null)?.source?.filename
  const locator = ref.file ?? ref.sourceId
  const name = locator ? normalize(locator) : 'paper.pdf'
  const paperAlias = name === 'paper' || name === 'paper.pdf' || (paperName && !name.includes('/') && name === normalize(paperName))
  const byName = all.filter(e => normalize(e.rel) === name || normalize(e.path) === name)
  if (!byName.length && !name.includes('/') && !paperAlias) byName.push(...all.filter(e => e.name === name))
  let file: SourceFile | null = byName.length === 1 ? byName[0] : paperAlias ? project.pdf : null
  const manifest = project.sourceDigests?.[name] ??
    (paperAlias ? project.sourceDigests?.['paper.pdf'] ?? (paperName && project.sourceDigests?.[normalize(paperName)]) : undefined)
  const expected = validSourceDigest(ref.sourceSha256) ? ref.sourceSha256.toLowerCase() :
    validSourceDigest(manifest) ? manifest.toLowerCase() : undefined
  if (expected && file?.sha256 !== expected) {
    const matching = all.filter(e => e.sha256 === expected)
    if (matching.length === 1) file = matching[0]
  }
  const changed = Boolean(file && expected && file.sha256 !== expected)
  const pdf = file?.ext === 'pdf' || Boolean(expected) || /\.pdf$/i.test(name) || Boolean(paperAlias)
  // Older evidence without its own binding is retained as pending, even if a manifest locates the file.
  const pending = !file || (pdf && (!validSourceDigest(ref.sourceSha256) || changed))
  return { file, pending, changed }
}

export function sourceTarget(project: ProjectSnapshot, ref: Reference): SourceFile | null {
  return resolveSource(project, ref).file
}

/** An existing sidecar can follow a uniquely identified rename without reattaching old rectangles
 * to new bytes. If both the old and new paths have notes, keep each path's records separate. */
export function pdfAnnotationPath(project: ProjectSnapshot, file: SourceFile, ref?: Reference | null): string {
  const defaultPath = file.path + '.annotations.json'
  if (!file.sha256) return defaultPath
  const all = projectFiles(project.tree)
  if (all.some(e => e.path === defaultPath) || all.filter(e => e.sha256 === file.sha256).length !== 1) return defaultPath
  const priorPaths = new Set(Object.entries(project.sourceDigests ?? {}).filter(([, digest]) => digest === file.sha256).map(([path]) => path))
  if (ref?.file && ref.sourceSha256?.toLowerCase() === file.sha256) priorPaths.add(normalize(ref.file))
  const candidates = all.filter(e => e.rel.endsWith('.annotations.json') &&
    (priorPaths.has(e.rel.slice(0, -'.annotations.json'.length)) || priorPaths.has(normalize(e.path.slice(0, -'.annotations.json'.length)))))
  return candidates.length === 1 ? candidates[0].path : defaultPath
}
