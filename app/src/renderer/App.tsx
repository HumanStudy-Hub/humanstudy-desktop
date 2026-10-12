import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProjectSnapshot } from '../preload/types'
import { Chat, type ChatHandle } from './components/Chat'
import { ArtifactPanel } from './components/ArtifactPanel'
import { SourceDrawer, type SourceRef } from './components/SourceDrawer'
import { VisualizeMenu } from './components/VisualizeMenu'
import { useSession } from './useSession'

const LAST_KEY = 'hs.lastProject'

export default function App() {
  const [project, setProject] = useState<ProjectSnapshot | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [source, setSource] = useState<SourceRef | null>(null)
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

  const open = async () => {
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
          {project?.pdf && (
            <button className="ghost" onClick={() => setSource(source ? null : { page: 1 })}>
              Source
            </button>
          )}
          <button className="ghost" onClick={open}>
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
          <button className="primary" onClick={open}>
            Open project
          </button>
        </main>
      ) : (
        <main className="workspace">
          <Chat
            ref={chat}
            session={session}
            selected={selected}
            onClearSelection={() => setSelected([])}
          />
          <ArtifactPanel
            project={project}
            selectedIds={selected}
            onPick={pick}
            onSource={(id, ref) => setSource({ page: ref.page ?? 1, quote: ref.quote, nodeId: id })}
            onAsk={(id, fieldId, draft) => chat.current?.ask(id, fieldId, draft)}
          />
          <SourceDrawer pdf={project.pdf} source={source} onClose={() => setSource(null)} />
        </main>
      )}
    </div>
  )
}
