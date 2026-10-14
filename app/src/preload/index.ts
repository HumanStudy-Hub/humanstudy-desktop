import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { HumanStudyApi, KernelEvent, KernelInstallStatus, MenuCommand, UpdateStatus } from './types'

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_: IpcRendererEvent, v: T): void => cb(v)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api: HumanStudyApi = {
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input) => ipcRenderer.invoke('projects:create', input),
    pickPdf: () => ipcRenderer.invoke('projects:pickPdf'),
    rename: (dir, name) => ipcRenderer.invoke('projects:rename', dir, name),
    trash: (dir) => ipcRenderer.invoke('projects:trash', dir),
  },
  community: {
    studies: () => ipcRenderer.invoke('community:studies'),
    study: (id) => ipcRenderer.invoke('community:study', id),
    fork: (id) => ipcRenderer.invoke('community:fork', id),
    openExternal: (url) => ipcRenderer.invoke('community:openExternal', url),
  },
  account: {
    status: () => ipcRenderer.invoke('account:status'),
    signIn: (email, password) => ipcRenderer.invoke('account:signIn', email, password),
    signUp: (email, password) => ipcRenderer.invoke('account:signUp', email, password),
    signOut: () => ipcRenderer.invoke('account:signOut'),
    unlock: (code) => ipcRenderer.invoke('account:unlock', code),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    providers: () => ipcRenderer.invoke('settings:providers'),
    setKey: (provider, key) => ipcRenderer.invoke('settings:setKey', provider, key),
    pickProjectsRoot: () => ipcRenderer.invoke('settings:pickProjectsRoot'),
  },
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    read: (dir) => ipcRenderer.invoke('project:read', dir),
    reveal: (path) => ipcRenderer.invoke('project:reveal', path),
    versions: (path) => ipcRenderer.invoke('project:versions', path),
    readVersion: (path, id) => ipcRenderer.invoke('project:readVersion', path, id),
    saveCopy: (path) => ipcRenderer.invoke('project:saveCopy', path),
    readText: (path) => ipcRenderer.invoke('project:readText', path),
    writeText: (path, text) => ipcRenderer.invoke('project:writeText', path, text),
    importFiles: (dir, paths) => ipcRenderer.invoke('project:importFiles', dir, paths),
    onChanged: (cb) => listen<string>('project:changed', cb),
  },
  files: {
    pathOf: (file) => webUtils.getPathForFile(file),
  },
  kernel: {
    startSession: (dir) => ipcRenderer.invoke('kernel:startSession', dir),
    send: (id, text, workspace) => ipcRenderer.invoke('kernel:send', id, text, workspace),
    abort: (id) => ipcRenderer.invoke('kernel:abort', id),
    reply: (id, permissionId, response) => ipcRenderer.invoke('kernel:reply', id, permissionId, response),
    questions: (id) => ipcRenderer.invoke('kernel:questions', id),
    answerQuestion: (id, questionId, answers) => ipcRenderer.invoke('kernel:answerQuestion', id, questionId, answers),
    rejectQuestion: (id, questionId) => ipcRenderer.invoke('kernel:rejectQuestion', id, questionId),
    onEvent: (cb) => listen<KernelEvent>('kernel:event', cb),
    install: {
      status: () => ipcRenderer.invoke('kernel:installStatus'),
      onProgress: (cb) => listen<KernelInstallStatus>('kernel:installProgress', cb),
      retry: () => ipcRenderer.invoke('kernel:installRetry'),
    },
  },
  app: { info: () => ipcRenderer.invoke('app:info') },
  menu: { onCommand: (cb) => listen<MenuCommand>('menu:command', cb) },
  threads: {
    list: (dir) => ipcRenderer.invoke('threads:list', dir),
    get: (dir, id) => ipcRenderer.invoke('threads:get', dir, id),
    create: (dir) => ipcRenderer.invoke('threads:create', dir),
    resume: (dir, id) => ipcRenderer.invoke('threads:resume', dir, id),
    rename: (dir, id, title) => ipcRenderer.invoke('threads:rename', dir, id, title),
    delete: (dir, id) => ipcRenderer.invoke('threads:delete', dir, id),
    onChanged: (cb) => listen<{ dir: string; id: string }>('threads:changed', cb),
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.invoke('updates:install'),
    onChange: (cb) => listen<UpdateStatus>('updates:changed', cb),
  },
  telemetry: {
    status: () => ipcRenderer.invoke('telemetry:status'),
    setConsent: (consent) => ipcRenderer.invoke('telemetry:setConsent', consent),
    track: (type, opts) => ipcRenderer.invoke('telemetry:track', type, opts),
    projectId: (dir) => ipcRenderer.invoke('telemetry:projectId', dir),
    recent: () => ipcRenderer.invoke('telemetry:recent'),
    flush: () => ipcRenderer.invoke('telemetry:flush'),
    sessionId: () => ipcRenderer.invoke('telemetry:sessionId'),
    replayChunk: (chunk) => ipcRenderer.invoke('telemetry:replayChunk', chunk),
    exportMyData: () => ipcRenderer.invoke('telemetry:exportMyData'),
    saveExport: (json) => ipcRenderer.invoke('telemetry:saveExport', json),
  },
}

contextBridge.exposeInMainWorld('humanstudy', api)
