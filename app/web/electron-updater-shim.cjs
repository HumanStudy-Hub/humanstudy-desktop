// `electron-updater` for the web build: the sandbox image is updated by HumanStudy Hub, not by the app.
'use strict'
const { EventEmitter } = require('node:events')
const autoUpdater = Object.assign(new EventEmitter(), {
  autoDownload: false,
  autoInstallOnAppQuit: false,
  allowPrerelease: false,
  logger: null,
  async checkForUpdates() { return null },
  async downloadUpdate() { return [] },
  quitAndInstall() {},
})
module.exports = { autoUpdater, default: { autoUpdater } }
module.exports.default = module.exports
