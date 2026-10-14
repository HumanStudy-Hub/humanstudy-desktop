// The right pane: Study (the 12-section document) and Paper, plus any file the researcher or the agent
// opens as another tab, like an artifact panel. A Files sidebar (hidden by default, ⌘B) lists the folder.
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react'
import ProgramDocument, { viewStudies, type ProgramDocumentProps } from '../program/ProgramDocument'
import { readHumanProgram, validateHumanProgram, type HumanProgram } from '../../shared/human-program'
import type { ProjectEntry, ProjectSnapshot } from '../../preload/types'
import { lap, track } from '../telemetry'
import { FileView } from './FileView'
import { Explorer, flatten } from './Explorer'
import { SourceDrawer, type SourceRef } from './SourceDrawer'
import type { SelectedItem } from '../program/labels'
import { t } from '../i18n'

export type MainTab = 'study' | 'paper'
type TabId = MainTab | `file:${string}`
interface Layout {
  /** Open file tabs, as `file:<path>`. */
  tabs: `file:${string}`[]
  active: TabId
  files: boolean
  study?: string
}
const DEFAULT: Layout = { tabs: [], active: 'study', files: false }

export interface WorkbenchHandle {
  showTab(tab: MainTab): void
  /** Open a project file in a tab by its absolute path. */
  openFile(path: string): void
  toggleFiles(): void
}

interface Props extends Pick<ProgramDocumentProps, 'selectedIds' | 'onPick' | 'onSource' | 'onAsk' | 'onPrefill'> {
  ref?: Ref<WorkbenchHandle>
  project: ProjectSnapshot
  selectedItems: SelectedItem[]
  source: SourceRef | null
  onClearSelection(): void
  /** Focus the composer with the current selection attached. */
  onAskSelection(): void
  /** Send the agent a message about a program.json that needs fixing. */
  onFixProgram?(text: string): void
  onFold(): void
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
        study: typeof raw.study === 'string' ? raw.study : undefined,
      }
  } catch {
    /* ignore */
  }
  return DEFAULT
}

export function Workbench({ ref, project, selectedItems, source, onClearSelection, onAskSelection, onFixProgram, onFold, ...docProps }: Props) {
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
  const [dirty, setDirty] = useState<Set<string>>(() => new Set())
  const [editError, setEditError] = useState('')
  const [changed, setChanged] = useState<Set<string>>(() => new Set())
  const [paperSeen, setPaperSeen] = useState(false)

  // Project switch: restore its tabs.
  useEffect(() => {
    setLayout(loadLayout(project.dir))
    setDirty(new Set())
    setChanged(new Set())
    setEditError('')
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
    if (layout.active === 'paper') setPaperSeen(true)
  }, [layout.active])

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
  }))
  const close = (id: `file:${string}`) => {
    track('tab.close', { target: tabKind(id, fileByPath), metadata: { dirty: dirty.has(id.slice(5)) } })
    if (dirty.has(id.slice(5)) && !window.confirm(t('wb.discard'))) return
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
  // Human edit of a study field: the researcher's decision, written straight into program.json.
  const onEdit = async (id: string, fieldId: string, text: string) => {
    if (!program) return
    const next = structuredClone(program) as HumanProgram
    const field = id.startsWith('flow:')
      ? next.steps.find((s) => s.id === id.slice(5))?.rule
      : next.nodes.find((n) => n.id === id)?.fields.find((f) => f.id === fieldId)
    if (!field) return setEditError(t('study.field_missing', { id, field: fieldId }))
    field.value = text
    field.origin = 'researcher'
    field.state = 'confirmed'
    try {
      validateHumanProgram(next)
      await window.humanstudy.project.writeText(`${project.dir}/program.json`, JSON.stringify(next, null, 2) + '\n')
      setEditError('')
      setChanged((c) => new Set(c).add(id))
      track('program.edited', { target: id, metadata: { field: fieldId } })
    } catch (e) {
      setEditError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '') : String(e))
    }
  }

  const active = layout.active
  const activeFile = active.startsWith('file:') ? (fileByPath.get(active.slice(5)) ?? null) : null
  const studyId = studies.find((s) => s.id === layout.study)?.id ?? studies[0]?.id ?? ''
  const label = (tb: `file:${string}`) => tb.split(/[\\/]/).pop()!
  const tabBtn = (id: MainTab, text: string) => (
    <div role="tab" aria-selected={active === id} className={`wb-tab main ${active === id ? 'active' : ''}`}>
      <button className="wb-tab-label" onClick={() => activate(id)}>
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
        <button className="ghost fold" aria-label={t('wb.fold')} title={t('wb.fold')} onClick={onFold}>
          ‹
        </button>
      </nav>
      <div className="wb-body">
        {layout.files && <Explorer tree={project.tree} name={project.name} activePath={activeFile?.path ?? null} dirty={dirty} onOpen={openEntry} />}
        <div className="wb-content">
          {active === 'study' &&
            (program ? (
              <>
                {studies.length > 1 && (
                  <div className="study-picker">
                    <label className="muted small">
                      {t('study.which')}{' '}
                      <select value={studyId} onChange={(e) => update((l) => ({ ...l, study: e.target.value }))}>
                        {studies.map((st) => (
                          <option key={st.id} value={st.id}>
                            {st.title}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                )}
                <StudyView
                  program={program}
                  studyId={studyId}
                  storageKey={project.dir}
                  selectedItems={selectedItems}
                  onClearSelection={onClearSelection}
                  onAskSelection={onAskSelection}
                  editError={editError}
                  problems={problems}
                  onFix={fixProgram}
                  changedIds={changed}
                  onEdit={(id, fieldId, text) => void onEdit(id, fieldId, text)}
                  {...docProps}
                  onSource={(id, ref) => {
                    docProps.onSource(id, ref)
                    activate('paper')
                  }}
                />
              </>
            ) : (
              <Empty title={error ? t('study.unreadable') : t('study.empty_title')} body={error ?? t('study.empty_body')}>
                {error && onFixProgram && <button className="link" onClick={fixProgram}>{t('study.fix')}</button>}
              </Empty>
            ))}
          {paperSeen && (
            <div className="wb-paper" hidden={active !== 'paper'}>
              <SourceDrawer pdf={project.pdf} source={source ?? { page: 1 }} onClose={() => activate('study')} />
            </div>
          )}
          {activeFile && (
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
      </div>
    </section>
  )
}

type StudyViewProps = Pick<ProgramDocumentProps, 'selectedIds' | 'onPick' | 'onSource' | 'onAsk' | 'onPrefill' | 'onEdit' | 'changedIds' | 'storageKey'> & {
  program: HumanProgram
  studyId: string
  selectedItems: SelectedItem[]
  onClearSelection(): void
  onAskSelection(): void
  editError: string
  problems: string[]
  onFix(): void
}

function StudyView({ program, studyId, selectedItems, onClearSelection, onAskSelection, editError, problems, onFix, ...docProps }: StudyViewProps) {
  const n = selectedItems.length
  return (
    <div className="doc-scroll study-scroll">
      {n > 0 && (
        <div className="selection-bar" role="status">
          <span>
            {t('study.selected', { n })}
            <span className="selection-names"> · {selectedItems.map((i) => i.title).join(', ')}</span>
          </span>
          <button className="link" onClick={onAskSelection}>
            {t('study.ask_selection')}
          </button>
          <button className="link muted" onClick={onClearSelection}>
            {t('chat.clear')}
          </button>
        </div>
      )}
      {problems.length > 0 && (
        <p className="muted small program-notice" role="status" title={problems.join('\n')}>
          {t('study.problems', { n: problems.length })} · <button className="link" onClick={onFix}>{t('study.fix')}</button>
        </p>
      )}
      {editError && <div className="part error edit-error">{editError}</div>}
      <ProgramDocument program={program} studyId={studyId} {...docProps} />
    </div>
  )
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
