import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { HumanStudyApi, KernelEvent, KernelInstallStatus, MenuCommand, UpdateStatus } from './types'

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_: IpcRendererEvent, v: T): void => cb(v)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api: HumanStudyApi = {
  support: {
    status: () => ipcRenderer.invoke('support:status'),
    submit: (input) => ipcRenderer.invoke('support:submit', input),
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (input, action) => ipcRenderer.invoke('projects:create', input, action),
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
    forgotPassword: (email) => ipcRenderer.invoke('account:forgotPassword', email),
    resendConfirmation: (email) => ipcRenderer.invoke('account:resendConfirmation', email),
    changePassword: (currentPassword, newPassword) => ipcRenderer.invoke('account:changePassword', currentPassword, newPassword),
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
    startBuild: (dir, sid, action) => ipcRenderer.invoke('project:startBuild', dir, sid, action),
    releaseBuild: (dir, sid) => ipcRenderer.invoke('project:releaseBuild', dir, sid),
    retryBuild: (dir, action) => ipcRenderer.invoke('project:retryBuild', dir, action),
    open: () => ipcRenderer.invoke('project:open'),
    read: (dir) => ipcRenderer.invoke('project:read', dir),
    reveal: (path) => ipcRenderer.invoke('project:reveal', path),
    versions: (path) => ipcRenderer.invoke('project:versions', path),
    readVersion: (path, id) => ipcRenderer.invoke('project:readVersion', path, id),
    saveCopy: (path) => ipcRenderer.invoke('project:saveCopy', path),
    readText: (path) => ipcRenderer.invoke('project:readText', path),
    packageReadiness: (dir, studyId) => ipcRenderer.invoke('project:packageReadiness', dir, studyId),
    writeText: (path, text, ifUnchanged, action) => ipcRenderer.invoke('project:writeText', path, text, ifUnchanged, action),
    importFiles: (dir, paths, action) => ipcRenderer.invoke('project:importFiles', dir, paths, action),
    onChanged: (cb) => listen<string>('project:changed', cb),
  },
  files: {
    pathOf: (file) => webUtils.getPathForFile(file),
  },
  kernel: {
    export: id => ipcRenderer.invoke('kernel:export', id),
    native: (id, request, action) => ipcRenderer.invoke('kernel:native', id, request, action),
    startSession: (dir) => ipcRenderer.invoke('kernel:startSession', dir),
    send: (id, text, workspace, action) => ipcRenderer.invoke('kernel:send', id, text, workspace, action),
    abort: (id, action) => ipcRenderer.invoke('kernel:abort', id, action),
    reply: (id, permissionId, response, action) => ipcRenderer.invoke('kernel:reply', id, permissionId, response, action),
    questions: (id) => ipcRenderer.invoke('kernel:questions', id),
    answerQuestion: (id, questionId, answers, action) => ipcRenderer.invoke('kernel:answerQuestion', id, questionId, answers, action),
    rejectQuestion: (id, questionId, action) => ipcRenderer.invoke('kernel:rejectQuestion', id, questionId, action),
    onEvent: (cb) => listen<KernelEvent>('kernel:event', cb),
    install: {
      status: () => ipcRenderer.invoke('kernel:installStatus'),
      onProgress: (cb) => listen<KernelInstallStatus>('kernel:installProgress', cb),
      retry: () => ipcRenderer.invoke('kernel:installRetry'),
    },
  },
  app: { info: () => ipcRenderer.invoke('app:info'), setUnsaved: (prompt) => ipcRenderer.send('app:unsaved', prompt) },
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
    replayChunk: async () => false,
    exportMyData: () => ipcRenderer.invoke('telemetry:exportMyData'),
    saveExport: (json) => ipcRenderer.invoke('telemetry:saveExport', json),
  },
}

contextBridge.exposeInMainWorld('humanstudy', api)
