// Host-side check on `artifact.interact` events. The artifact frame is untrusted: the renderer only
// checks the message shape, so a hostile artifact could still spell out typed text through controlId,
// label or arm, one event at a time. Here the main process accepts only identifiers that the artifact
// file itself declares (read once per artifact revision), and bounds how many events one revision can
// produce.
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parseArtifactInteraction, semanticId, type ArtifactInteraction } from '../shared/research-contract'

export const DROPPED_INTERACTION = 'dropped'
export const MAX_LABEL = 40
export const MAX_EVENTS_PER_REVISION = 500
export const DUPLICATE_WINDOW_MS = 1000
const MAX_FILE_BYTES = 5 * 1024 * 1024
// A compressed preview block may not expand past this (decompression bomb).
const MAX_PREVIEW_JSON_BYTES = 8 * 1024 * 1024
const MAX_CACHED = 32
const UNKNOWN = 'unknown'
// Constant labels the artifact kit posts itself; they carry no information from the page.
const KIT_LABELS = ['source-citation']
// A citation to a page the file does not list keeps the click, not the number.
const UNLISTED_PAGE = 'source-page'

export interface ArtifactVocabulary {
  /** Quoted string literals in the file (for the preview: in its code, not in its data block). */
  literals: Set<string>
  /** Page numbers the file names: data-page attributes, or "page"/"pages" in its embedded JSON (HS.cite
   *  builds data-page at runtime). These are the kit's `source-page-N` control ids. */
  pages: Set<string>
  /** data-hs-step attribute values, or "step" numbers in embedded JSON (generic artifacts). */
  steps: Set<number>
  /** The participant preview's embedded protocol, when the file is one. */
  preview?: { responses: Set<string>; arms: Set<string>; controls: Set<string>; maxStep: number }
}

const LITERAL = /"([A-Za-z0-9][A-Za-z0-9_.:/#-]{0,119})"|'([A-Za-z0-9][A-Za-z0-9_.:/#-]{0,119})'|&quot;([A-Za-z0-9][A-Za-z0-9_.:/#-]{0,119})&quot;/g
const PREVIEW_BLOCK = /<script type="application\/json" id="hs-preview"( data-encoding="gzip\+base64")?>([\s\S]*?)<\/script>/

function literals(text: string): Set<string> {
  const out = new Set<string>()
  for (const m of text.matchAll(LITERAL)) out.add(m[1] ?? m[2] ?? m[3])
  return out
}

type PreviewData = {
  arms?: Array<{ id?: unknown; participants?: Array<{ screens?: unknown[] }> }>
  screens?: Record<string, { responses?: Array<{ id?: unknown }> }>
  conditions?: { differ?: Array<{ variants?: unknown[] }>; partial?: Array<{ screens?: unknown[] }> }
}

function previewData(match: RegExpMatchArray): PreviewData | null {
  try {
    if (!match[1]) return JSON.parse(match[2])
    const blob = JSON.parse(match[2])
    return typeof blob === 'string' ? JSON.parse(gunzipSync(Buffer.from(blob, 'base64'), { maxOutputLength: MAX_PREVIEW_JSON_BYTES }).toString('utf8')) : null
  } catch { return null }
}

/** What one artifact file allows its frame to report. */
export function artifactVocabulary(html: string): ArtifactVocabulary {
  const pages = new Set<string>()
  for (const m of html.matchAll(/data-page=["']?(\d{1,6})["']?/g)) pages.add(String(Number(m[1])))
  for (const m of html.matchAll(/"pages?"\s*:\s*(\[[\d\s,"]{0,400}\]|"?\d{1,6}"?)/g))
    for (const n of m[1].match(/\d{1,6}/g) ?? []) pages.add(String(Number(n)))
  const steps = new Set<number>()
  for (const m of html.matchAll(/data-hs-step=["']?(\d{1,6})["']?|"step"\s*:\s*"?(\d{1,6})"?/g)) steps.add(Number(m[1] ?? m[2]))
  const block = /<meta name="hs-artifact" content="participant-preview">/.test(html) ? html.match(PREVIEW_BLOCK) : null
  const data = block && previewData(block)
  if (!block || !data || typeof data !== 'object') return { literals: literals(html), pages, steps }

  // The preview's own controls are the literals of its code; the protocol's text is not a vocabulary.
  const code = html.slice(0, block.index) + html.slice((block.index ?? 0) + block[0].length)
  const responses = new Set<string>(), arms = new Set<string>(), controls = new Set<string>()
  let maxStep = -1
  for (const arm of Array.isArray(data.arms) ? data.arms : []) {
    if (semanticId(arm?.id)) arms.add(arm.id)
    for (const p of Array.isArray(arm?.participants) ? arm.participants : [])
      if (Array.isArray(p?.screens)) maxStep = Math.max(maxStep, p.screens.length - 1)
  }
  for (const screen of Object.values(data.screens && typeof data.screens === 'object' ? data.screens : {}))
    for (const r of Array.isArray(screen?.responses) ? screen.responses : []) if (semanticId(r?.id)) responses.add(r.id)
  const differ = Array.isArray(data.conditions?.differ) ? data.conditions.differ : []
  differ.forEach((d, k) => (Array.isArray(d?.variants) ? d.variants : []).forEach((_v, i) => controls.add(`variant-${k}-${i}`)))
  const partial = Array.isArray(data.conditions?.partial) ? data.conditions.partial : []
  partial.forEach((e, k) => (Array.isArray(e?.screens) ? e.screens : []).forEach((_s, i) => controls.add(`partial-${k}-${i}`)))
  return { literals: literals(code), pages, steps, preview: { responses, arms, controls, maxStep } }
}

function knownControl(v: ArtifactVocabulary, i: ArtifactInteraction): boolean {
  if (v.preview) {
    // An answer names a response of the embedded protocol, nothing else.
    if (i.action === 'answer') return v.preview.responses.has(i.controlId)
    return v.preview.controls.has(i.controlId) || v.literals.has(i.controlId)
  }
  // Citation ids were already reduced to listed pages or `source-page` by citation().
  return v.literals.has(i.controlId) || i.controlId === UNLISTED_PAGE || /^source-page-\d{1,6}$/.test(i.controlId)
}

/** The kit's citation ids: a listed page keeps its number, an unlisted one becomes `source-page`. */
function citation(v: ArtifactVocabulary, controlId: string): string {
  const page = /^source-page-(\d{1,6})$/.exec(controlId)
  return !page || v.preview || v.literals.has(controlId) ? controlId
    : v.pages.has(String(Number(page[1]))) ? controlId : UNLISTED_PAGE
}

/** The interaction with every field the file does not declare replaced; null if the shape is invalid. */
export function screenInteraction(v: ArtifactVocabulary, input: unknown, dropUnknown = false): ArtifactInteraction | null {
  const parsed = parseArtifactInteraction(input)
  if (!parsed) return null
  const i = { ...parsed, controlId: citation(v, parsed.controlId) }
  if (!knownControl(v, i)) return dropUnknown ? null : { ...i, controlId: UNKNOWN, label: UNKNOWN, arm: null, step: null }
  const label = i.label.length <= MAX_LABEL && (i.label === i.controlId || v.literals.has(i.label) || KIT_LABELS.includes(i.label))
    ? i.label : UNKNOWN
  const arm = i.arm !== null && (v.preview ? v.preview.arms.has(i.arm) : v.literals.has(i.arm)) ? i.arm : null
  const step = i.step === null ? null
    : v.preview ? (i.step <= v.preview.maxStep ? i.step : null)
    : v.steps.has(i.step) ? i.step : null
  return { ...i, label, arm, step }
}

/** Revisions that name the file on disk (FileView uses `draft` and `history:<id>` for in-memory text). */
export const onDiskRevision = (revision: string): boolean => revision !== 'draft' && !revision.startsWith('history:')

export type ReadArtifact = (projectDir: string, rel: string) => Promise<string | null>

/** One guard per app session: vocabularies cached per artifact revision, volume bounded per revision. */
export function createInteractionGuard(read: ReadArtifact, now: () => number = Date.now) {
  const vocabularies = new Map<string, Promise<ArtifactVocabulary | null>>()
  const volume = new Map<string, { count: number; last?: string; at: number }>()
  // A retry after a lost ACK keeps its original decision, even outside the dedupe window.
  type Decision = ArtifactInteraction | typeof DROPPED_INTERACTION
  const decisions = new Map<string, Decision>()
  return async (projectDir: string, rel: string, revision: string, input: unknown, deliveryId?: string): Promise<Decision | null> => {
    // A draft or an older version is shown from text the renderer holds, not the file on disk, so
    // the file cannot vouch for its ids: such views report no interactions.
    if (!onDiskRevision(revision)) return DROPPED_INTERACTION
    const key = `${projectDir}\0${rel}\0${revision}`
    const deliveryKey = deliveryId ? `${key}\0${deliveryId}` : undefined
    const prior = deliveryKey && decisions.get(deliveryKey)
    if (prior) return prior
    const remember = (decision: Decision) => {
      if (deliveryKey) {
        decisions.set(deliveryKey, decision)
        if (decisions.size > 5000) decisions.delete(decisions.keys().next().value!)
      }
      return decision
    }
    let vocabulary = vocabularies.get(key)
    if (!vocabulary) {
      const reading = read(projectDir, rel).then(text => text === null ? null : artifactVocabulary(text))
      vocabulary = reading
      vocabularies.set(key, reading)
      if (vocabularies.size > MAX_CACHED) vocabularies.delete(vocabularies.keys().next().value as string)
    }
    let v: ArtifactVocabulary | null
    try {
      v = await vocabulary
    } catch {
      if (vocabularies.get(key) === vocabulary) vocabularies.delete(key)
      return null // Retry this delivery without consuming its id or volume allowance.
    }
    const concurrent = deliveryKey && decisions.get(deliveryKey)
    if (concurrent) return concurrent
    if (!v) return remember(DROPPED_INTERACTION)
    const interaction = screenInteraction(v, input, true)
    if (!interaction) return remember(DROPPED_INTERACTION)
    const state = volume.get(key) ?? { count: 0, at: -Infinity }
    volume.set(key, state)
    const signature = JSON.stringify(interaction), t = now()
    if (state.last === signature && t - state.at < DUPLICATE_WINDOW_MS) { state.at = t; return remember(DROPPED_INTERACTION) }
    if (state.count >= MAX_EVENTS_PER_REVISION) return remember(DROPPED_INTERACTION)
    state.count++
    state.last = signature
    state.at = t
    return remember(interaction)
  }
}

/** Reads an artifact file inside its project, refusing anything too large to be a page. */
export async function readArtifactFile(projectDir: string, rel: string): Promise<string | null> {
  const root = resolve(projectDir)
  const path = resolve(join(root, rel))
  if (!path.startsWith(root + sep)) return null
  const st = await stat(path)
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return null
  return readFile(path, 'utf8')
}
