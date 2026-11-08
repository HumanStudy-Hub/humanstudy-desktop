// "Agent finished" notification, Dock bounce and Dock badge for a turn that ends in the background.
import { BrowserWindow, Notification, app } from 'electron'
import { basename } from 'node:path'
import type { KernelEvent } from './kernel-types'
import { notifyKind, notifyTitle } from './notify-core'
import { getSettings } from './settings'

const sessionDir = new Map<string, string>()
let wired = false
const asked = new Set<string>()

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
  const asking = e.type === 'question' ? e.question : e.type === 'permission' ? e.permission : undefined
  const kind = notifyKind({ enabled: getSettings().notifications, anyWindowFocused, eventType: e.type, resolved: Boolean(asking?.resolved) })
  if (!kind) return
  // One notification per question or permission request, however often its event is repeated.
  if (kind === 'waiting') {
    const key = `${e.sessionId}:${asking?.id ?? ''}`
    if (asked.has(key)) return
    asked.add(key)
  }
  const dir = sessionDir.get(e.sessionId)
  const name = dir ? basename(dir) : 'HumanStudy'
  if (Notification.isSupported()) {
    const n = new Notification({ title: notifyTitle(name, kind), silent: false })
    n.on('click', focusApp)
    n.show()
  }
  if (process.platform === 'darwin') {
    app.dock?.bounce('informational')
    app.dock?.setBadge('1')
  }
}
