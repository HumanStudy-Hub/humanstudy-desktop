// Host-side check on `artifact.interact` events. The artifact frame is untrusted: the renderer only
// checks the message shape, so a hostile artifact could still spell out typed text through controlId,
// label or arm, one event at a time. Here the main process accepts only identifiers that the artifact
// file itself declares (read once per artifact revision), and bounds how many events one revision can
// produce. Anything else is kept as controlId "unknown" with no usable label or arm.
import { readFile, stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { parseArtifactInteraction, semanticId, type ArtifactInteraction } from '../shared/research-contract'

export const MAX_LABEL = 40
export const MAX_EVENTS_PER_REVISION = 500
export const DUPLICATE_WINDOW_MS = 1000
const MAX_FILE_BYTES = 20 * 1024 * 1024
const MAX_CACHED = 32
const UNKNOWN = 'unknown'
// Constant labels the artifact kit posts itself; they carry no information from the page.
const KIT_LABELS = ['source-citation']

export interface ArtifactVocabulary {
  /** Quoted string literals in the file (for the preview: in its code, not in its data block). */
  literals: Set<string>
  /** Page numbers named by data-page attributes (the kit's `source-page-N` control ids). */
  pages: Set<string>
  /** Literal data-hs-step values (generic artifacts). */
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
    return typeof blob === 'string' ? JSON.parse(gunzipSync(Buffer.from(blob, 'base64')).toString('utf8')) : null
  } catch { return null }
}

/** What one artifact file allows its frame to report. */
export function artifactVocabulary(html: string): ArtifactVocabulary {
  const pages = new Set<string>()
  for (const m of html.matchAll(/data-page=["']?(\d{1,6})["']?/g)) pages.add(String(Number(m[1])))
  const steps = new Set<number>()
  for (const m of html.matchAll(/data-hs-step=["']?(\d{1,6})["']?/g)) steps.add(Number(m[1]))
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
  const page = /^source-page-(\d{1,6})$/.exec(i.controlId)
  return v.literals.has(i.controlId) || (page !== null && v.pages.has(String(Number(page[1]))))
}

/** The interaction with every field the file does not declare replaced; null if the shape is invalid. */
export function screenInteraction(v: ArtifactVocabulary, input: unknown): ArtifactInteraction | null {
  const i = parseArtifactInteraction(input)
  if (!i) return null
  if (!knownControl(v, i)) return { ...i, controlId: UNKNOWN, label: UNKNOWN, arm: null, step: null }
  const label = i.label.length <= MAX_LABEL && (i.label === i.controlId || v.literals.has(i.label) || KIT_LABELS.includes(i.label))
    ? i.label : UNKNOWN
  const arm = i.arm !== null && (v.preview ? v.preview.arms.has(i.arm) : v.literals.has(i.arm)) ? i.arm : null
  const step = i.step === null ? null
    : v.preview ? (i.step <= v.preview.maxStep ? i.step : null)
    : v.steps.has(i.step) ? i.step : null
  return { ...i, label, arm, step }
}

export type ReadArtifact = (projectDir: string, rel: string) => Promise<string | null>

/** One guard per app session: vocabularies cached per artifact revision, volume bounded per revision. */
export function createInteractionGuard(read: ReadArtifact, now: () => number = Date.now) {
  const vocabularies = new Map<string, Promise<ArtifactVocabulary | null>>()
  const volume = new Map<string, { count: number; last?: string; at: number }>()
  return async (projectDir: string, rel: string, revision: string, input: unknown): Promise<ArtifactInteraction | null> => {
    const key = `${projectDir}\0${rel}\0${revision}`
    let vocabulary = vocabularies.get(key)
    if (!vocabulary) {
      vocabulary = read(projectDir, rel).then(text => text === null ? null : artifactVocabulary(text)).catch(() => null)
      vocabularies.set(key, vocabulary)
      if (vocabularies.size > MAX_CACHED) vocabularies.delete(vocabularies.keys().next().value as string)
    }
    const v = await vocabulary
    if (!v) return null
    const interaction = screenInteraction(v, input)
    if (!interaction) return null
    const state = volume.get(key) ?? { count: 0, at: -Infinity }
    volume.set(key, state)
    const signature = JSON.stringify(interaction), t = now()
    if (state.last === signature && t - state.at < DUPLICATE_WINDOW_MS) { state.at = t; return null }
    if (state.count >= MAX_EVENTS_PER_REVISION) return null
    state.count++
    state.last = signature
    state.at = t
    return interaction
  }
}

/** Reads an artifact file inside its project, refusing anything too large to be a page. */
export async function readArtifactFile(projectDir: string, rel: string): Promise<string | null> {
  const root = resolve(projectDir)
  const path = resolve(join(root, rel))
  if (!path.startsWith(root + sep)) return null
  const st = await stat(path).catch(() => null)
  if (!st?.isFile() || st.size > MAX_FILE_BYTES) return null
  return readFile(path, 'utf8')
}
