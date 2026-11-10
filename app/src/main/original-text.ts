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
import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { OriginalTextNeed, OriginalTextReason } from '../shared/package-readiness'
import { confinedPython, heldSources, runner, withScratch, type Limits } from './protocol-readiness'

export interface OriginalTextSource {
  key: string; title: string; tier: 'link' | 'user' | 'hosted'; format: string
  items: number; restored: number; screens: number; file: string | null; url?: string; need?: OriginalTextReason
}
export interface OriginalTextStatus {
  projection: boolean; complete?: boolean; items?: number; restored?: number; screens?: number; pdfReader?: boolean
  sources?: OriginalTextSource[]; projectionSha256?: string; restoredPath?: string | null; restoredSha256?: string
}
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
      else if (st?.isFile() && e.name !== 'SOURCE.json') into.push(real)
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
  o: { allowLocal?: boolean; offline?: boolean; timeout?: number } = {}): Promise<OriginalTextStatus> {
  if (!files.some(([rel]) => rel === 'hs_original_text.py') || !files.some(([rel]) => rel === 'hsenv/hsenv/distribution.py'))
    throw Error('The original-wording helper is not available in this version.')
  const protocol = await realpath(join(project, 'protocol.json'))
  await mkdir(cacheDir, { recursive: true })
  const args = [...(o.allowLocal ? ['--allow-local'] : []), ...(o.offline ? ['--offline'] : []),
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

const PLAIN: Record<OriginalTextReason, string> = {
  download: 'the download from the publisher did not work; drop in your copy',
  file: 'drop in your copy',
  'wrong-file': 'the copy you added does not match the version the study was built from',
  'changed-online': 'the copy online no longer matches the version the study was built from; drop in your copy',
  'pdf-reader': 'this computer cannot read PDF files yet (update HumanStudy Hub)',
  'app-version': 'the study was published for a newer version of HumanStudy Hub',
  reading: 'the wording is printed inside a picture and cannot be filled in automatically',
}

/** One problem per source that still has screens without their wording: a run is blocked until there are none.
 *  `reason` is the plain English line (approval errors, the agent); `text` lets the app word it in either language. */
export function originalTextProblems(status: OriginalTextStatus): OriginalTextProblem[] {
  if (!status.projection || status.complete) return []
  const out: OriginalTextProblem[] = []
  for (const s of status.sources ?? []) {
    if (!s.need || s.restored >= s.items) continue
    const screens = Math.max(1, s.screens)
    out.push({ check: 'original-text', text: { need: s.need, title: s.title, format: s.format, screens },
      reason: `${screens} screen(s) are missing the wording from ${s.title} (${s.format}): ${PLAIN[s.need] ?? 'it could not be filled in'}.` })
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
    sources: (status.sources ?? []).map((s) => ({ ...s, file: s.file && s.file.startsWith(root + sep) ? relative(root, s.file).split(sep).join('/') : null })),
    updatedAt: new Date().toISOString(),
  }
  const dir = join(root, '.humanstudy')
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `original-text.json.${process.pid}.tmp`)
  await writeFile(tmp, JSON.stringify(shown, null, 1) + '\n', 'utf8')
  await rename(tmp, join(dir, 'original-text.json'))
}

/** The restored protocol of one published study version, from the app's cache: only when every item was restored
 *  and the cached file is the one the helper wrote (its sha256 recorded beside it). */
export async function restoredProtocolText(cacheDir: string, projectionSha256: string): Promise<string | null> {
  if (!/^[0-9a-f]{64}$/.test(projectionSha256)) return null
  try {
    const here = join(cacheDir, projectionSha256)
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
  const text = await restoredProtocolText(cacheDir, protocolSha256)
  if (text === null) throw Error("This study's original wording has not been filled in on this computer yet, so the simulation was not started (its screens would show \"[text not available]\"). Ask the agent what is missing.")
  return [['restored/protocol.json', text]]
}
