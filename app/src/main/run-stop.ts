// Stop ends a simulation's model access at once (v0.8): when the researcher's Stop writes STOP into a run folder
// (artifacts/simulations/<run>/STOP), every run relay of that project closes, so no further model call is
// possible whatever the run process does; the run then ends after the pages in flight and records them as partial.
import { relative, resolve, sep } from 'node:path'

/** True when `path` is the STOP file of a run folder of `project`. */
export function isRunStop(project: string, path: string): boolean {
  const rel = relative(project, path).split(sep).join('/')
  return /^artifacts\/simulations\/[^/]+\/STOP$/.test(rel) && !rel.split('/').some((p) => p === '..' || p === '')
}

/** Close every relay of `project`; returns the ids closed. */
export async function closeProjectRelays(project: string, relays: Map<string, { project: string }>, close: (id: string) => Promise<void>): Promise<string[]> {
  const ids = [...relays].filter(([, r]) => resolve(r.project) === resolve(project)).map(([id]) => id)
  for (const id of ids) await close(id)
  return ids
}
