import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AccountStatus, ProjectSnapshot, Settings, TelemetryStatus } from '../preload/types'
import { Chat, type ChatHandle } from './components/Chat'
import { Workbench, type WorkbenchHandle } from './components/Workbench'
import { labelItems } from './program/labels'
import { SourceDrawer, type SourceRef } from './components/SourceDrawer'
import { VisualizeMenu } from './components/VisualizeMenu'
import { Home, type HomeHandle } from './components/Home'
import { SettingsDialog, type SettingsSection } from './components/SettingsDialog'
import { useSession } from './useSession'
import { useKernelInstall } from './useKernelInstall'
import { ThreadMenu } from './components/Threads'
import { UpdateNotice, useUpdateStatus } from './components/Updates'
import { ConsentDialog } from './components/ResearchData'
import { lap, setTelemetryProject, track } from './telemetry'

const PANES_KEY = 'hs.panes'
type Pane = 'agent' | 'source' | 'program'
const paneLabel: Record<Pane, string> = { agent: 'Study agent', source: 'Original paper', program: 'Study' }

/** Commands both the keyboard shortcuts and (later) the native menu run. */
export type AppCommand = 'pane.toggle' | 'settings.open' | 'project.fromPaper' | 'project.new' | 'project.open' | 'selection.clear' | 'thread.new'
let commandHandler: ((command: AppCommand, arg?: string) => void) | null = null
export function runCommand(command: AppCommand, arg?: string): void {
  commandHandler?.(command, arg)
}

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
  const setPane = (pane: Pane, value: boolean) => {
    // durationMs: how long the pane stayed in the state it just left.
    if (open[pane] !== value) track(value ? 'pane.unfold' : 'pane.fold', { target: pane, durationMs: lap(`pane:${pane}`) })
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
  }
  const showSource = (ref: SourceRef) => {
    setSource(ref)
    setPane('source', true)
  }
  const chat = useRef<ChatHandle>(null)
  const home = useRef<HomeHandle>(null)
  const update = useUpdateStatus()
  const workbench = useRef<WorkbenchHandle>(null)
  const session = useSession(project?.dir ?? null)
  const kernel = useKernelInstall()
  const openStudy = () => {
    setPane('program', true)
    requestAnimationFrame(() => workbench.current?.openStudy())
  }
  const newThreadRef = useRef(session.newThread)
  newThreadRef.current = session.newThread
  // The native menu's File > New project comes from anywhere; it lands on Home's "From a paper".
  const [wantNew, setWantNew] = useState(false)
  useEffect(() => {
    if (project || !wantNew) return
    setWantNew(false)
    requestAnimationFrame(() => home.current?.fromPaper())
  }, [project, wantNew])

  const load = useCallback(async (dir: string) => {
    const snap = await window.humanstudy.project.read(dir)
    setProject(snap)
    setSelected([])
  }, [])
  const openProject = useCallback(
    async (dir: string) => {
      const started = performance.now()
      await load(dir)
      await setTelemetryProject(dir)
      track('project.opened', { durationMs: performance.now() - started })
    },
    [load]
  )
  const closeProject = () => {
    track('project.closed')
    void setTelemetryProject(null)
    setProject(null)
  }

  useEffect(() => {
    window.humanstudy.settings.get().then(setSettings).catch(() => undefined)
  }, [])
  const refreshAccount = useCallback(() => {
    window.humanstudy.account.status().then(setAccount).catch(() => undefined)
  }, [])
  useEffect(refreshAccount, [refreshAccount])

  // Research data: ask once per account (and per consent version) after sign-in.
  const [research, setResearch] = useState<TelemetryStatus | null>(null)
  const [askLater, setAskLater] = useState(false)
  useEffect(() => {
    if (!account?.signedIn) return setResearch(null)
    window.humanstudy.telemetry
      ?.status()
      .then(setResearch)
      .catch(() => undefined)
  }, [account?.signedIn, account?.email, settingsOpen])
  const consent = account?.signedIn && research && !research.decided && !askLater && !settingsOpen && (
    <ConsentDialog onDone={setResearch} onLater={() => setAskLater(true)} />
  )

  // The explicit theme choice wins over the OS preference; 'system' defers to prefers-color-scheme.
  useEffect(() => {
    if (settings) document.documentElement.dataset.theme = settings.theme
  }, [settings])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    track('settings.changed', { metadata: { names: Object.keys(patch) } })
    if (typeof patch.model === 'string') track('model.change', { target: patch.model })
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

  const openSettings = (section: SettingsSection) => {
    track('settings.opened', { target: section })
    setSettingsOpen(section)
  }
  // A click toggles the item in the selection, so several items can be picked and asked about together.
  const pick = (id: string, extend: boolean) => {
    track('program.item_pick', { target: id, metadata: { extend } })
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  }
  const firstSelection = useRef(true)
  useEffect(() => {
    if (firstSelection.current) {
      firstSelection.current = false
      return
    }
    track('selection.change', { metadata: { ids: selected.slice(0, 50), count: selected.length } })
  }, [selected])
  const selectedItems = useMemo(() => labelItems(project?.program, selected), [project?.program, selected])
  const askSelection = () => {
    track('program.ask_selection', { metadata: { count: selected.length } })
    setPane('agent', true)
    chat.current?.focus()
  }
  const prefill = (text: string) => {
    setPane('agent', true)
    requestAnimationFrame(() => chat.current?.prefill(text))
  }

  // Commands: shortcuts below and the native menu both go through runCommand.
  const state = useRef({ project, open, settingsOpen })
  state.current = { project, open, settingsOpen }
  useEffect(() => {
    commandHandler = (command, arg) => {
      const st = state.current
      if (command === 'settings.open') return openSettings((arg as SettingsSection) || 'general')
      if (command === 'project.fromPaper') return st.project ? undefined : home.current?.fromPaper()
      if (command === 'project.new') {
        if (st.project) closeProject()
        return setWantNew(true)
      }
      if (command === 'project.open') return void window.humanstudy.project.open().then((dir) => { if (dir) void openProject(dir) })
      if (command === 'thread.new') return st.project ? newThreadRef.current() : undefined
      if (command === 'selection.clear') return setSelected([])
      if (command === 'pane.toggle' && st.project && (arg === 'agent' || arg === 'source' || arg === 'program'))
        setPane(arg, !st.open[arg])
    }
    return () => {
      commandHandler = null
    }
  })
  useEffect(
    () =>
      window.humanstudy.menu.onCommand((c) => {
        if (c.command === 'newProject') runCommand('project.new')
        else if (c.command === 'openFolder') runCommand('project.open')
        else if (c.command === 'pane') runCommand('pane.toggle', c.arg)
        else if (c.command === 'settings') runCommand('settings.open', 'general')
      }),
    [],
  )
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if (e.isComposing) return
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
        e.preventDefault()
        return runCommand('thread.new')
      }
      if (e.key === 'Escape') {
        if (!state.current.settingsOpen) runCommand('selection.clear')
        return
      }
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      const panes: Record<string, Pane> = { '1': 'agent', '2': 'source', '3': 'program' }
      if (panes[e.key]) {
        e.preventDefault()
        runCommand('pane.toggle', panes[e.key])
      } else if (e.key === ',') {
        e.preventDefault()
        runCommand('settings.open', 'general')
      } else if (e.key.toLowerCase() === 'n' && !state.current.project) {
        e.preventDefault()
        runCommand('project.fromPaper')
      }
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [])

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
          ref={home}
          onOpen={(dir) => void openProject(dir)}
          onSettings={() => openSettings('general')}
          account={account}
          onAccount={() => openSettings('account')}
        />
        {dialog}
        {consent}
        <UpdateNotice />
      </div>
    )

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand" title={update ? `v${update.version}` : undefined}>
          <span className="brand-mark" aria-hidden />
          HumanStudy Hub
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
          <button className="ghost" onClick={closeProject} title="Back to all projects">
            Projects
          </button>
          <button className="ghost icon" onClick={() => openSettings('general')} aria-label="Settings" title="Settings">
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
              <PaneHead title={paneLabel.agent} onFold={() => setPane('agent', false)}>
                <ThreadMenu session={session} />
              </PaneHead>
              <Chat
                ref={chat}
                session={session}
                selected={selectedItems}
                onClearSelection={() => setSelected([])}
                account={account}
                onSettings={openSettings}
                projectDir={project.dir}
                tree={project.tree}
                model={settings?.model ?? ''}
                busyEnter={settings?.busyEnter ?? 'queue'}
                onModel={(model) => updateSettings({ model })}
                kernel={kernel}
                onOpenStudy={openStudy}
              />
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
              <Workbench
                ref={workbench}
                project={project}
                selectedIds={selected}
                selectedItems={selectedItems}
                onClearSelection={() => setSelected([])}
                onAskSelection={askSelection}
                onPrefill={prefill}
                onPick={pick}
                onSource={(id, ref) => {
                  track('citation.click', { target: id, metadata: { page: ref.page ?? null } })
                  showSource({ page: ref.page ?? 1, quote: ref.quote, nodeId: id })
                }}
                onAsk={(id, fieldId, draft) => {
                  track('program.ask', { target: id, metadata: { field: fieldId ?? null } })
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
      {consent}
      <UpdateNotice />
    </div>
  )
}

function PaneHead({ title, onFold, children }: { title: string; onFold(): void; children?: ReactNode }) {
  return (
    <header className="pane-head">
      <strong title={title}>{title}</strong>
      {children}
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
