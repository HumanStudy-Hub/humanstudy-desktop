// A published study's original wording, filled in on this computer (hsenv link + hash rehydration, DESIGN §3.6).
//
// A published protocol.json may hold placeholders where the participant-facing text comes from a source that cannot
// be redistributed (`distribution.held`). pack/runtime/lib/hs_original_text.py restores them: it downloads link-tier
// sources from the publisher, tries the files the researcher dropped into the project (sources/private/, paper.pdf,
// sources/) for the rest, and checks every item by its own text hash. The main process runs it from the app's own
// copy (never the project's), isolated (-I -B, empty home, no keys), with network access for the downloads only.
//
// Nothing restored is written into the project: downloads and the restored protocol stay in app storage
// (userData/original-text/<sha256 of protocol.json>/), so neither the project's exports nor research capture can
// carry them. The project gets only a status without any source text (.humanstudy/original-text.json), which the
// agent reads to tell the researcher what is missing.
//
// Three tiers, each labelled: exact (the text's sha256 verified); approximate (the release's fingerprint located in
// the researcher's own PDF: may contain reading errors); supplied (the project's fills file, FILLS_FILE, written by
// the assistant: text the researcher pasted or a reconstruction they agreed to). All three count for a run; the
// status says how many of each, and lists what is still unresolved (ids and titles, never text).
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { OriginalTextNeed, OriginalTextReason } from '../shared/package-readiness'
import { confinedPython, heldSources, runner, withScratch, type Limits } from './protocol-readiness'

export interface OriginalTextSource {
  key: string; title: string; tier: 'link' | 'user' | 'hosted'; format: string
  items: number; restored: number; screens: number; file: string | null; url?: string; need?: OriginalTextReason
  approx?: number; user?: number; reconstructed?: number
}
/** A held item nothing could restore: where it goes and why, never any text. */
export interface OriginalTextUnresolved {
  held: string; screen: string; path: string | null; source: string | null; title: string | null
  kind: 'text' | 'picture'; length: number | null; need: OriginalTextReason
}
export type OriginalTextLabel = 'approx' | 'user' | 'reconstructed'
export interface OriginalTextStatus {
  projection: boolean; complete?: boolean; items?: number; restored?: number; screens?: number; pdfReader?: boolean
  sources?: OriginalTextSource[]; projectionSha256?: string; restoredPath?: string | null; restoredSha256?: string
  /** The cache folder of this restored copy (restoreSlot: per study version and project). */
  slot?: string
  exact?: number; approx?: number; supplied?: { user: number; reconstructed: number }
  labels?: Record<string, OriginalTextLabel>; unresolved?: OriginalTextUnresolved[]
  fills?: { file: string; present: boolean; problems: { held: string | null; why: string }[] }
}
/** The project's fills file (project-relative): wording the researcher pasted, or a reconstruction they agreed to,
 *  per held id. Under sources/private/, so it is never exported, published or collected (it may sync: project sync
 *  is private per account). */
export const FILLS_FILE = 'sources/private/original-text-fills.json'
export interface OriginalTextProblem { check: 'original-text'; reason: string; text?: OriginalTextNeed }

/** Downloads can be slow; the restore itself is bounded by hsenv's own hashing budgets. */
export const ORIGINAL_TEXT_TIMEOUT_MS = 5 * 60_000
const LIMITS: Limits = { cpuSeconds: 300, memoryBytes: 2 * 1024 ** 3 }
const MAX_FILES = 200
const MAX_DEPTH = 4
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** True when protocol.json is a published study with wording held back (and so needs filling in to run). */
export async function isPublishedStudy(project: string): Promise<boolean> {
  return (await heldSources(project)).size > 0
}

/** The project files the researcher may have supplied a source in: sources/private/ first (where the app puts a
 *  file dropped into a published study), then paper.pdf and the rest of sources/. Regular files inside the
 *  project only (links that lead out of it are skipped). */
export async function candidateFiles(project: string): Promise<string[]> {
  const root = await realpath(project)
  const visit = async (dir: string, depth: number, into: string[]): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (into.length >= MAX_FILES || e.name.startsWith('.')) continue
      const real = await realpath(join(dir, e.name)).catch(() => null)
      if (!real || !real.startsWith(root + sep)) continue
      const st = await lstat(real).catch(() => null)
      if (st?.isDirectory() && depth < MAX_DEPTH) await visit(real, depth + 1, into)
      else if (st?.isFile() && e.name !== 'SOURCE.json' && relative(root, real).split(sep).join('/') !== FILLS_FILE) into.push(real)
    }
    return into
  }
  const paper = await realpath(join(root, 'paper.pdf')).catch(() => null)
  const all = [...await visit(join(root, 'sources', 'private'), 1, []),
    ...(paper && paper.startsWith(root + sep) ? [paper] : []), ...await visit(join(root, 'sources'), 1, [])]
  return [...new Set(all)].slice(0, MAX_FILES)
}

/** Proxy and certificate settings the download may need; never a key or token. */
function networkEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR'])
    if (process.env[k]) out[k] = process.env[k] as string
  return out
}

/** Fill in the original wording of the project's protocol.json (a no-op answer for an ordinary one). `files`: the
 *  engine under hsenv/ and the helper as hs_original_text.py, from the app's own copy. */
export async function fillOriginalText(python: string, files: [string, string][], project: string, cacheDir: string, bin: string,
  o: { allowLocal?: boolean; offline?: boolean; timeout?: number; indexOnly?: boolean } = {}): Promise<OriginalTextStatus> {
  if (!files.some(([rel]) => rel === 'hs_original_text.py') || !files.some(([rel]) => rel === 'hsenv/hsenv/distribution.py'))
    throw Error('The original-wording helper is not available in this version.')
  const protocol = await realpath(join(project, 'protocol.json'))
  await mkdir(cacheDir, { recursive: true })
  const received = receivedPath(cacheDir, await realpath(project))
  const receivedArgs = (await lstat(received).then((x) => x.isFile(), () => false)) ? ['--received', received] : []
  const fills = await realpath(join(project, ...FILLS_FILE.split('/'))).catch(() => null)
  const root = await realpath(project)
  const fillsArgs = fills && fills.startsWith(root + sep) && (await lstat(fills).then((x) => x.isFile(), () => false)) ? ['--fills', fills] : []
  const args = [...receivedArgs, ...fillsArgs, '--project-key', sha256(root), ...(o.allowLocal ? ['--allow-local'] : []), ...(o.offline ? ['--offline'] : []), ...(o.indexOnly ? ['--index-only'] : []),
    ...(await candidateFiles(project)).flatMap((f) => ['--file', f])]
  return withScratch(files, async (work, home) => {
    const code = runner(LIMITS.cpuSeconds, LIMITS.memoryBytes).replace(/sys\.path\.insert[\s\S]*$/,
      'import runpy\nscript = sys.argv.pop(1)\nsys.argv = [script] + sys.argv[1:]\nrunpy.run_path(script, run_name="__main__")')
    const run = await confinedPython(python, code, [join(work, 'hs_original_text.py'), join(work, 'hsenv'), protocol, cacheDir, ...args],
      home, bin, o.timeout ?? ORIGINAL_TEXT_TIMEOUT_MS, LIMITS, networkEnv())
    if (run.limit) throw Error('Filling in the original wording stopped at its time or memory limit.')
    const last = run.stdout.trim().split('\n').at(-1) ?? ''
    const status = JSON.parse(last) as OriginalTextStatus
    if (typeof status?.projection !== 'boolean') throw Error('Invalid original-wording status')
    return status
  })
}

const FORMAT: Record<string, string> = { pdf: 'PDF', html: 'web page', text: 'text file', docx: 'Word file', qsf: 'Qualtrics file' }
const PLAIN: Record<OriginalTextReason, string> = {
  download: 'the download from the publisher did not work; drop in your copy',
  file: 'drop in your copy',
  'wrong-file': 'the copy you added does not match the version the study was built from',
  'changed-online': 'the copy online no longer matches the version the study was built from; drop in your copy',
  'pdf-reader': 'this computer cannot read PDF files yet (update HumanStudy Hub)',
  'app-version': 'the study was published with a different version of the app\'s PDF reader (update HumanStudy Hub)',
  reading: 'the wording is printed inside a picture and cannot be filled in automatically',
  picture: 'the study shows pictures from it; drop in a screenshot or scan of each picture (it stays on your computer)',
  'held-changed': 'the study was changed after it was opened (put back its protocol.json as received)',
  'checks-failed': 'with the wording filled in, the study did not pass its own checks',
}

/** What the researcher can do about wording no file filled in (the assistant reads it in the problem). */
const ASK = ' Or ask the assistant: it can take that passage from you (paste it into the chat), or, if the paper does not print it, reconstruct it with your agreement, labelled as reconstructed.'
const SUPPLIABLE = new Set<OriginalTextReason>(['download', 'file', 'wrong-file', 'changed-online', 'pdf-reader', 'app-version', 'reading'])
const ASK_PICTURE = ' Ask the assistant: once the screenshot or scan is in, it puts it in place of the picture, labelled as supplied by you.'

/** One problem per source that still has screens without their wording: a run is blocked until there are none.
 *  Wording restored approximately or supplied in the fills file counts as filled in. `reason` is the plain English
 *  line (approval errors, the agent); `text` lets the app word it in either language. */
export function originalTextProblems(status: OriginalTextStatus): OriginalTextProblem[] {
  if (!status.projection || status.complete) return []
  const out: OriginalTextProblem[] = []
  for (const s of status.sources ?? []) {
    if (!s.need || s.restored >= s.items) continue
    const screens = Math.max(1, s.screens)
    out.push({ check: 'original-text', text: { need: s.need, title: s.title, format: s.format, screens },
      reason: `${screens === 1 ? '1 screen is' : `${screens} screens are`} missing the wording from ${s.title} (${FORMAT[s.format] ?? 'file'}): ${PLAIN[s.need] ?? 'it could not be filled in'}.${SUPPLIABLE.has(s.need) ? ASK : s.need === 'picture' ? ASK_PICTURE : ''}` })
  }
  if (!out.length) out.push({ check: 'original-text', reason: 'Some screens are missing their original wording.' })
  return out
}

/** The status the agent reads (.humanstudy/original-text.json): counts and what is needed per source, files as
 *  project paths, never any source text and never the app-storage path of the restored copy. */
export async function writeAgentStatus(project: string, status: OriginalTextStatus): Promise<void> {
  const root = await realpath(project)
  const shown = {
    publishedStudy: status.projection, complete: Boolean(status.complete), screensMissing: status.complete ? 0 : status.screens ?? 0,
    items: status.items ?? 0, restored: status.restored ?? 0, pdfReader: status.pdfReader ?? null,
    // how the restored items were filled in: exact, approximate (from the researcher's copy: may hold reading errors),
    // supplied by the researcher, reconstructed with their agreement
    exact: status.exact ?? status.restored ?? 0, approx: status.approx ?? 0, supplied: status.supplied ?? { user: 0, reconstructed: 0 },
    labels: status.labels ?? {},
    unresolved: (status.unresolved ?? []).map((u) => ({ held: u.held, screen: u.screen, path: u.path, source: u.source, title: u.title, kind: u.kind, length: u.length, need: u.need })),
    fillsFile: FILLS_FILE, fillsProblems: (status.fills?.problems ?? []).map((p) => ({ held: p.held, why: p.why })),
    sources: (status.sources ?? []).map((s) => ({ ...s, file: s.file && s.file.startsWith(root + sep) ? relative(root, s.file).split(sep).join('/') : null })),
    updatedAt: new Date().toISOString(),
  }
  const dir = join(root, '.humanstudy')
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `original-text.json.${process.pid}.tmp`)
  await writeFile(tmp, JSON.stringify(shown, null, 1) + '\n', 'utf8')
  await rename(tmp, join(dir, 'original-text.json'))
}

/** The cache folder of one project's restored copy of a published study version: fills and approximate wording are
 *  per project, so two projects with the same protocol.json never share one (hs_original_text.restore_slot). */
export async function restoreSlot(project: string, projectionSha256: string): Promise<string> {
  return sha256(`${projectionSha256}\n${sha256(await realpath(project))}`)
}

/** The restored protocol of one published study version, from the app's cache (`slot`: restoreSlot, or the version
 *  itself): only when every item was restored and the cached file is the one the helper wrote (its sha256 recorded
 *  beside it). */
export async function restoredProtocolText(cacheDir: string, projectionSha256: string, slot: string = projectionSha256): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(projectionSha256) || !/^[0-9a-f]{64}$/.test(slot)) return null
  try {
    const here = join(cacheDir, slot)
    const status = JSON.parse(await readFile(join(here, 'status.json'), 'utf8')) as OriginalTextStatus
    const bytes = await readFile(join(here, 'protocol.json'))
    if (!status.complete || status.projectionSha256 !== projectionSha256 || status.restoredSha256 !== sha256(bytes)) return null
    return bytes.toString('utf8')
  } catch { return null }
}

/** The extra trusted files of an approved run: for a published study, its restored protocol (the run's code folder
 *  gets it as restored/protocol.json, and skills/run plays it instead of the placeholders). Refuses a published
 *  study whose wording is not filled in for exactly the approved version. Nothing for an ordinary protocol.json. */
export async function restoredRunFiles(project: string, cacheDir: string, protocolSha256: string): Promise<[string, string][]> {
  if (!(await isPublishedStudy(project))) return []
  const slot = /^[0-9a-f]{64}$/.test(protocolSha256) ? await restoreSlot(project, protocolSha256) : protocolSha256
  const text = await restoredProtocolText(cacheDir, protocolSha256, slot)
  if (text === null) throw Error("This study's original wording has not been filled in on this computer yet, so the simulation was not started (its screens would show \"[text not available]\"). Ask the agent what is missing.")
  const labels = await restoredLabels(cacheDir, slot)
  // which items were restored without verification (ids and labels only): the run accepts exactly those and says so
  return [['restored/protocol.json', text], ...(Object.keys(labels).length ? [['restored/labels.json', JSON.stringify({ labels }) + '\n'] as [string, string]] : [])]
}

/** The labels of a cached restored copy ({held id: approx | user | reconstructed}); {} when all is exact. */
export async function restoredLabels(cacheDir: string, slot: string): Promise<Record<string, OriginalTextLabel>> {
  if (!/^[0-9a-f]{64}$/.test(slot)) return {}
  try {
    const raw = (JSON.parse(await readFile(join(cacheDir, slot, 'status.json'), 'utf8')) as OriginalTextStatus).labels
    const out: Record<string, OriginalTextLabel> = {}
    for (const [h, v] of Object.entries(raw && typeof raw === 'object' ? raw : {}))
      if (/^h[0-9]{1,9}$/.test(h) && (v === 'approx' || v === 'user' || v === 'reconstructed')) out[h] = v
    return out
  } catch { return {} }
}

/** The held-back list of a published study is pinned the first time this computer sees it (app storage, keyed by
 *  the project folder): an edited `distribution.held` could select another span of the real source under a new hash,
 *  and a removed one would leave placeholders on screen. Either change blocks the run until protocol.json is put back
 *  as received. The community library calls `repinHeld` only after writing a hash-verified published
 *  revision. Ordinary project writes cannot accept a changed list. An ordinary protocol.json that still holds runs of
 *  placeholders is refused the same way. */
const pinWrites = new Map<string, Promise<unknown>>()
function withPinLock<T>(cacheDir: string, work: () => Promise<T>): Promise<T> {
  const previous = pinWrites.get(cacheDir) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(work)
  pinWrites.set(cacheDir, next)
  void next.finally(() => { if (pinWrites.get(cacheDir) === next) pinWrites.delete(cacheDir) }).catch(() => undefined)
  return next
}

export function heldPinProblem(cacheDir: string, project: string): Promise<OriginalTextProblem | null> {
  return withPinLock(cacheDir, () => updateHeldPin(cacheDir, project))
}

async function updateHeldPin(cacheDir: string, project: string): Promise<OriginalTextProblem | null> {
  let raw: string
  try { raw = await readFile(join(project, 'protocol.json'), 'utf8') } catch { return null }
  let p: { distribution?: unknown; meta?: { title?: unknown } }
  try { p = JSON.parse(raw) } catch { return null }
  const dist = p?.distribution && typeof p.distribution === 'object' ? p.distribution : null
  const root = await realpath(project)
  const file = join(cacheDir, 'pins.json')
  let pins: Record<string, string> = {}
  try { pins = JSON.parse(await readFile(file, 'utf8')) } catch { /* none yet */ }
  const now = dist ? sha256(JSON.stringify(dist)) : null
  const title = typeof p?.meta?.title === 'string' ? p.meta.title.slice(0, 200) : 'this study'
  const changed: OriginalTextProblem = { check: 'original-text', text: { need: 'held-changed', title, format: '', screens: 0 },
    reason: "This study's record of which wording to fill in was changed or removed after it was first opened on this computer, so it cannot run. Put back the study's protocol.json exactly as you received it." }
  if (pins[root] !== undefined) return pins[root] === now ? null : changed
  if (now === null) return /░{3,}/.test(raw) ? changed : null
  pins[root] = now
  await mkdir(join(cacheDir, 'received'), { recursive: true })
  // The protocol.json as received: what verifiably ships with the study (the redaction index subtracts only its text).
  await writeFile(receivedPath(cacheDir, root), raw, 'utf8')
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(pins, null, 1), 'utf8')
  await rename(tmp, file)
  return null
}

/** Where the protocol.json of a project is kept as the app first received it (app storage). */
export const receivedPath = (cacheDir: string, root: string): string => join(cacheDir, 'received', sha256(root) + '.json')

/** Accept the protocol.json now in the project as the published version (for an import path that writes a new
 *  published version on the researcher's behalf): its held list becomes the pinned one. */
export function repinHeld(cacheDir: string, project: string): Promise<void> {
  return withPinLock(cacheDir, async () => {
  const file = join(cacheDir, 'pins.json')
  let pins: Record<string, string> = {}
  try { pins = JSON.parse(await readFile(file, 'utf8')) } catch { /* none yet */ }
  delete pins[await realpath(project)]
  await mkdir(cacheDir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(pins, null, 1), 'utf8')
  await rename(tmp, file)
  const problem = await updateHeldPin(cacheDir, project)
  if (problem) throw new Error(problem.reason)
  })
}

/** The problem shown when the engine's checks fail on the restored copy: plain words, no check names and no source
 *  text (the details could quote it), and no blame (a local edit can cause it as well as the publisher's version). */
export function restoredChecksProblem(title: string): OriginalTextProblem {
  return { check: 'original-text', text: { need: 'checks-failed', title, format: '', screens: 0 },
    reason: "With its original wording filled in, the study did not pass its own checks, so it cannot run. If protocol.json or the files in sourcetext/ were changed on this computer, put back the versions you received; otherwise the published version itself needs fixing." }
}

/** Index the project's private copies for research capture now, without downloading or restoring anything (the
 *  drop path calls it before it returns, so a copy is recognised before the agent hears of it). */
export async function indexPrivateCopies(python: string, files: [string, string][], project: string, cacheDir: string, bin: string): Promise<void> {
  await fillOriginalText(python, files, project, cacheDir, bin, { indexOnly: true, offline: true, timeout: 120_000 })
}

// ---- the Library release a project was forked from (study downloads, the published checks) ---------------------

/** A Library study's provenance (.humanstudy/community.json): its manifest and the revision it names. */
export interface ReleaseContext { assetFiles: { path: string; sha256: string }[]; identity: string; protocolSha256: string; context: Record<string, unknown> }
/** The manifest identity a revision folder is named by (community.ts forkCommunityStudy checks the same). */
export const manifestIdentity = (files: { path: string; sha256: string }[]): string =>
  sha256(JSON.stringify(files.map((f) => ({ path: f.path, sha256: f.sha256 }))))

/** 'none': no community.json, or one naming no protocol release; null: present but unreadable; else that release. */
async function releaseContext(project: string): Promise<ReleaseContext | 'none' | null> {
  let raw: string
  try { raw = await readFile(join(project, '.humanstudy', 'community.json'), 'utf8') } catch (e) { return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'none' : null }
  let c: unknown
  try { c = JSON.parse(raw) } catch { return null }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null
  const files = (c as { assetFiles?: unknown }).assetFiles
  if (!Array.isArray(files)) return 'none'
  const list = files.filter((f): f is { path: string; sha256: string } => !!f && typeof f.path === 'string' && typeof f.sha256 === 'string')
  const protocol = list.find((f) => f.path === 'protocol.json')
  if (!protocol) return 'none'
  return { assetFiles: list, identity: manifestIdentity(list), protocolSha256: protocol.sha256, context: c as Record<string, unknown> }
}

/** Whether a project is a released (Library) study for a study download: its provenance names a protocol release
 *  (an unreadable one counts), or its protocol.json holds wording back. An ordinary project is never one. */
export async function releasedStudy(project: string): Promise<boolean> {
  const ctx = await releaseContext(project)
  return ctx !== 'none' || await isPublishedStudy(project)
}

/** Verified releases in app storage, content-addressed: <cache>/releases/<manifest identity>/protocol.json exists
 *  only once that protocol.json was fetched from the official repository (or written by the fork) and matched the
 *  manifest whose identity names the folder, so a folder found by a project's manifest authenticates that manifest. */
const releaseDir = (cacheDir: string, identity: string): string => join(cacheDir, 'releases', identity)
export async function storeRelease(cacheDir: string, assetFiles: { path: string; sha256: string }[], protocol: Buffer): Promise<void> {
  if (assetFiles.find((f) => f.path === 'protocol.json')?.sha256 !== sha256(protocol)) return
  const dir = releaseDir(cacheDir, manifestIdentity(assetFiles))
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `protocol.json.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  await writeFile(tmp, protocol)
  await rename(tmp, join(dir, 'protocol.json'))
}

/** What the published checks treat as received when no release could be confirmed: nothing (protocol-readiness.ts). */
export const UNVERIFIED_RELEASE = { humanstudyRelease: 'unverified' } as const
const failedFetch = new Map<string, number>()
/** A failed fetch is not tried again for this long (checks run often); nothing is stored, so a later check retries. */
export const RELEASE_RETRY_MS = 30_000

/** The release a project is checked against: the Library release its provenance names, from app storage, or fetched
 *  (`fetchRelease`: community.ts fetchReleasedProtocol, which checks the revision folder and the sha256) and stored.
 *  'unverified' when the project is a Library study, or holds wording back, and no release is confirmed yet; null for
 *  an ordinary project. Never the project's own protocol.json, and never anything a study file carried. */
export async function releaseBaseline(cacheDir: string, project: string,
  fetchRelease: (context: Record<string, unknown>) => Promise<Buffer | null>, now = Date.now()): Promise<{ protocol: Buffer; assetFiles: ReleaseContext['assetFiles'] } | 'unverified' | null> {
  const ctx = await releaseContext(project)
  if (ctx === 'none') return (await isPublishedStudy(project)) ? 'unverified' : null
  if (!ctx) return 'unverified'
  const file = join(releaseDir(cacheDir, ctx.identity), 'protocol.json')
  const ok = (b: Buffer | null) => b && sha256(b) === ctx.protocolSha256 ? { protocol: b, assetFiles: ctx.assetFiles } : null
  const cached = ok(await readFile(file).catch(() => null))
  if (cached) return cached
  if ((failedFetch.get(ctx.identity) ?? -Infinity) + RELEASE_RETRY_MS > now) return 'unverified'
  const got = ok(await fetchRelease(ctx.context).catch(() => null))
  if (!got) { failedFetch.set(ctx.identity, now); return 'unverified' }
  failedFetch.delete(ctx.identity)
  await storeRelease(cacheDir, ctx.assetFiles, got.protocol).catch(() => undefined)
  return got
}
