// The right pane: tabs like an editor's. A Study tab reads one study of program.json as a document;
// file tabs show or edit any file of the project; the Program explorer lists the project folder.
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import ProgramDocument, { viewStudies, type ProgramDocumentProps } from '../program/ProgramDocument'
import { validateHumanProgram, type HumanProgram } from '../../shared/human-program'
import type { ProjectEntry, ProjectSnapshot } from '../../preload/types'
import { track } from '../telemetry'
import { FileView } from './FileView'
import { Explorer, flatten } from './Explorer'
import type { SelectedItem } from '../program/labels'

type TabId = `study:${string}` | `file:${string}`
interface Layout {
  tabs: TabId[]
  active: TabId | null
  explorer: boolean
}

export interface WorkbenchHandle {
  /** Show the Study tab (the first study of program.json). */
  openStudy(): void
  /** Open a project file in a tab by its absolute path. */
  openFile(path: string): void
}

interface Props extends Pick<ProgramDocumentProps, 'selectedIds' | 'onPick' | 'onSource' | 'onAsk' | 'onPrefill'> {
  ref?: Ref<WorkbenchHandle>
  project: ProjectSnapshot
  selectedItems: SelectedItem[]
  onClearSelection(): void
  /** Focus the composer with the current selection attached. */
  onAskSelection(): void
}

const key = (dir: string) => `hs.tabs:${dir}`
function loadLayout(dir: string): Layout | null {
  try {
    const raw = JSON.parse(localStorage.getItem(key(dir)) || 'null')
    if (raw && Array.isArray(raw.tabs)) return { tabs: raw.tabs, active: raw.active ?? raw.tabs[0] ?? null, explorer: Boolean(raw.explorer) }
  } catch {
    /* ignore */
  }
  return null
}

export function Workbench({ ref, project, selectedItems, onClearSelection, onAskSelection, ...docProps }: Props) {
  const { program, error } = useMemo(() => {
    if (!project.program) return { program: null, error: project.programError }
    try {
      return { program: validateHumanProgram(project.program), error: undefined }
    } catch (e) {
      return { program: null, error: `program.json is not a valid Human Program: ${String(e)}` }
    }
  }, [project.program, project.programError])
  const studies = useMemo(() => (program ? viewStudies(program) : []), [program])
  const files = useMemo(() => flatten(project.tree), [project.tree])
  const fileByPath = useMemo(() => new Map(files.map((f) => [f.path, f])), [files])

  const [layout, setLayout] = useState<Layout>(() => loadLayout(project.dir) ?? { tabs: [], active: null, explorer: false })
  const [dirty, setDirty] = useState<Set<string>>(() => new Set())
  const [editError, setEditError] = useState('')
  const [changed, setChanged] = useState<Set<string>>(() => new Set())

  // Project switch: restore its tabs.
  useEffect(() => {
    setLayout(loadLayout(project.dir) ?? { tabs: [], active: null, explorer: false })
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

  // Keep the tabs honest: a Study tab needs its study, a file tab its file, and there is always one.
  useEffect(() => {
    update((l) => {
      let tabs = l.tabs.filter((t) =>
        t.startsWith('study:') ? studies.some((st) => `study:${st.id}` === t) : fileByPath.has(t.slice(5)) || dirty.has(t.slice(5)),
      )
      if (!tabs.length && studies[0]) tabs = [`study:${studies[0].id}`]
      const active = l.active && tabs.includes(l.active) ? l.active : (tabs[0] ?? null)
      const explorer = l.explorer || (!tabs.length && !program)
      if (tabs.length === l.tabs.length && active === l.active && explorer === l.explorer && tabs.every((t, i) => t === l.tabs[i])) return l
      return { tabs, active, explorer }
    })
  }, [studies, fileByPath, dirty, program, update])

  const open = (id: TabId) => {
    track('tab.open', { target: id.startsWith('file:') ? `file.${fileByPath.get(id.slice(5))?.ext ?? ''}` : 'study' })
    update((l) => ({ ...l, tabs: l.tabs.includes(id) ? l.tabs : [...l.tabs, id], active: id }))
  }
  useImperativeHandle(ref, () => ({
    openStudy() {
      const first = studies[0]
      if (first) open(`study:${first.id}`)
      else {
        const f = files.find((x) => x.rel === 'program.json')
        if (f) open(`file:${f.path}`)
      }
    },
    openFile(path) {
      if (fileByPath.has(path)) open(`file:${path}`)
    },
  }))
  const activate = (id: TabId) => update((l) => (l.active === id ? l : { ...l, active: id }))
  const close = (id: TabId) => {
    if (id.startsWith('file:') && dirty.has(id.slice(5)) && !window.confirm('Discard unsaved changes to this file?')) return
    setDirty((d) => {
      if (!d.has(id.slice(5))) return d
      const n = new Set(d)
      n.delete(id.slice(5))
      return n
    })
    update((l) => {
      const tabs = l.tabs.filter((t) => t !== id)
      const at = l.tabs.indexOf(id)
      const active = l.active === id ? (tabs[Math.min(at, tabs.length - 1)] ?? null) : l.active
      return { ...l, tabs, active }
    })
  }
  const markDirty = (path: string, isDirty: boolean) =>
    setDirty((d) => {
      if (d.has(path) === isDirty) return d
      const n = new Set(d)
      if (isDirty) n.add(path)
      else n.delete(path)
      return n
    })

  const openEntry = (e: ProjectEntry) => {
    if (e.kind === 'dir') return
    if (e.ext === 'pdf') {
      docProps.onSource(`file:${e.rel}`, { page: 1, quote: '', verified: true })
      return
    }
    open(`file:${e.path}`)
  }

  // Human edit of a program field: the researcher's decision, written straight into program.json.
  const onEdit = async (id: string, fieldId: string, text: string) => {
    if (!program) return
    const next = structuredClone(program) as HumanProgram
    const field = id.startsWith('flow:')
      ? next.steps.find((s) => s.id === id.slice(5))?.rule
      : next.nodes.find((n) => n.id === id)?.fields.find((f) => f.id === fieldId)
    if (!field) return setEditError(`Could not find ${id} › ${fieldId} in program.json.`)
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

  const label = (t: TabId) => (t.startsWith('study:') ? (studies.find((st) => `study:${st.id}` === t)?.title ?? 'Study') : t.split(/[\\/]/).pop()!)
  const active = layout.active
  const activeFile = active?.startsWith('file:') ? (fileByPath.get(active.slice(5)) ?? null) : null
  const unopened = studies.filter((st) => !layout.tabs.includes(`study:${st.id}`))

  return (
    <section className="wb">
      <nav className="wb-tabs" aria-label="Open tabs">
        <button
          className={`wb-explorer-toggle ${layout.explorer ? 'on' : ''}`}
          aria-pressed={layout.explorer}
          title="Program: the project's files"
          onClick={() => {
            track(layout.explorer ? 'explorer.hide' : 'explorer.show')
            update((l) => ({ ...l, explorer: !l.explorer }))
          }}
        >
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
            <path d="M2 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          </svg>
          Program
        </button>
        <div className="wb-tablist" role="tablist">
          {layout.tabs.map((t) => {
            const isDirty = t.startsWith('file:') && dirty.has(t.slice(5))
            return (
              <div key={t} role="tab" aria-selected={active === t} className={`wb-tab ${active === t ? 'active' : ''}`} title={t.startsWith('file:') ? t.slice(5) : label(t)}>
                <button className="wb-tab-label" onClick={() => activate(t)} onAuxClick={(e) => e.button === 1 && close(t)}>
                  {t.startsWith('study:') && <span className="wb-tab-kind">Study</span>}
                  {label(t)}
                </button>
                {isDirty ? (
                  <button className="wb-tab-close dirty" aria-label="Unsaved changes · close" onClick={() => close(t)}>
                    ●
                  </button>
                ) : (
                  <button className="wb-tab-close" aria-label={`Close ${label(t)}`} onClick={() => close(t)}>
                    ×
                  </button>
                )}
              </div>
            )
          })}
          {unopened.length > 0 && <StudyPicker studies={unopened} onOpen={(id) => open(`study:${id}`)} />}
        </div>
      </nav>
      <div className="wb-body">
        {layout.explorer && <Explorer tree={project.tree} name={project.name} activePath={activeFile?.path ?? null} dirty={dirty} onOpen={openEntry} />}
        <div className="wb-content">
          {active?.startsWith('study:') &&
            (program ? (
              <StudyView
                program={program}
                studyId={active.slice(6)}
                storageKey={`${project.dir}:${active}`}
                selectedItems={selectedItems}
                onClearSelection={onClearSelection}
                onAskSelection={onAskSelection}
                editError={editError}
                changedIds={changed}
                onEdit={(id, fieldId, text) => void onEdit(id, fieldId, text)}
                {...docProps}
              />
            ) : (
              <Empty title={error ? 'program.json could not be read' : 'No study yet'} body={error ?? 'Ask the agent to build the Human Program from paper.pdf. The study appears here as soon as program.json is written.'} />
            ))}
          {active?.startsWith('file:') &&
            (activeFile ? (
              <FileView key={activeFile.path} file={activeFile} dir={project.dir} version={project} onDirty={markDirty} />
            ) : (
              <Empty title="File removed" body="This file is no longer in the project." />
            ))}
          {!active && (
            <Empty
              title={program ? 'Nothing open' : 'No study yet'}
              body={program ? 'Open a study or a file from the Program explorer.' : 'Ask the agent to build the Human Program from paper.pdf, or open a file from the Program explorer.'}
            />
          )}
        </div>
      </div>
    </section>
  )
}

function StudyPicker({ studies, onOpen }: { studies: { id: string; title: string }[]; onOpen(id: string): void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div className="menu wb-add" ref={ref}>
      <button className="wb-add-btn" onClick={() => setOpen(!open)} title="Open another study" aria-haspopup="menu" aria-expanded={open}>
        + Study
      </button>
      {open && (
        <div className="menu-pop" role="menu" style={{ left: 0, right: 'auto' }}>
          {studies.map((st) => (
            <button
              key={st.id}
              className="menu-item row"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                track('program.study_select', { target: st.id })
                onOpen(st.id)
              }}
            >
              {st.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

type StudyViewProps = Pick<ProgramDocumentProps, 'selectedIds' | 'onPick' | 'onSource' | 'onAsk' | 'onPrefill' | 'onEdit' | 'changedIds' | 'storageKey'> & {
  program: HumanProgram
  studyId: string
  selectedItems: SelectedItem[]
  onClearSelection(): void
  onAskSelection(): void
  editError: string
}

function StudyView({ program, studyId, selectedItems, onClearSelection, onAskSelection, editError, ...docProps }: StudyViewProps) {
  const n = selectedItems.length
  return (
    <div className="doc-scroll study-scroll">
      {n > 0 && (
        <div className="selection-bar" role="status">
          <span>
            {n} selected
            <span className="selection-names"> · {selectedItems.map((i) => i.title).join(', ')}</span>
          </span>
          <button className="link" onClick={onAskSelection}>
            Ask the agent ↗
          </button>
          <button className="link muted" onClick={onClearSelection}>
            Clear
          </button>
        </div>
      )}
      {editError && <div className="part error edit-error">{editError}</div>}
      <ProgramDocument program={program} studyId={studyId} {...docProps} />
    </div>
  )
}

function Empty({ title, body }: { title: string; body: ReactNode }) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p className="muted">{body}</p>
    </div>
  )
}
