// Pure helpers behind the Simulation tab: what will run (conditions, AI participants, rough time and
// cost), live progress from artifacts/simulations/<run>/progress.json, and the list of earlier runs.
// No I/O here; the renderer reads the files and passes their text in.
import type { HumanProgram } from './human-program'

/** Folder every simulation run writes into (see pack/skills/simulate/SKILL.md). */
export const SIM_DIR = 'artifacts/simulations'
/** The real example run every sample project ships with (app/resources/sample/example-simulation). */
export const EXAMPLE_RUN = 'artifacts/simulations/2026-10-15-1329-example'

export type SimStage = 'preparing' | 'trial' | 'running' | 'scoring' | 'writing' | 'done' | 'failed' | 'stopped'
const STAGES: SimStage[] = ['preparing', 'trial', 'running', 'scoring', 'writing', 'done', 'failed', 'stopped']

/** progress.json, written by the run's run.py while it runs (contract in the simulate skill). */
export interface SimProgress {
  stage: SimStage
  /** AI participants finished so far, and planned in total (the trial run counts separately). */
  done: number
  total: number
  failed: number
  conditions: { id: string; done: number; total: number }[]
  model?: string
  startedAt?: number
  updatedAt?: number
  /** One plain sentence from the run (shown as is), or the reason it failed. */
  message?: string
  /** simkit's liveness: "alive" while run.py runs (heartbeatAt moves every 15 s), "exited" after it ended.
   *  Absent in files from older packs. */
  runner?: 'alive' | 'exited'
  heartbeatAt?: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const time = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v
  if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : undefined }
  return undefined
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 400) : undefined)

/** Tolerant: an agent-written file may use other casing, nest counts per condition, or be half-written. */
export function parseProgress(text: string | null | undefined): SimProgress | null {
  if (!text) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const stageRaw = String(r.stage ?? r.status ?? '').toLowerCase()
  const stage: SimStage = STAGES.includes(stageRaw as SimStage) ? (stageRaw as SimStage)
    : /smoke|pilot|trial|test/.test(stageRaw) ? 'trial'
    : /run|simulat|progress/.test(stageRaw) ? 'running'
    : /eval|scor|analy/.test(stageRaw) ? 'scoring'
    : /report|writ|chart|html/.test(stageRaw) ? 'writing'
    : /complete|finish|success/.test(stageRaw) ? 'done'
    : /error|fail/.test(stageRaw) ? 'failed'
    : /abort|cancel|stop/.test(stageRaw) ? 'stopped' : 'preparing'
  const condRaw = r.conditions ?? r.arms
  const conditions = Array.isArray(condRaw)
    ? condRaw.filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object').map((c) => ({ id: String(c.id ?? c.name ?? c.condition ?? ''), done: num(c.done ?? c.completed), total: num(c.total ?? c.n) }))
    : condRaw && typeof condRaw === 'object'
      ? Object.entries(condRaw as Record<string, unknown>).map(([id, c]) => (c && typeof c === 'object' ? { id, done: num((c as Record<string, unknown>).done ?? (c as Record<string, unknown>).completed), total: num((c as Record<string, unknown>).total ?? (c as Record<string, unknown>).n) } : { id, done: 0, total: num(c) }))
      : []
  const sum = (k: 'done' | 'total') => conditions.reduce((a, c) => a + c[k], 0)
  const total = num(r.total ?? r.planned ?? r.n_total) || sum('total')
  const done = Math.min(total || Infinity, num(r.done ?? r.completed ?? r.sessions_done) || sum('done'))
  return {
    stage, done: Number.isFinite(done) ? done : 0, total, failed: num(r.failed ?? r.parse_failures ?? r.errors), conditions: conditions.filter((c) => c.id),
    model: str(r.model), startedAt: time(r.startedAt ?? r.started_at), updatedAt: time(r.updatedAt ?? r.updated_at),
    message: str(r.message ?? r.error ?? r.note),
    runner: r.runner === 'alive' || r.runner === 'exited' ? r.runner : undefined, heartbeatAt: time(r.heartbeatAt ?? r.heartbeat_at),
  }
}

/** summary.json, written by the agent when a run finishes: the plain-language comparison. */
export interface SimSummary {
  outcome: 'replicated' | 'partly' | 'not_replicated' | 'not_ready' | 'unknown'
  paragraph: string
  model?: string
  perCondition?: number
  calls?: number
  example?: boolean
}
/** `lang` 'zh-CN' prefers `paragraph_zh` when the file carries one (the shipped example does). */
export function parseSummary(text: string | null | undefined, lang = 'en'): SimSummary | null {
  if (!text) return null
  let r: Record<string, unknown>
  try { r = JSON.parse(text) } catch { return null }
  if (!r || typeof r !== 'object') return null
  const o = String(r.outcome ?? r.verdict ?? '').toLowerCase()
  const outcome: SimSummary['outcome'] = /not[_ -]?ready/.test(o) ? 'not_ready' : /not|fail/.test(o) ? 'not_replicated' : /part|mixed|weak/.test(o) ? 'partly' : /replicat|yes|shown/.test(o) ? 'replicated' : 'unknown'
  const zh = lang.startsWith('zh') && typeof r.paragraph_zh === 'string' && r.paragraph_zh.trim() ? r.paragraph_zh : null
  const raw = zh ?? r.paragraph ?? r.summary ?? r.text
  if (!str(raw)) return null
  const per = r.perCondition ?? r.n_per_condition
  return { outcome, paragraph: String(raw).trim().slice(0, 2000), model: str(r.model), perCondition: typeof per === 'number' ? per : undefined, calls: typeof r.calls === 'number' ? r.calls : undefined, example: r.example === true }
}

/** One run folder as seen in the project tree. */
export interface SimRunFiles {
  id: string
  /** Project-relative folder, e.g. artifacts/simulations/2026-10-15-1402. */
  rel: string
  path: string
  progress?: string
  summary?: string
  results?: string
  report?: string
  /** sessions.jsonl: one line per finished AI participant (the run's participant data). */
  sessions?: string
  sessionsSize?: number
  /** The researcher pressed Stop (the app wrote a STOP file into the folder). */
  stop?: boolean
  /** Newest modification time of anything in the folder, ms. */
  mtime: number
}
interface TreeEntry { name: string; path: string; rel: string; kind: 'file' | 'dir'; mtime?: number; size?: number; children?: TreeEntry[] }

/** Run folders under artifacts/simulations, newest first. */
export function runFolders(tree: TreeEntry[]): SimRunFiles[] {
  const find = (entries: TreeEntry[], rel: string): TreeEntry | undefined => {
    for (const e of entries) {
      if (e.rel === rel) return e
      if (e.kind === 'dir' && rel.startsWith(e.rel + '/') && e.children) { const hit = find(e.children, rel); if (hit) return hit }
    }
    return undefined
  }
  const root = find(tree, SIM_DIR)
  const runs: SimRunFiles[] = []
  for (const dir of root?.children ?? []) {
    if (dir.kind !== 'dir') continue
    const files = new Map<string, TreeEntry>()
    const walk = (es: TreeEntry[]) => es.forEach((e) => (e.kind === 'dir' ? walk(e.children ?? []) : files.set(e.rel.slice(dir.rel.length + 1), e)))
    walk(dir.children ?? [])
    const pick = (name: string) => files.get(name)?.path
    runs.push({
      id: dir.name, rel: dir.rel, path: dir.path,
      progress: pick('progress.json'), summary: pick('summary.json'), results: pick('results.html'), report: pick('report.md'),
      sessions: pick('sessions.jsonl'), sessionsSize: files.get('sessions.jsonl')?.size, stop: files.has('STOP'),
      mtime: Math.max(dir.mtime ?? 0, ...[...files.values()].map((f) => f.mtime ?? 0)),
    })
  }
  return runs.sort((a, b) => b.id.localeCompare(a.id) || b.mtime - a.mtime)
}

export type RunState = 'running' | 'done' | 'failed' | 'stopped'
/** run.py's heartbeat moves every 15 s; this many missed beats means its process is gone. */
export const HEARTBEAT_STALE = 90_000
/** After run.py ends, the agent writes the report and results page into the run folder. */
export const WRITE_UP_WINDOW = 20 * 60_000

/** The run's status comes from the run itself (its folder and progress.json), never from whether the
 *  agent happens to be replying in the chat: a question about a report must not revive a stopped run.
 *  `owned` is true only while the chat turn that started this very run is still working.
 *  Finished = results.html exists. Stopped only when STOP was written or nothing is behind the run any
 *  more: run.py's heartbeat went stale (its process is gone), or, after run.py ended, the folder has
 *  not changed for the whole write-up window. A quiet scoring or writing stage is not "stopped". */
export function runState(run: Pick<SimRunFiles, 'results' | 'stop'>, progress: SimProgress | null, now: number, lastChange: number, owned = false): RunState {
  if (progress?.stage === 'failed') return 'failed'
  if (run.results && (!progress || progress.stage === 'done' || !owned)) return 'done'
  if (progress?.stage === 'stopped' || run.stop) return 'stopped'
  if (progress?.stage === 'done') return 'done'
  if (owned) return 'running'
  if (progress?.runner === 'alive') return now - (progress.heartbeatAt ?? progress.updatedAt ?? lastChange) < HEARTBEAT_STALE ? 'running' : 'stopped'
  if (progress?.runner === 'exited') return now - Math.max(progress.updatedAt ?? 0, lastChange) < WRITE_UP_WINDOW ? 'running' : 'stopped'
  // Older packs write no heartbeat: progress that stopped moving for a while means the run is gone.
  return now - (progress?.updatedAt ?? lastChange) < HEARTBEAT_STALE ? 'running' : 'stopped'
}

/** Participant data: at least one finished AI participant (sessions.jsonl with content, or a count in
 *  progress.json, as the shipped example has). A folder without it is never a result. */
export function hasParticipantData(run: Pick<SimRunFiles, 'sessions' | 'sessionsSize'>, progress: SimProgress | null): boolean {
  return Boolean(run.sessions && run.sessionsSize !== 0) || (progress?.done ?? 0) > 0
}

/** A result: finished, with a results page, from real participant data. */
export function isResult(run: Pick<SimRunFiles, 'results' | 'sessions' | 'sessionsSize'>, progress: SimProgress | null, state: RunState | undefined): boolean {
  return Boolean(run.results) && state === 'done' && hasParticipantData(run, progress)
}

/** "Run from 15 Oct, 14:02" needs the stamp folder name as a date. */
export function runDate(id: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[-_T ]?(\d{2})?[:-]?(\d{2})?/.exec(id)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0))
  return Number.isFinite(d.getTime()) ? d.getTime() : null
}

// ---- the plan: what a run of this study would be -------------------------------------------------

export interface SimPlan {
  conditions: { id: string; label: string }[]
  /** The paper's analysed sample per condition, when the study document states it. */
  paperPerCondition: number | null
  /** What the tab proposes: the paper's size capped at 60, else 20. */
  defaultPerCondition: number
}
const inStudy = (ids: string[], studyId: string) => !ids.length || ids.includes(studyId)
export function simulationPlan(program: HumanProgram, studyId: string): SimPlan {
  const conditions = program.nodes.filter((n) => n.kind === 'condition' && inStudy(n.studyIds, studyId)).map((n) => ({ id: n.id, label: n.title }))
  const study = program.studies.find((s) => s.id === studyId)
  const index = program.studies.findIndex((s) => s.id === studyId)
  const fields = program.nodes.filter((n) => n.kind === 'participants' && inStudy(n.studyIds, studyId)).flatMap((n) => n.fields)
  const order = ['n-analysed', 'n-completed', 'sample', 'n-recruited']
  let total: number | null = null
  for (const id of order) {
    const f = fields.find((x) => x.id === id)
    if (!f || f.value == null) continue
    total = sampleFor(f.value, study?.title ?? '', index, program.studies.length)
    if (total) break
  }
  const k = Math.max(1, conditions.length)
  const paperPerCondition = total ? Math.max(1, Math.round(total / k)) : null
  return { conditions, paperPerCondition, defaultPerCondition: paperPerCondition ? Math.min(60, paperPerCondition) : 20 }
}

/** The sample size of one study from a field like "Experiment 1: 78; Experiment 2: 42" or {"Experiment 1": {"n": 78}}. */
export function sampleFor(value: unknown, title: string, index: number, studies: number): number | null {
  if (typeof value === 'number') return value > 0 ? value : null
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    const label = `${index + 1}`
    const hit = entries.find(([k]) => title && k.toLowerCase() === title.toLowerCase()) ?? entries.find(([k]) => new RegExp(`(^|\\D)${label}(\\D|$)`).test(k)) ?? (entries.length === 1 ? entries[0] : undefined)
    if (!hit) return null
    const v = hit[1]
    return sampleFor(v && typeof v === 'object' && 'n' in (v as object) ? (v as { n: unknown }).n : v, '', 0, 1)
  }
  if (typeof value !== 'string') return null
  const label = new RegExp(`(?:experiment|study|exp\\.?|实验|研究)\\s*${index + 1}\\D{0,12}?(\\d{1,6})`, 'i').exec(value)
  if (label) return Number(label[1])
  if (studies === 1) { const first = /(\d{1,6})/.exec(value); return first ? Number(first[1]) : null }
  return null
}

// ---- the estimate -------------------------------------------------------------------------------

/** USD per million tokens (input, output) of the hosted models; unknown models use the Haiku price as a floor. */
const PRICES: Record<string, [number, number]> = {
  'anthropic/claude-haiku-5.5': [0.1, 0.5],
  'anthropic/claude-sonnet-5.5': [2, 10],
  'deepseek/deepseek-v4.1-flash': [0.1, 0.4],
}
/** Measured on the Knobe sample with Haiku 5.5 (2026-10-15, two real runs; see the commit message). */
export const MEASURED = {
  /** Prompt and reply tokens of one AI participant (one vignette, two questions; reply incl. reasoning). */
  participantIn: 280,
  participantOut: 300,
  /** Seconds per participant with 8 calls in flight (about 3 s per call). */
  secondsPerParticipant: 0.4,
  /** The agent: run.py, trial, monitoring, report, results page, summary (input incl. re-reads; output incl. reasoning). */
  agentIn: 300_000,
  agentOut: 50_000,
  agentMinutes: 6,
  /** Building the runnable study package first, when it does not exist yet. */
  buildIn: 150_000,
  buildOut: 35_000,
  buildMinutes: 5,
}
export interface SimEstimate { participants: number; minutes: [number, number]; cost: [number, number] }
export function estimateRun(opts: { conditions: number; perCondition: number; model: string; needsBuild: boolean; callsPerParticipant?: number }): SimEstimate {
  const participants = Math.max(1, opts.conditions) * Math.max(1, opts.perCondition)
  const [pin, pout] = PRICES[opts.model] ?? PRICES['anthropic/claude-haiku-5.5']
  const calls = participants * (opts.callsPerParticipant ?? 1)
  const usd = (inTok: number, outTok: number) => (inTok * pin + outTok * pout) / 1e6
  const agent = usd(MEASURED.agentIn + (opts.needsBuild ? MEASURED.buildIn : 0), MEASURED.agentOut + (opts.needsBuild ? MEASURED.buildOut : 0))
  const people = usd(calls * MEASURED.participantIn, calls * MEASURED.participantOut)
  const mid = agent + people
  const minutes = MEASURED.agentMinutes + (opts.needsBuild ? MEASURED.buildMinutes : 0) + (calls * MEASURED.secondsPerParticipant) / 60
  return { participants, minutes: [Math.max(1, Math.round(minutes * 0.6)), Math.ceil(minutes * 1.8)], cost: [mid * 0.6, mid * 2] }
}

/** An honest range, never false precision: {under 0.05} | {about a} | {a – b}, dollars as text. */
export function costRange([lo, hi]: [number, number]): { kind: 'under' | 'about' | 'range'; a: string; b: string } {
  if (hi < 0.05) return { kind: 'under', a: '$0.05', b: '' }
  const f = (v: number) => (v < 1 ? `$${(Math.ceil(v * 20) / 20).toFixed(2)}` : `$${Math.ceil(v)}`)
  const a = f(lo), b = f(hi)
  return a === b ? { kind: 'about', a, b: '' } : { kind: 'range', a, b }
}
