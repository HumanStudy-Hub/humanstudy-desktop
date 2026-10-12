import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectSnapshot } from '../preload/types'
import { Chat, type ChatHandle } from './components/Chat'
import { ArtifactPanel } from './components/ArtifactPanel'
import { SourceDrawer, type SourceRef } from './components/SourceDrawer'
import { VisualizeMenu } from './components/VisualizeMenu'
import { useSession } from './useSession'

const LAST_KEY = 'hs.lastProject'
const PANES_KEY = 'hs.panes'
type Pane = 'agent' | 'source' | 'program'
const paneLabel: Record<Pane, string> = { agent: 'Study agent', source: 'Original paper', program: 'Human Program' }

export default function App() {
  const [project, setProject] = useState<ProjectSnapshot | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [source, setSource] = useState<SourceRef | null>(null)
  // Three panes, each foldable to a rail; at least one stays open.
  const [open, setOpen] = useState<Record<Pane, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PANES_KEY) || 'null')
      if (saved && typeof saved.agent === 'boolean') return saved
    } catch {
      /* ignore */
    }
    return { agent: true, source: false, program: true }
  })
  const setPane = (pane: Pane, value: boolean) =>
    setOpen((prev) => {
      const next = { ...prev, [pane]: value }
      if (!Object.values(next).some(Boolean)) return prev
      try {
        localStorage.setItem(PANES_KEY, JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  const showSource = (ref: SourceRef) => {
    setSource(ref)
    setPane('source', true)
  }
  const chat = useRef<ChatHandle>(null)
  const session = useSession(project?.dir ?? null)

  const load = useCallback(async (dir: string) => {
    const snap = await window.humanstudy.project.read(dir)
    setProject(snap)
    try {
      localStorage.setItem(LAST_KEY, snap.dir)
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    let last: string | null = null
    try {
      last = localStorage.getItem(LAST_KEY)
    } catch {
      /* ignore */
    }
    if (last) load(last).catch(() => undefined)
  }, [load])

  useEffect(() => {
    if (!project) return
    return window.humanstudy.project.onChanged((dir) => {
      if (dir === project.dir) void load(dir)
    })
  }, [project, load])

  const openProject = async () => {
    const dir = await window.humanstudy.project.open()
    if (dir) await load(dir)
  }

  const pick = (id: string, extend: boolean) =>
    setSelected((s) =>
      extend ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : s.length === 1 && s[0] === id ? [] : [id],
    )

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          HumanStudy
          {project && <span className="crumb">/ {project.name}</span>}
        </div>
        <div className="titlebar-actions">
          {project && (
            <VisualizeMenu disabled={!session.id || session.busy} onSend={session.send} />
          )}
          {project && (
            <div className="pane-switch" role="group" aria-label="Panels">
              {(Object.keys(paneLabel) as Pane[]).map((pane) => (
                <button key={pane} aria-pressed={open[pane]} onClick={() => setPane(pane, !open[pane])}>
                  {paneLabel[pane]}
                </button>
              ))}
            </div>
          )}
          <button className="ghost" onClick={openProject}>
            {project ? 'Switch project' : 'Open project'}
          </button>
        </div>
      </header>

      {!project ? (
        <main className="welcome">
          <h1>Replay a human study with agents.</h1>
          <p>
            Open a project folder containing <code>paper.pdf</code> and <code>program.json</code>.
            The agent builds, visualizes and exports the study; every step streams on the left.
          </p>
          <button className="primary" onClick={openProject}>
            Open project
          </button>
        </main>
      ) : (
        <main className="workspace">
          <section className={`pane agent ${open.agent ? '' : 'folded'}`} aria-label={paneLabel.agent}>
            {open.agent ? (
              <>
                <PaneHead title={paneLabel.agent} onFold={() => setPane('agent', false)} />
                <Chat ref={chat} session={session} selected={selected} onClearSelection={() => setSelected([])} />
              </>
            ) : (
              <Rail label={paneLabel.agent} onOpen={() => setPane('agent', true)} />
            )}
          </section>
          <section className={`pane source ${open.source ? '' : 'folded'}`} aria-label={paneLabel.source}>
            {open.source ? (
              <>
                <PaneHead title={project.pdf?.name ?? paneLabel.source} onFold={() => setPane('source', false)} />
                <SourceDrawer pdf={project.pdf} source={source ?? { page: 1 }} onClose={() => setPane('source', false)} />
              </>
            ) : (
              <Rail label={paneLabel.source} onOpen={() => setPane('source', true)} />
            )}
          </section>
          <section className={`pane program ${open.program ? '' : 'folded'}`} aria-label={paneLabel.program}>
            {open.program ? (
              <>
                <PaneHead title={paneLabel.program} onFold={() => setPane('program', false)} />
                <ArtifactPanel
                  project={project}
                  selectedIds={selected}
                  onPick={pick}
                  onSource={(id, ref) => showSource({ page: ref.page ?? 1, quote: ref.quote, nodeId: id })}
                  onAsk={(id, fieldId, draft) => {
                    setPane('agent', true)
                    requestAnimationFrame(() => chat.current?.ask(id, fieldId, draft))
                  }}
                />
              </>
            ) : (
              <Rail label={paneLabel.program} onOpen={() => setPane('program', true)} />
            )}
          </section>
        </main>
      )}
    </div>
  )
}

function PaneHead({ title, onFold }: { title: string; onFold(): void }) {
  return (
    <header className="pane-head">
      <strong title={title}>{title}</strong>
      <button className="ghost fold" aria-label={`Fold ${title}`} title="Fold" onClick={onFold}>
        ‹
      </button>
    </header>
  )
}

function Rail({ label, onOpen }: { label: string; onOpen(): void }) {
  return (
    <button className="rail" onClick={onOpen} title={`Open ${label}`}>
      <span>{label}</span>
    </button>
  )
}
