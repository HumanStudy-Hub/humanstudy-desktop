// A project that holds only protocol.json (no program.json) still opens the Simulation tab (v0.8): this builds the
// small, view-only program the tab reads (one study, the protocol's runnable arms as its conditions, the paper's n
// as its sample), so the plan, the estimate and the protocol approval have what they need. It is never written to
// disk and never stands in for program.json anywhere else; the run itself is decided by the protocol's own checks.
import type { HumanProgram, ProgramField } from './human-program'

export const PROTOCOL_STUDY_ID = 'protocol'

/** null when the text is not a protocol with at least one runnable arm. */
export function protocolProgram(text: string | null | undefined): HumanProgram | null {
  let raw: unknown
  try { raw = JSON.parse(text ?? '') } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as { id?: unknown; meta?: { title?: unknown }; arms?: unknown }
  const arms = (Array.isArray(p.arms) ? p.arms : [])
    .filter((a): a is { id: string; n_paper?: unknown; runnable?: unknown } => Boolean(a) && typeof a.id === 'string' && a.id !== '' && a.runnable !== false)
  if (!arms.length) return null
  const id = typeof p.id === 'string' && p.id ? p.id : 'protocol'
  const title = typeof p.meta?.title === 'string' && p.meta.title ? p.meta.title : id
  const n = arms.reduce((sum, a) => sum + (typeof a.n_paper === 'number' && a.n_paper > 0 ? a.n_paper : 0), 0)
  const field = (fid: string, value: number): ProgramField => ({ id: fid, label: 'Sample', value, origin: 'reported', state: 'confirmed', evidenceIds: [] } as unknown as ProgramField)
  return {
    schemaVersion: 2, id, title, intent: 'reconstruct',
    source: { title, authors: '', filename: 'protocol.json' },
    studies: [{ id: PROTOCOL_STUDY_ID, title, type: 'empirical' }],
    nodes: [
      ...arms.map((a) => ({ id: a.id, kind: 'condition', title: a.id, studyIds: [PROTOCOL_STUDY_ID], fields: [], evidenceIds: [] })),
      ...(n > 0 ? [{ id: 'participants', kind: 'participants', title: 'Participants', studyIds: [PROTOCOL_STUDY_ID], fields: [field('sample', n)], evidenceIds: [] }] : []),
    ],
    steps: [], relations: [], evidence: [], issues: [],
  }
}
