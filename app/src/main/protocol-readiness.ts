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

export interface ProtocolProblem { check: string; reason: string }

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
export const runner = (cpuSeconds = PROTOCOL_CPU_SECONDS, memoryBytes = PROTOCOL_MEMORY_BYTES): string => [
  'import sys',
  'try:',
  ' import resource',
  ` for name, n in (("RLIMIT_CPU", ${cpuSeconds}), ("RLIMIT_AS", ${memoryBytes}), ("RLIMIT_DATA", ${memoryBytes})):`,
  '  try: resource.setrlimit(getattr(resource, name), (n, n))',
  '  except (AttributeError, ValueError, OSError): pass',
  'except ImportError: pass',
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
 *  (its `fail |= …` lines). A report that does not say PASS: true never passes, whatever else it holds.
 *  `held`: the sources whose wording a published study holds back (its `distribution.held`). Their texts are
 *  placeholders here and have no source text to compare against; each is checked instead by its own text hash
 *  when the app fills it in on this computer (original-text.ts), and an unfilled one blocks the run there. So
 *  `verbatim.unchecked` does not block when it names only held sources AND counts no more texts than the study
 *  holds as placeholders (`heldTexts`): any other unverified text of those sources still blocks. */
export function protocolProblems(report: unknown, held: ReadonlySet<string> = new Set(), heldTexts = 0): ProtocolProblem[] {
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
  const onlyHeld = held.size > 0 && heldTexts > 0 && Number(v.unchecked) <= heldTexts && list(v.unchecked_sources).length > 0
    && list(v.unchecked_sources).every((k) => typeof k === 'string' && held.has(k))
  if (Number(v.unchecked) > 0 && !onlyHeld) add('verbatim', `${v.unchecked} served text(s) have no source text under sourcetext/ to check against`)
  const annotations = list(r.reading_annotations).filter((a) => obj(a).error !== undefined)
  if (annotations.length) add('verbatim', `printed-annotation rules with errors: ${some(annotations)}`)
  if (r.images !== undefined) {
    const imgs = list(r.images).filter((x) => !(typeof x === 'string' && x.startsWith('note:')))
    if (imgs.length) add('images', `images that do not match their source: ${some(imgs)}`)
  }
  if (r.public === true && list(r.release_hold).length) add('release', `arms on release hold: ${some(list(r.release_hold))}`)
  for (const [id, c] of Object.entries(obj(r.coding)))
    if (list(obj(c).mismatches).length) add('coding', `coding ${id}: ${list(obj(c).mismatches).length} test case(s) coded differently`)
  // Every `fail |=` line of checks.py is parsed above, so a failing report whose only finding is the held
  // sources' unchecked texts is explained by them; any other failing report without a parsed finding still blocks.
  if (r.PASS === false && !out.length && !(onlyHeld && Number(v.unchecked) > 0)) add('protocol', 'The protocol checks did not pass.')
  if (r.PASS === true && out.length) return out // a report that contradicts itself is not a pass
  return out
}

/** Parse the engine's report (indented JSON on stdout); anything else counts as a failed check, never a pass. */
export function parseProtocolReport(stdout: string, held: ReadonlySet<string> = new Set(), heldTexts = 0): ProtocolProblem[] {
  const start = stdout.indexOf('{')
  if (start < 0) throw Error('No protocol checks report')
  return protocolProblems(JSON.parse(stdout.slice(start)), held, heldTexts).slice(0, 30)
}

/** The checks' answer from what the engine printed: its report, or, when the engine stopped on the protocol
 *  (a traceback, e.g. a flow naming a stage that does not exist), that error as a blocking problem. */
export function protocolOutcome(stdout: string, stderr: string, held: ReadonlySet<string> = new Set(), heldTexts = 0): ProtocolProblem[] {
  if (stdout.includes('{')) return parseProtocolReport(stdout, held, heldTexts)
  const last = stderr.trim().split('\n').at(-1)?.trim()
  if (/Traceback/.test(stderr) && last) return [{ check: 'protocol', reason: `The engine stopped on this protocol: ${last}`.slice(0, 400) }]
  throw Error('No protocol checks report')
}

/** The sources whose wording a published protocol.json holds back (`distribution.held[*].source`); empty for an
 *  ordinary protocol.json or one that cannot be read. */
export async function heldSources(project: string): Promise<Set<string>> {
  try {
    const held = JSON.parse(await readFile(join(project, 'protocol.json'), 'utf8'))?.distribution?.held
    if (!held || typeof held !== 'object' || Array.isArray(held)) return new Set()
    return new Set(Object.values(held as Record<string, { source?: unknown }>).map((h) => h?.source).filter((k): k is string => typeof k === 'string'))
  } catch { return new Set() }
}

/** The held texts of a published protocol.json that really are placeholders (a string of U+2591 of the recorded
 *  length at their path), and their sources: what the source-text check may leave to the per-item hash check. */
export async function heldTexts(project: string): Promise<{ sources: Set<string>; texts: number }> {
  const out = { sources: new Set<string>(), texts: 0 }
  try {
    const p = JSON.parse(await readFile(join(project, 'protocol.json'), 'utf8'))
    const held = p?.distribution?.held
    if (!held || typeof held !== 'object' || Array.isArray(held)) return out
    for (const h of Object.values(held as Record<string, { source?: unknown; path?: unknown; kind?: unknown; length?: unknown }>)) {
      if (!h || typeof h.source !== 'string' || typeof h.path !== 'string' || h.kind === 'image') continue
      let v: unknown = p
      for (const part of h.path.split('/').slice(1).map((x) => x.replace(/~1/g, '/').replace(/~0/g, '~')))
        v = v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined
      if (typeof v === 'string' && v.length > 0 && v.length === h.length && /^\u2591+$/.test(v)) { out.texts++; out.sources.add(h.source) }
    }
  } catch { /* unreadable: nothing is held */ }
  return out
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
export type Ran = { stdout: string; stderr: string; limit?: boolean }

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
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    })
    // macOS does not enforce RLIMIT_AS/RLIMIT_DATA: watch the resident size and stop the check above the bound.
    const watch = setInterval(() => {
      if (win || !child.pid) return
      execFile('/bin/ps', ['-o', 'rss=', '-p', String(child.pid)], { timeout: 2000 }, (e, out) => {
        if (!e && Number(String(out).trim()) * 1024 > memoryBytes) { overMemory = true; child.kill('SIGKILL') }
      })
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

export async function protocolReadiness(python: string | null, engine: [string, string][], project: string, bin: string,
  timeout = PROTOCOL_TIMEOUT_MS, limits: Limits = {}): Promise<ProtocolProblem[]> {
  if (!python) return [ENGINE_MISSING]
  if (!engine.some(([rel]) => rel === 'hsenv/checks.py')) return [ENGINE_FAILED]
  try {
    return await withScratch(engine, async (work, home) => {
      const run = await confinedPython(python, runner(limits.cpuSeconds, limits.memoryBytes),
        [work, await realpath(project), '--sessions', String(PROTOCOL_SESSIONS), ...await sourceTextArgs(project)], home, bin, timeout, limits)
      if (run.limit) return [ENGINE_LIMIT]
      if (/\bMemoryError\b/.test(run.stderr) && !run.stdout.includes('{')) return [ENGINE_LIMIT]
      const held = await heldTexts(project)
      return protocolOutcome(run.stdout, run.stderr, held.sources, held.texts)
    })
  } catch { return [ENGINE_FAILED] }
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
