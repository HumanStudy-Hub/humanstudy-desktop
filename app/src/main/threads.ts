// Conversation threads over IPC. The store and the recording logic live in threads-core.ts.
import { ThreadManager, type ThreadHost } from './threads-core'

export { ThreadManager }
export type { ThreadHost }

let manager: ThreadManager | null = null

export function createThreads(host: ThreadHost, notify: (e: { dir: string; id: string }) => void): ThreadManager {
  manager = new ThreadManager(host, notify)
  return manager
}

export function threads(): ThreadManager {
  if (!manager) throw new Error('threads not initialised')
  return manager
}
