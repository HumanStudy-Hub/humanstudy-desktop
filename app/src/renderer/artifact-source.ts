import type { OpenSourceRequest } from './bridge'
import type { SourceRef } from './components/SourceDrawer'
import { itemSources } from '../shared/program-view'
import type { HumanProgram } from '../shared/human-program'

/** Where an artifact's click should open: its own page/quote, else the program item's first cited source. */
export function artifactSourceRef(program: unknown, req: OpenSourceRequest): SourceRef {
  const p = program as HumanProgram | null | undefined
  const usable = !!p && Array.isArray(p.evidence) && Array.isArray(p.nodes) && Array.isArray(p.steps)
  const id = req.programId?.split('/')[0]
  const cited = usable && id ? (itemSources(p, id)[0] ?? itemSources(p, `flow:${id}`)[0]) : undefined
  const page = req.page ?? cited?.page ?? 1
  const samePlace = req.page === undefined || cited?.page === req.page
  return {
    page,
    quote: req.quote ?? (samePlace ? cited?.quote : undefined),
    file: req.file ?? (samePlace ? cited?.file : undefined),
    sourceId: samePlace ? cited?.sourceId : undefined,
    nodeId: req.programId,
  }
}
