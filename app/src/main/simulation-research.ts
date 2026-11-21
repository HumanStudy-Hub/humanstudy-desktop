import { lstat, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { semanticId, type SimulationStage } from '../shared/research-contract'

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

/** One lifecycle for the app-owned runner. Approval and spawn can succeed independently. */
export function simulationResearch(runId: string, scope: SimulationScope,
  emit: (stage: SimulationStage, metadata: SimulationMetadata) => void) {
  let started = false
  let terminal = false
  let pending: Promise<void> | undefined
  let dir: string | undefined
  const base = { run_id: runId, scope }
  function record(stage: SimulationStage, outputs: string[] = [], ids: string[] = [], code?: number | null) {
    // Bounded metadata, even when a run makes thousands of requests.
    const width = 48
    const parts = Math.max(1, Math.ceil(ids.length / width))
    for (let part = 0; part < parts; part++) {
      emit(stage, { ...base, outputs, model_request_ids: ids.slice(part * width, (part + 1) * width),
        ...(code === undefined ? {} : { exit_code: code }), ...(parts > 1 ? { part } : {}) })
    }
  }
  function finish(code: number | null, signal: NodeJS.Signals | null, interrupted = false) {
    if (terminal) return pending
    terminal = true
    pending = (async () => {
      const details = dir ? await runDetails(dir) : { stage: null, stopped: false, outputs: [], ids: [] }
      const stage = interrupted && !['done', 'failed', 'stopped'].includes(String(details.stage)) && !details.stopped
        ? 'interrupted'
        : terminalStage(details.stage, interrupted && details.stage === 'done' ? 0 : code, signal, details.stopped)
      record(stage, details.outputs, details.ids, interrupted ? undefined : code)
    })()
    return pending
  }
  record('approved')
  return {
    started(runDir: string) {
      if (terminal || started) return
      started = true
      dir = runDir
      record('started', [`artifacts/simulations/${basename(runDir)}/plan.json`])
    },
    finish,
    interrupt: () => finish(null, null, true),
  }
}
