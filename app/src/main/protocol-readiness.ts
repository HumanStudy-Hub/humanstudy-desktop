// Runs the protocol engine's mechanical checks (`hsenv.checks`, vendored in pack/runtime/hsenv) on a
// project's protocol.json, as the app's readiness gate for the protocol route. Confined like
// scientific-readiness.ts: the engine is written fresh from the files bundled in the app into a private scratch
// folder for every run (never the project's editable .opencode copy), Python runs isolated (-I -B), from an
// empty home, with no keys or tokens in its environment. The checks make no model calls and fetch nothing.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type { ProtocolBudget } from '../shared/run-limits'

/** `retry`: the outcome depends on something that may become available without any study file changing (the
 *  Library release, while it cannot be fetched): never kept by the readiness cache. */
export interface ProtocolProblem { check: string; reason: string; retry?: boolean }

/** Random-answer sessions the gate plays (the converter's own gate plays 1,000). */
export const PROTOCOL_SESSIONS = 50
/** Wall clock for one check (a 50-session check takes about a second; checks.py doubles the sessions up to
 *  five times when screening ends most of them early). */
export const PROTOCOL_TIMEOUT_MS = 3 * 60_000
/** Resource bounds set inside the engine process (POSIX): the protocol's expressions are data written by an
 *  agent, and `[0]*10**10` or `10**10**9` must stop the check, not the computer (review 1, S1). */
export const PROTOCOL_CPU_SECONDS = 120
export const PROTOCOL_MEMORY_BYTES = 2 * 1024 ** 3

export const ENGINE_MISSING: ProtocolProblem = { check: 'runtime', reason: 'The research runtime is not installed, so the protocol checks cannot run yet.' }
/** The check stopped at its CPU, memory or time bound: a property of this protocol, so it blocks and is cached. */
export const ENGINE_LIMIT: ProtocolProblem = { check: 'limits', reason: 'The protocol checks stopped at their time or memory limit. An expression or a loop in protocol.json is too large to check.' }
export const ENGINE_FAILED: ProtocolProblem = { check: 'runtime', reason: 'The protocol checks could not complete. Retry; if it persists, reinstall the research runtime.' }

// `-I` leaves the script folder and the working folder off sys.path, so the engine folder is added explicitly.
// The limits are set before the engine is imported: CPU time always; address space (Linux) and data size (macOS,
// where RLIMIT_AS cannot be lowered) where the platform accepts them. No resource module (Windows): the wall
// clock timeout alone.
export const pythonResourceLimits = (cpuSeconds = PROTOCOL_CPU_SECONDS, memoryBytes = PROTOCOL_MEMORY_BYTES): string => [
  'try:',
  ' import resource',
  ` for name, n in (("RLIMIT_CPU", ${cpuSeconds}), ("RLIMIT_AS", ${memoryBytes}), ("RLIMIT_DATA", ${memoryBytes})):`,
  '  try: resource.setrlimit(getattr(resource, name), (n, n))',
  '  except (AttributeError, ValueError, OSError): pass',
  'except ImportError: pass',
].join('\n')

export const runner = (cpuSeconds = PROTOCOL_CPU_SECONDS, memoryBytes = PROTOCOL_MEMORY_BYTES): string => [
  'import sys',
  pythonResourceLimits(cpuSeconds, memoryBytes),
  'sys.path.insert(0, sys.argv.pop(1))',
  'from hsenv import checks',
  'sys.exit(checks.main())',
].join('\n')

type Report = Record<string, unknown>
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const obj = (v: unknown): Report => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Report) : {})
const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)).slice(0, 160)
const some = (items: unknown[], n = 3): string => items.slice(0, n).map(show).join('; ') + (items.length > n ? ` (+${items.length - n} more)` : '')

/** The blocking findings of one checks report, one line each: the same conditions that make checks.py fail
 *  (its `fail |= …` lines). A report that does not say PASS: true never passes, whatever else it holds. */
export function protocolProblems(report: unknown): ProtocolProblem[] {
  const r = obj(report)
  if (typeof r.PASS !== 'boolean') throw Error('Invalid protocol checks report')
  const out: ProtocolProblem[] = []
  const add = (check: string, reason: string) => out.push({ check, reason: reason.slice(0, 400) })
  const refs = list(r.refs)
  if (refs.length) add('refs', `${refs.length} broken reference(s): ${some(refs)}`)
  const fuzz = obj(r.fuzz)
  const probs = list(fuzz.problems)
  if (probs.length) add('fuzz', `random-answer sessions hit ${probs.length} problem(s): ${some(probs)}`)
  const unreached = list(fuzz.unreached_stages)
  if (unreached.length) add('fuzz', `stages no session reached: ${some(unreached, 5)}`)
  if (Number(fuzz.n_unanswerable) > 0) add('fuzz', `${fuzz.n_unanswerable} screen(s) could not be answered`)
  const spans = list(fuzz.table_spans_unserved)
  if (spans.length) add('fuzz', `${spans.length} table cell(s) served without their span: ${some(spans)}`)
  const leaks = list(fuzz.leaks)
  if (leaks.length) add('leaks', `${leaks.length} screen(s) show text meant to stay hidden: ${some(leaks)}`)
  const exprLeaks = list(fuzz.state_expr_leaks)
  if (exprLeaks.length) add('leaks', `${exprLeaks.length} screen(s) show an unresolved expression: ${some(exprLeaks)}`)
  const notComputed = list(fuzz.effects_not_computed)
  if (notComputed.length) add('effects', `effects not computed from the sessions: ${some(notComputed, 5)}`)
  if (list(fuzz.blocked_effects_not_computed).length || (fuzz.blocked_effects_not_computed && !Array.isArray(fuzz.blocked_effects_not_computed)))
    add('effects', `blocked effects not computed: ${show(fuzz.blocked_effects_not_computed)}`)
  const keyed = r.keyed === undefined ? null : obj(r.keyed)
  if (keyed) {
    if (list(keyed.problems).length) add('keyed', `keyed answers hit problems: ${some(list(keyed.problems))}`)
    if (Number(keyed.excluded_share) > 0) add('keyed', `keyed answers excluded ${keyed.excluded_share} of the sessions`)
    const wrong = list(keyed.signs).filter((s) => !obj(s).same_sign).map((s) => obj(s).effect)
    if (wrong.length) add('keyed', `keyed answers do not reproduce the paper's sign: ${some(wrong, 5)}`)
    if (list(keyed.state_expr_leaks).length) add('keyed', `keyed sessions show an unresolved expression: ${some(list(keyed.state_expr_leaks))}`)
  }
  const v = obj(r.verbatim)
  if (list(v.not_found).length) add('verbatim', `texts not found in the source: ${some(list(v.not_found))}`)
  if (list(v.image_unconfirmed).length) add('verbatim', `image-read texts without an agreeing blind reading: ${some(list(v.image_unconfirmed))}`)
  if (list(v.bad_source).length) add('verbatim', `texts cite an unknown source: ${some(list(v.bad_source))}`)
  if (Number(v.unchecked) > 0) add('verbatim', `${v.unchecked} served text(s) have no source text under sourcetext/ to check against`)
  const annotations = list(r.reading_annotations).filter((a) => obj(a).error !== undefined)
  if (annotations.length) add('verbatim', `printed-annotation rules with errors: ${some(annotations)}`)
  if (r.images !== undefined) {
    const imgs = list(r.images).filter((x) => !(typeof x === 'string' && x.startsWith('note:')))
    if (imgs.length) add('images', `images that do not match their source: ${some(imgs)}`)
  }
  if (r.public === true && list(r.release_hold).length) add('release', `arms on release hold: ${some(list(r.release_hold))}`)
  for (const [id, c] of Object.entries(obj(r.coding)))
    if (list(obj(c).mismatches).length) add('coding', `coding ${id}: ${list(obj(c).mismatches).length} test case(s) coded differently`)
  if (r.PASS === false && !out.length) add('protocol', 'The protocol checks did not pass.')
  if (r.PASS === true && out.length) return out // a report that contradicts itself is not a pass
  return out
}

/** Parse the engine's report (indented JSON on stdout); anything else counts as a failed check, never a pass. */
export function parseProtocolReport(stdout: string): ProtocolProblem[] {
  const start = stdout.indexOf('{')
  if (start < 0) throw Error('No protocol checks report')
  return protocolProblems(JSON.parse(stdout.slice(start))).slice(0, 30)
}

/** The checks' answer from what the engine printed: its report, or, when the engine stopped on the protocol
 *  (a traceback, e.g. a flow naming a stage that does not exist), that error as a blocking problem. */
export function protocolOutcome(stdout: string, stderr: string): ProtocolProblem[] {
  if (stdout.includes('{')) return parseProtocolReport(stdout)
  const last = stderr.trim().split('\n').at(-1)?.trim()
  if (/Traceback/.test(stderr) && last) return [{ check: 'protocol', reason: `The engine stopped on this protocol: ${last}`.slice(0, 400) }]
  throw Error('No protocol checks report')
}

/** The protocol.json of a published study as this computer first received it (original-text.ts keeps it in app
 *  storage; index.ts installs the reader). Its strings are what the release verifiably ships. */
let receivedProtocol: (project: string) => Promise<unknown> = async () => null
export function configureReceivedProtocol(read: (project: string) => Promise<unknown>): void { receivedProtocol = read }

/** Every string of a protocol outside its `distribution` block. */
function releasedStrings(o: unknown, out: string[] = [], top = true): string[] {
  if (typeof o === 'string') out.push(o)
  else if (Array.isArray(o)) for (const v of o) releasedStrings(v, out, false)
  else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (!(top && k === 'distribution')) releasedStrings(v, out, false)
  return out
}

const canonical = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x))

/** The fields that can hold a cited text's wording next to its `cite`, in the order checks.py check_verbatim reads
 *  them. A `<field>_cite` cites its own field. */
const WORDING = ['value', 'text', 'label', 'prompt'] as const
const PLACEHOLDER_ONLY = /^░+$/
/** NFC and the engine's whitespace rule (checks.py _norm: runs of whitespace are one space, trimmed). */
const normWording = (v: unknown): unknown => typeof v === 'string' ? v.normalize('NFC').replace(/\s+/g, ' ').trim()
  : Array.isArray(v) ? v.map(normWording)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, normWording(x)])) : v
interface VerbatimText { key: string; source: unknown; image: boolean; held: boolean }
/** Every text a protocol cites verbatim, the way checks.py check_verbatim reads them: its plain wording, normalised,
 *  with its cite (canonical), never the name of the field it sits in nor its styling spans, so the same wording with
 *  the same cite in any valid form is the same key. An object with a `cite` contributes its first wording field (an
 *  inline text dict counting as its text); a `<field>_cite` contributes that field; each span tooltip is a text of
 *  its own with the same cite. Only the top-level `distribution` block is skipped. `held`: the wording is a held
 *  placeholder (checked by its hash). */
function verbatimTexts(o: unknown, out: VerbatimText[] = [], top = true): VerbatimText[] {
  if (Array.isArray(o)) for (const v of o) verbatimTexts(v, out, false)
  else if (o && typeof o === 'object') {
    const d = o as Record<string, unknown>
    const add = (wording: unknown, cite: Record<string, unknown>) => out.push({ key: canonical({ wording: normWording(wording), cite }),
      source: cite.source, image: cite.read === 'image', held: typeof wording === 'string' && PLACEHOLDER_ONLY.test(wording) })
    for (const [k, c] of Object.entries(d)) {
      if (!(k === 'cite' || k.endsWith('_cite')) || !c || typeof c !== 'object' || (c as Record<string, unknown>).label !== 'verbatim') continue
      const cite = c as Record<string, unknown>
      // only the field the engine renders: `value` if present, else `text` (engine.py _make_page), then label and
      // prompt; so a value added beside a released text, or value and text swapped, is a local text
      const rendered = k === 'cite' ? WORDING.find((f) => d[f] !== undefined) : k.slice(0, -'_cite'.length)
      const fields = rendered !== undefined && d[rendered] !== undefined ? [rendered] : []
      for (const field of fields) {
        const inline = d[field] && typeof d[field] === 'object' && !Array.isArray(d[field]) && typeof (d[field] as Record<string, unknown>).text === 'string'
          ? d[field] as Record<string, unknown> : null
        // an inline text dict with a cite of its own is checked once, with that cite (check_verbatim: the inner cite
        // wins), when the walk reaches it
        if (inline && inline.cite !== undefined) continue
        // anchors ({left, right, ...}) are each a text of their own with the shared cite (check_verbatim walks them so)
        if (k === 'anchors_cite' && d.anchors && typeof d.anchors === 'object' && !Array.isArray(d.anchors)) {
          for (const lab of Object.values(d.anchors as Record<string, unknown>)) add(lab, cite)
          continue
        }
        add(inline ? inline.text : d[field], cite)
        for (const sp of [inline?.spans, k === 'cite' && field === fields[0] ? d.spans : undefined].flatMap((x) => (Array.isArray(x) ? x : [])))
          if (sp && typeof sp === 'object' && typeof (sp as Record<string, unknown>).tooltip === 'string') add((sp as Record<string, unknown>).tooltip, cite)
      }
    }
    for (const [k, v] of Object.entries(d)) if (!(top && k === 'distribution')) verbatimTexts(v, out, false)
  }
  return out
}

/** In public mode the engine cannot verify a verbatim text made or changed on this computer: a text read from a page
 *  image, or cited from a source whose text was not shipped, is left to Bench's private check, and a held source's
 *  check text holds every released string (heldSourceTexts), so released wording copied into another field is found.
 *  Every verbatim text (its wording with its cite) must therefore be one the study was received with; a text may
 *  move, but each received text counts once. Left to the engine: a held placeholder (checked by its hash once
 *  restored; the held list is pinned) and a text it checks against the project's own sourcetext/ file of a source
 *  that is not held and not read from an image. A Library study whose release could not be fetched yet
 *  (UNVERIFIED_RELEASE, original-text.ts releaseBaseline) has nothing received; the next check tries again. */
/** True while the Library release a published study is checked against is not confirmed (UNVERIFIED_RELEASE). */
export async function releaseUnconfirmed(project: string): Promise<boolean> {
  const received = await receivedProtocol(project).catch(() => null)
  return Boolean(received && typeof received === 'object' && (received as Record<string, unknown>).humanstudyRelease === 'unverified')
}

async function editedVerbatimTexts(project: string): Promise<ProtocolProblem[]> {
  const received = await receivedProtocol(project).catch(() => null)
  if (!received || typeof received !== 'object') return []
  const unverified = (received as Record<string, unknown>).humanstudyRelease === 'unverified'
  let now: unknown
  try { now = JSON.parse(await readFile(join(project, 'protocol.json'), 'utf8')) } catch { return [] }
  const held = await heldSources(project)
  const own = new Set((await sourceTextArgs(project)).filter((_, i, a) => i > 0 && a[i - 1] === '--source-text').map((x) => x.split('=')[0]))
  const shipped = new Map<string, number>()
  if (!unverified) for (const t of verbatimTexts(received)) shipped.set(t.key, (shipped.get(t.key) ?? 0) + 1)
  let images = 0, others = 0
  for (const t of verbatimTexts(now)) {
    const left = shipped.get(t.key) ?? 0
    if (left > 0) { shipped.set(t.key, left - 1); continue }
    if (t.held) continue
    if (t.image) images++
    else if (typeof t.source === 'string' && own.has(t.source) && !held.has(t.source)) continue
    else others++
  }
  const out: ProtocolProblem[] = []
  if (unverified && images + others) return [{ check: 'verbatim', reason: `This study's published version could not be fetched from the Library yet, so ${images + others} text(s) cited word for word cannot be checked against their source. Connect to the internet and check again.`, retry: true }]
  if (images) out.push({ check: 'verbatim', reason: `${images} text(s) read from a page image of the paper were changed on this computer, so they can no longer be checked against the paper. Put back the wording as published, or keep the change as a separate, labelled variant.` })
  if (others) out.push({ check: 'verbatim', reason: `${others} text(s) cited word for word from a source this study does not include were changed on this computer (their wording or their citation), so they can no longer be checked against that source. Put back the wording as published, or keep the change as a separate, labelled variant.` })
  return out
}

/** For a published protocol.json: per held source, the text its served strings must be found in, by the engine's own
 *  verbatim rule (checks.py check_verbatim), as a `--source-text` file. Before the wording is filled in that text is
 *  one run of placeholders as long as the longest held text: every held placeholder is found in it, and any other
 *  text cited verbatim from that source is not (so it still blocks). `restored` (the copy filled in on this computer)
 *  gives instead the restored held texts themselves, each already checked by its own hash. A source with its own
 *  sourcetext/ file in the project keeps that file. Never a placeholder text for an ordinary protocol.json. */
export async function heldSourceTexts(project: string, restored?: Record<string, unknown>): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  try {
    const p = JSON.parse(await readFile(join(project, 'protocol.json'), 'utf8'))
    const held = p?.distribution?.held
    if (!held || typeof held !== 'object' || Array.isArray(held)) return out
    const own = new Set((await sourceTextArgs(project)).filter((_, i, a) => i > 0 && a[i - 1] === '--source-text').map((x) => x.split('=')[0]))
    const pieces = new Map<string, string[]>()
    for (const h of Object.values(held as Record<string, { source?: unknown; path?: unknown; kind?: unknown; length?: unknown }>)) {
      if (!h || typeof h.source !== 'string' || own.has(h.source) || h.kind === 'image' || typeof h.path !== 'string') continue
      let piece: string
      if (restored) {
        let v: unknown = restored
        for (const part of h.path.split('/').slice(1).map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~')))
          v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined
        if (typeof v !== 'string') continue
        piece = v
      } else {
        const n = Number(h.length)
        if (!Number.isSafeInteger(n) || n < 1 || n > 200_000) continue
        piece = '\u2591'.repeat(n)
      }
      pieces.set(h.source, [...(pieces.get(h.source) ?? []), piece])
    }
    // plus every string of the study as received: wording the release cites verbatim from a held source outside the
    // held fields (checked by Bench against the source) is found as released, while a text changed or added on
    // this computer is not, so it still blocks
    const received = await receivedProtocol(project).catch(() => null)
    const shipped = received && typeof received === 'object' && (received as Record<string, unknown>).humanstudyRelease !== 'unverified'
      ? releasedStrings(received).join('\n') : ''
    for (const [k, list_] of pieces)
      out.set(k, (restored ? list_.join('\n') : list_.reduce((a, b) => (b.length > a.length ? b : a), '')) + (shipped ? '\n' + shipped : ''))
  } catch { /* unreadable: the checks report it */ }
  return out
}

/** The sources a published protocol.json holds wording back from (`distribution.held[*].source`). */
export async function heldSources(project: string): Promise<Set<string>> {
  try {
    const held = JSON.parse(await readFile(join(project, 'protocol.json'), 'utf8'))?.distribution?.held
    if (!held || typeof held !== 'object' || Array.isArray(held)) return new Set()
    return new Set(Object.values(held as Record<string, { source?: unknown }>).map((h) => h?.source).filter((k): k is string => typeof k === 'string'))
  } catch { return new Set() }
}

/** `--source-text name=path` for every regular sourcetext/*.txt inside the project (links out of it are skipped). */
export async function sourceTextArgs(project: string): Promise<string[]> {
  const root = await realpath(project)
  const dir = join(project, 'sourcetext')
  const names = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const args: string[] = []
  for (const d of names.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!d.name.endsWith('.txt') || d.name.length <= 4) continue
    const real = await realpath(join(dir, d.name)).catch(() => null)
    if (!real || !real.startsWith(root + sep)) continue
    args.push('--source-text', `${d.name.slice(0, -4)}=${real}`)
  }
  return args
}

export interface Limits { cpuSeconds?: number; memoryBytes?: number }
export type Ran = { stdout: string; stderr: string; limit: true; exitCode?: never } |
  { stdout: string; stderr: string; limit?: never; exitCode: number }

/** Run Python confined: -I -B, an empty home as working folder and temp, no keys in the environment, the CPU and
 *  memory bounds set before any engine code runs, an RSS watch where the OS ignores them, a wall clock. Exit 0/1
 *  resolve with the output; a stop at a bound resolves with `limit`; anything else rejects. */
export async function confinedPython(python: string, code: string, args: string[], home: string, bin: string, timeout: number, limits: Limits,
  extraEnv: Record<string, string> = {}): Promise<Ran> {
  const win = process.platform === 'win32'
  const system = win ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32` : '/usr/bin:/bin:/usr/sbin:/sbin'
  const memoryBytes = limits.memoryBytes ?? PROTOCOL_MEMORY_BYTES
  return new Promise<Ran>((resolve, reject) => {
    let overMemory = false
    const child = execFile(python, ['-I', '-B', '-X', 'utf8', '-c', code, ...args], {
      cwd: home, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
      // No keys or tokens: only a path, a home and a temp folder in the scratch space.
      env: {
        PATH: (bin ? bin + (win ? ';' : ':') : '') + system,
        HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home, LANG: 'C.UTF-8',
        // The engine's private sidecar (study pins outside the public code) is never read by the app's gate: it
        // would otherwise be looked for next to the scratch folder, where anything could plant it.
        HSENV_PRIVATE_CONFIG: '',
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...extraEnv,
      },
    }, (error, stdout, stderr) => {
      // checks.py exits 1 when the protocol fails (its report is still the answer) and Python exits 1 on an
      // uncaught error in the engine. Stopped at a bound (CPU, memory watch, wall clock): the limits problem.
      // Anything else (not started, crashed) is a failed run.
      clearInterval(watch)
      if (overMemory || (error && (error.signal === 'SIGXCPU' || error.signal === 'SIGKILL' || error.killed))) return resolve({ stdout: '', stderr: '', limit: true })
      if (error && !(typeof error.code === 'number' && error.code === 1)) return reject(error)
      resolve({ stdout: String(stdout), stderr: String(stderr), exitCode: error ? 1 : 0 })
    })
    // macOS does not enforce RLIMIT_AS/RLIMIT_DATA: watch the resident size and stop the check above the bound.
    const watch = setInterval(() => {
      if (win || !child.pid) return
      try {
        execFile('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], { timeout: 2000 }, (e, out) => {
          if (!e && Number(String(out).trim()) * 1024 > memoryBytes) { overMemory = true; child.kill('SIGKILL') }
        })
      } catch {
        // A restricted environment can deny the process probe at spawn. The Python and wall-time limits still apply.
      }
    }, 250)
  })
}

export async function withScratch<T>(files: [string, string][], body: (work: string, home: string) => Promise<T>): Promise<T> {
  const work = await mkdtemp(join(tmpdir(), 'hs-protocol-'))
  const home = await mkdtemp(join(tmpdir(), 'hs-protocol-home-'))
  try {
    for (const [rel, content] of files) {
      const path = join(work, ...rel.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
    }
    return await body(work, home)
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Conservative support for study.json's documented comma-separated engine range. Unknown range
 * syntax fails closed: a newer protocol can still be previewed, but cannot run on an unverified engine. */
export function engineRangeProblem(required: unknown, version: string): ProtocolProblem | null {
  if (required === undefined) return null
  const current = version.match(/^(\d+)[.](\d+)(?:[.](\d+))?$/)
  const clauses = typeof required === 'string' ? required.split(',').map(s => s.trim()) : []
  const good = current && clauses.length && clauses.every(clause => {
    const m = clause.match(/^(>=|<=|>|<|==|=)?\s*(\d+)[.](\d+)(?:[.](\d+))?$/)
    if (!m) return false
    const a = current.slice(1).map(x => Number(x || 0)), b = m.slice(2).map(x => Number(x || 0))
    const i = a.findIndex((x, i) => x !== b[i]), cmp = i < 0 ? 0 : a[i] < b[i] ? -1 : 1
    return m[1] === '>=' ? cmp >= 0 : m[1] === '<=' ? cmp <= 0 : m[1] === '>' ? cmp > 0 : m[1] === '<' ? cmp < 0 : cmp === 0
  })
  return good ? null : { check: 'app-version', reason: `This study needs research engine ${String(required)}. Update HumanStudy Hub before running it (installed engine: ${version || 'unknown'}).` }
}

async function requiredEngine(project: string, engine: [string, string][]): Promise<ProtocolProblem | null> {
  try {
    const meta = JSON.parse(await readFile(join(project, 'study.json'), 'utf8'))
    const version = engine.find(([path]) => path === 'VERSION')?.[1].match(/tag v([0-9]+[.][0-9]+[.][0-9]+)/)?.[1] || ''
    return engineRangeProblem(meta?.hsenv, version)
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : { check: 'app-version', reason: 'The study version information could not be read. Restore study.json from the published study before running it.' }
  }
}

/** A published study (protocol.json holds back wording: `distribution.held`) is checked as Bench released it,
 *  `checks --public`: the blind readings and source texts of sources that may not be redistributed were never
 *  shipped, so a text read from a page image of such a source is "checked privately" (by Bench) instead of
 *  unconfirmed, and so is a cite whose source text is not here. Held texts are still checked against their own
 *  placeholders or restored wording, and the researcher's own projects keep the strict check. */
export async function publicMode(project: string): Promise<string[]> {
  return (await heldSources(project)).size > 0 ? ['--public'] : []
}

export async function protocolReadiness(python: string | null, engine: [string, string][], project: string, bin: string,
  timeout = PROTOCOL_TIMEOUT_MS, limits: Limits = {}): Promise<ProtocolProblem[]> {
  if (!python) return [ENGINE_MISSING]
  if (!engine.some(([rel]) => rel === 'hsenv/checks.py')) return [ENGINE_FAILED]
  const incompatible = await requiredEngine(project, engine)
  if (incompatible) return [incompatible]
  const unconfirmed = await releaseUnconfirmed(project)   // the snapshot the retry mark is decided by
  try {
    return await withScratch(engine, async (work, home) => {
      const held: string[] = []
      for (const [name, text] of await heldSourceTexts(project)) {
        const file = join(home, `held-${held.length / 2}.txt`)
        await writeFile(file, text, 'utf8')
        held.push('--source-text', `${name}=${file}`)
      }
      const run = await confinedPython(python, runner(limits.cpuSeconds, limits.memoryBytes),
        [work, await realpath(project), '--sessions', String(PROTOCOL_SESSIONS), ...await publicMode(project), ...await sourceTextArgs(project), ...held], home, bin, timeout, limits)
      if (run.limit) return [ENGINE_LIMIT]
      if (/\bMemoryError\b/.test(run.stderr) && !run.stdout.includes('{')) return [ENGINE_LIMIT]
      const found = protocolOutcome(run.stdout, run.stderr)
      if (!(await publicMode(project)).length) return found
      // without the Library release the held sources' check texts lack the released strings: whatever fails now may
      // pass once it is fetched, so nothing found is kept by the readiness cache. Decided by the snapshot taken
      // before the check (a release stored meanwhile never makes a failure computed without it look final).
      const all = [...found, ...await editedVerbatimTexts(project)]
      return unconfirmed ? all.map((p) => ({ ...p, retry: true })) : all
    })
  } catch { return [ENGINE_FAILED] }
}


/** The engine's checks on the copy of a published study restored on this computer (leaks, unresolved expressions,
 *  verbatim texts and everything else), run once before a run is allowed. The copy is written to a folder in app
 *  storage (`workDir`, removed afterwards), never in the project. Held texts are checked against themselves (each was
 *  already checked by its own hash); every other text against the project's sourcetext/. Findings are reported by
 *  check name only: their details can quote the restored wording, which must not reach the UI, the agent or logs. */
export async function restoredReadiness(python: string | null, engine: [string, string][], project: string, restored: string,
  workDir: string, bin: string, timeout = PROTOCOL_TIMEOUT_MS, limits: Limits = {}): Promise<ProtocolProblem[]> {
  if (!python) return [ENGINE_MISSING]
  if (!engine.some(([rel]) => rel === 'hsenv/checks.py')) return [ENGINE_FAILED]
  await mkdir(workDir, { recursive: true })
  const dir = await mkdtemp(join(workDir, 'check-'))
  try {
    await writeFile(join(dir, 'protocol.json'), restored, 'utf8')
    const held: string[] = []
    for (const [name, text] of await heldSourceTexts(project, JSON.parse(restored))) {
      const file = join(dir, `held-${held.length / 2}.txt`)
      await writeFile(file, text, 'utf8')
      held.push('--source-text', `${name}=${file}`)
    }
    return await withScratch(engine, async (work, home) => {
      const run = await confinedPython(python, runner(limits.cpuSeconds, limits.memoryBytes),
        [work, dir, '--sessions', String(PROTOCOL_SESSIONS), ...await publicMode(project), ...await sourceTextArgs(project), ...held], home, bin, timeout, limits)
      if (run.limit) return [ENGINE_LIMIT]
      // Check names only (the details can quote the restored wording); the app words the problem itself.
      return [...new Set(protocolOutcome(run.stdout, run.stderr).map((p) => p.check))].map((check) => ({ check, reason: check }))
    })
  } catch { return [ENGINE_FAILED] } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Parse budget.py's line; anything malformed is an error, never a small budget. */
export function parseBudget(stdout: string): ProtocolBudget {
  const raw = JSON.parse(stdout.trim().split('\n').at(-1) ?? '')
  const arms = raw?.arms
  if (!arms || typeof arms !== 'object' || Array.isArray(arms) || !Object.keys(arms).length) throw Error('Invalid budget')
  const ok = (n: unknown, max: number) => Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= max
  const out: ProtocolBudget = { arms: {}, output_tokens: ok(raw.output_tokens, 4096) ? raw.output_tokens : 512 }
  for (const [id, a] of Object.entries(arms as Record<string, { group_size?: unknown; calls?: unknown; tokens_per_member?: unknown }>)) {
    if (!id || !ok(a?.group_size, 1000) || !ok(a?.calls, 1_000_000) || !ok(a?.tokens_per_member, 1e12)) throw Error('Invalid budget')
    out.arms[id] = { group_size: a.group_size as number, calls: a.calls as number, tokens_per_member: a.tokens_per_member as number }
  }
  return out
}

export const BUDGET_FAILED: ProtocolProblem = { check: 'budget', reason: 'The model budget of a run could not be measured from protocol.json, so a run cannot be sized.' }

/** Measure what a run sends the model (skills/run/budget.py: a few oracle participants per arm, the default
 *  renderer's prompts), confined like the checks. `files`: the engine under hsenv/ and skills/run/*.py. */
export async function protocolBudget(python: string | null, files: [string, string][], project: string, bin: string,
  timeout = PROTOCOL_TIMEOUT_MS, limits: Limits = {}): Promise<ProtocolBudget | ProtocolProblem[]> {
  if (!python) return [ENGINE_MISSING]
  if (!files.some(([rel]) => rel === 'skills/run/budget.py') || !files.some(([rel]) => rel === 'hsenv/hsenv/engine.py')) return [ENGINE_FAILED]
  try {
    return await withScratch(files, async (work, home) => {
      const code = runner(limits.cpuSeconds, limits.memoryBytes).replace(/sys\.path\.insert[\s\S]*$/,
        'import runpy\nscript = sys.argv.pop(1)\nsys.argv = [script] + sys.argv[1:]\nrunpy.run_path(script, run_name="__main__")')
      const run = await confinedPython(python, code, [join(work, 'skills', 'run', 'budget.py'), await realpath(project), home], home, bin, timeout, limits)
      if (run.limit) return [{ ...ENGINE_LIMIT, check: 'budget' }]
      try { return parseBudget(run.stdout) } catch {
        const last = run.stderr.trim().split('\n').at(-1)?.trim()
        return [{ check: 'budget', reason: (BUDGET_FAILED.reason + (last ? ` ${last}` : '')).slice(0, 400) }]
      }
    })
  } catch { return [ENGINE_FAILED] }
}

/** Certify a saved draft, not permission to run it. The bundled schema/reference validator accepts
 * explicitly blocked arms; full mechanical/source checks remain required by protocolReadiness. */
export async function protocolDraftCertificate(python: string | null, engine: [string, string][], project: string, bin: string): Promise<{ hash: string; problems: string[] } | null> {
  if (!python || !engine.some(([rel]) => rel === 'hsenv/schema_check.py')) return null
  try {
    return await withScratch(engine, async (work, home) => {
      const code = [
        'import sys, json, hashlib',
        'from pathlib import Path',
        'sys.path.insert(0, sys.argv[1])',
        'from hsenv.schema_check import validate',
        'from hsenv.engine import Protocol',
        'from hsenv.checks import check_refs',
        'raw = Path(sys.argv[2]).read_bytes()',
        'p = json.loads(raw.decode("utf-8-sig"))',
        'r = validate(p, "protocol")',
        'errors = [str(path) + ": " + str(reason) for path, reason in r["errors"]]',
        'if not errors: errors.extend(check_refs(Protocol(p)))',
        'if p.get("schema_version") != "1": errors.append("Declare protocol schema_version 1.")',
        'if not p.get("meta", {}).get("title") or not p.get("meta", {}).get("sources"): errors.append("Identify the paper and its sources.")',
        'if not p.get("stages") and any(a.get("runnable", True) for a in p.get("arms", [])): errors.append("The participant flow is empty.")',
        'if any(a.get("runnable") is False and not a.get("why") for a in p.get("arms", [])): errors.append("Explain why each blocked arm cannot run.")',
        'print(json.dumps({"hash": hashlib.sha256(raw).hexdigest(), "problems": errors}))',
      ].join('\n')
      const result = await confinedPython(python, code, [work, join(await realpath(project), 'protocol.json')], home, bin, 30_000, { cpuSeconds: 20 })
      if (result.limit) return null
      const parsed = JSON.parse(result.stdout)
      if (!/^[a-f0-9]{64}$/.test(parsed.hash) || !Array.isArray(parsed.problems) || parsed.problems.some((p: unknown) => typeof p !== 'string')) return null
      return parsed
    })
  } catch { return null }
}
