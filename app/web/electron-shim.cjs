// The `electron` module for the web build: the desktop main process (out/main/index.js, unchanged) runs in
// plain Node inside the user's sandbox, and this stands in for the parts of Electron it uses. IPC handlers
// are served over HTTP by server.cjs; webContents.send reaches the browser as server-sent events.
'use strict'
const { EventEmitter } = require('node:events')
const { createCipheriv, createDecipheriv, randomBytes, createHash } = require('node:crypto')
const { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } = require('node:fs')
const { basename, dirname, extname, join } = require('node:path')
const { homedir, tmpdir } = require('node:os')
const { fileURLToPath } = require('node:url')
const { Readable } = require('node:stream')

const env = process.env
const USER_DATA = env.HS_USER_DATA || join(homedir(), '.humanstudy-web', 'userData')
const APP_ROOT = env.HS_APP_ROOT || __dirname
mkdirSync(USER_DATA, { recursive: true })

// ---- events to the browser ---------------------------------------------------------------
const bus = new EventEmitter()
bus.setMaxListeners(0)
const send = (channel, payload) => bus.emit('send', channel, payload)

// ---- app ---------------------------------------------------------------------------------
const paths = {
  userData: USER_DATA,
  appData: dirname(USER_DATA),
  home: homedir(),
  downloads: join(USER_DATA, 'downloads'),
  temp: tmpdir(),
  logs: join(USER_DATA, 'logs'),
  documents: join(homedir(), 'Documents'),
  desktop: join(homedir(), 'Desktop'),
}
class App extends EventEmitter {
  constructor() {
    super()
    this.name = 'HumanStudy Hub'
    this.isPackaged = false
    this.dock = undefined
    this.commandLine = { appendSwitch() {}, hasSwitch: () => false, getSwitchValue: () => '' }
  }
  getPath(name) {
    if (!(name in paths)) throw new Error(`app.getPath: unknown path ${name}`)
    return paths[name]
  }
  setPath(name, p) { paths[name] = p }
  getVersion() { return env.HS_APP_VERSION || '0.0.0' }
  getName() { return this.name }
  getAppPath() { return APP_ROOT }
  getLocale() { return 'en-US' }
  whenReady() { return Promise.resolve() }
  isReady() { return true }
  requestSingleInstanceLock() { return true }
  setAboutPanelOptions() {}
  showAboutPanel() {}
  focus() {}
  quit() {
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
    this.emit('before-quit', e)
    if (!e.defaultPrevented) this.exit(0)
  }
  exit(code = 0) {
    this.emit('will-quit', { preventDefault() {} })
    setTimeout(() => process.exit(code), 50)
  }
}
const app = new App()

// ---- windows: one virtual window, the browser tab(s) ---------------------------------------
const webContents = {
  id: 1,
  send,
  on() {}, once() {}, setWindowOpenHandler() {}, isDestroyed: () => false,
  getURL: () => '', executeJavaScript: async () => undefined,
}
let windows = []
class BrowserWindow extends EventEmitter {
  constructor() {
    super()
    this.webContents = webContents
    windows = [this]
    // ready-to-show: nothing to wait for
    setImmediate(() => this.emit('ready-to-show'))
  }
  static getAllWindows() { return windows }
  static getFocusedWindow() { return windows[0] ?? null }
  static fromWebContents() { return windows[0] ?? null }
  loadURL() { return Promise.resolve() }
  loadFile() { return Promise.resolve() }
  show() {} focus() {} restore() {} close() {} destroy() {}
  isMinimized() { return false }
  isDestroyed() { return false }
  isFocused() { return true }
  setTitle() {}
}

// ---- ipc -----------------------------------------------------------------------------------
const handlers = new Map()
const listeners = new Map()
const ipcMain = {
  handle(channel, fn) {
    if (handlers.has(channel)) throw new Error(`Attempted to register a second handler for '${channel}'`)
    handlers.set(channel, fn)
  },
  handleOnce(channel, fn) { handlers.set(channel, async (...a) => { handlers.delete(channel); return fn(...a) }) },
  removeHandler(channel) { handlers.delete(channel) },
  on(channel, fn) {
    if (!listeners.has(channel)) listeners.set(channel, new Set())
    listeners.get(channel).add(fn)
    return ipcMain
  },
  removeListener(channel, fn) { listeners.get(channel)?.delete(fn); return ipcMain },
  removeAllListeners(channel) { if (channel) listeners.delete(channel); else listeners.clear(); return ipcMain },
}
const event = () => ({ sender: webContents, senderFrame: null, processId: 0, frameId: 0 })
async function invoke(channel, args) {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`No handler registered for '${channel}'`)
  return fn(event(), ...args)
}
function emitSend(channel, args) {
  for (const fn of listeners.get(channel) ?? []) fn({ ...event(), returnValue: undefined, reply: send }, ...args)
}

// ---- dialogs: the browser picks files itself (see browser-electron.ts); nothing blocks here ------
let saveTarget = 0
const dialog = {
  async showOpenDialog() { return { canceled: true, filePaths: [] } },
  // A save goes to the sandbox's downloads folder; the browser then downloads that file.
  async showSaveDialog(win, opts) {
    const o = opts ?? win ?? {}
    const dir = join(paths.downloads, String(++saveTarget))
    mkdirSync(dir, { recursive: true })
    return { canceled: false, filePath: join(dir, basename(o.defaultPath || 'download')) }
  },
  async showMessageBox() { return { response: 0, checkboxChecked: false } },
  // Only the unsaved-drafts prompt uses this; the browser asks on its own (beforeunload).
  showMessageBoxSync() { return 0 },
  showErrorBox(title, content) { console.error(`[dialog] ${title}: ${content}`) },
}

// ---- shell ------------------------------------------------------------------------------------
const shell = {
  async openExternal(url) { send('web:openExternal', String(url)) },
  showItemInFolder() {},
  async openPath() { return '' },
  async trashItem(p) {
    const bin = join(USER_DATA, 'Trash')
    mkdirSync(bin, { recursive: true })
    renameSync(p, join(bin, `${Date.now()}-${basename(p)}`))
  },
  beep() {},
}

// ---- safeStorage: AES-GCM with a key that lives outside the synced user data ----------------------
function storageKey() {
  if (env.HS_STORAGE_KEY) return createHash('sha256').update(env.HS_STORAGE_KEY).digest()
  const file = join(homedir(), '.humanstudy-web', 'storage.key')
  if (!existsSync(file)) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 }) }
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'hex')
}
const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString(plain) {
    const iv = randomBytes(12)
    const c = createCipheriv('aes-256-gcm', storageKey(), iv)
    const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()])
    return Buffer.concat([iv, c.getAuthTag(), body])
  },
  decryptString(buf) {
    const b = Buffer.from(buf)
    const d = createDecipheriv('aes-256-gcm', storageKey(), b.subarray(0, 12))
    d.setAuthTag(b.subarray(12, 28))
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
  },
}

// ---- protocol + net: hsfile:// is served by server.cjs at /hsfile/ ------------------------------
const protocols = new Map()
const protocol = {
  registerSchemesAsPrivileged() {},
  handle(scheme, fn) { protocols.set(scheme, fn) },
  unhandle(scheme) { protocols.delete(scheme) },
  isProtocolHandled: (scheme) => protocols.has(scheme),
}
const TYPES = {
  '.pdf': 'application/pdf', '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.otf': 'font/otf', '.ico': 'image/x-icon', '.map': 'application/json', '.bcmap': 'application/octet-stream',
  '.py': 'text/plain; charset=utf-8',
}
const contentType = (p) => TYPES[extname(p).toLowerCase()] || 'application/octet-stream'
const net = {
  async fetch(input, init) {
    const url = typeof input === 'string' ? input : input.url
    if (!url.startsWith('file:')) return fetch(input, init)
    const p = fileURLToPath(url)
    let st
    try { st = statSync(p) } catch { return new Response('not found', { status: 404 }) }
    if (!st.isFile()) return new Response('not found', { status: 404 })
    return new Response(Readable.toWeb(createReadStream(p)), {
      status: 200,
      headers: { 'Content-Type': contentType(p), 'Content-Length': String(st.size) },
    })
  },
  isOnline: () => true,
}

// ---- the rest: present, inert ------------------------------------------------------------------
const Menu = { buildFromTemplate: () => ({ popup() {}, items: [] }), setApplicationMenu() {}, getApplicationMenu: () => null }
class Notification extends EventEmitter { static isSupported() { return false } show() {} close() {} }
const nativeTheme = Object.assign(new EventEmitter(), { themeSource: 'system', shouldUseDarkColors: false })
const autoUpdater = Object.assign(new EventEmitter(), { setFeedURL() {}, checkForUpdates() {}, quitAndInstall() {} })
const powerMonitor = Object.assign(new EventEmitter(), { getSystemIdleTime: () => 0 })
const session = { defaultSession: { webRequest: { onHeadersReceived() {}, onBeforeRequest() {} }, setPermissionRequestHandler() {} } }

module.exports = {
  app, BrowserWindow, ipcMain, dialog, shell, safeStorage, protocol, net, Menu, Notification, nativeTheme,
  autoUpdater, powerMonitor, session,
  // for server.cjs
  __web: { bus, invoke, emitSend, protocols, contentType, paths, handlers },
}
