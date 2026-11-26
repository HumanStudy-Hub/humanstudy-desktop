// Who takes part in a protocol run, in one line for the Simulation tab. The run itself reads
// simulation/participants.json with pack/skills/run/participants.py (the authority: validation, the paper's
// sample, per-participant draws); this only says, in plain words, what the approval will carry.

export type ParticipantsMode = 'paper' | 'custom' | 'blank'
export interface ParticipantsView { mode: ParticipantsMode; text: string; problem?: string }
/** What the Simulation tab shows and the approval sends: the summary with the hashes of the very files it was read
 *  from (null: no such file), so Run approves exactly what was displayed. */
export interface ShownParticipants extends ParticipantsView { participantsSha256: string | null; programSha256: string | null; stamp: string }

/** SHA-256 (hex) of a text's UTF-8 bytes. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The summary of the files as read, with their hashes. */
export async function shownParticipants(files: { participants: string | null; protocol: string | null; program: string | null }, stamp: string): Promise<ShownParticipants> {
  const parse = (raw: string | null): unknown => { try { return raw === null ? null : JSON.parse(raw) } catch { return null } }
  const view = participantsSummary(files.participants, parse(files.protocol), parse(files.program) as Parameters<typeof paperSample>[1])
  return { ...view, stamp,
    participantsSha256: files.participants === null ? null : await sha256Hex(files.participants),
    programSha256: files.program === null ? null : await sha256Hex(files.program) }
}

const MARK = /\b(?:study|experiment|exp\.?)\s*\d+\b/i
const AGE_MEAN = /\b(?:M\s*age|mean\s+age|average\s+age)\s*(?:was|of|=|:|,)?\s*(\d{1,2}(?:\.\d+)?)/i

/** The population as printed, without counts (participants.py _clean). */
export function cleanPopulation(text: string): string {
  let t = text.replace(/\s*\([^()]*\d[^()]*\)/g, '')
  t = t.split(/:\s*(?=(?:study|experiment|exp\.?)\s*\d)/i)[0]
  t = t.split(/(?<=[a-z0-9)])\.\s/)[0].trim().replace(/[.;,]+$/, '')
  t = t.replace(/^(?:the\s+)?(?:n\s*=\s*)?\d[\d,]*\s+/i, '')
  return t.slice(0, 300)
}

/** The paper's own description of its sample: protocol.json meta.sample (text, or its population), else the
 *  program's participants field `population`/`setting`/`sample` when it is text. */
export function paperSample(protocol: unknown, program?: { nodes?: { kind?: string; fields?: { id?: string; value?: unknown; state?: string }[] }[] } | null): string | null {
  const sample = (protocol as { meta?: { sample?: unknown } } | null)?.meta?.sample
  const texts: string[] = []
  if (typeof sample === 'string') texts.push(sample)
  else if (sample && typeof sample === 'object') for (const k of ['population', 'description', 'who'])
    if (typeof (sample as Record<string, unknown>)[k] === 'string') texts.push((sample as Record<string, string>)[k])
  for (const n of program?.nodes ?? []) if (n?.kind === 'participants') for (const f of n.fields ?? [])
    if (f?.state !== 'missing' && typeof f?.value === 'string' && /^(population|setting|sample)$/.test(String(f.id))) texts.push(f.value)
  for (const t of texts) {
    const d = cleanPopulation(t)
    if (d && !/^[\d\s,.;:()%-]*$/.test(d)) {
      const age = MARK.test(t) ? null : AGE_MEAN.exec(t)?.[1]
      return age ? `${d}, age ~${Number(age)}` : d
    }
  }
  return null
}

/** One line on who takes part. `raw`: simulation/participants.json (null when absent). */
export function participantsSummary(raw: string | null, protocol: unknown, program?: Parameters<typeof paperSample>[1]): ParticipantsView {
  const paper = (): ParticipantsView => ({ mode: 'paper', text: `Sample-matched: ${paperSample(protocol, program) ?? 'the paper does not describe its participants'}` })
  if (raw === null) return paper()
  let spec: { mode?: unknown; groups?: unknown; system?: unknown }
  try { spec = JSON.parse(raw) } catch { return { ...paper(), problem: 'simulation/participants.json is not valid JSON' } }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ...paper(), problem: 'simulation/participants.json must be one JSON object' }
  const mode = spec.mode ?? 'paper'
  if (mode === 'blank') return { mode, text: 'Blank: the model with no persona (for comparison)' }
  if (mode === 'paper') return { ...paper(), ...(typeof spec.system === 'string' ? { text: paper().text + '; own system prompt' } : {}) }
  if (mode !== 'custom') return { ...paper(), problem: `simulation/participants.json has an unknown mode "${String(mode)}"` }
  const groups = Array.isArray(spec.groups) ? spec.groups as { id?: unknown; label?: unknown; weight?: unknown }[] : []
  if (!groups.length) return { mode: 'custom', text: 'Custom: no groups', problem: 'simulation/participants.json has no groups' }
  const weights = groups.map((g) => (typeof g?.weight === 'number' && g.weight > 0 ? g.weight : 1))
  const total = weights.reduce((a, b) => a + b, 0)
  const names = groups.slice(0, 4).map((g, i) => `${String(g?.label ?? g?.id ?? `group ${i + 1}`)} ${Math.round((100 * weights[i]) / total)}%`)
  return { mode: 'custom', text: `Custom: ${groups.length} group${groups.length === 1 ? '' : 's'} (${names.join(', ')}${groups.length > 4 ? ', …' : ''})${typeof spec.system === 'string' ? '; own system prompt' : ''}` }
}
