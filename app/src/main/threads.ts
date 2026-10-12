// Conversation threads over IPC. The store and the recording logic live in threads-core.ts.
import { ThreadManager, type Capture, type ThreadHost, type ThreadsOptions } from './threads-core'

export { ThreadManager }
export type { Capture, ThreadHost }

let manager: ThreadManager | null = null

export function createThreads(host: ThreadHost, notify: (e: { dir: string; id: string }) => void, opts: ThreadsOptions = {}): ThreadManager {
  manager = new ThreadManager(host, notify, opts)
  return manager
}

export function threads(): ThreadManager {
  if (!manager) throw new Error('threads not initialised')
  return manager
}
