// Native application menu. Items that the renderer owns are sent as one `menu:command` message
// ({command, arg?}) to the focused window, so ⌘N in one window does not open dialogs in all of them.
import { BrowserWindow, Menu, app, shell, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../preload/types'

export interface MenuHooks {
  newWindow(): void
  checkForUpdates(): void | Promise<void>
}

const DOCS = 'https://humanstudy-hub.com'
const RELEASES = 'https://github.com/HumanStudy-Hub/humanstudy-desktop/releases'
const ISSUES = 'https://github.com/HumanStudy-Hub/humanstudy-desktop/issues'

function send(c: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('menu:command', c)
}

export function buildMenu(hooks: MenuHooks): Menu {
  const mac = process.platform === 'darwin'
  const pane = (label: string, arg: string, n: number): MenuItemConstructorOptions => ({
    label,
    accelerator: `CmdOrCtrl+${n}`,
    click: () => send({ command: 'pane', arg }),
  })
  const template: MenuItemConstructorOptions[] = []
  if (mac) {
    template.push({
      label: app.name,
      submenu: [
        { label: `About ${app.name}`, click: () => app.showAboutPanel() },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'Cmd+,', click: () => send({ command: 'settings' }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }
  template.push(
    {
      label: 'File',
      submenu: [
        { label: 'New project', accelerator: 'CmdOrCtrl+N', click: () => send({ command: 'newProject' }) },
        { label: 'New window', accelerator: 'CmdOrCtrl+Shift+N', click: () => hooks.newWindow() },
        { label: 'Open folder…', accelerator: 'CmdOrCtrl+O', click: () => send({ command: 'openFolder' }) },
        { type: 'separator' },
        { role: 'close', label: 'Close window', accelerator: 'CmdOrCtrl+W' },
        ...(mac
          ? []
          : ([
              { label: 'Settings…', accelerator: 'Ctrl+,', click: () => send({ command: 'settings' }) },
              { type: 'separator' },
              { role: 'quit' },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        pane('Show chat', 'agent', 1),
        pane('Study', 'study', 2),
        pane('Paper', 'paper', 3),
        { label: 'Show or hide files', accelerator: 'CmdOrCtrl+B', click: () => send({ command: 'pane', arg: 'files' }) },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged
          ? []
          : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Documentation', click: () => void shell.openExternal(DOCS) },
        { label: 'Release notes', click: () => void shell.openExternal(RELEASES) },
        { label: 'Report a problem', click: () => void shell.openExternal(ISSUES) },
        { type: 'separator' },
        { label: 'Check for updates…', click: () => void hooks.checkForUpdates() },
      ],
    }
  )
  return Menu.buildFromTemplate(template)
}

export function setupMenu(hooks: MenuHooks): void {
  app.setAboutPanelOptions({ applicationName: app.name, applicationVersion: app.getVersion(), version: '', copyright: 'MIT licence' })
  Menu.setApplicationMenu(buildMenu(hooks))
}
