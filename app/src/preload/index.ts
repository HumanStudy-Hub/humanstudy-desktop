import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HumanStudyApi, KernelEvent, UpdateStatus } from './types'

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
  },
  project: {
    open: () => ipcRenderer.invoke('project:open'),
    read: (dir) => ipcRenderer.invoke('project:read', dir),
    reveal: (path) => ipcRenderer.invoke('project:reveal', path),
    onChanged: (cb) => listen<string>('project:changed', cb),
  },
  kernel: {
    startSession: (dir) => ipcRenderer.invoke('kernel:startSession', dir),
    send: (id, text) => ipcRenderer.invoke('kernel:send', id, text),
    abort: (id) => ipcRenderer.invoke('kernel:abort', id),
    onEvent: (cb) => listen<KernelEvent>('kernel:event', cb),
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
    deleteMyData: () => ipcRenderer.invoke('telemetry:deleteMyData'),
    flush: () => ipcRenderer.invoke('telemetry:flush'),
  },
}

contextBridge.exposeInMainWorld('humanstudy', api)
