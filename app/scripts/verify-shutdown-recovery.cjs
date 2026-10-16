// Actual main/preload IPC, temporary data, mock agent and updater; no external network/install.
const { app, BrowserWindow, ipcMain, dialog, autoUpdater: native } = require('electron')
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict')
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'hs-quit-recovery-'))
app.setPath('userData', root)
Object.defineProperty(app, 'isPackaged', { value: true })
fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify({ projectsRoot: path.join(root, 'projects'), notifications: false }))
process.env.HUMANSTUDY_KERNEL = 'mock'; process.env.HUMANSTUDY_SERVER = 'http://127.0.0.1:1'
global.fetch = async () => { throw Error('Fixture network disabled') }
BrowserWindow.prototype.show = function () {}; BrowserWindow.prototype.focus = function () {}
dialog.showMessageBox = async () => ({ response: 1 })
let saveErrors = 0, armed = false, dir, thread, done = false, expected
let installMode = 'throw', launches = 0
const updater = require('../node_modules/electron-updater').autoUpdater
updater.checkForUpdates = async () => {
  updater.emit('checking-for-update')
  updater.emit('update-available', { version: '0.6.4' })
  updater.emit('update-downloaded', { version: '0.6.4' })
  native.emit('update-downloaded')
  return { downloadPromise: Promise.resolve([]) }
}
updater.quitAndInstall = () => {
  launches++
  if (installMode === 'throw') throw Error('Injected installer launch failure')
  if (installMode === 'async') setTimeout(() => updater.emit('error', Error('Injected asynchronous installer failure')), 5)
}
dialog.showErrorBox = () => { saveErrors++ }
app.on('web-contents-created', (_event, contents) => {
  const send = contents.send.bind(contents)
  contents.send = (channel, ...args) => {
    const result = send(channel, ...args)
    // This happens inside quiesce(), AFTER the first save and BEFORE the second save.
    if (armed && channel === 'kernel:event' && args[0]?.type === 'done') {
      armed = false
      fs.renameSync(path.join(dir, '.humanstudy'), path.join(dir, '.humanstudy.backup'))
      fs.writeFileSync(path.join(dir, '.humanstudy'), 'blocked final save')
    }
    return result
  }
})
const handles = new Map(), original = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, fn) => { handles.set(channel, fn); return original(channel, fn) }
const invoke = (name, ...args) => handles.get(name)({}, ...args)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
process.on('exit', () => {
  if (!done) { process.exitCode = 1; return }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, '.humanstudy', 'threads', thread.id + '.json'))).messages, expected)
  console.log(JSON.stringify({ root, secondSaveFailureRecovered: true, syncInstallerFailureRecovered: true, asyncInstallerFailureRecovered: true, silentInstallerTimeoutRecovered: true, sameSessionRemainedUsable: true, launches }))
})
setTimeout(() => { console.error('Shutdown recovery fixture timed out'); process.exit(1) }, 35000).unref()
require('../out/main/index.js')
app.whenReady().then(async () => {
  await sleep(200)
  dir = await invoke('projects:create', { name: 'Recovery fixture' })
  thread = await invoke('threads:create', dir)
  const send = () => invoke('kernel:send', thread.kernelSessionId, 'ask question ' + 'full content '.repeat(1000))
  await send(); armed = true; app.quit(); await sleep(300)
  assert.equal(saveErrors, 1)
  fs.unlinkSync(path.join(dir, '.humanstudy')); fs.renameSync(path.join(dir, '.humanstudy.backup'), path.join(dir, '.humanstudy'))
  await send() // Same session ID, no reload or manual reopen.
  for (const mode of ['throw', 'async', 'silent']) {
    installMode = mode
    await invoke('updates:check'); await invoke('updates:install')
    await sleep(mode === 'silent' ? 15500 : 50)
    assert.equal((await invoke('updates:status')).state, 'error', mode)
    await send()
  }
  assert.equal(launches, 3)
  await invoke('kernel:abort', thread.kernelSessionId)
  expected = (await invoke('threads:get', dir, thread.id)).messages
  done = true; app.quit()
}).catch(error => { console.error(error); process.exit(1) })
