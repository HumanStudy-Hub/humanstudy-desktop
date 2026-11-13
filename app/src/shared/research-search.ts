import type { CommunityStudy } from '../preload/types'

const norm = (s: string) => s.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim()
export type ResearchConcept = { id: string; label: string; aliases: string[]; status: string }

/** Shared projection for the Electron library and its browser preview. Text matches are not tags. */
export function catalogSearchFields(paper: Record<string, unknown>, concepts: ResearchConcept[]) {
  const ids = Array.isArray(paper.conceptIds) ? paper.conceptIds : []
  const assigned = concepts.filter(c => c.status === 'reviewed' && ids.includes(c.id))
  const text = norm([paper.title, paper.description, paper.searchText, ...(Array.isArray(paper.authors) ? paper.authors : [])].join('\n'))
  return {
    topics: assigned.map(c => ({ id: c.id, label: c.label })),
    conceptLabels: assigned.flatMap(c => [c.label, ...c.aliases]),
    searchAliases: concepts.filter(c => c.status === 'reviewed' && norm(c.label).split(' ').every(word => text.includes(word)))
      .flatMap(c => [c.label, ...c.aliases]),
  }
}

/** Extracted papers have a community Human Program or a benchmark study package. */
export function isExtracted(study: Pick<CommunityStudy, 'id' | 'currentRevision' | 'legacyStudyId'>): boolean {
  return Boolean(study.currentRevision || study.legacyStudyId || /^study_\d+$/.test(study.id))
}

/** Publication provenance is issued by the catalog, independently of contributor metadata. */
export function catalogPublicationFields(paper: Record<string, unknown>, publications: unknown): Pick<CommunityStudy, 'publication' | 'hasReviewedProtocol'> {
  const record = publications && typeof publications === 'object' && typeof paper.id === 'string'
    ? (publications as Record<string, { revision?: unknown; kind?: unknown }>)[paper.id] : undefined
  const { revision, kind } = record ?? {}
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision) || revision !== paper.currentRevision
    || (kind !== 'user-submitted' && kind !== 'maintainer-reviewed-protocol')) return { publication: undefined, hasReviewedProtocol: false }
  const protocol = paper.protocol as {
    revision?: unknown; schemaVersion?: unknown; arms?: { runnable?: unknown }[]
    fidelity?: { verdict?: unknown; signed_by?: unknown }
  } | undefined
  const hasReviewedProtocol = Boolean(kind === 'maintainer-reviewed-protocol'
    && Array.isArray(paper.assetFiles) && paper.assetFiles.some(file => file?.path === 'protocol.json')
    && protocol?.revision === revision && protocol.schemaVersion === '1'
    && (protocol.fidelity?.verdict === 'HIGH FIDELITY' || protocol.fidelity?.verdict === 'high_fidelity')
    && typeof protocol.fidelity?.signed_by === 'string' && protocol.fidelity.signed_by.trim()
    && Array.isArray(protocol.arms) && protocol.arms.some(arm => arm?.runnable === true))
  return { publication: { kind, revision }, hasReviewedProtocol }
}

export function isUserSubmission(study: Pick<CommunityStudy, 'publication' | 'currentRevision'>): boolean {
  return study.publication?.kind === 'user-submitted' && study.publication.revision === study.currentRevision
}

export function isValidatedProtocol(study: Pick<CommunityStudy, 'publication' | 'currentRevision' | 'hasReviewedProtocol'>): boolean {
  return study.hasReviewedProtocol === true && study.publication?.kind === 'maintainer-reviewed-protocol'
    && study.publication.revision === study.currentRevision
}

export function researchAvailability(study: CommunityStudy): string {
  if (isValidatedProtocol(study)) return 'Validated protocol'
  if (isUserSubmission(study)) return 'User submitted'
  return study.currentRevision ? 'Human Study Program available' : study.legacyStudyId || /^study_\d+$/.test(study.id)
    ? 'Study materials' : 'Not yet extracted'
}

/** Same relevance order as the website snapshot: identity, assigned topic, title, body. */
export function researchRank(study: CommunityStudy, query: string): number {
  const q = norm(query)
  if (!q) return 1
  if (study.id === query.trim() || study.aliases?.includes(query.trim())) return 100
  if (study.conceptLabels?.some(label => norm(label) === q)) return 20
  return norm(study.title).includes(q) ? 10 : 1
}
/** Searches the entire downloaded index, including reviewed concept aliases and substudy text. */
export function matchesResearch(study: CommunityStudy, query: string, topicId?: string): boolean {
  if (topicId && !study.topics?.some(topic => topic.id === topicId)) return false
  const q = norm(query)
  if (!q) return true
  const labels = study.conceptLabels ?? []
  if (labels.some(label => norm(label) === q) || study.aliases?.includes(query.trim())) return true
  if (study.searchAliases?.some(alias => norm(alias) === q)) return true
  if (study.id === query.trim()) return true
  const haystack = norm([study.title, study.description, study.authors.join(' '), study.year ?? '', study.searchText ?? ''].join('\n'))
  return q.split(' ').every(word => haystack.includes(word))
}
