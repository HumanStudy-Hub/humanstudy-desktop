import { NATIVE_TURNS, NATIVE_MUTATIONS, type NativeRequest, type NativeSelection } from '../shared/native'
import { nativeMessages } from './native-history'
import { createHash, randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { applyCredentials, providers, setKey } from './credentials'
import { applyAccount, getAccount } from './account'
import * as telemetry from './telemetry'
import { setupMenu } from './menu'
import { createSupport } from './support-core'
import * as notify from './notify'
import { cancelAssistantInstall, ensureAssistant, installStatus, onInstallProgress } from './assistant-install'
import { kernelBinary, managedBinary } from './opencode-install'
import {
  communityStudies,
  communityStudy,
  forkCommunityStudy,
  isAllowedExternal,
  setCommunityCacheDir,
} from './community'
import { createProject, isInside, isWithin, listProjects, renameProject, trashProject } from './projects'
import { applySettings, ensureProjectsRoot, getSettings, setSettings } from './settings'
import { checkForUpdates, installUpdate, startUpdates, stopUpdates, updateStatus } from './updates'
import { existsSync } from 'node:fs'
import { watchFolder, type FolderWatch } from './project-watch'
import { fileVersion } from '../shared/file-version'
import { copyFile, lstat, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as kernelModule from './kernel'
import { isVersioned, readVersion, relOf, snapshot, versionsOf } from './versions'
import { createThreads, threads } from './threads'
import { saveProjectCopy, saveProjectText } from './program-save'
import { createPaperBuilds, isBuildTurn } from './paper-build'
import { createShutdown } from './shutdown-core'
import { refreshAppOwned, refreshPack, trustedBudgetFiles, trustedCheckFiles, trustedEngineFiles, trustedOriginalTextFiles, trustedRunFiles } from './pack'
import { legacyFileIsolationAvailable, scientificReadiness } from './scientific-readiness'
import { readyPython } from './runtime-install'
import { assertRunnablePackage, projectPackageReadiness, configureScientificChecks, configureProtocolChecks, configureOriginalText, originalTextProblemsOf } from './package-readiness'
import { fillOriginalText, heldPinProblem, indexPrivateCopies, isPublishedStudy, originalTextProblems, restoredChecksProblem, restoredProtocolText, restoredRunFiles, writeAgentStatus } from './original-text'
type ScientificProblemLike = { check: string; reason: string }
import { protocolBudget, protocolReadiness, protocolDraftCertificate, restoredReadiness, sourceTextArgs } from './protocol-readiness'
import { startModelRelay, relaySupported } from './model-relay'
import { approvedRunLimits } from './run-approval'
import { closeProjectRelays, isRunStop } from './run-stop'
import { RunRegistry } from './run-registry'
import { launchProtocolRun, newRunFolder, sweepRunCopies, type Binding as ProtocolBinding } from './protocol-run'
import type { Kernel, KernelEvent } from './kernel-types'
import { actionRef } from '../shared/research-operations'
import { withPrivateCopyNote } from '../shared/workspace-context'
import type { ProjectEntry, ProjectFile, ProjectSnapshot, Settings, UnsavedPrompt, WorkspaceContext } from '../preload/types'

// macOS with /usr/bin/sandbox-exec: simulations go through a per-run relay. Elsewhere they use the
// pre-relay path and the run confirmation says that the study's code can read the key.
const RELAY = relaySupported()
const runs = new RunRegistry()
const runRelays = runs.relays
async function closeRunRelay(id: string) {
  await runs.closeCurrent(id)   // the relay's onClose frees its project (owner-checked)
}

// ---- kernel: accept a factory, a default export, a class, or an instance -------------
function loadKernel(): Kernel {
  const m = kernelModule as unknown as Record<string, unknown>
  for (const key of ['createKernel', 'getKernel', 'default', 'kernel', 'Kernel']) {
    const v = m[key]
    if (!v) continue
    if (typeof v === 'object' && 'send' in v) return v as Kernel
    if (typeof v === 'function') {
      try {
        return (v as () => Kernel)()
      } catch {
        return new (v as new () => Kernel)()
      }
    }
  }
  throw new Error('kernel module exports no Kernel (expected createKernel/default)')
}
// Kernels read the model and API keys from process.env when they are created (and opencode
// servers inherit env at spawn), so a settings/key change marks the current kernel stale and the
// next session gets a fresh one. Running sessions stay on the kernel that created them.
let kernel: Kernel | null = null
const allKernels = new Set<Kernel>()
const sessionKernel = new Map<string, Kernel>()
/** The project folder of each session (for checks that need it before the kernel sees a message). */
const sessionProject = new Map<string, string>()
const activeTurns = new Set<string>()
// The automatic paper build; its state file is under .humanstudy, which the project watcher ignores.
const paperBuilds = createPaperBuilds(dir => broadcast('project:changed', dir), async dir => protocolDraftCertificate(
  await readyPython(), trustedEngineFiles(), dir, process.env.HUMANSTUDY_RUNTIME_BIN || ''))
let threadsInitialized = false
const shutdown = createShutdown({
  busy: () => activeTurns.size > 0,
  confirm: async restart => {
    const result = await dialog.showMessageBox({
      type: 'question',
      message: 'The study agent is still working.',
      detail: 'Stopping now will interrupt the current work. Your conversation will be saved.',
      buttons: ['Keep working', restart ? 'Stop and restart' : 'Stop and quit'],
      defaultId: 0, cancelId: 0, noLink: true,
    })
    return result.response === 1
  },
  flush: async () => { if (threadsInitialized) await threads().flush(); await telemetry.settleResearch(activeTurns.size === 0) },
  quiesce: async () => {
    // Preserve kernel/session bindings until exit so an unsuccessful quit remains usable.
    await Promise.all([...activeTurns].map(id => kernelFor(id).abort(id)))
  },
  failed: error => {
    console.error('shutdown: could not save', error)
    dialog.showErrorBox('Your conversation could not be saved', 'The app stayed open. Check free disk space and project folder access, then try quitting again.')
  },
})
function currentKernel(): Kernel {
  if (!kernel) {
    kernel = loadKernel()
    allKernels.add(kernel)
    kernel.onEvent((e: KernelEvent) => {
      // A cancelled quit must leave queued prompts in place rather than dispatching them
      // into the closing gate when the interrupted turn reports completion.
      if (shutdown.closing() && e.type === 'done') e = { ...e, detail: 'shutdown' }
      if (e.type === 'done') activeTurns.delete(e.sessionId)
      else if (e.type === 'text' || e.type === 'tool' || (e.type === 'status' && e.text === 'busy') || (e.type === 'question' && !e.question?.resolved) || (e.type === 'permission' && !e.permission?.resolved)) activeTurns.add(e.sessionId)
      try { void Promise.resolve(paperBuilds.event(e)).catch(err => console.error('paper build check', err)) } catch (err) { console.error('paper build state', err) } // never blocks events
      threads().onEvent(e) // record before the renderer hears about it
      broadcast('kernel:event', e)
    })
    kernel.onEvent(telemetry.onKernelEvent)
    kernel.onEvent(notify.onKernelEvent)
  }
  return kernel
}
function markKernelStale(): void {
  kernel = null
}
// Model access (own key / hosted / none) decides the kernel's provider; when it changes, new
// sessions get a fresh kernel. Checked on every change and before each new session, because a
// desktop key can expire while the app is open.
let appliedAccess = ''
function syncAccess(): void {
  const sig = applyAccount()
  if (sig !== appliedAccess) {
    appliedAccess = sig
    markKernelStale()
  }
}
/** The implementation's name ("opencode" | "mock"); kernel/types.ts declares it, kernel-types.ts does not. */
function kernelName(k: Kernel): string {
  const name: unknown = (k as Partial<Record<'name', unknown>>).name
  return typeof name === 'string' && name ? name.slice(0, 40) : 'unknown'
}
function kernelFor(id: string): Kernel {
  const k = sessionKernel.get(id)
  if (!k) throw new Error(`unknown session ${id}`)
  return k
}

// ---- project files over a private protocol, limited to opened projects --------------
protocol.registerSchemesAsPrivileged([
  { scheme: 'hsfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])
// Folders opened explicitly with the Open dialog; everything under projectsRoot is allowed too.
const allowedRoots = new Set<string>()
function isAllowed(p: string): boolean {
  const q = resolve(p)
  if (isWithin(getSettings().projectsRoot, q)) return true
  return [...allowedRoots].some((r) => isWithin(r, q))
}
const toUrl = (p: string): string => 'hsfile://local/' + encodeURIComponent(p)
const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: hsfile:; font-src data:; media-src data: blob: hsfile:; connect-src 'none'; base-uri 'none'; form-action 'none'"

async function listDir(dir: string): Promise<ProjectFile[]> {
  if (!existsSync(dir)) return []
  const names = (await readdir(dir, { withFileTypes: true }))
    .filter((d) => d.isFile() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .sort()
  return names.map((name) => {
    const path = join(dir, name)
    return { name, path, url: toUrl(path), ext: extname(name).slice(1).toLowerCase() }
  })
}

// The Program tab shows the project as files, like an editor's explorer. App and kernel internals
// stay out of it; the agent's skills live in .opencode and the marker in .humanstudy.
const HIDDEN_DIRS = new Set(['.humanstudy', '.opencode', 'node_modules', '__pycache__', '.git', '.venv', '.DS_Store'])
// Engineering files the pack installs for the agent. The agent reads them from disk; researchers never need to see them.
const HIDDEN_TOP = new Set(['AGENTS.md', 'PROJECT_FORMAT.md', 'schema'])
const TREE_LIMIT = 3000
async function listTree(root: string, dir: string, depth: number, count: { n: number }): Promise<ProjectEntry[]> {
  if (!existsSync(dir) || depth > 8) return []
  const entries = (await readdir(dir, { withFileTypes: true })).filter((d) => !HIDDEN_DIRS.has(d.name) && !d.name.startsWith('.') && !(depth === 0 && HIDDEN_TOP.has(d.name)))
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  const out: ProjectEntry[] = []
  for (const d of entries) {
    if (count.n++ > TREE_LIMIT) break
    const path = join(dir, d.name)
    const rel = relative(root, path).split(sep).join('/')
    if (d.isDirectory()) out.push({ name: d.name, path, rel, kind: 'dir', ext: '', children: await listTree(root, path, depth + 1, count) })
    else if (d.isFile()) {
      let size: number | undefined
      let mtime: number | undefined
      let version: string | undefined
      try {
        const st = await stat(path)
        size = st.size
        mtime = Math.round(st.mtimeMs)
        version = fileVersion(st)
      } catch {
        /* unreadable */
      }
      out.push({ name: d.name, path, rel, kind: 'file', ext: extname(d.name).slice(1).toLowerCase(), url: toUrl(path), size, mtime, version })
    }
  }
  return out
}

const TEXT_LIMIT = 4 * 1024 * 1024
function ownedPath(p: string): string {
  const q = resolve(p)
  if (!isAllowed(q)) throw new Error('that file is outside the opened projects')
  if (q.split(sep).includes('.humanstudy')) throw new Error('app state is not editable')
  return q
}

// Editor and import paths must not traverse a linked directory or junction in the project.
async function assertProjectWritePath(root: string, target: string): Promise<void> {
  if (!isWithin(root, target)) throw Error('The write target is outside the project.')
  let current = root
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part)
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
      return null
    })
    if (!info) break
    if (info.isSymbolicLink()) throw Error('The write target crosses a linked project path.')
  }
}

async function readProject(dir: string): Promise<ProjectSnapshot> {
  dir = resolve(dir)
  if (!isInside(getSettings().projectsRoot, dir) && !allowedRoots.has(dir))
    throw new Error('project folder is not under the projects folder and was not opened')
  let program: unknown | null = null
  let programError: string | undefined
  const programPath = join(dir, 'program.json')
  if (existsSync(programPath)) {
    try {
      program = JSON.parse(await readFile(programPath, 'utf8'))
    } catch (e) {
      programError = String(e)
    }
  }
  const pdfPath = [join(dir, 'paper.pdf')].find(existsSync)
  // The version stamp lets the paper pane notice paper.pdf replaced at the same path.
  const pdfStat = pdfPath ? await stat(pdfPath).catch(() => null) : null
  return {
    dir,
    name: basename(dir),
    program,
    programError,
    build: paperBuilds.readOnly(dir),
    artifacts: await listDir(join(dir, 'artifacts')),
    exports: await listDir(join(dir, 'exports')),
    pdf: pdfPath
      ? {
          name: 'paper.pdf',
          path: pdfPath,
          url: toUrl(pdfPath),
          ext: 'pdf',
          ...(pdfStat ? { size: pdfStat.size, mtime: Math.round(pdfStat.mtimeMs), version: fileVersion(pdfStat) } : {}),
        }
      : null,
    tree: await listTree(dir, dir, 0, { n: 0 }),
  }
}

// ---- watch the open project so new artifacts appear without a reload -----------------
const watchers = new Map<string, FolderWatch>()
// Open projects, kept apart from their watchers: a watcher that died (EPERM on Windows) must not make
// version history or the pre-save snapshot think the project was closed.
const openProjects = new Set<string>()
// A watcher that keeps failing is retried at most every few seconds, not on every re-read it triggers.
const watchFailedAt = new Map<string, number>()
const snapTimers = new Map<string, NodeJS.Timeout>()
function watchProject(dir: string): void {
  openProjects.add(dir)
  if (watchers.has(dir) || Date.now() - (watchFailedAt.get(dir) ?? 0) < 5_000) return
  try {
    const w = watchFolder(dir, {
      ignore: (file) => file.startsWith('.humanstudy'),
      onFile: (file) => {
        telemetry.noteFsChange(dir, file)
        // A history for what the agent (or the researcher) wrote; debounced so one write is one version.
        const rel = file.split(sep).join('/')
        if (isVersioned(rel)) {
          const k = `${dir}\n${rel}`
          clearTimeout(snapTimers.get(k))
          snapTimers.set(k, setTimeout(() => { snapTimers.delete(k); void snapshot(dir, rel).catch(() => undefined) }, 600))
        }
      },
      // Replacing a file is often several events (temporary file, rename, delete + create); one
      // broadcast after they settle, and the renderer compares version stamps.
      onSettled: () => broadcast('project:changed', dir),
      // Watching died (e.g. EPERM on Windows): forget it so the next project read watches again,
      // and let the renderer re-read now. It also re-checks on window focus and tab switches.
      onError: () => {
        if (watchers.get(dir) === w) watchers.delete(dir)
        watchFailedAt.set(dir, Date.now())
        broadcast('project:changed', dir)
      },
      debounceMs: 300,
    })
    watchers.set(dir, w)
  } catch {
    /* watching is a convenience: the renderer also re-reads on focus and tab switches */
  }
}

/** The opened project folder a file belongs to. */
function projectRootOf(file: string): string {
  const q = resolve(file)
  for (const d of openProjects) if (isInside(d, q)) return d
  throw new Error('that file is not in an opened project')
}

function unwatch(dir: string): void {
  watchers.get(dir)?.close()
  watchers.delete(dir)
  watchFailedAt.delete(dir)
  openProjects.delete(dir)
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
}

/** Project folder a threads call may touch: under the projects folder or opened with the Open dialog. */
function threadDir(dir: string): string {
  const d = resolve(dir)
  if (!isAllowed(d)) throw new Error('project folder is not under the projects folder and was not opened')
  return d
}

// ---- unsaved edits: a window that reports drafts asks before it closes or the app quits ----------
const unsaved = new Map<number, UnsavedPrompt>()
/** True when the window may close: no drafts, or the researcher chose to discard them. */
function confirmDiscard(win: BrowserWindow, forget = true): boolean {
  const id = win.webContents.id
  const prompt = unsaved.get(id)
  if (!prompt) return true
  const choice = dialog.showMessageBoxSync(win, { type: 'warning', message: prompt.message, detail: prompt.detail, buttons: [prompt.discard, prompt.cancel], defaultId: 1, cancelId: 1, noLink: true })
  if (choice !== 0) return false
  if (forget) unsaved.delete(id)
  return true
}
/** Every window agrees to discard its drafts; a Cancel in any one keeps all of them. */
function confirmDiscardAll(): boolean {
  const wins = BrowserWindow.getAllWindows()
  if (!wins.every((w) => confirmDiscard(w, false))) return false
  for (const w of wins) unsaved.delete(w.webContents.id)
  return true
}
ipcMain.on('app:unsaved', (e, prompt: UnsavedPrompt | null) => {
  const ok = prompt && typeof prompt === 'object' && ['message', 'detail', 'discard', 'cancel'].every((k) => typeof (prompt as unknown as Record<string, unknown>)[k] === 'string')
  if (ok) unsaved.set(e.sender.id, prompt)
  else unsaved.delete(e.sender.id)
})

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    backgroundColor: '#00000000',
    vibrancy: 'sidebar',
    show: false,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, contextIsolation: true },
  })
  win.once('ready-to-show', () => win.show())
  const contentsId = win.webContents.id
  win.on('close', (e) => { if (!confirmDiscard(win)) e.preventDefault() })
  win.on('closed', () => unsaved.delete(contentsId))
  // Back from the trackpad (macOS "swipe between pages") and the mouse back button (Windows).
  win.on('swipe', (_e, direction) => { if (direction === 'left') win.webContents.send('menu:command', { command: 'back' }) })
  win.on('app-command', (_e, command) => { if (command === 'browser-backward') win.webContents.send('menu:command', { command: 'back' }) })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

// A second app launch must not spawn another renderer/kernel/telemetry pipeline.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

/** App storage for published studies' original wording (downloads and restored protocols; never in a project). */
/** Per project: the paths of copies dropped into sources/private/ of a published study (for the agent's note). */
const privateImports = new Map<string, Set<string>>()
const originalTextCache = (): string => join(app.getPath('userData'), 'original-text')
/** The contents of the project's sourcetext/ files the checks read (part of the restored-copy check's cache key). */
async function sourceTextStamp(project: string): Promise<string> {
  const h = createHash('sha256')
  const args = await sourceTextArgs(project)
  for (let i = 1; i < args.length; i += 2) h.update(args[i]).update(await readFile(args[i].slice(args[i].indexOf('=') + 1)).catch(() => Buffer.from('missing')))
  return h.digest('hex')
}
const studyTitle = (restored: string): string => { try { const t = JSON.parse(restored)?.meta?.title; return typeof t === 'string' ? t.slice(0, 200) : '' } catch { return '' } }

app.whenReady().then(() => {
  // Per-run code copies of protocol runs that a quit or a crash left behind.
  void sweepRunCopies(join(app.getPath('userData'), 'protocol-runs'))
  process.env.HUMANSTUDY_DESKTOP_APP = '1'
  process.env.HUMANSTUDY_RELAY_DIR = join(app.getPath('userData'), 'run-relays')
  // `ready` needs every build check (pack/skills/build/check_readiness.py), run from the app's own copy.
  const checkFiles = trustedCheckFiles()
  configureScientificChecks(async (project, slug) => scientificReadiness(await readyPython(), checkFiles, project, slug, process.env.HUMANSTUDY_RUNTIME_BIN || ''),
    app.getVersion() + ':' + createHash('sha256').update(JSON.stringify(checkFiles)).digest('hex').slice(0, 16), RELAY && legacyFileIsolationAvailable())
  // The protocol route: protocol.json checked by the bundled engine (pack/runtime/hsenv), never the project's copy.
  const engine = trustedEngineFiles()
  const budgetFiles = trustedBudgetFiles()
  configureProtocolChecks(async (project) => protocolReadiness(await readyPython(), engine, project, process.env.HUMANSTUDY_RUNTIME_BIN || ''),
    app.getVersion() + ':' + createHash('sha256').update(JSON.stringify([engine, budgetFiles])).digest('hex').slice(0, 16),
    async (project) => protocolBudget(await readyPython(), budgetFiles, project, process.env.HUMANSTUDY_RUNTIME_BIN || ''))
  // A published study's original wording, filled in on this computer (original-text.ts): downloads and the restored
  // protocol stay in app storage; the project gets only a status for the agent.
  const textFiles = trustedOriginalTextFiles()
  void telemetry.refreshPrivateIndex().catch(() => undefined)
  const restoredChecks = new Map<string, ScientificProblemLike[]>()
  configureOriginalText(async (project) => {
    const pinned = await heldPinProblem(originalTextCache(), project).catch(() => null)
    if (pinned) return [pinned]
    if (!(await isPublishedStudy(project))) return []
    const python = await readyPython()
    if (!python) return [{ check: 'runtime', reason: "The research runtime is not installed yet, so the study's original wording cannot be filled in." }]
    try {
      const status = await fillOriginalText(python, textFiles, project, originalTextCache(), process.env.HUMANSTUDY_RUNTIME_BIN || '')
      await telemetry.refreshPrivateIndex().catch(() => undefined)   // the helper indexed the private copies it read
      await writeAgentStatus(project, status).catch(() => undefined)
      const problems = originalTextProblems(status)
      if (problems.length || !status.complete || !status.projectionSha256) return problems
      // The engine's checks once on the restored copy (leaks, expressions, verbatim), in app storage, per copy.
      const restored = await restoredProtocolText(originalTextCache(), status.projectionSha256)
      if (restored === null) return [{ check: 'runtime', reason: "The study's original wording could not be filled in. Retry." }]
      // Keyed by the restored copy and the project's source texts; only a completed report is kept (a runtime
      // failure or a time/memory stop is checked again next time).
      const key = createHash('sha256').update(restored).update(await sourceTextStamp(project)).digest('hex')
      if (!restoredChecks.has(key)) {
        const found = await restoredReadiness(python, engine, project, restored, join(originalTextCache(), status.projectionSha256), process.env.HUMANSTUDY_RUNTIME_BIN || '')
        if (found.some((p) => p.check === 'runtime' || p.check === 'limits')) return found.map((p) => ({ check: 'runtime', reason: "The study's checks with its original wording filled in could not complete. Retry." }))
        restoredChecks.set(key, found.length ? [restoredChecksProblem(studyTitle(restored))] : [])
      }
      return restoredChecks.get(key)!
    } catch {
      return [{ check: 'runtime', reason: "The study's original wording could not be filled in. Retry; if it persists, reinstall the research runtime." }]
    }
  })
  if (!primaryInstance) return
  applyCredentials()
  try {
    applySettings()
  } catch (e) {
    console.error('settings: could not apply', e)
  }
  syncAccess()
  // Fetch the server's model list in the background; hosted sessions use it once it arrives.
  void getAccount()
    .getConfig()
    .then(syncAccess)
    .catch(() => undefined)

  protocol.handle('hsfile', (req) => {
    const p = resolve(decodeURIComponent(new URL(req.url).pathname.slice(1)))
    if (!isAllowed(p)) return new Response('forbidden', { status: 403 })
    if (!/\.html?$/i.test(p)) return net.fetch(pathToFileURL(p).toString())
    // Project HTML is an agent-made artifact: inline code only, no network (see renderer/bridge.ts).
    return net.fetch(pathToFileURL(p).toString()).then((res) => {
      const headers = new Headers(res.headers)
      headers.set('Content-Security-Policy', ARTIFACT_CSP)
      headers.set('Content-Type', 'text/html; charset=utf-8')
      return new Response(res.body, { status: res.status, headers })
    })
  })

  ipcMain.handle('project:open', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      title: 'Open a HumanStudy Hub project',
      defaultPath: ensureProjectsRoot(),
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const picked = r.canceled ? null : (r.filePaths[0] ?? null)
    if (picked) allowedRoots.add(resolve(picked))
    return picked
  })
  ipcMain.handle('project:read', async (_e, dir: string) => {
    const snap = await readProject(dir)
    watchProject(snap.dir)
    telemetry.noteProjectFiles(snap)
    return snap
  })
  ipcMain.handle('project:startBuild', (_e, dir: string, sid: string, action?: unknown) => {
    const claimed = paperBuilds.start(ownedPath(dir), sid)
    if (claimed) telemetry.noteBuildClaim(ownedPath(dir), sid, actionRef(action))
    return claimed
  })
  ipcMain.handle('project:releaseBuild', (_e, dir: string, sid: string) => paperBuilds.release(ownedPath(dir), sid))
  ipcMain.handle('project:retryBuild', (_e, dir: string, action?: unknown) => {
    telemetry.noteAction(actionRef(action), ownedPath(dir))
    return paperBuilds.retry(ownedPath(dir))
  })
  ipcMain.handle('project:reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('project:versions', async (_e, p: string) => {
    const q = ownedPath(p)
    const root = projectRootOf(q)
    return versionsOf(root, relOf(root, q))
  })
  ipcMain.handle('project:readVersion', async (_e, p: string, id: string) => {
    const q = ownedPath(p)
    const root = projectRootOf(q)
    return readVersion(root, relOf(root, q), id)
  })
  ipcMain.handle('project:saveCopy', async (e, p: string) => {
    const q = ownedPath(p)
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = { defaultPath: join(app.getPath('downloads'), basename(q)) }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return null
    await saveProjectCopy(q, r.filePath)
    return r.filePath
  })
  ipcMain.handle('project:packageReadiness', async (_e, dir: string, studyId: string, execute?: boolean) => ({ ...await projectPackageReadiness(ownedPath(dir), studyId, execute === true, true), modelAccess: RELAY ? 'relay' as const : 'key' as const }))
  ipcMain.handle('project:readText', async (_e, p: string) => {
    const q = ownedPath(p)
    if ((await stat(q)).size > TEXT_LIMIT) throw new Error('file is larger than 4 MB')
    return readFile(q, 'utf8')
  })
  ipcMain.handle('project:writeText', async (_e, p: string, text: string, ifUnchanged?: string, action?: unknown) => {
    const q = ownedPath(p)
    await assertProjectWritePath(projectRootOf(q), q)
    const ref = actionRef(action)
    if (typeof text !== 'string' || text.length > TEXT_LIMIT) throw new Error('text is too large')
    telemetry.noteAction(ref, [...openProjects].find((d) => isInside(d, q))) // the save operation, with its project
    await saveProjectText(q, text, { ifUnchanged, beforeWrite: async () => {
      const root = [...openProjects].find((d) => isInside(d, q))
      if (root) await snapshot(root, relOf(root, q)).catch(() => undefined)
      telemetry.noteHumanWrite(q, text, ref)
    } })
    if (basename(q).toLowerCase() === 'program.json') {
      const root = projectRootOf(q)
      telemetry.noteProgramWritten(root, text) // the version actually committed under the lock
      paperBuilds.humanSaved(root)
    }
    if (basename(q).toLowerCase() === 'protocol.json') paperBuilds.humanSaved(projectRootOf(q))
    telemetry.track('file.edited', { target: extname(q).slice(1) || 'file', ...(ref ? { action: ref } : {}) })
    // The researcher's Stop: the run's model access ends now, not when the relay expires.
    const stopRoot = [...openProjects].find((d) => isInside(d, q))
    if (stopRoot && isRunStop(stopRoot, q)) await closeProjectRelays(stopRoot, runRelays, closeRunRelay)
  })

  ipcMain.handle('project:importFiles', async (_e, dir: string, paths: string[], action?: unknown) => {
    const root = ownedPath(dir)
    const ref = actionRef(action)
    telemetry.noteAction(ref, root)
    if (!Array.isArray(paths) || paths.length > 50) throw new Error('too many files')
    // A published study: a dropped file is the researcher's copy of a source whose wording fills in the study's
    // screens. It goes to sources/private/ (this project only: never exported, never collected) and never becomes
    // paper.pdf.
    const published = await isPublishedStudy(root)
    const folder = published ? join('sources', 'private') : 'sources'
    const hasPaper = existsSync(join(root, 'paper.pdf'))
    let paperTaken = hasPaper || published
    const out: ProjectFile[] = []
    for (const src of paths) {
      if (typeof src !== 'string' || !(await stat(src)).isFile()) continue
      let name = basename(src)
      let target: string
      if (!paperTaken && extname(name).toLowerCase() === '.pdf') {
        target = join(root, 'paper.pdf')
        paperTaken = true
      } else {
        await assertProjectWritePath(root, join(root, folder))
        await mkdir(join(root, folder), { recursive: true })
        const ext = extname(name)
        const stem = name.slice(0, name.length - ext.length)
        target = join(root, folder, name)
        for (let n = 2; existsSync(target); n++) target = join(root, folder, `${stem} ${n}${ext}`)
        name = basename(target)
      }
      await assertProjectWritePath(root, target)
      telemetry.noteImport(root, relative(root, target), ref)
      await copyFile(src, target, 1) // COPYFILE_EXCL: never overwrite
      // Import is a known completed action; don't rely on fs.watch reporting a filename on Windows.
      telemetry.noteFsChange(root, relative(root, target))
      out.push({ name: basename(target), path: target, url: toUrl(target), ext: extname(target).slice(1).toLowerCase() })
      if (published) privateImports.set(root, new Set([...(privateImports.get(root) ?? []), relative(root, target).split(sep).join('/')]))
    }
    if (published && out.length) {
      // Recognise the copy in research capture before the agent hears of it, then fill in what it can.
      const python = await readyPython()
      if (python) await indexPrivateCopies(python, trustedOriginalTextFiles(), root, originalTextCache(), process.env.HUMANSTUDY_RUNTIME_BIN || '').catch(() => undefined)
      await telemetry.refreshPrivateIndex().catch(() => undefined)
      void originalTextProblemsOf(root).catch(() => undefined)
    }
    return out
  })

  ipcMain.handle('projects:list', async () => {
    try {
      return await listProjects()
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'EPERM' || e.code === 'EACCES')
        throw new Error(
          `macOS did not allow the app to read ${getSettings().projectsRoot}. Allow it under System Settings → Privacy & Security → Files and Folders, or choose another projects folder in Settings → General.`
        )
      throw err
    }
  })
  ipcMain.handle('projects:create', async (_e, input: { name: string; pdfPath?: string; sample?: boolean }, action?: unknown) => {
    const ref = actionRef(action)
    const dir = await createProject(input)
    telemetry.noteProjectCreated(dir, ref)
    telemetry.track('project.created', { metadata: { sample: Boolean(input?.sample), withPaper: Boolean(input?.pdfPath) }, ...(ref ? { action: ref } : {}) }, dir)
    return dir
  })
  ipcMain.handle('projects:pickPdf', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      title: 'Choose a paper (PDF)',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle('projects:rename', async (_e, dir: string, name: string) => {
    const from = resolve(dir)
    const to = await renameProject(from, name)
    if (to !== from) unwatch(from)
    return to
  })
  ipcMain.handle('projects:trash', async (_e, dir: string) => {
    unwatch(resolve(dir))
    await trashProject(dir)
  })

  setCommunityCacheDir(app.getPath('userData'))
  ipcMain.handle('community:studies', () => communityStudies())
  ipcMain.handle('community:study', (_e, id: string) => communityStudy(id))
  ipcMain.handle('community:fork', async (_e, id: string) => {
    const dir = await forkCommunityStudy(id, (input) => createProject(input))
    telemetry.track('project.forked', { target: String(id).slice(0, 80) }, dir)
    return dir
  })
  ipcMain.handle('community:openExternal', async (_e, url: string) => {
    if (!isAllowedExternal(url)) throw new Error('refusing to open a URL outside github.com / humanstudy-hub.com')
    await shell.openExternal(url)
  })

  const support = createSupport({
    auth: () => getAccount().restAuth(), fetch,
    diagnostics: { version: app.getVersion(), platform: process.platform, arch: process.arch },
    contactEmail: import.meta.env.MAIN_VITE_HUMANSTUDY_SUPPORT_EMAIL?.trim(),
  })
  ipcMain.handle('support:status', () => support.status())
  ipcMain.handle('support:submit', (_e, input) => support.submit(input))

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const before = getSettings()
    const next = setSettings(patch)
    if (next.model !== before.model) markKernelStale()
    if (next.permission !== before.permission) for (const k of allKernels) k.setPermissionMode?.(next.permission)
    syncAccess()
    return next
  })
  ipcMain.handle('settings:pickProjectsRoot', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      title: 'Choose the projects folder',
      defaultPath: getSettings().projectsRoot,
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || !r.filePaths[0]) return null
    const next = setSettings({ projectsRoot: r.filePaths[0] })
    syncAccess()
    return next
  })
  ipcMain.handle('settings:providers', () => providers())
  ipcMain.handle('settings:setKey', (_e, id: 'openrouter' | 'anthropic' | 'deepseek', key: string) => {
    const r = setKey(id, key)
    markKernelStale()
    syncAccess()
    return r
  })

  const acct = getAccount()
  const afterAccount = <T>(v: T): T => {
    syncAccess()
    return v
  }
  ipcMain.handle('account:status', () => acct.status())
  ipcMain.handle('account:signIn', async (_e, email: string, password: string) =>
    afterAccount(await acct.signIn(email, password))
  )
  ipcMain.handle('account:signUp', async (_e, email: string, password: string) =>
    afterAccount(await acct.signUp(email, password))
  )
  ipcMain.handle('account:forgotPassword', (_e, email: string) => acct.forgotPassword(email))
  ipcMain.handle('account:resendConfirmation', (_e, email: string) => acct.resendConfirmation(email))
  ipcMain.handle('account:changePassword', async (_e, currentPassword: string, newPassword: string) =>
    afterAccount(await acct.changePassword(currentPassword, newPassword))
  )
  ipcMain.handle('account:signOut', async () => afterAccount(await acct.signOut()))
  ipcMain.handle('account:unlock', async (_e, code: string) => {
    await acct.getConfig().catch(() => undefined) // the hosted model list, if reachable
    return afterAccount(await acct.unlock(code))
  })

  // One place that starts kernel sessions: the legacy kernel:startSession and threads.create/resume.
  async function startKernelSession(dir: string): Promise<string> {
    if (shutdown.closing()) throw new Error('The app is saving before closing. Please wait.')
    syncAccess()
    if (existsSync(join(dir, '.humanstudy', 'project.json'))) await refreshPack(dir)
    // No opencode installed: fetch the managed one first, and replace a mock kernel created before it arrived.
    if (process.env.HUMANSTUDY_KERNEL !== 'mock') {
      await ensureAssistant().catch((err) => console.error('assistant install failed', err))
      const bin = kernelBinary() // also publishes HUMANSTUDY_OPENCODE_BIN for the kernel factory
      if (kernel && kernelName(kernel) === 'mock' && bin) markKernelStale()
    }
    const k = currentKernel()
    const started = Date.now()
    let id: string
    try {
      id = await k.startSession(dir)
    } catch (err) {
      telemetry.trackSessionError(dir, err, started)
      throw err
    }
    sessionKernel.set(id, k)
    sessionProject.set(id, dir)
    paperBuilds.bind(id, dir)
    notify.noteSession(id, dir)
    telemetry.trackSessionStart(id, dir, kernelName(k), started)
    return id
  }
  createThreads(
    {
      kernelName: () => kernelName(currentKernel()),
      restore: async (sid,selection) => {const k=kernelFor(sid);if(k.native)await k.native(sid,{operation:'select',input:selection as Record<string,unknown>})},
      start: startKernelSession,
      resume: async (dir, sid) => {
        const k = sessionKernel.get(sid) ?? currentKernel()
        const alive = await k.resumeSession(dir, sid)
        if (alive) { sessionKernel.set(alive, k); sessionProject.set(alive, dir); paperBuilds.bind(alive, dir) }
        return alive
      },
    },
    (e) => broadcast('threads:changed', e),
    { onCapture: telemetry.onThreadCapture }
  )
  ipcMain.handle('kernel:startSession', async (_e, dir: string) => {
    const id = await startKernelSession(dir)
    threads().adopt(dir, id) // recorded as a thread once the first message is sent
    return id
  })
  threadsInitialized = true
  /** An approved protocol run, started here from the app's trusted copy (review 4, S1), never by the agent: the
   *  run folder and plan.json come from the checked approval, and the run ends its relay when it exits. */
  async function startProtocolRun(projectDir: string, approved: { lang?: unknown; plan?: { perCondition?: unknown; model?: unknown; conditions?: unknown } }, binding: ProtocolBinding, relay: { baseURL: string; token: string; model: string; expiresAt: number } | undefined, ended: () => void) {
    const per = approved.plan?.perCondition
    if (!Number.isSafeInteger(per) || (per as number) < 1 || (per as number) > 60) throw Error('Participants per condition must be a whole number from 1 to 60. Review the simulation scope again.')
    const python = await readyPython()
    if (!python) throw Error('The research runtime is not installed yet, so the run cannot start. Try again in a minute.')
    const runDir = newRunFolder(projectDir)
    // A published study runs from its wording restored on this computer for exactly the approved version.
    const restored = await restoredRunFiles(projectDir, originalTextCache(), binding.protocolSha256)
    await launchProtocolRun({
      python, files: [...trustedRunFiles(), ...restored], codeDir: join(app.getPath('userData'), 'protocol-runs', binding.runId), project: projectDir, runDir, binding,
      plan: { perArm: per as number, arms: null, seeds: [1], temperature: 1.0 },
      relay: relay ? { baseURL: relay.baseURL, token: relay.token, model: relay.model, expiresAt: relay.expiresAt } : undefined,
      // Pre-relay path: the same environment the agent's runs get there (the run confirmation said the key is readable).
      env: relay ? { PATH: (process.env.HUMANSTUDY_RUNTIME_BIN ? process.env.HUMANSTUDY_RUNTIME_BIN + (process.platform === 'win32' ? ';' : ':') : '') + (process.env.PATH ?? '') } : { ...process.env },
      onExit: ended,
      lang: approved.lang === 'zh-CN' ? 'zh-CN' : 'en',
    })
  }

  ipcMain.handle('kernel:send', async (_e, id: string, text: string, workspace?: WorkspaceContext, action?: unknown) => {
    if (shutdown.closing()) throw new Error('The app is saving before closing. Please wait.')
    const k = kernelFor(id)
    // A simulation approval only reaches the agent when the package can run (the Simulation tab checks
    // the same; this is the second line of defence).
    let projectDir = sessionProject.get(id)
    try { projectDir ??= k.directory?.(id) } catch { /* unknown to the kernel; it will refuse the send itself */ }
    await assertRunnablePackage(projectDir, text)
    // The run checks its approval binding and computes its scores with the project's .opencode copy of the app's
    // code; put that copy back at the shipped version before any model access exists (review 3, S3).
    if (projectDir && text.startsWith('[Simulation scope approved]')) await refreshAppOwned(projectDir)
    let startedRelay = false
    if (RELAY && text.startsWith('[Simulation scope approved]')) {
      const owner = projectDir ? runs.claim(projectDir) : null
      if (!projectDir || !owner) throw Error('A simulation is already active in this project.')
      const approved = JSON.parse(text.split('\n')[1])
      const model = approved.plan?.model
      if (typeof model !== 'string' || !model) throw Error('Select a model before running.')
      const key = process.env.HUMANSTUDY_DESKTOP_KEY || (process.env.HUMANSTUDY_DEV_KEYS === '1' ? process.env.OPENROUTER_API_KEY : undefined)
      if (!key) throw Error('Sign in before running a simulation.')
      try {
        // The cap and lifetime follow the approved plan (the same figures the run confirmation showed),
        // rebuilt from the hashed program.json; a forged participant count is refused.
        const limits = await approvedRunLimits(projectDir, text)
        // The run capability names what it may run (review 2, S6): the route the approval names, the SHA-256 of
        // protocol.json as the app reads it now (never a hash typed by the agent), a fresh run id and when it was
        // approved (a stopped run restarts only under a later approval). run_confined.py
        // hands them to the run, and skills/run refuses anything else.
        const route: 'protocol' | 'package' = approved.route === 'protocol' || (approved.route === undefined && approved.protocolHash !== undefined) ? 'protocol' : 'package'
        const binding = { route, runId: randomUUID(), approvedAt: Date.now(), ...(route === 'protocol' ? { protocolSha256: createHash('sha256').update(await readFile(join(projectDir, 'protocol.json'))).digest('hex') } : {}) }
        if (route === 'protocol' && binding.protocolSha256 !== approved.protocolHash) throw Error('The study changed after approval. Review the simulation scope again.')
        // A protocol run gets its capability from the app directly: no descriptor for the agent (review 5, M3).
        // Removals are by owner, so this relay closing late never frees the next run's (review 5, M2).
        let ownClose: (() => Promise<void>) | undefined
        const relay = await startModelRelay({ project: projectDir, model, key, storage: process.env.HUMANSTUDY_RELAY_DIR!, tokenCap: limits.tokens, expiryMinutes: limits.minutes, binding, publish: route !== 'protocol',
        onClose: () => { if (ownClose) runs.forget(id, ownClose); runs.release(projectDir!, owner) },
        upstream: process.env.HUMANSTUDY_DESKTOP_KEY ? process.env.HUMANSTUDY_HOSTED_BASEURL || 'https://humanstudy-hub.com/api/desktop/v1' : 'https://openrouter.ai/api/v1',
        bypass: process.env.HUMANSTUDY_DESKTOP_KEY ? process.env.HUMANSTUDY_SERVER_BYPASS : undefined })
        ownClose = relay.close
        runs.register(id, { project: projectDir, close: relay.close })
        startedRelay = true
        if (route === 'protocol') await startProtocolRun(projectDir, approved, binding as ProtocolBinding, relay, () => { runs.forget(id, relay.close); void relay.close() })
      } catch (error) { if (startedRelay) await closeRunRelay(id); runs.release(projectDir, owner); throw error }
    } else if (projectDir && text.startsWith('[Simulation scope approved]')) {
      // Pre-relay path (Linux, Windows): no relay, but a protocol run is still started by the app from its trusted copy.
      const approved = JSON.parse(text.split('\n')[1])
      if (approved.route === 'protocol' || (approved.route === undefined && approved.protocolHash !== undefined)) {
        const binding: ProtocolBinding = { route: 'protocol', runId: randomUUID(), approvedAt: Date.now(),
          protocolSha256: createHash('sha256').update(await readFile(join(projectDir, 'protocol.json'))).digest('hex') }
        if (binding.protocolSha256 !== approved.protocolHash) throw Error('The study changed after approval. Review the simulation scope again.')
        // No relay here, so no cap: one protocol run per project at a time, held until its process exits (review 5, S5).
        const owner = runs.claim(projectDir)
        if (!owner) throw Error('A simulation is already active in this project.')
        try { await startProtocolRun(projectDir, approved, binding, undefined, () => runs.release(projectDir, owner)) }
        catch (error) { runs.release(projectDir, owner); throw error }
      }
    }
    telemetry.trackTurnStart(id, text, actionRef(action))
    const prompt = withPrivateCopyNote(threads().beforeSend(id, text, workspace), text, projectDir ? privateImports.get(resolve(projectDir)) ?? [] : [])
    const alreadyActive = activeTurns.has(id)
    activeTurns.add(id)
    const buildState = projectDir ? paperBuilds.read(projectDir) : undefined
    const purpose = isBuildTurn(buildState, id, actionRef(action)?.target) ? 'build' as const : undefined
    try { await k.send(id, prompt, { purpose }) }
    catch (error) { if (startedRelay) await closeRunRelay(id); if (!alreadyActive) activeTurns.delete(id); paperBuilds.sendFailed(id, error); throw error }
  })
  ipcMain.handle('kernel:export', async (_e,sid:string) => {
    const k=kernelFor(sid)
    if(!k.native)throw Error('OpenCode is unavailable.')
    const [session,messages]=await Promise.all([k.native(sid,{operation:'session'}),k.native(sid,{operation:'history'})])
    const choice=await dialog.showSaveDialog({title:'Export complete conversation',defaultPath:'conversation-'+sid+'.json',filters:[{name:'JSON',extensions:['json']},{name:'Markdown',extensions:['md']}]})
    if(choice.canceled||!choice.filePath)return null
    const content=JSON.stringify({session,messages},null,2)+'\n'
    await writeFile(choice.filePath,choice.filePath.endsWith('.md')?'# Conversation\n\n```json\n'+content+'```\n':content,'utf8')
    return choice.filePath
  })
  ipcMain.handle('kernel:native', async (_e, sid: string, request: NativeRequest, action?: unknown) => {
    const ref = actionRef(action)
    if (!request || typeof request.operation !== 'string') throw Error('Choose an OpenCode action.')
    if (shutdown.closing() && NATIVE_MUTATIONS.has(request.operation)) throw Error('The app is saving before closing.')
    const k=kernelFor(sid)
    if (!k.native) throw Error('This action needs the OpenCode kernel. It is unavailable in mock mode.')
    let operation=request
    if(request.operation==='undo' && !request.input?.messageID){
      const history=await k.native(sid,{operation:'history'}) as Array<{info:{id:string;role:string}}>
      const info=await k.native(sid,{operation:'session'}) as {revert?:{messageID:string}}
      const boundary=info.revert?history.findIndex(m=>m.info.id===info.revert!.messageID):history.length
      const last=history.slice(0,boundary<0?history.length:boundary).filter(m=>m.info.role==='user').at(-1)
      if(!last)throw Error('There is no earlier user turn to undo.')
      operation={...request,input:{...request.input,messageID:last.info.id}}
    }
    if(NATIVE_TURNS.has(request.operation)){
      activeTurns.add(sid)
      if(request.operation!=='compact')threads().beforeSend(sid, request.operation==='shell' ? '!'+String(request.input?.command??'') : '/'+String(request.input?.command??'')+' '+String(request.input?.arguments??''))
      telemetry.trackTurnStart(sid,'/'+request.operation,ref)
    } else if (ref && (ref.via !== 'system' || NATIVE_MUTATIONS.has(request.operation))) telemetry.noteAction(ref, sessionProject.get(sid)) // background reads are not operations
    telemetry.track('agent.native_action',{target:request.operation})
    const result=await k.native(sid,operation)
    if(request.operation==='select'){threads().rememberSelection(sid,result as NativeSelection);telemetry.track('agent.configuration',{metadata:result as Record<string,unknown>})}
    if(['open','fork','undo','redo'].includes(request.operation)){
      const next=['open','fork'].includes(request.operation)?(result as {id:string}).id:sid
      const current=await k.native(next,{operation:'session'}) as {title:string;directory:string;revert?:{messageID:string}}
      const history=await k.native(next,{operation:'history'}) as any[]
      const dir=ownedPath(k.directory?.(next)??current.directory)
      if(['open','fork'].includes(request.operation)){sessionKernel.set(next,k);sessionProject.set(next,dir);paperBuilds.bind(next,dir);notify.noteSession(next,dir);telemetry.trackSessionStart(next,dir,kernelName(k),Date.now())}
      const thread=await threads().fromNative(dir,next,nativeMessages(history,current.revert?.messageID),current.title,!['open','fork'].includes(request.operation))
      if(request.operation==='fork'){
        const catalog=await k.native(next,{operation:'catalog'}) as {selection:NativeSelection}
        threads().rememberSelection(next,catalog.selection)
        return threads().get(dir,thread.id)
      }
      if(request.operation==='open'&&thread.nativeSelection){
        try{await k.native(next,{operation:'select',input:thread.nativeSelection as Record<string,unknown>})}
        catch(error){thread.nativeSelectionWarning='Previous agent/model settings could not be restored: '+String(error)}
      }
      return thread
    }
    if(request.operation==='archive')threads().archiveSession(sid)
    if(request.operation==='rename'){
      const binding=await k.native(sid,{operation:'session'}) as {directory:string;title:string}
      const list=await threads().list(ownedPath(binding.directory))
      for(const t of list){const full=await threads().get(binding.directory,t.id);if(full.kernelSessionId===sid)await threads().rename(binding.directory,t.id,binding.title)}
    }
    return result
  })
  ipcMain.handle('kernel:abort', (_e, id: string, action?: unknown) => {
    telemetry.trackTurnAbort(id, actionRef(action))
    void closeRunRelay(id)
    return kernelFor(id).abort(id)
  })
  ipcMain.handle('kernel:reply', (_e, id: string, permissionId: string, response: 'once' | 'always' | 'reject', action?: unknown) => {
    if (shutdown.closing()) throw new Error('The app is saving before closing. Please wait.')
    if (response !== 'once' && response !== 'always' && response !== 'reject') throw new Error('bad permission response')
    telemetry.notePermission(id, permissionId, actionRef(action))
    return kernelFor(id).reply(id, permissionId, response)
  })
  ipcMain.handle('kernel:questions', async (_e, id: string) => {
    const pending = await kernelFor(id).questions(id)
    if (pending.length) activeTurns.add(id)
    return pending
  })
  ipcMain.handle('kernel:answerQuestion', (_e, id: string, questionId: string, answers: string[][], action?: unknown) => {
    if (shutdown.closing()) throw new Error('The app is saving before closing. Please wait.')
    telemetry.noteAnswer(id, questionId, actionRef(action))
    return kernelFor(id).answerQuestion(id, questionId, answers)
  })
  ipcMain.handle('kernel:rejectQuestion', (_e, id: string, questionId: string, action?: unknown) => {
    telemetry.noteAnswer(id, questionId, actionRef(action))
    return kernelFor(id).rejectQuestion(id, questionId)
  })
  ipcMain.handle('threads:list', (_e, dir: string) => threads().list(threadDir(dir)))
  ipcMain.handle('threads:get', (_e, dir: string, id: string) => threads().get(threadDir(dir), id))
  ipcMain.handle('threads:create', (_e, dir: string) => threads().create(threadDir(dir)))
  ipcMain.handle('threads:resume', (_e, dir: string, id: string) => threads().resume(threadDir(dir), id))
  ipcMain.handle('threads:rename', (_e, dir: string, id: string, title: string) =>
    threads().rename(threadDir(dir), id, title)
  )
  ipcMain.handle('threads:delete', (_e, dir: string, id: string) => threads().delete(threadDir(dir), id))
  telemetry.registerTelemetry()

  ipcMain.handle('kernel:installStatus', () => installStatus())
  ipcMain.handle('kernel:installRetry', async () => {
    await ensureAssistant().catch((err) => console.error('assistant install failed', err))
  })
  onInstallProgress((s) => broadcast('kernel:installProgress', s))
  // First run: start the download in the background so it is usually done before the first message.
  if (process.env.HUMANSTUDY_KERNEL !== 'mock') void ensureAssistant().catch((err) => console.error('assistant install failed', err))
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    kernelPath: managedBinary() ?? kernelBinary() ?? undefined,
    home: app.getPath('home'),
    devKeys: process.env.HUMANSTUDY_DEV_KEYS === '1',
  }))

  ipcMain.handle('updates:status', () => updateStatus())
  ipcMain.handle('updates:check', () => checkForUpdates())
  // Ask about unsaved drafts before the update stops the agent and quits: Cancel must leave everything
  // running (on Windows the installer starts before the app quits, so asking later is too late).
  ipcMain.handle('updates:install', () => (confirmDiscardAll() ? installUpdate() : undefined))
  startUpdates((s) => broadcast('updates:changed', s), () => shutdown.prepare(true), () => { shutdown.reset() })

  setupMenu({ newWindow: createWindow, checkForUpdates: () => void checkForUpdates() })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', event => {
  // Ask about unsaved edits before the kernels are stopped, so Cancel leaves everything running.
  if (!confirmDiscardAll()) return event.preventDefault()
  if (!primaryInstance || shutdown.ready()) return
  event.preventDefault()
  void shutdown.prepare(false).then(ready => {
    if (ready) app.quit()
    else if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Native kernels already have a synchronous SIGKILL process-exit hook. Keep that
// hook/session alive during preparation; only cancel downloads once quit is committed.
app.on('will-quit', () => { cancelAssistantInstall(); stopUpdates() })

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
