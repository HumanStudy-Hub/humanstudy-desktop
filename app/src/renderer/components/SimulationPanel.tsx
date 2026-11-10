// The Simulation tab: AI participants go through the paper's procedure, and the result is compared
// with what the paper reports. One screen per state — not runnable yet, ready, running, finished —
// with the agent doing the work. The approval message (the researcher's confirmation) is unchanged:
// pressing "Run simulation" is the confirmation of exactly what this screen shows.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HumanProgram } from '../../shared/human-program'
import type { ProjectEntry, ProjectSnapshot } from '../../preload/types'
import { simulationScope, simulationLimits } from '../../shared/simulation-scope'
import { estimateRun, hasParticipantData, headline, isResult, parseProgress, parseSummary, runDate, runFolders, runState, simulationPlan, costRange, type SimProgress, type SimRunFiles, type SimStage, type SimSummary } from '../../shared/simulation-run'
import { packageStamp, readinessStamp, runConfirmation, type PackageProblem, type PackageReadiness } from '../../shared/package-readiness'
import { shortModelName } from './ModelPicker'
import { formatTokens, MAX_PER_CONDITION, protocolRunLimits, runLimits } from '../../shared/run-limits'
import { listenToArtifact } from '../bridge'
import { getLang, t } from '../i18n'
import { holdAction, track } from '../telemetry'
import { formatDuration } from '../format'

interface Props {
  project: ProjectSnapshot
  program: HumanProgram
  studyId: string
  studies: { id: string; title: string }[]
  onStudy(id: string): void
  /** The model selected in the app; AI participants use it too. */
  model: string
  agentBusy: boolean
  agentThreadId?: string
  agentTurnKey?: string | null
  /** What the agent is doing right now, in plain words (from the chat's activity line). */
  agentActivity?: string
  /** Model access (signed in, as App.tsx decides it): without it Run is disabled and says so. */
  canRun?: boolean
  /** route: which runnable form the approval names (protocol.json through the engine, or package/). */
  onRun(perCondition: number, route: 'protocol' | 'package', conditions: string[], tokenBudget?: number): Promise<void>
  onBuild(): void
  /** Stop the agent and ask these run folders (absolute paths) to stop. */
  /** Stop: write STOP into these run folders; `ownTurn` when the agent's current turn is this tab's request. */
  onStop(runs: string[], ownTurn: boolean): void
  onAsk(draft: string): void
  onOpenFile(path: string): void
}

const PENDING_KEY = (dir: string) => `hs.sim.pending:${dir}`
interface Pending { at: number; kind: 'run' | 'build'; owner: string; before: string | null; turn?: string }
const readPending = (dir: string): Pending | null => {
  try { const p = JSON.parse(sessionStorage.getItem(PENDING_KEY(dir)) || 'null'); return p && Number.isFinite(p.at) && ['build','run'].includes(p.kind) && typeof p.owner === 'string' && (p.before === null || typeof p.before === 'string') && (p.turn === undefined || typeof p.turn === 'string') ? p : null } catch { return null }
}
const writePending = (dir: string, p: Pending | null) => {
  try { if (p) sessionStorage.setItem(PENDING_KEY(dir), JSON.stringify(p)); else sessionStorage.removeItem(PENDING_KEY(dir)) } catch { /* no storage */ }
}
// When the researcher last pressed Stop. A run folder with no activity after it is stopped, even
// before its STOP file shows up in the tree or while a just-created folder still looks fresh.
const STOP_KEY = (dir: string) => `hs.sim.stopped:${dir}`
const readStopAt = (dir: string): number | null => {
  try { const v = Number(sessionStorage.getItem(STOP_KEY(dir))); return Number.isFinite(v) && v > 0 ? v : null } catch { return null }
}
const STOP_GRACE = 10_000

// A package can run only when its eight files are there and valid (shared/package-readiness, the same
// check the main process applies before it lets a run approval through). Rechecked when they change.
const allEntries = (es: ProjectEntry[]): ProjectEntry[] => es.flatMap((e) => [e, ...allEntries(e.children ?? [])])
const packageEntries = (tree: ProjectEntry[]): ProjectEntry[] => {
  const pkg = tree.find((e) => e.kind === 'dir' && e.rel === 'package')
  return pkg ? [pkg, ...allEntries(pkg.children ?? [])] : []
}
function usePackageReadiness(dir: string, tree: ProjectEntry[], studyId: string, program: HumanProgram): { slugs: string[]; readiness: PackageReadiness | null; checking: boolean } {
  const entries = useMemo(() => packageEntries(tree), [tree])
  const slugs = useMemo(() => entries.filter((e) => e.kind === 'dir' && /^package\/[^/]+$/.test(e.rel) && !e.name.startsWith('.') && e.name !== '__pycache__').map((e) => e.name), [entries])
  // The build checks also read sources/, effects.json and the paper, so a change there rechecks too.
  const inputs = useMemo(() => readinessStamp(allEntries(tree)), [tree])
  const stamp = JSON.stringify([dir, studyId, packageStamp(entries), inputs, program])
  const [checked, setChecked] = useState<{ stamp: string; readiness: PackageReadiness } | null>(null)
  useEffect(() => {
    let live = true
    void window.humanstudy.project.packageReadiness(dir, studyId).then((readiness) => {
      if (live) setChecked({ stamp, readiness })
    }).catch(() => { if (live) setChecked({ stamp, readiness: { exists: slugs.length > 0, ready: false, slug: null, problems: [] } }) })
    return () => { live = false }
  }, [dir, stamp, studyId]) // eslint-disable-line react-hooks/exhaustive-deps
  return { slugs, readiness: checked?.stamp === stamp ? checked.readiness : null, checking: checked?.stamp !== stamp }
}
const fileUrl = (tree: ProjectEntry[], path?: string): string | undefined => {
  if (!path) return undefined
  for (const e of tree) {
    if (e.path === path) return e.url
    if (e.children && path.startsWith(e.path + '/')) { const u = fileUrl(e.children, path); if (u) return u }
  }
  return undefined
}

const STEPS: SimStage[] = ['preparing', 'trial', 'running', 'scoring', 'writing']

export function SimulationPanel(props: Props) {
  const { project, program, studyId, studies, model, agentBusy, agentThreadId = '', agentTurnKey = null, canRun = true } = props
  const dir = project.dir
  const owner = `${dir}:${agentThreadId}`
  const plan = useMemo(() => simulationPlan(program, studyId), [program, studyId])
  const scope = useMemo(() => simulationScope(program, studyId), [program, studyId])
  const limits = useMemo(() => simulationLimits(program, studyId), [program, studyId])
  const { slugs, readiness, checking } = usePackageReadiness(dir, project.tree, studyId, program)
  // Two runnable forms, checked separately by the main process: protocol.json (the engine) wins when it passes.
  const route: 'protocol' | 'package' | null = readiness?.protocol?.ready ? 'protocol' : readiness?.ready ? 'package' : null
  const built = route !== null
  const hasProtocolFile = project.tree.some((e) => e.rel === 'protocol.json')
  const runConditions = route === 'protocol' ? readiness?.protocol?.arms ?? [] : plan.conditions
  // The program's section-12 scope gates a package run; a protocol run is gated by the protocol's own checks and
  // its measured budget (a protocol-only project has no section 12).
  const scopeReady = route === 'protocol' || scope.ready
  const confirmation = runConfirmation(readiness)
  const [perCondition, setPerCondition] = useState(plan.defaultPerCondition)
  useEffect(() => setPerCondition(plan.defaultPerCondition), [plan.defaultPerCondition])
  // A protocol run: one call per page for every member of every group (the measured budget), not the package's few calls.
  const budgetArms = route === 'protocol' ? Object.values(readiness?.protocol?.budget?.arms ?? {}) : []
  const members = budgetArms.reduce((n, a) => n + a.group_size, 0)
  const estimate = estimateRun({ conditions: members || runConditions.length || plan.conditions.length, perCondition, model, needsBuild: !built,
    ...(members ? { callsPerParticipant: Math.max(1, Math.round(budgetArms.reduce((n, a) => n + a.group_size * a.calls, 0) / members)) } : {}) })
  // The relay's cap and lifetime for this plan, computed exactly as the main process will (macOS wording).
  // A protocol run is sized from its measured budget (pages per participant, growing prompts, group size), the
  // same figure the main process recomputes; the approval carries it and is refused for any other number.
  const protocolLimits = route === 'protocol' ? protocolRunLimits(readiness?.protocol?.budget, perCondition) : null
  const access = protocolLimits ?? runLimits({ conditions: runConditions, perCondition })
  const accessVars = { tokens: formatTokens(access.tokens), minutes: access.minutes }

  // Run folders and the two small files each one writes while and after it runs.
  const runs = useMemo(() => runFolders(project.tree), [project.tree])
  const [texts, setTexts] = useState<Record<string, { progress: SimProgress | null; summary: SimSummary | null }>>({})
  const stamp = runs.map((r) => `${r.id}:${r.mtime}`).join('|') + getLang()
  useEffect(() => {
    let live = true
    void Promise.all(runs.map(async (r) => {
      const read = (p?: string) => (p ? window.humanstudy.project.readText(p).catch(() => null) : Promise.resolve(null))
      const [pr, su] = await Promise.all([read(r.progress), read(r.summary)])
      return [r.id, { progress: parseProgress(pr), summary: parseSummary(su, getLang()) }] as const
    })).then((rows) => { if (live) setTexts(Object.fromEntries(rows)) })
    return () => { live = false }
  }, [stamp]) // eslint-disable-line react-hooks/exhaustive-deps

  const [pending, setPendingState] = useState<Pending | null>(() => readPending(dir))
  useEffect(() => setPendingState(readPending(dir)), [dir])
  const setPending = (p: Pending | null) => { writePending(dir, p); setPendingState(p) }
  const [buildProblem, setBuildProblem] = useState(false)
  const [runProblem, setRunProblem] = useState(false)
  useEffect(() => { setBuildProblem(false); setRunProblem(false) }, [owner])
  const requestBusy = pending?.owner === owner && agentBusy && Boolean(agentTurnKey) && (pending.turn ? pending.turn === agentTurnKey : pending.before !== agentTurnKey)
  const [now, setNow] = useState(() => Date.now())
  const [stopAt, setStopAt] = useState<number | null>(() => readStopAt(dir))
  useEffect(() => setStopAt(readStopAt(dir)), [dir])
  const newRun = pending?.kind === 'run' ? runs.find((r) => r.mtime >= pending.at - 5_000 && !texts[r.id]?.summary?.example) : undefined
  // Only the chat turn that started this run speaks for it; any other chat activity (a question about
  // a report, an edit) says nothing about whether a simulation is running.
  const ownedRun = pending?.kind === 'run' && requestBusy
  const states = new Map(runs.map((r) => {
    const progress = texts[r.id]?.progress ?? null
    const st = runState(r, progress, now, r.mtime, ownedRun && r.id === newRun?.id)
    const startedAfterStop = stopAt !== null && pending?.kind === 'run' && pending.at > stopAt && r.id === newRun?.id
    const quietSinceStop = stopAt !== null && !startedAfterStop && (Math.max(progress?.updatedAt ?? 0, progress?.heartbeatAt ?? 0) || r.mtime) < stopAt + STOP_GRACE
    return [r.id, st === 'running' && quietSinceStop ? 'stopped' : st] as const
  }))
  const active = runs.find((r) => states.get(r.id) === 'running' && !texts[r.id]?.summary?.example && now - r.mtime < 6 * 3600_000)
  const running = Boolean(active) || (ownedRun && !newRun) || (pending?.kind === 'run' && newRun && states.get(newRun.id) === 'running')
  const building = pending?.kind === 'build' && requestBusy
  // Bind the request to its actual chat turn. A different conversation or later
  // question must never resurrect a project-level "building" flag.
  // Only a run that could start (signed in) can be missed; never point to a chat reply that cannot exist.
  const quietMiss = canRun && (runProblem || (pending?.kind === 'run' && !requestBusy && !newRun && now - pending.at > 8_000))
  useEffect(() => {
    if (!pending) return
    // Until the conversation is known again (reopening a project, signing in) it cannot own anything;
    // keep the request instead of discarding it as someone else's.
    if (!agentThreadId) return
    if (pending.owner !== owner) { setPending(null); setBuildProblem(false); return }
    if (!pending.turn && requestBusy && agentTurnKey) {
      setPending({ ...pending, turn: agentTurnKey }); return
    }
    const turnEnded = Boolean(pending.turn) && (!agentBusy || pending.turn !== agentTurnKey)
    const notStarted = !pending.turn && !requestBusy && now - pending.at > 8_000
    if (pending.kind === 'build' && (turnEnded || notStarted)) {
      // The package check is still reading the files the build just wrote: decide once it is done.
      if (checking && slugs.length > 0) return
      setBuildProblem(!built && (!pending.turn || pending.turn === agentTurnKey))
      setPending(null)
    }
    if (pending.kind === 'run' && quietMiss && !newRun) { setRunProblem(true); setPending(null) }
    if (pending.kind === 'run' && newRun && states.get(newRun.id) !== 'running') setPending(null)
  }) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (built) setBuildProblem(false) }, [built])
  useEffect(() => {
    // Keep the dispatch grace period ticking even when the agent hasn't started.
    if (!running && !building && (!pending || quietMiss)) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running, building, Boolean(pending), quietMiss])

  // Results are finished runs with participant data; an empty or aborted folder is never one.
  const finished = runs.filter((r) => isResult(r, texts[r.id]?.progress ?? null, states.get(r.id)))
  const listed = runs.filter((r) => states.get(r.id) === 'running' || hasParticipantData(r, texts[r.id]?.progress ?? null))
  const [shown, setShown] = useState<string | null>(null)
  const current = (shown && finished.find((r) => r.id === shown)) || (newRun && finished.includes(newRun) ? newRun : undefined) || finished.find((r) => !texts[r.id]?.summary?.example) || finished[0]
  const failedRun = newRun && states.get(newRun.id) === 'failed' ? newRun : undefined

  const viewed = useRef(false)
  useEffect(() => {
    if (viewed.current) return
    viewed.current = true
    track('simulation.view', { metadata: { built, ready: scope.ready, runs: runs.length, conditions: plan.conditions.length } })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setRunProblem(false); setNow(Date.now()); setPending({ at: Date.now(), kind: 'run', owner, before: agentTurnKey })
    setShown(null)
    track('simulation.run', { metadata: { perCondition, conditions: plan.conditions.length, model, built } })
    // The approval is checked before it is sent; the resulting agent turn belongs to this run operation.
    holdAction()
    try { await props.onRun(perCondition, route ?? 'package', route === 'protocol' ? readiness?.protocol?.arms ?? [] : plan.conditions.map((c) => c.id), protocolLimits?.tokens) } catch { setPending(null) }
  }
  const build = () => {
    setBuildProblem(false); setNow(Date.now()); setPending({ at: Date.now(), kind: 'build', owner, before: agentTurnKey })
    track('simulation.build', { metadata: { conditions: plan.conditions.length } })
    props.onBuild()
  }
  // Stop returns the tab to its idle, retryable state at once, also while the run is still being prepared.
  const stop = () => {
    track('simulation.stop', { metadata: { done: activeProgress?.done ?? 0, total: activeProgress?.total ?? 0 } })
    const at = Date.now()
    try { sessionStorage.setItem(STOP_KEY(dir), String(at)) } catch { /* no storage */ }
    setStopAt(at); setNow(at)
    // The chat turn is stopped only when it belongs to this run or build; a run going on in the
    // background while the agent answers something else stops through its STOP file alone.
    props.onStop([...new Set([activeRun?.path, newRun?.path].filter((p): p is string => Boolean(p) && !runs.find((r) => r.path === p)?.results))], Boolean(requestBusy || (pending?.owner === owner && !agentBusy)))
    setPending(null); setBuildProblem(false); setRunProblem(false)
  }
  const activeRun = active ?? (newRun && states.get(newRun.id) === 'running' ? newRun : undefined)
  // The newest run, when the researcher stopped it: one line says how far it got (no comparison is drawn).
  const newest = runs.find((r) => !texts[r.id]?.summary?.example)
  const latestStopped = newest && states.get(newest.id) === 'stopped' ? { done: texts[newest.id]?.progress?.done ?? 0, total: texts[newest.id]?.progress?.total ?? 0 } : null
  const activeProgress = activeRun ? texts[activeRun.id]?.progress ?? null : null
  const studyTitle = studies.find((s) => s.id === studyId)?.title ?? ''
  const modelName = shortModelName(model)

  const isExample = Boolean(current && texts[current.id]?.summary?.example)
  // Your own finished run comes first; the shipped example sits below the plan, and nothing old
  // distracts from a run in progress.
  const resultFirst = Boolean(current && !isExample && !running && !building)
  const result = current ? (
    <Result run={current} tree={project.tree} summary={texts[current.id]?.summary ?? null} progress={texts[current.id]?.progress ?? null}
      onOpen={() => { track('simulation.result_open', { metadata: { how: 'tab', example: isExample } }); props.onOpenFile(current.results!) }}
      onAsk={() => props.onAsk(t('sim.discuss_prompt', { run: current.rel }))} canAsk={canRun} />
  ) : null
  return (
    <div className="sim">
      <header className="sim-head">
        <h2>{t('sim.title')}</h2>
        <p>{t('sim.what')}</p>
      </header>

      {resultFirst && result}
      {latestStopped && !running && !building && (
        <p className="sim-stopped muted small" role="status">{latestStopped.total ? t('sim.stopped_line', { done: latestStopped.done, total: latestStopped.total }) : t('sim.stopped_line_none')}</p>
      )}
      {running ? (
        <Progress progress={activeProgress} startedAt={activeProgress?.startedAt ?? pending?.at ?? activeRun?.mtime ?? now} now={now} plan={plan} built={built} activity={requestBusy ? props.agentActivity : undefined} model={activeProgress?.model ?? model} onStop={stop} />
      ) : building ? (
        <section className="sim-card sim-live" aria-live="polite">
          <p className="sim-stage-now">{t('sim.building')}</p>
          <p className="muted small">{props.agentActivity || t('sim.building_hint')} · {formatDuration(now - (pending?.at ?? now))}</p>
          <button className="ghost small-btn sim-stop" onClick={stop}>{t('sim.stop')}</button>
        </section>
      ) : (
        <>
          {(failedRun || quietMiss || buildProblem) && (
            <section className="sim-card sim-problem" role="alert">
              <p>{failedRun ? t('sim.failed', { reason: texts[failedRun.id]?.progress?.message ?? t('sim.failed_unknown') }) : t(buildProblem ? 'sim.no_build' : 'sim.no_run')}</p>
              <button className="link" onClick={() => { setPending(null); setBuildProblem(false); setRunProblem(false); props.onAsk(failedRun ? t('sim.fix_prompt', { run: failedRun.rel }) : t(buildProblem ? 'sim.why_build_prompt' : 'sim.why_prompt')) }}>{t('sim.ask_fix')}</button>
            </section>
          )}
          {(slugs.length > 0 || readiness?.protocol) && !built ? (
            <section className="sim-card" aria-live="polite">
              {readiness ? (() => {
                // A project with protocol.json shows the protocol's problems (the route new studies take).
                const problems = readiness.protocol ? readiness.protocol.problems : readiness.problems
                const what = readiness.protocol ? 'protocol.json' : `package/${readiness.slug}`
                // A published study whose screens still lack their original wording: it previews, but cannot run yet.
                // A published study that cannot run as it stands (its held list was changed, or it fails its checks
                // with the wording filled in): its own heading and button, not "fill in the wording".
                const stuck = problems.filter((p) => p.kind === 'scientific' && (p.text?.need === 'held-changed' || p.text?.need === 'checks-failed'))
                const wording = problems.filter((p) => p.kind === 'scientific' && p.text && !stuck.includes(p))
                const rest = problems.filter((p) => !(p.kind === 'scientific' && p.text))
                return (<>
                  {stuck.length > 0 && <>
                    <p>{t('sim.text_blocked')}</p>
                    <ul className="sim-missing">{stuck.map((p) => <li key={problemText(p)}>{problemText(p)}</li>)}</ul>
                  </>}
                  {wording.length > 0 && <>
                    <p>{t('sim.text_needed')}</p>
                    <ul className="sim-missing">{wording.map((p) => <li key={problemText(p)}>{problemText(p)}</li>)}</ul>
                  </>}
                  {rest.length > 0 && <>
                    <p>{t('sim.incomplete')}</p>
                    <ul className="sim-missing">{rest.map((p) => <li key={p.kind === 'scientific' ? `${p.check}:${p.reason}` : `${p.file}:${p.kind}`}>{problemText(p)}</li>)}</ul>
                  </>}
                  <button className="link" onClick={() => props.onAsk(rest.length
                    ? t('sim.complete_prompt', { pkg: what, what: problems.map(problemText).join(t('sim.list_sep')) })
                    : stuck.length ? t('sim.text_blocked_prompt', { what: stuck.map(problemText).join(t('sim.list_sep')) })
                    : t('sim.text_prompt', { what: wording.map(problemText).join(t('sim.list_sep')) }))}>{t(rest.length ? 'sim.ask_complete' : stuck.length ? 'sim.ask_text_blocked' : 'sim.ask_text')}</button>
                </>)
              })() : <p className="muted small">{t('sim.checking')}</p>}
            </section>
          ) : !built && hasProtocolFile ? (
            // A protocol project whose checks have not answered yet (the app or the assistant is still starting):
            // never offer "Build the study first" for a study that is already runnable.
            <section className="sim-card" aria-live="polite"><p className="muted small">{t('sim.checking')}</p></section>
          ) : !built ? (
            <section className="sim-card">
              <p>{t('sim.not_built')}</p>
              <div className="sim-actions">
                <button className="primary" onClick={build} disabled={agentBusy}>{t('sim.build')}</button>
                <span className="muted small">{t('sim.build_time')}</span>
              </div>
            </section>
          ) : (
            <section className="sim-card" aria-label={t('sim.will_run')}>
              <h3>{resultFirst ? t('sim.run_again') : t('sim.will_run')}</h3>
              <dl className="sim-plan">
                {studies.length > 1 && (<>
                  <dt>{t('sim.study')}</dt>
                  <dd><select value={studyId} onChange={(e) => props.onStudy(e.target.value)}>{studies.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}</select></dd>
                </>)}
                {studies.length <= 1 && studyTitle && (<><dt>{t('sim.study')}</dt><dd>{studyTitle}</dd></>)}
                <dt>{t('sim.conditions')}</dt>
                <dd>{route === 'protocol' ? (runConditions as string[]).join(t('sim.list_sep')) || t('sim.one_group') : plan.conditions.length ? plan.conditions.map((c) => c.label).join(t('sim.list_sep')) : t('sim.one_group')}</dd>
                <dt>{t('sim.participants')}</dt>
                <dd>
                  <select aria-label={t('sim.participants')} value={perCondition} onChange={(e) => setPerCondition(Number(e.target.value))}>
                    {[...new Set([5, 10, 20, plan.defaultPerCondition, 40, 60].filter((n) => n <= MAX_PER_CONDITION))].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>{' '}
                  {t(runConditions.length > 1 ? 'sim.per_condition' : 'sim.in_total_one', { total: estimate.participants })}
                  {plan.paperPerCondition && <span className="muted small"> · {plan.paperPerCondition === perCondition ? t('sim.same_as_paper') : t('sim.paper_had', { n: plan.paperPerCondition })}</span>}
                </dd>
                <dt>{t('sim.model')}</dt>
                <dd>{modelName}</dd>
                {protocolLimits && (<>
                  <dt>{t('sim.budget')}</dt>
                  <dd>{protocolLimits.fits ? t(readiness?.modelAccess === 'relay' ? 'sim.budget_value' : 'sim.budget_estimate', { minutes: protocolLimits.minutes }) : t('sim.budget_too_large')}</dd>
                </>)}
                <dt>{t('sim.estimate')}</dt>
                <dd>{t('sim.estimate_value', { lo: estimate.minutes[0], hi: estimate.minutes[1], cost: costText(estimate.cost) })}</dd>
              </dl>
              {(limits.text.length > 0 || limits.decisions.length > 0) && (
                <div className="sim-limits">
                  <h3>{t('sim.cannot')}</h3>
                  <ul>
                    {limits.text.map((x, i) => <li key={`l${i}`}>{x}</li>)}
                    {limits.decisions.map((d) => <li key={d.id}>{d.title}<span className="muted"> — {t('sim.decision_default')}</span></li>)}
                  </ul>
                </div>
              )}
              {!scopeReady && <p className="sim-blocked">{t('sim.blocked', { what: [...scope.missing.map((m) => t(`sim.need.${m}`)), ...scope.blocking.map((b) => b.title)].join(t('sim.list_sep')) })}</p>}
              {confirmation.notice && <p className="sim-note">{t(confirmation.notice, accessVars)}</p>}
              <div className="sim-actions">
                <button className="primary" disabled={!canRun || !scopeReady || agentBusy || protocolLimits?.fits === false} title={agentBusy ? t('sim.agent_busy') : undefined} onClick={() => void run()}>{t('sim.run')}</button>
                <button className="ghost" disabled={!canRun} title={canRun ? undefined : t('sim.sign_in_to_run')} onClick={() => props.onAsk(scopeReady ? t('sim.ask_prompt', { study: studyTitle }) : t('sim.resolve_prompt', { study: studyTitle }))}>{t('sim.ask')}</button>
              </div>
              {!canRun && <p className="sim-note">{t('sim.sign_in_to_run')}</p>}
              <p className="muted small sim-note">{t(confirmation.note, accessVars)}</p>
              {confirmation.detail && (
                <details className="muted small sim-detail">
                  <summary>{t('sim.details')}</summary>
                  <p>{t(confirmation.detail, accessVars)}</p>
                </details>
              )}
            </section>
          )}
        </>
      )}

      {!resultFirst && !running && !building && result}
      {listed.length > 1 && (
        <section className="sim-history">
          <h3>{t('sim.earlier')}</h3>
          <ul>
            {listed.map((r) => {
              const s = texts[r.id]?.summary, p = texts[r.id]?.progress, st = states.get(r.id)
              const when = runDate(r.id) ?? r.mtime
              return (
                <li key={r.id}>
                  <button className={`sim-run-row${current?.id === r.id ? ' on' : ''}`} disabled={!finished.includes(r)} onClick={() => { setShown(r.id); track('simulation.result_open', { metadata: { how: 'history', example: Boolean(s?.example) } }) }}>
                    <span>{new Date(when).toLocaleString(getLang(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}{s?.example ? ` · ${t('sim.example')}` : ''}</span>
                    <span className="muted">{shortModelName(s?.model ?? p?.model ?? '') || '—'}</span>
                    <span className="muted">{s?.perCondition ? t('sim.n_each', { n: s.perCondition }) : p?.total ? t('sim.n_total', { n: p.total }) : ''}</span>
                    <span className={`sim-outcome o-${st === 'done' ? (s ? headline(s) : 'unknown') : st}`}>{st === 'done' ? (s ? t(`sim.outcome.${headline(s)}`, { k: s.facts?.same ?? 0, n: s.facts?.compared ?? 0 }) : t('sim.state.done')) : t(`sim.state.${st}`)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}
    </div>
  )
}

function problemText(p: PackageProblem): string {
  if (p.kind === 'scientific' && p.text) {
    const { need, title, format, screens } = p.text
    const known = t(`sim.text_format.${format}`) !== `sim.text_format.${format}`
    const vars = { title, format: t(known ? `sim.text_format.${format}` : 'sim.text_format.unknown'),
      screens: screens === 1 ? t('sim.text_one_screen') : t('sim.text_screens', { n: screens }) }
    return t(`sim.text_need.${need}`, vars)
  }
  if (p.kind === 'scientific') return `${p.check}: ${p.reason}`
  const vars = { what: t(`sim.pkg.${p.file}`), file: p.file }
  if (p.kind === 'unvalidated') return t('sim.pkg_unvalidated', vars)
  if (p.kind === 'wrong-study' || p.kind === 'stale-program' || p.kind === 'bindings') return t('sim.pkg_stale', vars)
  return p.kind === 'missing' ? t('sim.pkg_missing', vars) : p.kind === 'invalid-json' ? t('sim.pkg_invalid', vars) : t('sim.pkg_no_entry', { ...vars, entry: p.kind === 'no-entry' ? p.entry : '' })
}

function costText(range: [number, number]): string {
  const c = costRange(range)
  return c.kind === 'under' ? t('sim.cost_under', { a: c.a }) : c.kind === 'about' ? t('sim.cost_about', { a: c.a }) : t('sim.cost_range', { a: c.a, b: c.b })
}

function Progress({ progress, startedAt, now, plan, built, activity, model, onStop }: {
  progress: SimProgress | null; startedAt: number; now: number; plan: ReturnType<typeof simulationPlan>; built: boolean; activity?: string; model: string; onStop(): void
}) {
  const stage: SimStage = progress?.stage ?? 'preparing'
  const total = progress?.total ?? 0
  const done = progress?.done ?? 0
  const at = STEPS.indexOf(stage === 'done' ? 'writing' : stage)
  // One mark per AI participant, grouped by condition: the run made visible as people, not a percentage.
  const groups = progress?.conditions.length ? progress.conditions : total ? [{ id: '', done, total }] : []
  const label = (id: string) => plan.conditions.find((c) => c.id === id || c.label.toLowerCase() === id.toLowerCase() || c.id.endsWith(`-${id}`))?.label ?? id
  return (
    <section className="sim-card sim-live" aria-live="polite">
      <div className="sim-live-top">
        <p className="sim-stage-now">{stage === 'preparing' && !built ? t('sim.stage.building') : t(`sim.stage.${stage}`)}</p>
        <span className="muted small">{t('sim.elapsed', { time: formatDuration(now - startedAt) })}</span>
        <button className="ghost small-btn sim-stop" onClick={onStop}>{t('sim.stop')}</button>
      </div>
      <ol className="sim-steps">
        {STEPS.map((s, i) => <li key={s} className={i < at ? 'past' : i === at ? 'now' : ''}>{t(`sim.step.${s}`)}</li>)}
      </ol>
      {total > 0 ? (
        <>
          <p className="sim-count"><strong>{t('sim.count', { done, total })}</strong>{progress?.failed ? <span className="muted small"> · {t('sim.unusable', { n: progress.failed })}</span> : null}</p>
          <div className="sim-people">
            {groups.map((g) => (
              <div key={g.id || 'all'} className="sim-group">
                {g.id && <span className="small">{label(g.id)} <span className="muted">{g.done}/{g.total}</span></span>}
                <div className="sim-dots" role="img" aria-label={t('sim.count', { done: g.done, total: g.total })}>
                  {Array.from({ length: Math.min(g.total, 120) }, (_, i) => <i key={i} className={i < g.done ? 'on' : ''} />)}
                </div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="muted small">{t(stage === 'trial' ? 'sim.trial_hint' : 'sim.preparing_hint')}</p>
      )}
      <p className="muted small sim-activity">{progress?.message ?? activity ?? ''}{progress?.message || activity ? ' · ' : ''}{shortModelName(model)}</p>
    </section>
  )
}

function Result({ run, tree, summary, progress, onOpen, onAsk, canAsk = true }: { run: SimRunFiles; tree: ProjectEntry[]; summary: SimSummary | null; progress: SimProgress | null; onOpen(): void; onAsk(): void; canAsk?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null)
  useEffect(() => listenToArtifact(() => frame.current), [])
  const url = fileUrl(tree, run.results)
  const when = runDate(run.id) ?? run.mtime
  const model = shortModelName(summary?.model ?? progress?.model ?? '')
  const n = summary?.perCondition ? t('sim.n_each', { n: summary.perCondition }) : progress?.total ? t('sim.n_total', { n: progress.total }) : ''
  return (
    <section className="sim-result">
      <div className="sim-result-head">
        <h3>{summary?.example ? t('sim.example_title') : t('sim.result_title')}</h3>
        <span className="muted small">{[new Date(when).toLocaleDateString(getLang(), { month: 'short', day: 'numeric', year: 'numeric' }), model, n].filter(Boolean).join(t('sim.list_sep'))}</span>
      </div>
      {summary?.example && <p className="sim-example-note">{t('sim.example_note')}</p>}
      {summary ? (
        <div className={`sim-summary o-${headline(summary)}`}>
          <p className="sim-verdict">{t(`sim.outcome.${headline(summary)}`, { k: summary.facts?.same ?? 0, n: summary.facts?.compared ?? 0 })}</p>
          <p>{summary.facts ? factsParagraph(summary.facts) : summary.paragraph}</p>
        </div>
      ) : (
        <p className="muted small">{t('sim.no_summary')}</p>
      )}
      {url && <iframe ref={frame} key={url} className="sim-frame" src={url} sandbox="allow-scripts" title={t('sim.result_title')} />}
      <div className="sim-actions">
        <button className="ghost small-btn" onClick={onOpen}>{t('sim.open_tab')}</button>
        <button className="ghost small-btn" disabled={!canAsk} title={canAsk ? undefined : t('sim.sign_in_to_run')} onClick={onAsk}>{t('sim.discuss')}</button>
      </div>
    </section>
  )
}

/** A protocol run's paragraph in the app's language, from its structured summary (never the page's English). */
export function factsParagraph(f: NonNullable<SimSummary['facts']>): string {
  return [
    t('sim.p.finished', { done: f.done, planned: f.planned }),
    f.partial ? t('sim.p.partial') : '',
    f.partial ? t(f.tokenCap ? 'sim.p.why_cap' : f.failedCalls ? 'sim.p.why_calls' : 'sim.p.why_unfinished', { n: f.failedCalls }) : '',
    f.partial ? t('sim.p.run_again') : '',
    f.compared ? t('sim.p.directions', { same: f.same, compared: f.compared }) : t('sim.p.no_directions'),
    f.partial ? '' : f.official ? t('sim.p.official') : t('sim.p.unofficial'),
    f.unverified ? t('sim.p.unverified') : '',
    t('sim.p.caveat'),
  ].filter(Boolean).join(getLang() === 'zh-CN' ? '' : ' ')   // Chinese sentences run on without spaces
}
