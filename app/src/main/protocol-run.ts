// An approved protocol run is started by the main process, from the app's trusted copy of the code (review 4, S1),
// not by the agent: the copy is written outside the project (app storage), the run folder and plan.json come from
// the approval the main process checked, and skills/run/launch.py runs it (confined by sandbox-exec behind the
// relay on macOS). Nothing the agent can edit is ever on the run's sys.path: the project is data, never code.
import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

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

/** plan.json exactly as app_run.py reads it, from the approved plan and the hash the app read itself. */
export function planJson(binding: Binding, plan: ProtocolRunPlan): string {
  return JSON.stringify({ route: 'protocol', protocolSha256: binding.protocolSha256, perArm: plan.perArm, arms: plan.arms,
    seeds: plan.seeds, temperature: plan.temperature, startedBy: 'app' }, null, 1) + '\n'
}

/** Write the trusted code into `codeDir` (fresh) and start launch.py; resolves with the child once it runs.
 *  `relay` absent: the pre-relay path (Linux, Windows), with `env` carrying the app's simulation environment. */
export async function launchProtocolRun(o: {
  python: string; files: [string, string][]; codeDir: string; project: string; runDir: string; binding: Binding;
  plan: ProtocolRunPlan; relay?: RelayAccess; env?: NodeJS.ProcessEnv; onExit?(code: number | null): void
}) {
  if (!o.files.some(([rel]) => rel === 'skills/run/launch.py')) throw Error('The protocol runner is not available in this version.')
  const bytes = await readFile(join(o.project, 'protocol.json'))
  if (createHash('sha256').update(bytes).digest('hex') !== o.binding.protocolSha256)
    throw Error('The study changed after approval. Review the simulation scope again.')
  await rm(o.codeDir, { recursive: true, force: true })
  for (const [rel, content] of o.files) {
    const path = join(o.codeDir, ...rel.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
  await mkdir(o.runDir, { recursive: true })
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
    ...(o.relay ? { HS_RELAY_BASEURL: o.relay.baseURL, HS_RELAY_TOKEN: o.relay.token, HS_RELAY_MODEL: o.relay.model, HS_RELAY_EXPIRES_AT: String(o.relay.expiresAt) } : {}),
  }
  delete env.PYTHONPATH; delete env.PYTHONHOME; delete env.PYTHONSTARTUP
  const child = spawn(o.python, ['-I', '-B', '-X', 'utf8', join(o.codeDir, 'skills', 'run', 'launch.py'), o.runDir, o.project, o.codeDir],
    { cwd: o.runDir, env, stdio: 'ignore', detached: process.platform !== 'win32', windowsHide: true })
  child.once('exit', (code) => o.onExit?.(code))
  child.once('error', () => o.onExit?.(null))
  return child
}
