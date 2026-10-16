// Public GitHub updates; downloaded releases are installed only after the main process saves.
import { app, autoUpdater as nativeUpdater } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../preload/types'
import { createUpdateController, waitForNativeUpdate } from './updates-core'

const { autoUpdater } = electronUpdater
let notify: (s: UpdateStatus) => void = () => undefined
const controller = createUpdateController({ client: autoUpdater, version: app.getVersion(), notify: s => notify(s) })
let started = false
let firstTimer: NodeJS.Timeout | undefined
let interval: NodeJS.Timeout | undefined
let prepareInstall: () => Promise<boolean> = async () => false

export const updateStatus = controller.status
export async function checkForUpdates(): Promise<void> {
  if (app.isPackaged) await controller.check()
}

let nativeReady = false
let installing = false
export async function installUpdate(): Promise<void> {
  if (controller.status().state !== 'ready' || installing) return
  installing = true
  try {
    if (process.platform === 'darwin' && !nativeReady) await waitForNativeUpdate(nativeUpdater)
    if (await prepareInstall()) {
      // The shutdown coordinator already saved and quiesced the agent.
      autoUpdater.quitAndInstall(false, true)
    }
  } catch (error) { controller.reportError(error) }
  finally { installing = false }
}

export function stopUpdates(): void {
  clearTimeout(firstTimer)
  clearInterval(interval)
  controller.stop()
}

export function startUpdates(onChange: (s: UpdateStatus) => void, beforeInstall: () => Promise<boolean>): void {
  notify = onChange
  prepareInstall = beforeInstall
  if (started) return
  started = true
  if (!app.isPackaged) return
  if (process.platform === 'darwin') nativeUpdater.on('update-downloaded', () => { nativeReady = true })
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = console
  firstTimer = setTimeout(() => void controller.check(false), 10_000)
  interval = setInterval(() => void controller.check(false), 6 * 60 * 60 * 1000)
  interval.unref?.()
}
