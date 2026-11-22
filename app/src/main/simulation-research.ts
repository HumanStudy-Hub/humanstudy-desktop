import { execFile } from 'node:child_process'
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { ActionRef } from '../shared/research-operations'
import { researchUuid, semanticId, type SimulationStage } from '../shared/research-contract'
import { killRunGroup } from './protocol-run'

export interface SimulationScope {
  study_id: string
  revision: string
  per_condition: number
  model: string
}

export interface SimulationMetadata {
  run_id: string
  scope: SimulationScope
  outputs: string[]
  model_request_ids: string[]
  exit_code?: number | null
  part?: number
}

const OUTPUTS = ['plan.json', 'run.json', 'progress.json', 'records.jsonl', 'steps.jsonl',
  'effects.json', 'rewards.json', 'summary.json', 'results.html', 'partial.jsonl']
const terminalStage = (stage: unknown, code: number | null, signal: NodeJS.Signals | null, stopped: boolean) => {
  if (stage === 'stopped' || (stage !== 'done' && stopped)) return 'stopped'
  if (stage === 'done' && code === 0) return 'completed'
  // launch.py normalizes timeouts and child signals to shell exit codes.
  if (signal || code === 124 || (code !== null && code > 128 && code < 160)) return 'interrupted'
  return 'failed'
}

async function runDetails(dir: string) {
  const isFile = (name: string) => lstat(join(dir, name)).then(st => st.isFile(), () => false)
  const read = async (name: string) => (await isFile(name)) ? readFile(join(dir, name), 'utf8').catch(() => '') : ''
  const [progress, usage, stopped, ...files] = await Promise.all([
    read('progress.json'), read('llm-usage.jsonl'), isFile('STOP'), ...OUTPUTS.map(isFile),
  ])
  let stage: unknown
  try { stage = JSON.parse(progress)?.stage } catch { /* runner did not write a readable stage */ }
  const requestIds = new Set<string>()
  for (const line of usage.split('\n')) {
    try {
      const id: unknown = JSON.parse(line)?.request_id
      if (semanticId(id)) requestIds.add(id)
    } catch { /* a terminated process may leave an incomplete last line */ }
  }
  return { stage, stopped, ids: [...requestIds], outputs: OUTPUTS.filter((_, i) => files[i])
    .map(name => `artifacts/simulations/${basename(dir)}/${name}`) }
}

type Publisher = (stage: SimulationStage, metadata: SimulationMetadata) => unknown

async function record(emit: Publisher, base: { run_id: string; scope: SimulationScope }, stage: SimulationStage,
  outputs: string[] = [], ids: string[] = [], code?: number | null): Promise<boolean> {
  // Bounded metadata, even when a run makes thousands of requests.
  const width = 48
  const parts = Math.max(1, Math.ceil(ids.length / width))
  const writes = []
  for (let part = 0; part < parts; part++) {
    writes.push(emit(stage, { ...base, outputs, model_request_ids: ids.slice(part * width, (part + 1) * width),
      ...(code === undefined ? {} : { exit_code: code }), ...(parts > 1 ? { part } : {}) }))
  }
  return (await Promise.all(writes)).every(result => result !== null)
}

/** One lifecycle for the app-owned runner. Approval and spawn can succeed independently. */
export function simulationResearch(runId: string, scope: SimulationScope,
  emit: (stage: SimulationStage, metadata: SimulationMetadata) => unknown) {
  let started = false
  let terminal = false
  let pending: Promise<boolean> | undefined
  let journaled: Promise<void> | undefined
  let dir: string | undefined
  const base = { run_id: runId, scope }
  function finish(code: number | null, signal: NodeJS.Signals | null, interrupted = false) {
    if (terminal) return pending
    terminal = true
    pending = (async () => {
      await journaled?.catch(() => {})
      const details = dir ? await runDetails(dir) : { stage: null, stopped: false, outputs: [], ids: [] }
      const stage = interrupted && !['done', 'failed', 'stopped'].includes(String(details.stage)) && !details.stopped
        ? 'interrupted'
        : terminalStage(details.stage, interrupted && details.stage === 'done' ? 0 : code, signal, details.stopped)
      return record(emit, base, stage, details.outputs, details.ids, interrupted ? undefined : code)
    })()
    return pending
  }
  void record(emit, base, 'approved').catch(() => undefined)
  return {
    started(runDir: string, saved?: Promise<void>) {
      if (terminal || started) return
      started = true
      dir = runDir
      journaled = saved
      void saved?.catch(() => undefined)
      void record(emit, base, 'started', [`artifacts/simulations/${basename(runDir)}/plan.json`]).catch(() => undefined)
    },
    finish,
    interrupt: () => finish(null, null, true),
    quit: () => journaled
      ? journaled.catch(() => finish(null, null, true)?.catch(() => undefined))
      : finish(null, null, true),
  }
}

export interface DetachedRunResearch {
  researchScope: string
  visitId?: string
  projectDir: string
  threadId: string
  action: ActionRef
  runDir: string
  scope: SimulationScope
  pid: number
  bootId?: string
  processStartTime?: string | null
}

const runCommand = promisify(execFile)
const readBootId = () => process.platform === 'linux'
  ? readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(value => value.trim(), () => undefined)
  : Promise.resolve(undefined)

async function processStartTime(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
      // The comm field may contain spaces and parentheses. Fields after it start at field 3.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      return fields[0] === 'Z' ? null : fields[19] || null
    }
    const { stdout } = process.platform === 'win32'
      ? await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`], { windowsHide: true, timeout: 2000 })
      : await runCommand('ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 2000 })
    return stdout.trim() || null
  } catch { return null }
}

async function processAlive(run: DetachedRunResearch): Promise<boolean> {
  if (!Number.isSafeInteger(run.pid) || run.pid <= 0) return false
  if (run.bootId !== undefined && run.bootId !== await readBootId()) return false
  if (run.processStartTime !== undefined) {
    return run.processStartTime !== null && run.processStartTime === await processStartTime(run.pid)
  }
  // Journals from before process identity was recorded.
  try { process.kill(run.pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** Private handoff for app-owned runs that can outlive the desktop process. */
export function detachedRunJournal(root: string) {
  const marker = (id: string) => join(root, id + '.json')
  const exitFile = (id: string) => join(root, id + '.exit')
  const forget = async (id: string) => {
    await rm(marker(id), { force: true })
    await rm(exitFile(id), { force: true })
  }
  return {
    exitFile,
    prepare: () => mkdir(root, { recursive: true, mode: 0o700 }),
    async remember(id: string, run: DetachedRunResearch) {
      const tmp = marker(id) + '.tmp'
      const [bootId, startTime] = await Promise.all([readBootId(), processStartTime(run.pid)])
      await writeFile(tmp, JSON.stringify({ ...run, bootId, processStartTime: startTime }), { mode: 0o600 })
      await rename(tmp, marker(id))
    },
    forget,
    async reconcile(publisher: (run: DetachedRunResearch) => Publisher | undefined, sandboxStop = false) {
      const files = await readdir(root).catch(() => [] as string[])
      const pending = files.map(name => name.endsWith('.json') ? name.slice(0, -5) : '').filter(researchUuid)
      async function check() {
        for (const id of [...pending]) {
          try {
            const run: DetachedRunResearch = JSON.parse(await readFile(marker(id), 'utf8'))
            const emit = publisher(run)
            if (!emit && !sandboxStop) {
              pending.splice(pending.indexOf(id), 1)
              continue
            }
            const exit = await readFile(exitFile(id), 'utf8').catch(() => '')
            if (!exit && await processAlive(run)) {
              if (!sandboxStop) continue
              if (run.processStartTime != null) killRunGroup(run.pid)
            }
            if (emit) {
              const details = await runDetails(run.runDir)
              // Older or forcibly killed launchers can leave a terminal progress stage without an exit receipt.
              const code = exit ? Number(exit) : details.stage === 'done' ? 0 : null
              const interrupted = !exit && !['done', 'failed', 'stopped'].includes(String(details.stage)) && !details.stopped
              const saved = await record(emit, { run_id: id, scope: run.scope },
                interrupted ? 'interrupted' : terminalStage(details.stage, code, null, details.stopped),
                details.outputs, details.ids, exit ? code : undefined)
              if (!saved) continue
              await forget(id)
            }
            pending.splice(pending.indexOf(id), 1)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') pending.splice(pending.indexOf(id), 1)
          }
        }
        if (pending.length && !sandboxStop) setTimeout(() => void check(), 5000).unref()
      }
      await check()
    },
  }
}
