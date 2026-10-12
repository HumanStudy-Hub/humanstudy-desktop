import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountStatus, ProjectSnapshot, Settings } from '../preload/types'
import { Chat, type ChatHandle } from './components/Chat'
import { ArtifactPanel } from './components/ArtifactPanel'
import { SourceDrawer, type SourceRef } from './components/SourceDrawer'
import { VisualizeMenu } from './components/VisualizeMenu'
import { Home } from './components/Home'
import { SettingsDialog, type SettingsSection } from './components/SettingsDialog'
import { useSession } from './useSession'

const PANES_KEY = 'hs.panes'
type Pane = 'agent' | 'source' | 'program'
const paneLabel: Record<Pane, string> = { agent: 'Study agent', source: 'Original paper', program: 'Human Program' }

export default function App() {
  const [project, setProject] = useState<ProjectSnapshot | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [source, setSource] = useState<SourceRef | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null)
  const [account, setAccount] = useState<AccountStatus | null>(null)
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
    setSelected([])
  }, [])

  useEffect(() => {
    window.humanstudy.settings.get().then(setSettings).catch(() => undefined)
  }, [])
  const refreshAccount = useCallback(() => {
    window.humanstudy.account.status().then(setAccount).catch(() => undefined)
  }, [])
  useEffect(refreshAccount, [refreshAccount])

  // The explicit theme choice wins over the OS preference; 'system' defers to prefers-color-scheme.
  useEffect(() => {
    if (settings) document.documentElement.dataset.theme = settings.theme
  }, [settings])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => (prev ? { ...prev, ...patch } : prev))
    window.humanstudy.settings
      .set(patch)
      .then(setSettings)
      .catch(() => undefined)
  }, [])
  const closeSettings = useCallback(() => {
    setSettingsOpen(null)
    refreshAccount() // a saved or removed own key changes model access too
  }, [refreshAccount])

  useEffect(() => {
    if (!project) return
    return window.humanstudy.project.onChanged((dir) => {
      if (dir === project.dir) void load(dir)
    })
  }, [project, load])

  const pick = (id: string, extend: boolean) =>
    setSelected((s) =>
      extend ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : s.length === 1 && s[0] === id ? [] : [id],
    )

  const dialog = settingsOpen && (
    <SettingsDialog
      initialSection={settingsOpen}
      settings={settings}
      onChange={updateSettings}
      account={account}
      onAccount={setAccount}
      onClose={closeSettings}
    />
  )

  if (!project)
    return (
      <div className="app">
        <Home
          onOpen={(dir) => void load(dir)}
          onSettings={() => setSettingsOpen('general')}
          account={account}
          onAccount={() => setSettingsOpen('account')}
        />
        {dialog}
      </div>
    )

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          HumanStudy
          <span className="crumb">/ {project.name}</span>
        </div>
        <div className="titlebar-actions">
          <VisualizeMenu disabled={!session.id || session.busy} onSend={session.send} />
          <div className="pane-switch" role="group" aria-label="Panels">
            {(Object.keys(paneLabel) as Pane[]).map((pane) => (
              <button key={pane} aria-pressed={open[pane]} onClick={() => setPane(pane, !open[pane])}>
                {paneLabel[pane]}
              </button>
            ))}
          </div>
          <button className="ghost" onClick={() => setProject(null)} title="Back to all projects">
            Projects
          </button>
          <button className="ghost icon" onClick={() => setSettingsOpen('general')} aria-label="Settings" title="Settings">
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
              <circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path
                d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </header>

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
      {dialog}
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
