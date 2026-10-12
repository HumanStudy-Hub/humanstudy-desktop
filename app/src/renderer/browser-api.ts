// Browser preview: when the renderer runs outside Electron, stand in for the preload bridge with
// the sample program, a local paper and a scripted kernel, so the interface can be reviewed in a
// normal browser. Electron never loads this path because window.humanstudy already exists.
import type { HumanStudyApi, KernelEvent, ProjectSnapshot, ProjectSummary, ProviderStatus, Settings } from '../preload/types'
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
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const projects: ProjectSummary[] = [
    { dir: snapshot.dir, name: 'Knobe 2003 · side-effect effect', updatedAt: ago(14), hasPaper: true, hasProgram: true, artifactCount: 2 },
    { dir: '/preview/untitled', name: 'Untitled project', updatedAt: ago(60 * 26), hasPaper: false, hasProgram: false, artifactCount: 0 },
  ]
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'
  const settings: Settings = {
    theme: 'system',
    busyEnter: 'queue',
    permission: 'ask',
    model: 'anthropic/claude-haiku-5.5',
    projectsRoot: '~/HumanStudy',
  }
  const providers: ProviderStatus[] = [
    { id: 'openrouter', label: 'OpenRouter', configured: false },
    { id: 'anthropic', label: 'Anthropic', configured: false },
    { id: 'deepseek', label: 'DeepSeek', configured: false },
  ]
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
    projects: {
      list: async () => projects.map((p) => ({ ...p })),
      create: async ({ name, pdfPath, sample: isSample }) => {
        if (isSample) {
          const existing = projects.find((p) => p.dir === snapshot.dir)
          if (existing) {
            existing.updatedAt = new Date().toISOString()
            return existing.dir
          }
          projects.unshift({ dir: snapshot.dir, name: 'Knobe 2003 · side-effect effect', updatedAt: new Date().toISOString(), hasPaper: true, hasProgram: true, artifactCount: 0 })
          return snapshot.dir
        }
        let dir = `/preview/${slug(name)}`
        for (let i = 2; projects.some((p) => p.dir === dir); i++) dir = `/preview/${slug(name)}-${i}`
        projects.unshift({ dir, name: name || 'Untitled project', updatedAt: new Date().toISOString(), hasPaper: Boolean(pdfPath), hasProgram: false, artifactCount: 0 })
        return dir
      },
      pickPdf: async () => '/preview/paper.pdf',
      rename: async (dir, name) => {
        const p = projects.find((x) => x.dir === dir)
        if (p) {
          p.name = name
          p.updatedAt = new Date().toISOString()
        }
        return dir
      },
      trash: async (dir) => {
        const i = projects.findIndex((p) => p.dir === dir)
        if (i >= 0) projects.splice(i, 1)
      },
    },
    settings: {
      get: async () => ({ ...settings }),
      set: async (patch) => ({ ...Object.assign(settings, patch) }),
      providers: async () => providers.map((p) => ({ ...p })),
      setKey: async (id, key) => {
        const p = providers.find((x) => x.id === id)
        if (p) p.configured = key.length > 0
        return providers.map((x) => ({ ...x }))
      },
    },
    project: {
      open: async () => snapshot.dir,
      read: async (dir) => {
        if (dir === snapshot.dir) return snapshot
        const p = projects.find((x) => x.dir === dir)
        return {
          dir,
          name: p?.name ?? 'Untitled project',
          program: null,
          artifacts: [],
          exports: [],
          pdf: p?.hasPaper ? snapshot.pdf : null,
        }
      },
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
}
