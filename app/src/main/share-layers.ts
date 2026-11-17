// Sharing a study in three layers (owner decision 2026-11-16), all prepared by the one community exporter
// (pack/skills/export/community.py, the app's shipped copy, never the project's):
//   1 study overview   program.json; always shareable. Wording from sources without an open licence is withheld and
//                      marked "Get from source" (URL or DOI plus hash).
//   2 runnable experiment  the overview plus protocol.json, the study card and allowed materials; only for a
//                      Validated library study or a protocol whose checks passed here. Restricted materials ship as
//                      "Get from source" through the hsenv distribution tiers (hosted / link / user).
//   3 my results and materials  artifacts/ items (AI-trial outputs, agent-written materials); private unless ticked.
// Restricted wording is checked by content in every shared file. Private project sync (project-sync*.ts) is not
// sharing and never comes through here. No electron imports, so this module runs from plain Node in tests.
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ShareLayer, ShareLayerState, SharePreview, ShareResultItem } from '../preload/types'
import { confinedPython, withScratch } from './protocol-readiness'

export interface ShareRuntime {
  /** The research runtime's Python; null when it is not installed (nothing can be prepared then). */
  python: string | null
  /** trustedShareFiles(): the exporter, the build checks and the engine as shipped. */
  files: [string, string][]
  bin: string
  /** SHA-256 of the protocol.json bytes whose protocol checks passed on this computer, if they did. */
  checksPassed?: string | null
  /** SHA-256 of protocol.json when the library catalog (not the project's own files) confirms it is the current
   *  Validated revision of this paper. */
  libraryValidated?: string | null
  /** A published study's restored held wording ({held id: text}), used only to check results for it. */
  heldTexts?: Record<string, string> | null
}

export const SHARE_TIMEOUT_MS = 3 * 60_000
const LIMITS = { cpuSeconds: 150, memoryBytes: 2 * 1024 ** 3 }
const RUNNER = [
  'import os, runpy, sys',
  'script = os.path.join(sys.argv[1], "skills", "export", "community.py")',
  'os.chdir(sys.argv[2])',
  'sys.argv = [script] + sys.argv[3:]',
  'runpy.run_path(script, run_name="__main__")',
].join('\n')

export class ShareError extends Error {
  constructor(public code: 'runtime' | 'failed', message: string) { super(message) }
}

/** The plain reason the exporter printed (its own sentences), never a traceback. */
const GENERIC = 'The share file could not be prepared. Retry; if it persists, ask the agent to check the study.'
/** The exporter prints its own plain sentence on a refusal; an unexpected failure (a traceback) is never shown. */
export function exporterMessage(stderr: string): string {
  if (/Traceback \(most recent call last\)/.test(stderr)) return GENERIC
  const last = stderr.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? ''
  return last && last.length < 600 && /\s/.test(last) ? last : GENERIC
}

async function runExporter(rt: ShareRuntime, project: string, args: string[], after?: (home: string) => Promise<void>): Promise<unknown> {
  if (!rt.python || !rt.files.some(([rel]) => rel === 'skills/export/community.py')) throw new ShareError('runtime', 'The research runtime is not installed yet, so a share cannot be prepared.')
  const root = await realpath(project)
  return withScratch(rt.files, async (work, home) => {
    const extra: string[] = []
    if (rt.checksPassed && /^[a-f0-9]{64}$/.test(rt.checksPassed)) extra.push('--checks-passed', rt.checksPassed)
    if (rt.libraryValidated && /^[a-f0-9]{64}$/.test(rt.libraryValidated)) extra.push('--library-validated', rt.libraryValidated)
    if (rt.heldTexts && Object.keys(rt.heldTexts).length) {
      const file = join(home, 'held-texts.json')
      await writeFile(file, JSON.stringify(rt.heldTexts), 'utf8')
      extra.push('--held-texts', file)
    }
    const resolved = args.map((a) => (a.startsWith('@home/') ? join(home, a.slice('@home/'.length)) : a))
    const ran = await confinedPython(rt.python!, RUNNER, [work, root, ...resolved, ...extra], home, rt.bin, SHARE_TIMEOUT_MS, LIMITS)
      .catch(() => { throw new ShareError('failed', GENERIC) })
    if (ran.limit) throw new ShareError('failed', 'Preparing the share stopped at its time or memory limit. Leave large results out and try again.')
    let out: unknown
    try {
      out = JSON.parse(ran.stdout.trim().split(/\r?\n/).at(-1) ?? '')
    } catch {
      throw new ShareError('failed', exporterMessage(ran.stderr))
    }
    if (after) await after(home)
    return out
  })
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const CODES = new Set(['not-validated', 'no-protocol', 'changed-published', 'blocked', 'runtime'])

function layerState(raw: unknown): ShareLayerState {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  if (o.available !== true) {
    const code = typeof o.code === 'string' && CODES.has(o.code) ? (o.code as ShareLayerState['code']) : 'blocked'
    return { available: false, code, reason: typeof o.reason === 'string' ? o.reason : undefined, files: [] }
  }
  return {
    available: true,
    files: strings(o.files),
    withheld: typeof o.withheld === 'number' ? o.withheld : 0,
    getFromSource: Array.isArray(o.getFromSource) ? o.getFromSource.length : 0,
    ...(o.validated === 'library' || o.validated === 'checks' ? { validated: o.validated } : {}),
  }
}

/** The exporter's --plan output, as the dialog shows it. Unknown shapes fail closed (unavailable). */
export function sharePreviewOf(raw: unknown): SharePreview {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const results: ShareResultItem[] = (Array.isArray(o.results) ? o.results : []).flatMap((r) => {
    const item = r && typeof r === 'object' ? (r as Record<string, unknown>) : {}
    if (typeof item.id !== 'string' || !item.id.startsWith('artifacts/')) return []
    return [{
      id: item.id,
      kind: item.kind === 'trial' ? 'trial' as const : 'material' as const,
      files: strings(item.files),
      bytes: typeof item.bytes === 'number' ? item.bytes : 0,
      ...(typeof item.blocked === 'string' ? { blocked: item.blocked } : {}),
    }]
  })
  return { overview: layerState(o.overview), experiment: layerState(o.experiment), results }
}

export const runtimeMissing = (): SharePreview => {
  const off: ShareLayerState = { available: false, code: 'runtime', files: [] }
  return { overview: off, experiment: off, results: [] }
}

/** What each layer would contain, and why a layer or a result is unavailable. Writes nothing. */
export async function sharePlan(rt: ShareRuntime, project: string): Promise<SharePreview> {
  if (!rt.python) return runtimeMissing()
  return sharePreviewOf(await runExporter(rt, project, ['--plan']))
}

/** Only ids of the current plan's shareable results are passed on; the exporter checks them again. */
export function selectedResults(requested: unknown, preview: SharePreview): string[] {
  const allowed = new Set(preview.results.filter((r) => !r.blocked).map((r) => r.id))
  return [...new Set(strings(requested))].filter((id) => allowed.has(id))
}

/** Writes the share ZIP for one layer plus the ticked results to `target`. The exporter writes it into the
 *  confined run's scratch folder (removed afterwards), so no copy ever sits in the project. */
export async function shareExport(rt: ShareRuntime, project: string, layer: ShareLayer, results: string[], target: string): Promise<{ files: string[]; bytes: number }> {
  const name = `share-${randomUUID()}.zip`
  const out = await runExporter(rt, project, ['--layer', layer, ...results.flatMap((id) => ['--results', id]), '--output', '@home/' + name],
    async (home) => { await copyFile(join(home, name), target) }) as { publicFiles?: unknown }
  return { files: strings(out?.publicFiles), bytes: (await stat(target)).size }
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

/** The restored text of each held item of a published protocol, read from the copy filled in on this computer
 *  (original-text.ts) at the item's JSON pointer. Kept only for checking shared results; never written anywhere. */
export function heldTextsOf(protocolText: string, restoredText: string): Record<string, string> {
  const out: Record<string, string> = {}
  try {
    const held = JSON.parse(protocolText)?.distribution?.held
    const restored = JSON.parse(restoredText)
    if (!held || typeof held !== 'object' || Array.isArray(held)) return out
    for (const [id, h] of Object.entries(held as Record<string, { path?: unknown; kind?: unknown }>)) {
      if (!h || h.kind === 'image' || typeof h.path !== 'string') continue
      let v: unknown = restored
      for (const part of h.path.split('/').slice(1).map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~')))
        v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined
      if (typeof v === 'string') out[id] = v
    }
  } catch { /* unreadable: results stay blocked until the wording can be checked */ }
  return out
}

/** SHA-256 of protocol.json when the library catalog confirms it as the current Validated revision of the paper
 *  this project came from. The project's own .humanstudy/community.json only names the paper. */
export async function confirmedLibrarySha<T extends { id: string; assetFiles?: { path: string; sha256: string }[] }>(project: string,
  catalog: () => Promise<T[]>, validated: (entry: T) => boolean): Promise<string | null> {
  try {
    const context = JSON.parse(await readFile(join(project, '.humanstudy', 'community.json'), 'utf8'))
    const raw = await readFile(join(project, 'protocol.json'))
    const entry = (await catalog()).find((e) => e.id === context?.id)
    if (!entry || !validated(entry)) return null
    const sha = sha256(raw)
    return entry.assetFiles?.some((f) => f.path === 'protocol.json' && f.sha256 === sha) ? sha : null
  } catch { return null }
}

/** SHA-256 of protocol.json when its protocol checks pass (`problems` resolves to none), else null. */
export async function passedProtocolSha(project: string, problems: (project: string) => Promise<unknown[]>): Promise<string | null> {
  const raw = await readFile(join(project, 'protocol.json')).catch(() => null)
  if (!raw) return null
  const found = await problems(project).catch(() => null)
  if (!Array.isArray(found) || found.length) return null
  const after = await readFile(join(project, 'protocol.json')).catch(() => null)
  return after && after.equals(raw) ? sha256(raw) : null
}

export const shareFileName = (project: string, layer: ShareLayer, date = new Date()): string =>
  `${project.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Study'}-${layer === 'experiment' ? 'experiment' : 'overview'}-${date.toISOString().slice(0, 10)}.zip`
