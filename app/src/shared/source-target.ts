import type { ProjectEntry, ProjectFile, ProjectSnapshot } from '../preload/types'
import type { SourceRef } from './program-view'

/** Resolve an explicit source without substituting the paper for an unknown attachment. */
export function sourceTarget(project: ProjectSnapshot, ref: Pick<SourceRef, 'file' | 'sourceId'>): ProjectEntry | ProjectFile | null {
  const all: ProjectEntry[] = []
  const walk = (entries: ProjectEntry[]) => entries.forEach(e => e.kind === 'dir' ? walk(e.children ?? []) : all.push(e))
  walk(project.tree)
  const normalize = (s: string) => s.replace(/\\/g, '/').replace(/^\.\//, '')
  const locator = ref.file ?? ref.sourceId
  if (!locator || ['paper', 'paper.pdf', (project.program as { source?: { filename?: string } } | null)?.source?.filename].includes(locator)) return project.pdf
  const name = normalize(locator)
  return all.find(e => normalize(e.rel) === name || normalize(e.path) === name)
    ?? (all.filter(e => e.name === name).length === 1 ? all.find(e => e.name === name)! : null)
}
