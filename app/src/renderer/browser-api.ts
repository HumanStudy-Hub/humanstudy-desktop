// Browser preview: when the renderer runs outside Electron, stand in for the preload bridge with
// the sample program, a local paper and a scripted kernel, so the interface can be reviewed in a
// normal browser. Electron never loads this path because window.humanstudy already exists.
import type { HumanStudyApi, KernelEvent, ProjectSnapshot } from '../preload/types'
import sample from '../shared/sample-program.json'

if (!('humanstudy' in window)) {
  const listeners = new Set<(e: KernelEvent) => void>()
  const emit = (e: KernelEvent) => listeners.forEach((cb) => cb(e))
  const timers = new Map<string, number[]>()
  const snapshot: ProjectSnapshot = {
    dir: '/preview/knobe-2003',
    name: 'Knobe 2003 · browser preview',
    program: sample,
    artifacts: [],
    exports: [],
    pdf: { name: 'paper.pdf', path: '/preview/paper.pdf', url: '/preview/paper.pdf', ext: 'pdf' },
  }
  const script = (text: string): Omit<KernelEvent, 'sessionId'>[] => [
    { type: 'status', text: 'Reading the project' },
    { type: 'tool', tool: 'read', detail: 'program.json' },
    { type: 'tool', tool: 'read', detail: 'paper.pdf · pages 1–2' },
    ...`This is a browser preview with a scripted agent, so nothing here comes from a model. You asked: “${text.slice(0, 120)}”. In the app, the agent reads the paper and the program, answers with citations, and writes any view or export into the project's artifacts.`
      .split(/(?<= )/)
      .map((w) => ({ type: 'text' as const, text: w })),
    { type: 'done' },
  ]
  const api: HumanStudyApi = {
    project: {
      open: async () => snapshot.dir,
      read: async () => snapshot,
      reveal: async () => undefined,
      onChanged: () => () => undefined,
    },
    kernel: {
      startSession: async () => 'preview-session',
      send: async (sessionId, text) => {
        const ids = script(text).map((e, i) => window.setTimeout(() => emit({ sessionId, ...e }), 120 + i * 45))
        timers.set(sessionId, ids)
      },
      abort: async (sessionId) => {
        timers.get(sessionId)?.forEach((t) => clearTimeout(t))
        emit({ sessionId, type: 'done' })
      },
      onEvent: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
    },
  }
  ;(window as unknown as { humanstudy: HumanStudyApi }).humanstudy = api
  // Open the sample project straight away.
  try {
    localStorage.setItem('hs.lastProject', snapshot.dir)
  } catch {
    /* the welcome screen still offers Open project */
  }
}
