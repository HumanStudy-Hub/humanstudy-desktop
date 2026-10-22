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

export function researchAvailability(study: CommunityStudy): string {
  return study.currentRevision ? 'Human Program available' : study.legacyStudyId || /^study_\d+$/.test(study.id)
    ? 'Study materials' : 'Source indexed'
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
