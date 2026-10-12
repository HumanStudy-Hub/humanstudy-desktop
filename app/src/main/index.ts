import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as kernelModule from './kernel'
import type { Kernel, KernelEvent } from './kernel-types'
import type { ProjectFile, ProjectSnapshot } from '../preload/types'

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
const kernel = loadKernel()

// ---- project files over a private protocol, limited to opened projects --------------
protocol.registerSchemesAsPrivileged([
  { scheme: 'hsfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])
const allowedRoots = new Set<string>()
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
  allowedRoots.add(dir)
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
  protocol.handle('hsfile', (req) => {
    const p = resolve(decodeURIComponent(new URL(req.url).pathname.slice(1)))
    const ok = [...allowedRoots].some((r) => p === r || p.startsWith(r + sep))
    if (!ok) return new Response('forbidden', { status: 403 })
    return net.fetch(pathToFileURL(p).toString())
  })

  ipcMain.handle('project:open', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = {
      title: 'Open a HumanStudy project',
      defaultPath: join(app.getPath('home'), 'HumanStudy'),
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle('project:read', async (_e, dir: string) => {
    const snap = await readProject(dir)
    watchProject(snap.dir)
    return snap
  })
  ipcMain.handle('project:reveal', (_e, p: string) => shell.showItemInFolder(p))

  ipcMain.handle('kernel:startSession', (_e, dir: string) => kernel.startSession(dir))
  ipcMain.handle('kernel:send', (_e, id: string, text: string) => kernel.send(id, text))
  ipcMain.handle('kernel:abort', (_e, id: string) => kernel.abort(id))
  kernel.onEvent((e: KernelEvent) => broadcast('kernel:event', e))

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
