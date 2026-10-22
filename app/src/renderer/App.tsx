import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AccountStatus, ProjectSnapshot, Settings, TelemetryStatus, WorkspaceContext } from '../preload/types'
import { Chat, type ChatHandle } from './components/Chat'
import { Workbench, type WorkbenchHandle, type WorkspaceSnapshot } from './components/Workbench'
import { labelItems } from './program/labels'
import type { SourceRef } from './components/SourceDrawer'
import { Home, type HomeHandle } from './components/Home'
import { SettingsDialog, type SettingsSection } from './components/SettingsDialog'
import { useSession } from './useSession'
import { useKernelInstall } from './useKernelInstall'
import { ThreadMenu } from './components/Threads'
import { UpdateNotice, useUpdateStatus } from './components/Updates'
import { AgreementDialog } from './components/ResearchData'
import { lap, setTelemetryProject, track } from './telemetry'
import { t, useLang } from './i18n'
import { classifyTool, researchActivity, toolSentence } from './toolSentence'
import { onAsk as onArtifactAsk, onOpenSource as onArtifactOpenSource } from './bridge'
import { artifactSourceRef } from './artifact-source'
import { SampleOnboarding } from './components/SampleOnboarding'
import { clearDraftsIn, draftCount, draftsIn, onDraftsChange } from './drafts'

const PANES_KEY = 'hs.panes'
type Pane = 'agent' | 'program'
const paneLabel = (p: Pane) => t(p === 'agent' ? 'app.agent' : 'app.workspace')

/** Commands both the keyboard shortcuts and (later) the native menu run. */
export type AppCommand = 'pane.toggle' | 'tab.show' | 'files.toggle' | 'settings.open' | 'project.fromPaper' | 'project.new' | 'project.open' | 'selection.clear' | 'thread.new'
let commandHandler: ((command: AppCommand, arg?: string) => void) | null = null
export function runCommand(command: AppCommand, arg?: string): void {
  commandHandler?.(command, arg)
}

export default function App() {
  useLang() // re-render the whole tree when the language changes
  const [project, setProject] = useState<ProjectSnapshot | null>(null)
  const [showSampleOnboarding, setShowSampleOnboarding] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [source, setSource] = useState<SourceRef | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState<SettingsSection | null>(null)
  const [account, setAccount] = useState<AccountStatus | null>(null)
  // Three panes, each foldable to a rail; at least one stays open.
  const [open, setOpen] = useState<Record<Pane, boolean>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(PANES_KEY) || 'null')
      if (saved && typeof saved.agent === 'boolean') return { agent: saved.agent, program: saved.program !== false }
    } catch {
      /* ignore */
    }
    return { agent: true, program: true }
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
    setPane('program', true)
  }
  const chat = useRef<ChatHandle>(null)
  const home = useRef<HomeHandle>(null)
  const update = useUpdateStatus()
  const workbench = useRef<WorkbenchHandle>(null)
  const workspaceCache = useRef<WorkspaceSnapshot | null>(null)
  const cacheWorkspace = useCallback((snapshot: WorkspaceSnapshot) => { workspaceCache.current = snapshot }, [])
  const sendInWorkspace = (text: string, send: (text: string, workspace?: WorkspaceContext) => void) => {
    const snapshot = workbench.current?.getContext() ?? workspaceCache.current
    const context = snapshot && project && snapshot.projectDir === project.dir ? { ...snapshot.context, panels: { agent: open.agent, workspace: open.program } } : undefined
    send(text, context)
  }
  // Research data agreement: asked the moment the account is signed in (also over Settings, where sign-in
  // happens), per account and agreement version. The agent
  // only starts with hosted access (or the hidden developer key path) and an accepted agreement.
  const [research, setResearch] = useState<TelemetryStatus | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [devKeys, setDevKeys] = useState(false)
  useEffect(() => {
    window.humanstudy.app.info().then((i) => setDevKeys(Boolean(i.devKeys))).catch(() => undefined)
  }, [])
  const agreed = Boolean(research?.decided && research.usage && research.content)
  const hasAccess = account?.modelAccess === 'hosted' || (devKeys && account?.modelAccess === 'own-key')
  const agentReady = Boolean(hasAccess && agreed)
  const session = useSession(project?.dir ?? null, agentReady)
  const lastUser = session.messages.filter(m => m.role === 'user').at(-1)
  const agentTurnKey = lastUser ? `${session.threadId ?? session.id ?? ''}:${lastUser.id}` : null
  // Importing a paper authorizes building its study: start as soon as the agent is ready and idle (issue #15).
  const buildPending = Boolean(project?.pdf && project.build?.status === 'pending')
  const { startPaperBuild } = session
  useEffect(() => {
    if (agentReady && session.id && !session.busy && buildPending) void startPaperBuild(t('build.prompt')).catch(() => undefined)
  }, [agentReady, session.id, session.busy, buildPending, startPaperBuild])
  useEffect(() => { setSource(null) }, [project?.dir])
  // What the agent is doing, in the chat's own words, for the Simulation tab's live line.
  const agentActivity = useMemo(() => {
    if (!session.busy) return ''
    if (session.status === 'stalled') return t('activity.stalled')
    const tools = (session.messages.filter(m => m.role === 'assistant').at(-1)?.parts ?? []).filter(p => p.kind === 'tool') as Parameters<typeof researchActivity>[0]
    const last = tools[tools.length - 1]
    const s = last && (last.state === 'pending' || last.state === 'running') ? toolSentence(classifyTool(last, project?.dir)) : researchActivity(tools, project?.dir)
    return t(s.key, s.vars)
  }, [session.busy, session.status, session.messages, project?.dir])
  useEffect(() => {
    if (!account?.signedIn) return setResearch(null)
    window.humanstudy.telemetry
      ?.status()
      .then(setResearch)
      .catch(() => undefined)
  }, [account?.signedIn, account?.email, settingsOpen])
  const consent = account?.signedIn && research && (reviewing || !research.decided) && (
    <AgreementDialog
      onDone={(s) => {
        setResearch(s)
        setReviewing(false)
      }}
    />
  )

  const kernel = useKernelInstall()
  const showTab = (tab: 'study' | 'paper' | 'simulation') => {
    setPane('program', true)
    requestAnimationFrame(() => workbench.current?.showTab(tab))
  }
  const openStudy = () => showTab('study')
  const openFile = (path: string) => {
    setPane('program', true)
    requestAnimationFrame(() => workbench.current?.openFile(path))
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
  // Unsaved file edits survive tab switches; leaving the project asks before they are dropped.
  const confirmLeave = (): boolean => {
    const dir = state.current.project?.dir
    if (!dir) return true
    const n = draftsIn(dir).length
    if (n && !window.confirm(t('app.leave_unsaved', { n }))) return false
    clearDraftsIn(dir)
    return true
  }
  const closeProject = (): boolean => {
    if (!confirmLeave()) return false
    track('project.closed')
    void setTelemetryProject(null)
    setProject(null)
    return true
  }
  // Closing the window or quitting asks while any draft exists (main/index.ts shows the dialog).
  useEffect(() => {
    const sync = () => window.humanstudy.app.setUnsaved(draftCount() ? { message: t('app.quit_unsaved'), detail: t('app.quit_unsaved_detail'), discard: t('app.discard_close'), cancel: t('app.cancel') } : null)
    sync()
    return onDraftsChange(sync)
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
  // The folder watcher can miss a replaced file (on Windows a rename-replace or an editor's temporary
  // file may report only the other name). Re-read when the window regains focus or a tab is switched:
  // a changed version stamp reloads the source; an unchanged project keeps its state and selection.
  const lastCheck = useRef(0)
  const recheck = useCallback(() => {
    const dir = project?.dir
    if (!dir || Date.now() - lastCheck.current < 800) return
    lastCheck.current = Date.now()
    window.humanstudy.project
      .read(dir)
      .then((snap) => setProject((prev) => (!prev || prev.dir !== snap.dir || JSON.stringify(prev) === JSON.stringify(snap) ? prev : snap)))
      .catch(() => undefined)
  }, [project?.dir])
  useEffect(() => {
    const visible = () => {
      if (document.visibilityState === 'visible') recheck()
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', visible)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [recheck])

  const openSettings = (section: SettingsSection) => {
    track('settings.opened', { target: section })
    setSettingsOpen(section)
  }
  // A click selects one item (and opens its details); Shift-click adds or removes it, so several
  // items can be picked and asked about together (web build-preview study model).
  const pick = (id: string, extend: boolean) => {
    track('program.item_pick', { target: id, metadata: { extend } })
    setSelected((s) => (extend ? (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]) : [id]))
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

  // Artifact views (bridge.ts): a click on a cited mark opens the paper there; "ask" prefills the chat.
  const bridgeState = useRef({ program: project?.program as unknown, showSource, prefill })
  bridgeState.current = { program: project?.program, showSource, prefill }
  useEffect(() => {
    const offOpen = onArtifactOpenSource((req) => {
      const st = bridgeState.current
      track('artifact.source_click', { target: req.programId ?? '', metadata: { page: req.page ?? null } })
      st.showSource(artifactSourceRef(st.program, req))
      // The split view belongs to the Study tab; from an artifact tab the paper opens as its own tab.
      workbench.current?.showTab('paper')
    })
    const offAsk = onArtifactAsk(({ text }) => {
      track('artifact.ask')
      bridgeState.current.prefill(text)
    })
    return () => {
      offOpen()
      offAsk()
    }
  }, [])

  // Commands: shortcuts below and the native menu both go through runCommand.
  const state = useRef({ project, open, settingsOpen })
  state.current = { project, open, settingsOpen }
  useEffect(() => {
    commandHandler = (command, arg) => {
      const st = state.current
      if (command === 'settings.open') return openSettings((arg as SettingsSection) || 'general')
      if (command === 'project.fromPaper') return st.project ? undefined : home.current?.fromPaper()
      if (command === 'project.new') {
        if (st.project && !closeProject()) return
        return setWantNew(true)
      }
      if (command === 'project.open') return void window.humanstudy.project.open().then((dir) => { if (dir && (dir === state.current.project?.dir || confirmLeave())) void openProject(dir) })
      if (command === 'thread.new') return st.project ? newThreadRef.current() : undefined
      if (command === 'selection.clear') return setSelected([])
      if (command === 'pane.toggle' && st.project && (arg === 'agent' || arg === 'program')) setPane(arg, !st.open[arg])
      if (command === 'tab.show' && st.project && (arg === 'study' || arg === 'paper')) showTab(arg)
      if (command === 'files.toggle' && st.project) workbench.current?.toggleFiles()
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
        else if (c.command === 'pane') {
          if (c.arg === 'agent') runCommand('pane.toggle', 'agent')
          else if (c.arg === 'files') runCommand('files.toggle')
          else runCommand('tab.show', c.arg)
        }
        else if (c.command === 'settings') runCommand('settings.open', c.arg === 'help' ? 'help' : 'general')
      }),
    [],
  )
  useEffect(() => {
    const keys = (e: KeyboardEvent) => {
      if((e.target as HTMLElement)?.closest?.('.native-terminal'))return
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
      const tabs: Record<string, string> = { '2': 'study', '3': 'paper' }
      if (e.key === '1') {
        e.preventDefault()
        runCommand('pane.toggle', 'agent')
      } else if (tabs[e.key]) {
        e.preventDefault()
        runCommand('tab.show', tabs[e.key])
      } else if (e.key.toLowerCase() === 'b') {
        e.preventDefault()
        runCommand('files.toggle')
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
      devKeys={devKeys}
      onReviewAgreement={() => {
        setSettingsOpen(null)
        setReviewing(true)
      }}
    />
  )

  if (!project)
    return (
      <div className="app">
        <Home
          ref={home}
          onOpen={(dir, sample) => {
            if (sample) {
              let seen = false
              try { seen = localStorage.getItem('hs.sampleOnboarding.v1') === 'done' } catch { /* ignore */ }
              setShowSampleOnboarding(!seen)
            }
            void openProject(dir)
          }}
          onSettings={() => openSettings('general')}
          account={account}
          onAccount={() => openSettings('account')}
          kernel={kernel}
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
          <button className="ghost" onClick={closeProject} title={t('app.back_hint')}>
            {t('app.projects')}
          </button>
          <button className="ghost icon" onClick={() => openSettings('general')} aria-label={t('app.settings')} title={t('app.settings')}>
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
              <path
                d="M8.4 2.5h3.2l.5 2.1 1.4.8 2-.7 1.6 2.8-1.5 1.5v1.6l1.5 1.5-1.6 2.8-2-.7-1.4.8-.5 2.1H8.4l-.5-2.1-1.4-.8-2 .7-1.6-2.8L4.4 11V9.4L2.9 7.9l1.6-2.8 2 .7 1.4-.8z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <circle cx="10" cy="10.2" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className={`pane agent ${open.agent ? '' : 'folded'}`} aria-label={paneLabel('agent')}>
          {open.agent ? (
            <>
              <PaneHead title={paneLabel('agent')} onFold={() => setPane('agent', false)}>
                <ThreadMenu session={session} />
              </PaneHead>
              <Chat
                ref={chat}
                session={{ ...session, send: text => sendInWorkspace(text, session.send), enqueue: text => sendInWorkspace(text, session.enqueue), interruptAndSend: text => sendInWorkspace(text, session.interruptAndSend) }}
                selected={selectedItems}
                onClearSelection={() => setSelected([])}
                account={account}
                onSettings={openSettings}
                agreement={account?.signedIn && research ? (agreed ? 'accepted' : 'needed') : 'accepted'}
                onReview={() => setReviewing(true)}
                projectDir={project.dir}
                tree={project.tree}
                model={settings?.model ?? ''}
                auto={settings?.permission !== 'ask'}
                onAuto={enabled => updateSettings({ permission: enabled ? 'project' : 'ask' })}
                busyEnter={settings?.busyEnter ?? 'queue'}
                onModel={(model) => updateSettings({ model })}
                kernel={kernel}
                onOpenStudy={openStudy}
                onOpenFile={openFile}
              />
            </>
          ) : (
            <Rail label={paneLabel('agent')} onOpen={() => setPane('agent', true)} />
          )}
        </section>
        <section className={`pane program ${open.program ? '' : 'folded'}`} aria-label={paneLabel('program')}>
          {open.program ? (
            <Workbench
              ref={workbench}
              project={project}
              source={source}
              onWorkspaceChange={cacheWorkspace}
              onRecheck={recheck}
              onRunSimulation={approval => sendInWorkspace(approval, session.busy ? session.enqueue : session.send)}
              onSendAgent={text => sendInWorkspace(text, session.busy ? session.enqueue : session.send)}
              onStopAgent={() => void session.abort()}
              model={settings?.model ?? ''}
              agentBusy={session.busy}
              agentThreadId={session.threadId ?? session.id ?? ''}
              agentTurnKey={agentTurnKey}
              agentActivity={agentActivity}
              selectedIds={selected}
              onClearSelection={() => setSelected([])}
              onAskSelection={askSelection}
              onPrefill={prefill}
              onFixProgram={text => { track('program.fix_requested'); prefill(text) }}
              onPick={pick}
              onFold={() => setPane('program', false)}
              onSource={(id, ref) => {
                track('citation.click', { target: id, metadata: { page: ref.page ?? null } })
                showSource({ ...ref, page: ref.page ?? 1, nodeId: id })
              }}
              onAsk={(id, fieldId, draft) => {
                track('program.ask', { target: id, metadata: { field: fieldId ?? null } })
                setPane('agent', true)
                requestAnimationFrame(() => chat.current?.ask(id, fieldId, draft))
              }}
            />
          ) : (
            <Rail label={paneLabel('program')} onOpen={() => setPane('program', true)} />
          )}
        </section>
      </main>
      {dialog}
      {consent}
      {showSampleOnboarding && <SampleOnboarding onClose={() => {
        try { localStorage.setItem('hs.sampleOnboarding.v1', 'done') } catch { /* ignore */ }
        setShowSampleOnboarding(false)
      }} />}
      <UpdateNotice />
    </div>
  )
}

function PaneHead({ title, onFold, children }: { title: string; onFold(): void; children?: ReactNode }) {
  return (
    <header className="pane-head">
      <strong title={title}>{title}</strong>
      {children}
      <button className="ghost fold" aria-label={t('app.fold', { title })} title={t('app.fold_short')} onClick={onFold}>
        ‹
      </button>
    </header>
  )
}

function Rail({ label, onOpen }: { label: string; onOpen(): void }) {
  return (
    <button className="rail" onClick={onOpen} title={t('app.open_pane', { label })}>
      <span>{label}</span>
    </button>
  )
}
