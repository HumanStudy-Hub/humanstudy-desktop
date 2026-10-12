import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { applyCredentials, providers, setKey } from './credentials'
import { applyAccount, getAccount } from './account'
import * as telemetry from './telemetry'
import { setupMenu } from './menu'
import * as notify from './notify'
import { cancelInstall, ensureOpencode, installStatus, kernelBinary, managedBinary, onInstallProgress } from './opencode-install'
import {
  communityStudies,
  communityStudy,
  forkCommunityStudy,
  isAllowedExternal,
  setCommunityCacheDir,
} from './community'
import { createProject, isInside, listProjects, renameProject, trashProject } from './projects'
import { applySettings, ensureProjectsRoot, getSettings, setSettings } from './settings'
import { checkForUpdates, installUpdate, startUpdates, updateStatus } from './updates'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as kernelModule from './kernel'
import type { Kernel, KernelEvent } from './kernel-types'
import type { ProjectEntry, ProjectFile, ProjectSnapshot, Settings } from '../preload/types'

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
function currentKernel(): Kernel {
  if (!kernel) {
    kernel = loadKernel()
    allKernels.add(kernel)
    kernel.onEvent((e: KernelEvent) => broadcast('kernel:event', e))
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
const TREE_LIMIT = 3000
async function listTree(root: string, dir: string, depth: number, count: { n: number }): Promise<ProjectEntry[]> {
  if (!existsSync(dir) || depth > 8) return []
  const entries = (await readdir(dir, { withFileTypes: true })).filter((d) => !HIDDEN_DIRS.has(d.name) && !d.name.startsWith('.'))
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  const out: ProjectEntry[] = []
  for (const d of entries) {
    if (count.n++ > TREE_LIMIT) break
    const path = join(dir, d.name)
    const rel = relative(root, path).split(sep).join('/')
    if (d.isDirectory()) out.push({ name: d.name, path, rel, kind: 'dir', ext: '', children: await listTree(root, path, depth + 1, count) })
    else if (d.isFile()) {
      let size: number | undefined
      try {
        size = (await stat(path)).size
      } catch {
        /* unreadable */
      }
      out.push({ name: d.name, path, rel, kind: 'file', ext: extname(d.name).slice(1).toLowerCase(), url: toUrl(path), size })
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
function watchProject(dir: string): void {
  if (watchers.has(dir)) return
  let timer: NodeJS.Timeout | undefined
  try {
    const w = watch(dir, { recursive: true }, (_e, file) => {
      if (file && String(file).startsWith('.humanstudy')) return
      clearTimeout(timer)
      timer = setTimeout(() => broadcast('project:changed', dir), 250)
    })
    watchers.set(dir, w)
  } catch {
    /* watching is a convenience */
  }
}

function unwatch(dir: string): void {
  watchers.get(dir)?.close()
  watchers.delete(dir)
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload)
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
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
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
    return net.fetch(pathToFileURL(p).toString())
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
    await writeFile(q, text, 'utf8')
    telemetry.track('file.edited', { target: extname(q).slice(1) || 'file' })
  })

  ipcMain.handle('projects:list', () => listProjects())
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

  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>) => {
    const before = getSettings()
    const next = setSettings(patch)
    if (next.model !== before.model) markKernelStale()
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
  ipcMain.handle('account:signOut', async () => afterAccount(await acct.signOut()))
  ipcMain.handle('account:unlock', async (_e, code: string) => {
    await acct.getConfig().catch(() => undefined) // the hosted model list, if reachable
    return afterAccount(await acct.unlock(code))
  })

  ipcMain.handle('kernel:startSession', async (_e, dir: string) => {
    syncAccess()
    // No opencode installed: fetch the managed one first, and replace a mock kernel created before it arrived.
    if (process.env.HUMANSTUDY_KERNEL !== 'mock') {
      await ensureOpencode().catch((err) => console.error('opencode install failed', err))
      if (kernel && kernelName(kernel) === 'mock' && kernelBinary()) markKernelStale()
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
  })
  ipcMain.handle('kernel:send', (_e, id: string, text: string) => {
    const k = kernelFor(id)
    telemetry.trackTurnStart(id, text)
    return k.send(id, text)
  })
  ipcMain.handle('kernel:abort', (_e, id: string) => {
    telemetry.trackTurnAbort(id)
    return kernelFor(id).abort(id)
  })
  telemetry.registerTelemetry()

  ipcMain.handle('kernel:installStatus', () => installStatus())
  onInstallProgress((s) => broadcast('kernel:installProgress', s))
  // First run: start the download in the background so it is usually done before the first message.
  if (process.env.HUMANSTUDY_KERNEL !== 'mock') void ensureOpencode().catch((err) => console.error('opencode install failed', err))
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    kernelPath: managedBinary() ?? kernelBinary() ?? undefined,
  }))

  ipcMain.handle('updates:status', () => updateStatus())
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:install', () => installUpdate())
  startUpdates((s) => broadcast('updates:changed', s))

  setupMenu({ newWindow: createWindow, checkForUpdates: () => void checkForUpdates() })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  cancelInstall()
  for (const k of allKernels) {
    const d = (k as { dispose?: () => Promise<void> }).dispose
    if (d) void d.call(k).catch(() => undefined)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
