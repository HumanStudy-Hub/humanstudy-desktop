// The right pane: Study (the 12-section document) and Paper, plus any file the researcher or the agent
// opens as another tab, like an artifact panel. A Files sidebar (hidden by default, ⌘B) lists the folder.
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import StudyModel, { viewStudies, type QuoteStatus, type StudyModelProps } from '../program/StudyModel'
import { readHumanProgram, type HumanProgram } from '../../shared/human-program'
import { patchProgramField } from '../../shared/program-patch'
import type { ProjectEntry, ProjectSnapshot, WorkspaceContext } from '../../preload/types'
import { lap, track } from '../telemetry'
import { FileView } from './FileView'
import { Explorer, flatten } from './Explorer'
import { SourceDrawer, type PassageSelection, type SourceRef } from './SourceDrawer'
import { t } from '../i18n'
import { sourceTarget } from '../../shared/source-target'
import { simulationScope } from '../../shared/simulation-scope'
import { simulationPlan } from '../../shared/simulation-run'
import { SimulationPanel } from './SimulationPanel'
import { sourceFocus } from '../../shared/workspace-context'
import { supportedBy } from '../../shared/program-view'
import { quoteKey } from '../../shared/source-anchor'
import { clearDraft, draftsIn } from '../drafts'

export type MainTab = 'study' | 'paper' | 'simulation'
type TabId = MainTab | `file:${string}`
interface Layout {
  /** Open file tabs, as `file:<path>`. */
  tabs: `file:${string}`[]
  active: TabId
  files: boolean
  compare?: boolean
  ratio?: number
  study?: string
}
const DEFAULT: Layout = { tabs: [], active: 'study', files: false }
const DEFAULT_SOURCE: SourceRef = { page: 1 }

export interface WorkbenchHandle {
  showTab(tab: MainTab): void
  /** Open a project file in a tab by its absolute path. */
  openFile(path: string): void
  toggleFiles(): void
  getContext(): WorkspaceSnapshot
}

export interface WorkspaceSnapshot { projectDir: string; context: WorkspaceContext }

/** The researcher's confirmation, sent as the agent message: the program's hash at the moment of the
 *  click, the study, the five section-12 fields and the plan the Simulation tab showed. */
async function approveSimulation(dir: string, program: HumanProgram, studyId: string, request: string, plan: { perCondition: number; model: string }): Promise<string> {
  const scope = simulationScope(program, studyId)
  const raw = await window.humanstudy.project.readText(`${dir}/program.json`)
  if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(program)) throw new Error(t('simulation.changed'))
  const bytes = new TextEncoder().encode(raw)
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
  const conditions = simulationPlan(program, studyId).conditions.map(c => c.id)
  return `[Simulation scope approved]\n${JSON.stringify({ programId: program.id, programHash: hash, hashFormat: 'program.json UTF-8 file bytes', studyId, scope: scope.fields, plan: { perCondition: plan.perCondition, conditions, model: plan.model } })}\n${request}`
}

interface Props extends Pick<StudyModelProps, 'selectedIds' | 'onPick' | 'onSource' | 'onAsk' | 'onPrefill'> {
  ref?: Ref<WorkbenchHandle>
  project: ProjectSnapshot
  source: SourceRef | null
  onClearSelection(): void
  /** Focus the composer with the current selection attached. */
  onAskSelection(): void
  /** Send the agent a message about a program.json that needs fixing. */
  onFixProgram?(text: string): void
  onFold(): void
  onRunSimulation?(approval: string): void
  /** Send the agent a message right away (the Simulation tab's "Build the study first"). */
  onSendAgent?(text: string): void
  onStopAgent?(): void
  /** The model selected in the app, whether the agent is working, and what it is doing. */
  model?: string
  agentBusy?: boolean
  agentThreadId?: string
  agentTurnKey?: string | null
  agentActivity?: string
  onWorkspaceChange?(snapshot: WorkspaceSnapshot): void
}

const key = (dir: string) => `hs.wb2:${dir}`
function loadLayout(dir: string): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(key(dir)) || 'null')
    if (raw && typeof raw === 'object')
      return {
        tabs: Array.isArray(raw.tabs) ? raw.tabs.filter((x: unknown) => typeof x === 'string' && x.startsWith('file:')) : [],
        active: typeof raw.active === 'string' ? raw.active : 'study',
        files: Boolean(raw.files),
        compare: Boolean(raw.compare),
        ratio: typeof raw.ratio === 'number' ? Math.min(75, Math.max(25, raw.ratio)) : 50,
        study: typeof raw.study === 'string' ? raw.study : undefined,
      }
  } catch {
    /* ignore */
  }
  return DEFAULT
}

export function Workbench({ ref, project, source, onClearSelection, onAskSelection, onFixProgram, onFold, onRunSimulation, onSendAgent, onStopAgent, model = '', agentBusy = false, agentThreadId, agentTurnKey, agentActivity, onWorkspaceChange, ...docProps }: Props) {
  // Tolerant: one slip by the agent sets that detail aside and the document still renders.
  const { program, error, problems } = useMemo(() => {
    if (!project.program) return { program: null, error: project.programError, problems: [] as string[] }
    try {
      return { ...readHumanProgram(project.program), error: undefined }
    } catch (e) {
      return { program: null, error: t('study.invalid', { error: String(e) }), problems: [] as string[] }
    }
  }, [project.program, project.programError])
  const fixProgram = () => onFixProgram?.(fixProgramMessage(problems, error))
  const studies = useMemo(() => (program ? viewStudies(program) : []), [program])
  const files = useMemo(() => flatten(project.tree), [project.tree])
  const fileByPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])

  const [layout, setLayout] = useState<Layout>(() => loadLayout(project.dir))
  const [dirty, setDirty] = useState<Set<string>>(() => new Set(draftsIn(project.dir).map((d) => d.path)))
  const [editError, setEditError] = useState('')
  const [changed, setChanged] = useState<Set<string>>(() => new Set())
  const [paperSeen, setPaperSeen] = useState(false)
  const sourceFile = source ? sourceTarget(project, source) : project.pdf
  const sourcePdf = sourceFile?.ext === 'pdf' && sourceFile.url ? sourceFile as import('../../preload/types').ProjectFile : null
  const [sourcePage, setSourcePage] = useState<{ path: string; page: number } | null>(null)
  // What the paper found for each citation it opened, and the passage the reader selected there.
  const [quoteStatus, setQuoteStatus] = useState<ReadonlyMap<string, QuoteStatus>>(() => new Map())
  const [passage, setPassage] = useState<PassageSelection | null>(null)
  const support = useMemo(() => passage && program ? { page: passage.page, ids: supportedBy(program, passage) } : null, [passage, program])

  // Project switch: restore its tabs.
  useEffect(() => {
    setLayout(loadLayout(project.dir))
    setDirty(new Set(draftsIn(project.dir).map((d) => d.path)))
    setChanged(new Set())
    setEditError('')
    setQuoteStatus(new Map())
    setPassage(null)
  }, [project.dir])

  const update = useCallback(
    (fn: (l: Layout) => Layout) =>
      setLayout((prev) => {
        const next = fn(prev)
        try {
          localStorage.setItem(key(project.dir), JSON.stringify(next))
        } catch {
          /* ignore */
        }
        return next
      }),
    [project.dir],
  )

  // Keep the tabs honest: a file tab needs its file.
  useEffect(() => {
    update((l) => {
      const tabs = l.tabs.filter((tb) => fileByPath.has(tb.slice(5)) || dirty.has(tb.slice(5)))
      const active = l.active.startsWith('file:') && !tabs.includes(l.active as `file:${string}`) ? 'study' : l.active
      if (tabs.length === l.tabs.length && active === l.active) return l
      return { ...l, tabs, active }
    })
  }, [fileByPath, dirty, update])

  // Tab dwell.
  const prevTab = useRef<TabId | null>(null)
  useEffect(() => {
    const was = prevTab.current
    const now = layout.active
    if (was === now) return
    const dwell = lap('tab')
    track('tab.switch', {
      target: tabKind(now, fileByPath),
      durationMs: was ? dwell : undefined,
      metadata: { from: was ? tabKind(was, fileByPath) : null },
    })
    prevTab.current = now
  }, [layout.active, fileByPath])
  useEffect(() => {
    if (layout.active === 'paper' || layout.compare) setPaperSeen(true)
  }, [layout.active, layout.compare])

  const activate = (id: TabId) => update((l) => (l.active === id ? l : { ...l, active: id }))
  const open = (id: `file:${string}`) => {
    track('tab.open', { target: `file.${fileByPath.get(id.slice(5))?.ext ?? ''}` })
    update((l) => ({ ...l, tabs: l.tabs.includes(id) ? l.tabs : [...l.tabs, id], active: id }))
  }
  const toggleFiles = useCallback(() => {
    update((l) => {
      track('files.toggle', { metadata: { open: !l.files }, durationMs: lap('files') })
      return { ...l, files: !l.files }
    })
  }, [update])
  useImperativeHandle(ref, () => ({
    showTab: (tab) => activate(tab),
    openFile(path) {
      if (fileByPath.has(path)) open(`file:${path}`)
    },
    toggleFiles,
    getContext: () => workspaceSnapshot,
  }))
  const close = (id: `file:${string}`) => {
    track('tab.close', { target: tabKind(id, fileByPath), metadata: { dirty: dirty.has(id.slice(5)) } })
    if (dirty.has(id.slice(5)) && !window.confirm(t('wb.discard'))) return
    clearDraft(id.slice(5))
    setDirty((d) => {
      if (!d.has(id.slice(5))) return d
      const n = new Set(d)
      n.delete(id.slice(5))
      return n
    })
    update((l) => {
      const tabs = l.tabs.filter((x) => x !== id)
      const at = l.tabs.indexOf(id)
      const active = l.active === id ? (tabs[Math.min(at, tabs.length - 1)] ?? 'study') : l.active
      return { ...l, tabs, active }
    })
  }
  const markDirty = useCallback((path: string, isDirty: boolean) => {
    setDirty((d) => {
      if (d.has(path) === isDirty) return d
      const n = new Set(d)
      if (isDirty) n.add(path)
      else n.delete(path)
      return n
    })
  }, [])

  const openEntry = (e: ProjectEntry) => {
    if (e.kind === 'dir') return
    if (e.ext === 'pdf' && e.rel === 'paper.pdf') {
      docProps.onSource(`file:${e.rel}`, { page: 1, quote: '', verified: true })
      activate('paper')
      return
    }
    track('file.open', { target: e.rel, metadata: { ext: e.ext, size: e.size ?? null } })
    open(`file:${e.path}`)
  }
  // Human edit of a study field: the researcher's decision, patched into program.json as it is on disk.
  // Only that field's bytes change; entries the tolerant reader set aside are never rewritten.
  const onEdit = async (id: string, fieldId: string, text: string): Promise<boolean> => {
    if (!program) return false
    const path = `${project.dir}/program.json`
    try {
      const raw = await window.humanstudy.project.readText(path)
      let next: string
      try {
        next = patchProgramField(raw, { id, fieldId, value: text })
      } catch (e) {
        if (/is not in program\.json$/.test(e instanceof Error ? e.message : '')) throw new Error(t('study.field_missing', { id, field: fieldId }))
        throw e
      }
      await window.humanstudy.project.writeText(path, next)
      setEditError('')
      setChanged((c) => new Set(c).add(id))
      track('program.edited', { target: id, metadata: { field: fieldId } })
      return true
    } catch (e) {
      setEditError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '') : String(e))
      return false
    }
  }

  const compare = Boolean(layout.compare && layout.active === 'study')
  const editors = useRef<HTMLDivElement>(null)
  const ratio = layout.ratio ?? 50
  const active = layout.active
  const activeFile = active.startsWith('file:') ? (fileByPath.get(active.slice(5)) ?? null) : null
  const studyId = studies.find((s) => s.id === layout.study)?.id ?? studies[0]?.id ?? ''
  const workspaceSnapshot = useMemo<WorkspaceSnapshot>(() => {
    const st = studies.find(s => s.id === studyId)
    return { projectDir: project.dir, context: {
      project: project.name,
      programId: program?.id,
      ...(st ? { study: { id: st.id, title: st.title, type: st.type } } : {}),
      activeTab: active.startsWith('file:') ? 'file' : active as MainTab,
      visibleViews: compare ? ['study', 'paper'] : [active.startsWith('file:') ? 'file' : active],
      openTabs: ['study', 'paper', ...(program ? ['simulation'] : []), ...layout.tabs.map(tab => fileByPath.get(tab.slice(5))?.rel).filter((p): p is string => Boolean(p))],
      ...(activeFile ? { file: { path: activeFile.rel, ext: activeFile.ext, unsaved: dirty.has(activeFile.path) } } : {}),
      ...(active === 'paper' || compare ? { source: sourceFocus(sourceFile, source, sourcePage) } : {}),
    } }
  }, [project.dir, project.name, program?.id, studies, studyId, active, activeFile, layout.tabs, fileByPath, dirty, source, sourceFile, sourcePage, compare])
  useEffect(() => { onWorkspaceChange?.(workspaceSnapshot) }, [workspaceSnapshot, onWorkspaceChange])
  const label = (tb: `file:${string}`) => tb.split(/[\\/]/).pop()!
  const tabBtn = (id: MainTab, text: string) => (
    <div role="tab" aria-selected={active === id} className={`wb-tab main ${active === id ? 'active' : ''}`}>
      <button className="wb-tab-label" onClick={() => {
        if (id === 'paper' && (source?.file || source?.sourceId) && sourceFile?.path !== project.pdf?.path) docProps.onSource('file:paper.pdf', { page: 1, quote: '', verified: true })
        activate(id)
      }}>

        {text}
      </button>
    </div>
  )

  return (
    <section className="wb">
      <nav className="wb-tabs" aria-label={t('wb.tabs_aria')}>
        <button className={`wb-explorer-toggle ${layout.files ? 'on' : ''}`} aria-pressed={layout.files} aria-label={t('wb.files')} title={t('wb.files_hint')} onClick={toggleFiles}>
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
            <path d="M2 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="wb-tablist" role="tablist">
          {tabBtn('study', t('wb.study'))}
          {tabBtn('paper', t('wb.paper'))}
          {program && tabBtn('simulation', t('sec.simulation'))}
          {layout.tabs.map((tb) => {
            const isDirty = dirty.has(tb.slice(5))
            return (
              <div key={tb} role="tab" aria-selected={active === tb} className={`wb-tab ${active === tb ? 'active' : ''}`} title={tb.slice(5)}>
                <button className="wb-tab-label" onClick={() => activate(tb)} onAuxClick={(e) => e.button === 1 && close(tb)}>
                  {label(tb)}
                </button>
                {isDirty ? (
                  <button className="wb-tab-close dirty" aria-label={t('wb.unsaved_close')} onClick={() => close(tb)}>
                    ●
                  </button>
                ) : (
                  <button className="wb-tab-close" aria-label={t('wb.close_named', { name: label(tb) })} onClick={() => close(tb)}>
                    ×
                  </button>
                )}
              </div>
            )
          })}
        </div>
        <button className="wb-compare" aria-pressed={compare} disabled={!program} onClick={() => {
          track('source.compare', { metadata: { open: !compare } })
          update(l => ({ ...l, active: 'study', compare: !compare }))
        }}>{t('wb.compare')}</button>
        <button className="ghost fold" aria-label={t('wb.fold')} title={t('wb.fold')} onClick={onFold}>
          ‹
        </button>
      </nav>
      <div className="wb-body">
        {layout.files && <Explorer tree={project.tree} name={project.name} activePath={activeFile?.path ?? null} dirty={dirty} onOpen={openEntry} />}
        <div className={`wb-editors${compare ? " comparing" : ""}`} ref={editors}>
        <div className="wb-content" hidden={active === "paper"} style={compare ? { flex: `0 0 ${ratio}%` } : undefined}>
          {active === 'simulation' && program && (
            <SimulationPanel
              project={project}
              program={program}
              studyId={studyId}
              studies={studies.map(st => ({ id: st.id, title: st.title }))}
              onStudy={(id) => update((l) => ({ ...l, study: id }))}
              model={model}
              agentBusy={agentBusy}
              agentThreadId={agentThreadId}
              agentTurnKey={agentTurnKey}
              agentActivity={agentActivity}
              onRun={async (perCondition) => {
                const study = studies.find(st => st.id === studyId)?.title ?? studyId
                const request = t('sim.request', { study, n: perCondition, model: model || 'selected in the app' })
                try {
                  onRunSimulation?.(await approveSimulation(project.dir, program, studyId, request, { perCondition, model }))
                } catch (e) {
                  setEditError(e instanceof Error ? e.message : String(e))
                  throw e
                }
              }}
              onBuild={() => onSendAgent?.(t('sim.build_prompt'))}
              onStop={(runs) => {
                onStopAgent?.()
                // The run itself is a background process; simkit ends it after the participants in flight.
                const live = runs.length ? runs : [project.tree.length ? findRunning(project.tree) : null].filter((p): p is string => Boolean(p))
                for (const dir of live) void window.humanstudy.project.writeText(`${dir}/STOP`, 'Stopped by the researcher\n').catch(() => undefined)
              }}
              onAsk={(draft) => docProps.onPrefill?.(draft)}
              onOpenFile={(path) => { const e = fileByPath.get(path); if (e) openEntry(e) }}
            />
          )}
          {active === 'simulation' && program && editError && <div className="part error edit-error">{editError}</div>}
          {active === 'study' &&
            (program ? (
              <>
                <StudyView
                  view="study"
                  program={program}
                  studyId={studyId}
                  onStudy={(id) => update((l) => ({ ...l, study: id }))}
                  support={compare ? support : null}
                  onClearSupport={() => { window.getSelection()?.removeAllRanges(); setPassage(null) }}
                  quoteStatus={quoteStatus}
                  onClearSelection={onClearSelection}
                  onAskSelection={onAskSelection}
                  editError={editError}
                  problems={problems}
                  onFix={fixProgram}
                  changedIds={changed}
                  onEdit={onEdit}
                  {...docProps}
                  onSource={(id, ref) => {
                    docProps.onSource(id, ref)
                    update(l => ({ ...l, active: 'study', compare: true }))
                  }}
                />
              </>
            ) : (
              <Empty title={error ? t('study.unreadable') : t('study.empty_title')} body={error ?? t('study.empty_body')}>
                {error && onFixProgram && <button className="link" onClick={fixProgram}>{t('study.fix')}</button>}
              </Empty>
            ))}
          {activeFile?.ext === 'pdf' && activeFile.url ? (
            <SourceDrawer key={activeFile.path} pdf={activeFile as import('../../preload/types').ProjectFile} source={DEFAULT_SOURCE}
              onClose={() => close(`file:${activeFile.path}`)}
              onAskPassage={sel => docProps.onPrefill?.(`${activeFile.rel}\n${t('paper.passage_draft', { n: sel.page, q: sel.text })}`)} />
          ) : activeFile && (
            <FileView
              key={activeFile.path}
              file={activeFile}
              dir={project.dir}
              version={project}
              onDirty={markDirty}
            />
          )}
          {active.startsWith('file:') && !activeFile && <Empty title={t('wb.removed_title')} body={t('wb.removed_body')} />}
        </div>
        {compare && <div className="wb-separator" role="separator" tabIndex={0} aria-label={t('wb.resize_compare')}
          aria-orientation="vertical" aria-valuemin={25} aria-valuemax={75} aria-valuenow={Math.round(ratio)}
          onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId) }}
          onPointerMove={e => {
            if (!e.currentTarget.hasPointerCapture(e.pointerId) || !editors.current) return
            const rect = editors.current.getBoundingClientRect()
            const value = Math.min(75, Math.max(25, 100 * (e.clientX - rect.left) / rect.width))
            setLayout(l => ({ ...l, ratio: value }))
          }}
          onPointerUp={e => { e.currentTarget.releasePointerCapture(e.pointerId); update(l => ({ ...l })); track('source.compare_resized', { metadata: { ratio } }) }}
          onDoubleClick={() => update(l => ({ ...l, ratio: 50 }))}
          onKeyDown={e => {
            const value = e.key === 'ArrowLeft' ? ratio - 5 : e.key === 'ArrowRight' ? ratio + 5 : e.key === 'Home' ? 25 : e.key === 'End' ? 75 : null
            if (value === null) return
            e.preventDefault(); update(l => ({ ...l, ratio: Math.min(75, Math.max(25, value)) }))
          }} />}
          {paperSeen && (
            <div className="wb-paper" hidden={active !== 'paper' && !compare}>
              {sourceFile && sourceFile.ext !== 'pdf' && 'rel' in sourceFile
                ? <FileView key={sourceFile.path} file={sourceFile} dir={project.dir} version={project.tree} onDirty={markDirty} />
                : <SourceDrawer key={sourcePdf?.path ?? 'no-source'} pdf={sourcePdf} source={source ?? DEFAULT_SOURCE} active={active === 'paper' || compare} closeLabel={compare ? t('wb.close_source') : undefined}
                    onClose={() => update(l => ({ ...l, active: 'study', compare: false }))}
                    onPageChange={page => { if (sourceFile) setSourcePage({ path: sourceFile.path, page }) }}
                    onQuote={(ref, result) => setQuoteStatus(m => new Map(m).set(quoteKey(ref.page, ref.quote, ref.file ?? ref.sourceId), result))}
                    onSelect={setPassage}
                    supportCount={program && passage ? support?.ids.length ?? 0 : null}
                    onAskPassage={sel => docProps.onPrefill?.(`${sourceFile && 'rel' in sourceFile ? sourceFile.rel : sourceFile?.path ?? ''}\n${t('paper.passage_draft', { n: sel.page, q: sel.text })}`)} />}
            </div>
          )}
        </div>

      </div>
    </section>
  )
}

type StudyViewProps = StudyModelProps & {
  editError: string
  problems: string[]
  onFix(): void
}

/** The study model, with the notices about program.json that sit above it. */
function StudyView({ editError, problems, onFix, ...modelProps }: StudyViewProps) {
  return (
    <>
      {problems.length > 0 && (
        <p className="muted small program-notice" role="status" title={problems.join('\n')}>
          {t('study.problems', { n: problems.length })} · <button className="link" onClick={onFix}>{t('study.fix')}</button>
        </p>
      )}
      {editError && <div className="part error edit-error">{editError}</div>}
      <StudyModel {...modelProps} />
    </>
  )
}

/** The newest run folder whose progress says it is still running (absolute path), for Stop. */
function findRunning(tree: ProjectEntry[]): string | null {
  const sims = tree.find(e => e.rel === 'artifacts')?.children?.find(e => e.rel === 'artifacts/simulations')?.children ?? []
  const runs = sims.filter(e => e.kind === 'dir').sort((a, b) => b.name.localeCompare(a.name))
  return runs.find(r => !r.children?.some(f => f.name === 'results.html' || f.name === 'STOP'))?.path ?? null
}

function fixProgramMessage(problems: string[], error?: string): string {
  const list = problems.length ? problems.slice(0, 30).map((x) => `- ${x}`).join('\n') : `- ${error ?? 'program.json could not be read'}`
  return `program.json has formatting problems that the app set aside:\n${list}\n\nPlease fix program.json, then run \`python .opencode/skills/build/check_program.py program.json\` until it prints PASS.`
}

function Empty({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p className="muted">{body}</p>
      {children}
    </div>
  )
}

/** Tab label for research events: the kind and extension, never the file name. */
function tabKind(id: TabId, files: Map<string, ProjectEntry>): string {
  return id.startsWith('file:') ? `file.${files.get(id.slice(5))?.ext ?? ''}` : id
}
