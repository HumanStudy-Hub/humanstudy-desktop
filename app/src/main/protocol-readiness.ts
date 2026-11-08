// Runs the protocol engine's mechanical checks (`hsenv.checks`, vendored in pack/runtime/hsenv) on a
// project's protocol.json, as the app's readiness gate for the protocol route. Confined like
// scientific-readiness.ts: the engine is written fresh from the files bundled in the app into a private scratch
// folder for every run (never the project's editable .opencode copy), Python runs isolated (-I -B), from an
// empty home, with no keys or tokens in its environment. The checks make no model calls and fetch nothing.
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'

export interface ProtocolProblem { check: string; reason: string }

/** Random-answer sessions the gate plays (the converter's own gate plays 1,000). */
export const PROTOCOL_SESSIONS = 50
/** checks.py doubles the sessions up to five times when screening ends most of them early. */
export const PROTOCOL_TIMEOUT_MS = 10 * 60_000

export const ENGINE_MISSING: ProtocolProblem = { check: 'runtime', reason: 'The research runtime is not installed, so the protocol checks cannot run yet.' }
export const ENGINE_FAILED: ProtocolProblem = { check: 'runtime', reason: 'The protocol checks could not complete. Retry; if it persists, reinstall the research runtime.' }

// `-I` leaves the script folder and the working folder off sys.path, so the engine folder is added explicitly.
const RUNNER = 'import sys; sys.path.insert(0, sys.argv.pop(1)); from hsenv import checks; sys.exit(checks.main())'

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
  const leaks = list(fuzz.leaks)
  if (leaks.length) add('leaks', `${leaks.length} screen(s) show text meant to stay hidden: ${some(leaks)}`)
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
  }
  const v = obj(r.verbatim)
  if (list(v.not_found).length) add('verbatim', `texts not found in the source: ${some(list(v.not_found))}`)
  if (list(v.image_unconfirmed).length) add('verbatim', `image-read texts without an agreeing blind reading: ${some(list(v.image_unconfirmed))}`)
  if (list(v.bad_source).length) add('verbatim', `texts cite an unknown source: ${some(list(v.bad_source))}`)
  if (Number(v.unchecked) > 0) add('verbatim', `${v.unchecked} served text(s) have no source text under sourcetext/ to check against`)
  for (const [id, c] of Object.entries(obj(r.coding)))
    if (list(obj(c).mismatches).length) add('coding', `coding ${id}: ${list(obj(c).mismatches).length} test case(s) coded differently`)
  if (r.PASS === false && !out.length) add('protocol', 'The protocol checks did not pass.')
  if (r.PASS === true && out.length) return out // a report that contradicts itself is not a pass
  return r.PASS ? [] : out
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

export async function protocolReadiness(python: string | null, engine: [string, string][], project: string, bin: string,
  timeout = PROTOCOL_TIMEOUT_MS): Promise<ProtocolProblem[]> {
  if (!python) return [ENGINE_MISSING]
  if (!engine.some(([rel]) => rel === 'hsenv/checks.py')) return [ENGINE_FAILED]
  const work = await mkdtemp(join(tmpdir(), 'hs-protocol-'))
  const home = await mkdtemp(join(tmpdir(), 'hs-protocol-home-'))
  try {
    for (const [rel, content] of engine) {
      const path = join(work, ...rel.split('/'))
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, content, 'utf8')
    }
    const args = ['-I', '-B', '-X', 'utf8', '-c', RUNNER, work, await realpath(project), '--sessions', String(PROTOCOL_SESSIONS), ...await sourceTextArgs(project)]
    const win = process.platform === 'win32'
    const system = win ? `${process.env.SystemRoot || 'C:\\Windows'}\\System32` : '/usr/bin:/bin:/usr/sbin:/sbin'
    const run = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      execFile(python, args, {
        cwd: home, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
        // No keys or tokens: only a path, a home and a temp folder in the scratch space.
        env: {
          PATH: (bin ? bin + (win ? ';' : ':') : '') + system,
          HOME: home, USERPROFILE: home, TMPDIR: home, TEMP: home, TMP: home, LANG: 'C.UTF-8',
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      }, (error, stdout, stderr) => {
        // checks.py exits 1 when the protocol fails (its report is still the answer) and Python exits 1 on an
        // uncaught error in the engine. Anything else (not started, killed, timed out) is a failed run.
        if (error && !(typeof error.code === 'number' && error.code === 1 && !error.killed)) return reject(error)
        resolve({ stdout: String(stdout), stderr: String(stderr) })
      })
    })
    return protocolOutcome(run.stdout, run.stderr)
  } catch { return [ENGINE_FAILED] }
  finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
    await rm(home, { recursive: true, force: true }).catch(() => undefined)
  }
}
