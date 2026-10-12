import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { HumanStudyApi, KernelEvent } from './types'

function listen<T>(channel: string, cb: (v: T) => void): () => void {
  const h = (_: IpcRendererEvent, v: T): void => cb(v)
  ipcRenderer.on(channel, h)
  return () => ipcRenderer.removeListener(channel, h)
}

const api: HumanStudyApi = {
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
}

contextBridge.exposeInMainWorld('humanstudy', api)
