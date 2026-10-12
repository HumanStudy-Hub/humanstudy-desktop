// Auto-update through electron-updater against GitHub Releases (HumanStudy-Hub/humanstudy-desktop,
// public, so no token). Packaged builds only: check 10 s after launch and every 6 hours, download
// in the background, and tell the renderer when an update is ready to install on restart.
import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../preload/types'

const { autoUpdater } = electronUpdater

const FIRST_CHECK_MS = 10_000
const INTERVAL_MS = 6 * 60 * 60 * 1000

let status: UpdateStatus = { version: app.getVersion(), state: 'idle' }
let notify: (s: UpdateStatus) => void = () => undefined
let started = false

function set(patch: Partial<UpdateStatus>): void {
  status = { version: app.getVersion(), ...patch } as UpdateStatus
  notify(status)
}

export function updateStatus(): UpdateStatus {
  return status
}

export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    set({ state: 'none', error: undefined })
    return
  }
  // Already downloading or downloaded: a new check would only restart the work.
  if (status.state === 'downloading' || status.state === 'ready' || status.state === 'checking') return
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    set({ state: 'error', error: e instanceof Error ? e.message : String(e) })
  }
}

export function installUpdate(): void {
  if (status.state !== 'ready') return
  // isSilent=false shows the Windows installer progress; isForceRunAfter=true relaunches the app.
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
}

/** Wire events and start the schedule. `onChange` receives every status change. */
export function startUpdates(onChange: (s: UpdateStatus) => void): void {
  notify = onChange
  if (started) return
  started = true
  if (!app.isPackaged) {
    console.log('updates: not packaged, auto-update disabled')
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console

  autoUpdater.on('checking-for-update', () => set({ state: 'checking' }))
  autoUpdater.on('update-available', (info) => set({ state: 'available', nextVersion: info.version }))
  autoUpdater.on('update-not-available', () => set({ state: 'none' }))
  autoUpdater.on('download-progress', (p) =>
    set({ state: 'downloading', nextVersion: status.nextVersion, progress: Math.round(p.percent) })
  )
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', nextVersion: info.version, progress: 100 }))
  autoUpdater.on('error', (e) =>
    set({ state: 'error', nextVersion: status.nextVersion, error: e?.message ?? String(e) })
  )

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_MS)
  setInterval(() => void checkForUpdates(), INTERVAL_MS).unref?.()
}
