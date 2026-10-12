// "Agent finished" notification, Dock bounce and Dock badge for a turn that ends in the background.
import { BrowserWindow, Notification, app } from 'electron'
import { basename } from 'node:path'
import type { KernelEvent } from './kernel-types'
import { notifyTitle, shouldNotify } from './notify-core'
import { getSettings } from './settings'

const sessionDir = new Map<string, string>()
let wired = false

export function noteSession(id: string, dir: string): void {
  sessionDir.set(id, dir)
}

function focusApp(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function clearBadge(): void {
  if (process.platform === 'darwin') app.dock?.setBadge('')
}

export function onKernelEvent(e: KernelEvent): void {
  if (!wired) {
    wired = true
    app.on('browser-window-focus', clearBadge)
  }
  const anyWindowFocused = BrowserWindow.getAllWindows().some((w) => w.isFocused())
  if (!shouldNotify({ enabled: getSettings().notifications, anyWindowFocused, eventType: e.type })) return
  const dir = sessionDir.get(e.sessionId)
  const name = dir ? basename(dir) : 'HumanStudy'
  if (Notification.isSupported()) {
    const n = new Notification({ title: notifyTitle(name), silent: false })
    n.on('click', focusApp)
    n.show()
  }
  if (process.platform === 'darwin') {
    app.dock?.bounce('informational')
    app.dock?.setBadge('1')
  }
}
