// Public GitHub updates; downloaded releases are installed only after the main process saves.
import { app, autoUpdater as nativeUpdater } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateStatus } from '../preload/types'
import { createUpdateController, createUpdateInstaller, waitForNativeUpdate } from './updates-core'

const { autoUpdater } = electronUpdater
let notify: (s: UpdateStatus) => void = () => undefined
const controller = createUpdateController({ client: autoUpdater, version: app.getVersion(), notify: s => notify(s) })
let started = false
let firstTimer: NodeJS.Timeout | undefined
let interval: NodeJS.Timeout | undefined
let prepareInstall: () => Promise<boolean> = async () => false
let rollbackInstall: () => void = () => undefined

export const updateStatus = controller.status
export async function checkForUpdates(): Promise<void> {
  if (app.isPackaged) await controller.check()
}

let nativeReady = false
const installer = createUpdateInstaller({
  ready: () => controller.status().state === 'ready',
  waitForNative: async () => {
    if (process.platform === 'darwin' && !nativeReady) await waitForNativeUpdate(nativeUpdater)
  },
  prepare: () => prepareInstall(),
  rollback: () => rollbackInstall(),
  launch: () => autoUpdater.quitAndInstall(false, true),
  report: error => controller.reportError(error),
})
autoUpdater.on('error', error => installer.failed(error))
export const installUpdate = installer.run

export function stopUpdates(): void {
  installer.exiting()
  clearTimeout(firstTimer)
  clearInterval(interval)
  controller.stop()
}

export function startUpdates(onChange: (s: UpdateStatus) => void, beforeInstall: () => Promise<boolean>, onFailedInstall: () => void): void {
  notify = onChange
  prepareInstall = beforeInstall
  rollbackInstall = onFailedInstall
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
