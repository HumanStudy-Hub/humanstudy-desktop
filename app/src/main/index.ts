import { NATIVE_TURNS, NATIVE_MUTATIONS, type NativeRequest, type NativeSelection } from '../shared/native'
import { nativeMessages } from './native-history'
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
import { createProject, isInside, listProjects, renameProject, trashProject } from './projects'
import { applySettings, ensureProjectsRoot, getSettings, setSettings } from './settings'
import { checkForUpdates, installUpdate, startUpdates, stopUpdates, updateStatus } from './updates'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as kernelModule from './kernel'
import { isVersioned, readVersion, relOf, snapshot, versionsOf } from './versions'
import { createThreads, threads } from './threads'
import { createShutdown } from './shutdown-core'
import { refreshPack } from './pack'
import type { Kernel, KernelEvent } from './kernel-types'
import type { ProjectEntry, ProjectFile, ProjectSnapshot, Settings, WorkspaceContext } from '../preload/types'

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
const activeTurns = new Set<string>()
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
  flush: async () => { if (threadsInitialized) await threads().flush() },
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
  const root = resolve(getSettings().projectsRoot)
  if (q === root || q.startsWith(root + sep)) return true
  return [...allowedRoots].some((r) => q === r || q.startsWith(r + sep))
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
      try {
        const st = await stat(path)
        size = st.size
        mtime = Math.round(st.mtimeMs)
      } catch {
        /* unreadable */
      }
      out.push({ name: d.name, path, rel, kind: 'file', ext: extname(d.name).slice(1).toLowerCase(), url: toUrl(path), size, mtime })
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
  return {
    dir,
    name: basename(dir),
    program,
    programError,
    artifacts: await listDir(join(dir, 'artifacts')),
    exports: await listDir(join(dir, 'exports')),
    pdf: pdfPath ? { name: 'paper.pdf', path: pdfPath, url: toUrl(pdfPath), ext: 'pdf' } : null,
    tree: await listTree(dir, dir, 0, { n: 0 }),
  }
}

// ---- watch the open project so new artifacts appear without a reload -----------------
const watchers = new Map<string, FSWatcher>()
const snapTimers = new Map<string, NodeJS.Timeout>()
function watchProject(dir: string): void {
  if (watchers.has(dir)) return
  let timer: NodeJS.Timeout | undefined
  try {
    const w = watch(dir, { recursive: true }, (_e, file) => {
      if (file && String(file).startsWith('.humanstudy')) return
      if (file) telemetry.noteFsChange(dir, String(file))
      if (file) {
        // A history for what the agent (or the researcher) wrote; debounced so one write is one version.
        const rel = String(file).split(sep).join('/')
        if (isVersioned(rel)) {
          const k = `${dir}\n${rel}`
          clearTimeout(snapTimers.get(k))
          snapTimers.set(k, setTimeout(() => { snapTimers.delete(k); void snapshot(dir, rel).catch(() => undefined) }, 600))
        }
      }
      clearTimeout(timer)
      timer = setTimeout(() => broadcast('project:changed', dir), 250)
    })
    watchers.set(dir, w)
  } catch {
    /* watching is a convenience */
  }
}

/** The opened project folder a file belongs to. */
function projectRootOf(file: string): string {
  const q = resolve(file)
  for (const d of watchers.keys()) if (q.startsWith(d + sep)) return d
  throw new Error('that file is not in an opened project')
}

function unwatch(dir: string): void {
  watchers.get(dir)?.close()
  watchers.delete(dir)
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

app.whenReady().then(() => {
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
    await copyFile(q, r.filePath)
    return r.filePath
  })
  ipcMain.handle('project:readText', async (_e, p: string) => {
    const q = ownedPath(p)
    if ((await stat(q)).size > TEXT_LIMIT) throw new Error('file is larger than 4 MB')
    return readFile(q, 'utf8')
  })
  ipcMain.handle('project:writeText', async (_e, p: string, text: string) => {
    const q = ownedPath(p)
    if (typeof text !== 'string' || text.length > TEXT_LIMIT) throw new Error('text is too large')
    if (basename(q) === 'program.json') JSON.parse(text) // never leave the program unreadable
    await mkdir(dirname(q), { recursive: true })
    telemetry.noteHumanWrite(q)
    await writeFile(q, text, 'utf8')
    telemetry.track('file.edited', { target: extname(q).slice(1) || 'file' })
  })

  ipcMain.handle('project:importFiles', async (_e, dir: string, paths: string[]) => {
    const root = ownedPath(dir)
    if (!Array.isArray(paths) || paths.length > 50) throw new Error('too many files')
    const hasPaper = existsSync(join(root, 'paper.pdf'))
    let paperTaken = hasPaper
    const out: ProjectFile[] = []
    for (const src of paths) {
      if (typeof src !== 'string' || !(await stat(src)).isFile()) continue
      let name = basename(src)
      let target: string
      if (!paperTaken && extname(name).toLowerCase() === '.pdf') {
        target = join(root, 'paper.pdf')
        paperTaken = true
      } else {
        await mkdir(join(root, 'sources'), { recursive: true })
        const ext = extname(name)
        const stem = name.slice(0, name.length - ext.length)
        target = join(root, 'sources', name)
        for (let n = 2; existsSync(target); n++) target = join(root, 'sources', `${stem} ${n}${ext}`)
        name = basename(target)
      }
      await copyFile(src, target, 1) // COPYFILE_EXCL: never overwrite
      out.push({ name: basename(target), path: target, url: toUrl(target), ext: extname(target).slice(1).toLowerCase() })
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
  ipcMain.handle('projects:create', async (_e, input: { name: string; pdfPath?: string; sample?: boolean }) => {
    const dir = await createProject(input)
    telemetry.track('project.created', { metadata: { sample: Boolean(input?.sample), withPaper: Boolean(input?.pdfPath) } }, dir)
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
    if (!isAllowedExternal(url)) throw new Error('refusing to open a URL outside github.com / humanstudy-hub.org')
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
        if (alive) sessionKernel.set(alive, k)
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
  ipcMain.handle('kernel:send', async (_e, id: string, text: string, workspace?: WorkspaceContext) => {
    if (shutdown.closing()) throw new Error('The app is saving before closing. Please wait.')
    const k = kernelFor(id)
    telemetry.trackTurnStart(id, text)
    const prompt = threads().beforeSend(id, text, workspace)
    const alreadyActive = activeTurns.has(id)
    activeTurns.add(id)
    try { await k.send(id, prompt) }
    catch (error) { if (!alreadyActive) activeTurns.delete(id); throw error }
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
  ipcMain.handle('kernel:native', async (_e, sid: string, request: NativeRequest) => {
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
      telemetry.trackTurnStart(sid,'/'+request.operation)
    }
    telemetry.track('agent.native_action',{target:request.operation})
    const result=await k.native(sid,operation)
    if(request.operation==='select'){threads().rememberSelection(sid,result as NativeSelection);telemetry.track('agent.configuration',{metadata:result as Record<string,unknown>})}
    if(['open','fork','undo','redo'].includes(request.operation)){
      const next=['open','fork'].includes(request.operation)?(result as {id:string}).id:sid
      const current=await k.native(next,{operation:'session'}) as {title:string;directory:string;revert?:{messageID:string}}
      const history=await k.native(next,{operation:'history'}) as any[]
      const dir=ownedPath(k.directory?.(next)??current.directory)
      if(['open','fork'].includes(request.operation)){sessionKernel.set(next,k);notify.noteSession(next,dir);telemetry.trackSessionStart(next,dir,kernelName(k),Date.now())}
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
  ipcMain.handle('kernel:abort', (_e, id: string) => {
    telemetry.trackTurnAbort(id)
    return kernelFor(id).abort(id)
  })
  ipcMain.handle('kernel:reply', (_e, id: string, permissionId: string, response: 'once' | 'always' | 'reject') => {
    if (shutdown.closing()) throw new Error('The app is saving before closing. Please wait.')
    if (response !== 'once' && response !== 'always' && response !== 'reject') throw new Error('bad permission response')
    return kernelFor(id).reply(id, permissionId, response)
  })
  ipcMain.handle('kernel:questions', async (_e, id: string) => {
    const pending = await kernelFor(id).questions(id)
    if (pending.length) activeTurns.add(id)
    return pending
  })
  ipcMain.handle('kernel:answerQuestion', (_e, id: string, questionId: string, answers: string[][]) => {
    if (shutdown.closing()) throw new Error('The app is saving before closing. Please wait.')
    return kernelFor(id).answerQuestion(id, questionId, answers)
  })
  ipcMain.handle('kernel:rejectQuestion', (_e, id: string, questionId: string) => kernelFor(id).rejectQuestion(id, questionId))
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
  ipcMain.handle('updates:install', () => installUpdate())
  startUpdates((s) => broadcast('updates:changed', s), () => shutdown.prepare(true), () => { shutdown.reset() })

  setupMenu({ newWindow: createWindow, checkForUpdates: () => void checkForUpdates() })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', event => {
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
