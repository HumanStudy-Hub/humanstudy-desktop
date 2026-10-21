import type { CommunityStudy } from '../preload/types'

const norm = (s: string) => s.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim()
/** Searches the entire downloaded index, including reviewed concept aliases and substudy text. */
export function matchesResearch(study: CommunityStudy, query: string): boolean {
  const q = norm(query)
  if (!q) return true
  const labels = study.conceptLabels ?? []
  if (labels.some(label => norm(label) === q) || study.aliases?.includes(query.trim())) return true
  if (study.searchAliases?.some(alias => norm(alias) === q)) return true
  const haystack = norm([study.title, study.description, study.authors.join(' '), study.year ?? '', study.searchText ?? ''].join('\n'))
  return q.split(' ').every(word => haystack.includes(word))
}
