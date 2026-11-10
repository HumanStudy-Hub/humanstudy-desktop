// An approved protocol run is started by the main process, from the app's trusted copy of the code (review 4, S1),
// not by the agent: the copy is written outside the project (app storage), the run folder and plan.json come from
// the approval the main process checked, and skills/run/launch.py runs it (confined by sandbox-exec behind the
// relay on macOS). Nothing the agent can edit is ever on the run's sys.path: the project is data, never code.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

export interface ProtocolRunPlan { perArm: number; arms: string[] | null; seeds: number[]; temperature: number }
export interface RelayAccess { baseURL: string; token: string; model: string; expiresAt: number }
export interface Binding { route: 'protocol'; runId: string; approvedAt: number; protocolSha256: string }

const pad = (n: number) => String(n).padStart(2, '0')
/** artifacts/simulations/<YYYY-MM-DD-HHMM>[-k]: a new folder, never an existing run's. */
export function newRunFolder(project: string, now = new Date()): string {
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  for (let k = 0; ; k++) {
    const dir = join(project, 'artifacts', 'simulations', k ? `${stamp}-${k + 1}` : stamp)
    if (!existsSync(dir)) return dir
  }
}

/** The approved plan: what app_run plays. The main process hands it to the run in its environment
 *  (HUMANSTUDY_RUN_PLAN), and app_run refuses a plan.json that differs (review 5, M1). */
export function approvedPlan(binding: Binding, plan: ProtocolRunPlan) {
  return { route: 'protocol' as const, protocolSha256: binding.protocolSha256, perArm: plan.perArm, arms: plan.arms,
    seeds: plan.seeds, temperature: plan.temperature }
}

/** plan.json as app_run.py reads it: the approved plan, as a record in the run folder. */
export function planJson(binding: Binding, plan: ProtocolRunPlan): string {
  return JSON.stringify({ ...approvedPlan(binding, plan), startedBy: 'app' }, null, 1) + '\n'
}

/** The run folder must stay inside the project, whatever links the project holds (review 5, S4). */
export async function checkInside(project: string, runDir: string): Promise<void> {
  const root = await realpath(project)
  const parent = await realpath(dirname(runDir))
  if (parent !== root && !parent.startsWith(root + sep))
    throw Error('artifacts/simulations leads outside the project, so the run was not started.')
}

const TERMINAL = new Set(['done', 'failed', 'stopped'])
/** A run that ended without a final stage (it was refused or broke before it could write one) is marked failed
 *  with the end of its log, so the tab and the agent stop waiting (review 5, S2). */
export async function markEnded(runDir: string, code: number | null): Promise<void> {
  let progress: Record<string, unknown> = {}
  try { progress = JSON.parse(await readFile(join(runDir, 'progress.json'), 'utf8')) } catch { /* none yet */ }
  if (TERMINAL.has(String(progress.stage))) return
  const log = await readFile(join(runDir, 'run.log'), 'utf8').catch(() => '')
  const tail = log.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(' ').slice(-300)   // CRLF on Windows
  const now = new Date().toISOString().slice(0, 19) + 'Z'
  // Written whole and then renamed into place, so a reader never sees a half-written file (Windows readers poll it).
  const tmp = join(runDir, `progress.json.${process.pid}.tmp`)
  await writeFile(tmp, JSON.stringify({ done: 0, total: 0, failed: 0, conditions: [], ...progress, stage: 'failed',
    runner: 'exited', updatedAt: now, message: `The run ended before it finished (exit ${code ?? 'unknown'}).${tail ? ' ' + tail : ''}` }, null, 1))
  await rename(tmp, join(runDir, 'progress.json'))
}

/** Write the trusted code into `codeDir` (fresh) and start launch.py; resolves with the child once it runs.
 *  `relay` absent: the pre-relay path (Linux, Windows), with `env` carrying the app's simulation environment. */
export async function launchProtocolRun(o: {
  python: string; files: [string, string][]; codeDir: string; project: string; runDir: string; binding: Binding;
  plan: ProtocolRunPlan; relay?: RelayAccess; env?: NodeJS.ProcessEnv; onExit?(code: number | null): void
  /** The app's language for the run's messages and results page ('zh-CN' or 'en'). */
  lang?: string
}) {
  if (!o.files.some(([rel]) => rel === 'skills/run/launch.py')) throw Error('The protocol runner is not available in this version.')
  const bytes = await readFile(join(o.project, 'protocol.json'))
  if (createHash('sha256').update(bytes).digest('hex') !== o.binding.protocolSha256)
    throw Error('The study changed after approval. Review the simulation scope again.')
  // A variant (variant.json) is not the original experiment and is not part of the approval: not on this path.
  if (await stat(join(o.project, 'variant.json')).then(() => true, () => false))
    throw Error('This project holds a variant (variant.json); variants are not run from the Simulation tab.')
  await rm(o.codeDir, { recursive: true, force: true })
  for (const [rel, content] of o.files) {
    const path = join(o.codeDir, ...rel.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  await writeFile(join(o.codeDir, '.run.json'), JSON.stringify({ runDir: o.runDir, startedAt: Date.now() }))   // for the sweep
  await mkdir(dirname(o.runDir), { recursive: true })
  await checkInside(o.project, o.runDir)
  await mkdir(o.runDir)
  await writeFile(join(o.runDir, 'plan.json'), planJson(o.binding, o.plan), { flag: 'wx' })
  // run_study keeps the run's secret salt (opaque participant ids are HMACs under it) outside the run folder, in
  // <runs>/.operator/<run>.salt. The confined run may write only its run folder, so the app makes it here.
  const salt = join(dirname(o.runDir), '.operator', basename(o.runDir) + '.salt')
  await mkdir(dirname(salt), { recursive: true })
  await writeFile(salt, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  const env: NodeJS.ProcessEnv = {
    ...(o.env ?? { PATH: process.env.PATH }), HSENV_PRIVATE_CONFIG: '',
    HUMANSTUDY_RUN_ROUTE: 'protocol', HUMANSTUDY_RUN_ID: o.binding.runId, HUMANSTUDY_RUN_APPROVED_AT: String(o.binding.approvedAt),
    HUMANSTUDY_RUN_PROTOCOL_SHA256: o.binding.protocolSha256,
    HUMANSTUDY_RUN_PLAN: JSON.stringify(approvedPlan(o.binding, o.plan)),
    HUMANSTUDY_LANG: o.lang === 'zh-CN' ? 'zh-CN' : 'en',
    ...(o.relay ? { HS_RELAY_BASEURL: o.relay.baseURL, HS_RELAY_TOKEN: o.relay.token, HS_RELAY_MODEL: o.relay.model, HS_RELAY_EXPIRES_AT: String(o.relay.expiresAt) } : {}),
  }
  delete env.PYTHONPATH; delete env.PYTHONHOME; delete env.PYTHONSTARTUP
  const child = spawn(o.python, ['-I', '-B', '-X', 'utf8', join(o.codeDir, 'skills', 'run', 'launch.py'), o.runDir, o.project, o.codeDir],
    { cwd: o.runDir, env, stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true })
  let ended = false
  const end = async (code: number | null) => {
    if (ended) return
    ended = true
    if (code !== 0) await markEnded(o.runDir, code).catch(() => undefined)
    await rm(o.codeDir, { recursive: true, force: true }).catch(() => undefined)   // per-run copy: gone with the run
    o.onExit?.(code)
  }
  child.once('exit', (code) => void end(code))
  child.once('error', () => void end(null))
  return child
}

/** Remove per-run code copies a quit or a crash left behind (review 6, S6): a copy whose run has a final stage, whose
 *  run folder is gone, or that is older than two days. A run still going (a detached run that outlived the app on
 *  Linux) keeps its copy until it ends. */
export async function sweepRunCopies(root: string, now = Date.now()): Promise<string[]> {
  const removed: string[] = []
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const dir = join(root, name)
    let stale = true
    try {
      const marker = JSON.parse(await readFile(join(dir, '.run.json'), 'utf8'))
      const fresh = typeof marker.startedAt === 'number' && now - marker.startedAt < 2 * 24 * 3600_000
      const progress = await readFile(join(String(marker.runDir), 'progress.json'), 'utf8').then((t) => JSON.parse(t), () => null)
      const gone = !existsSync(String(marker.runDir))
      stale = !fresh || gone || TERMINAL.has(String(progress?.stage))
    } catch { /* no marker: an interrupted copy */ }
    if (stale) { await rm(dir, { recursive: true, force: true }).catch(() => undefined); removed.push(name) }
  }
  return removed
}
