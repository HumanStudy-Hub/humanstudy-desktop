import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { applyCredentials, providers, setKey } from './credentials'
import { applyAccount, getAccount } from './account'
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
import { readFile, readdir } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as kernelModule from './kernel'
import type { Kernel, KernelEvent } from './kernel-types'
import type { ProjectFile, ProjectSnapshot, Settings } from '../preload/types'

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
      title: 'Open a HumanStudy project',
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
    return snap
  })
  ipcMain.handle('project:reveal', (_e, p: string) => shell.showItemInFolder(p))

  ipcMain.handle('projects:list', () => listProjects())
  ipcMain.handle('projects:create', (_e, input: { name: string; pdfPath?: string; sample?: boolean }) =>
    createProject(input)
  )
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
  ipcMain.handle('community:fork', (_e, id: string) => forkCommunityStudy(id, (input) => createProject(input)))
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
    const k = currentKernel()
    const id = await k.startSession(dir)
    sessionKernel.set(id, k)
    return id
  })
  ipcMain.handle('kernel:send', (_e, id: string, text: string) => kernelFor(id).send(id, text))
  ipcMain.handle('kernel:abort', (_e, id: string) => kernelFor(id).abort(id))

  ipcMain.handle('updates:status', () => updateStatus())
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:install', () => installUpdate())
  startUpdates((s) => broadcast('updates:changed', s))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  for (const k of allKernels) {
    const d = (k as { dispose?: () => Promise<void> }).dispose
    if (d) void d.call(k).catch(() => undefined)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
