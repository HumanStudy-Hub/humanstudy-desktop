// Research capture of project file versions, kept apart from Electron so it can be tested directly.
// The app save (program-save.ts) and the agent helper (program_io.py) both replace files atomically
// through uniquely named temporaries. Capture must record the bytes each writer actually committed,
// attribute them to the right writer, and keep version numbers ordered when saves arrive close together.
import { createHash } from 'node:crypto'

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

/** `<name>.<pid>.<uuid>.tmp`: the app uses randomUUID(), program_io.py uses uuid4().hex. */
const SAVE_TEMP = /\.\d+\.(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/i
export function isSaveTemp(rel: string): boolean {
  return SAVE_TEMP.test(rel)
}

export const HUMAN_WINDOW_MS = 5_000

/**
 * The researcher's in-app saves. When the saved text is known, only that exact content counts as the
 * researcher's; a different version appearing soon after (the agent's merge) is the agent's.
 */
export function createWriteAttribution(now: () => number = Date.now) {
  const human = new Map<string, { at: number; hash?: string }>()
  return {
    note(path: string, text?: string): void {
      human.set(path, { at: now(), hash: text === undefined ? undefined : sha1(text) })
    },
    by(path: string, text?: string): 'human' | 'agent' {
      const h = human.get(path)
      if (!h || h.at <= now() - HUMAN_WINDOW_MS) return 'agent'
      if (h.hash === undefined || text === undefined) return 'human'
      return h.hash === sha1(text) ? 'human' : 'agent'
    },
  }
}

/** Run work for one key strictly in order, so two captures never claim the same version number. */
export function createSerial() {
  const tails = new Map<string, Promise<unknown>>()
  return function serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const next = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
    tails.set(key, next)
    void next.catch(() => undefined).finally(() => { if (tails.get(key) === next) tails.delete(key) })
    return next
  }
}
