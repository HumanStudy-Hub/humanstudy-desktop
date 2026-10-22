import { validateAnswers, updateQuestion, type KernelQuestion } from '../shared/question'
// Browser preview: when the renderer runs outside Electron, stand in for the preload bridge with
// the sample program, a local paper and a scripted kernel, so the interface can be reviewed in a
// normal browser. Electron never loads this path because window.humanstudy already exists.
import type { TelemetryRecent, TelemetryRow, TelemetryStatus, TelemetryTrackOptions, WorkspaceContext } from '../preload/types'
import type { AccountStatus, CommunityStudy, CommunityStudyDetail, HumanStudyApi, KernelEvent, KernelInstallStatus, MenuCommand, PermissionReply, Thread, ThreadMessage, ThreadPart, ProjectSnapshot, ProjectSummary, ProviderStatus, Settings } from '../preload/types'
import sample from '../shared/sample-program.json'
import brokenProgram from '../shared/fixtures/fce-broken.json'
import exampleResults from '../../resources/sample/example-simulation/results.html?raw'
import exampleResultsUrl from '../../resources/sample/example-simulation/results.html?url'
import exampleSummary from '../../resources/sample/example-simulation/summary.json?raw'
import exampleProgress from '../../resources/sample/example-simulation/progress.json?raw'
import exampleReport from '../../resources/sample/example-simulation/report.md?raw'
import { EXAMPLE_RUN } from '../shared/simulation-run'

// Preview flags (all optional, combine freely):
//   ?project=empty    a new project: paper.pdf only, no study yet
//   ?project=results  the sample study plus artifacts of different kinds (chart with 3 versions, report, table, simulation, draft, docx, figure)
//   ?build=hold       "Build the study from the paper" stalls while the agent is still reading (to look at the working state)
//   ?agent=1          signed in, unlocked, agreement accepted, so the agent can be used
//   ?lang=zh|en       sets the interface language (stored like Settings → Language)
//   ?program=real     the project in public/preview/real/ (local only; see below)
//   ?sim=built        the runnable study package exists (Simulation tab: ready to run); default: not built yet
//   ?sim=running      ...and a simulation is running (progress ticks, never finishes);  ?sim=done: a finished run of your own
//   ?fresh=1          no seeded conversations;  ?install=1|error, ?declined=1, ?devkeys=1, ?folderError=1 as before
if (!('humanstudy' in window)) {
  try {
    const l = new URLSearchParams(location.search).get('lang')
    if (l === 'zh' || l === 'zh-CN') localStorage.setItem('hs.lang', 'zh-CN')
    else if (l === 'en') localStorage.setItem('hs.lang', 'en')
  } catch {
    /* no storage */
  }
  const listeners = new Set<(e: KernelEvent) => void>()
  const changed = new Set<(dir: string) => void>()
  const emit = (e: KernelEvent) => listeners.forEach((cb) => cb(e))
  // In-memory conversation threads and scripted permission prompts for the preview kernel.
  let sessionCounter = 0
  const threadStore = new Map<string, Thread>()
  const sessionThread = new Map<string, string>() // session id -> thread id ('' = untracked)
  const threadChanged = new Set<(e: { dir: string; id: string }) => void>()
  const pendingQuestion = new Map<string, KernelQuestion>()
  const pendingPermission = new Map<string, { id: string; rest: Omit<KernelEvent, 'sessionId'>[] }>()
  const notifyThread = (t: Thread) => {
    t.updatedAt = new Date().toISOString()
    threadChanged.forEach((cb) => cb({ dir: snapshot.dir, id: t.id }))
  }
  const threadOf = (sessionId: string): Thread | undefined => {
    let id = sessionThread.get(sessionId)
    if (id === undefined) return undefined
    if (!id) {
      const now = new Date().toISOString()
      id = `thr_${sessionId}`
      threadStore.set(id, { id, title: 'New thread', createdAt: now, updatedAt: now, kernel: 'mock', kernelSessionId: sessionId, messages: [], usage: { input: 0, output: 0, cost: 0 } })
      sessionThread.set(sessionId, id)
    }
    return threadStore.get(id)
  }
  const recordUser = (sessionId: string, text: string, workspace?: WorkspaceContext) => {
    const t = threadOf(sessionId)
    if (!t) return
    t.messages.push({ id: `m${t.messages.length}`, role: 'user', parts: [{ kind: 'text', text }], at: new Date().toISOString(), workspace })
    if (t.title === 'New thread') t.title = text.replace(/\s+/g, ' ').trim().slice(0, 60) || t.title
    notifyThread(t)
  }
  const recordEvent = (e: KernelEvent) => {
    const t = threadOf(e.sessionId)
    if (!t) return
    if (e.type === 'usage' && e.usage) {
      t.usage = { input: t.usage.input + e.usage.input, output: t.usage.output + e.usage.output, cost: t.usage.cost + (e.usage.cost ?? 0) }
      return notifyThread(t)
    }
    if (e.type !== 'text' && e.type !== 'tool' && e.type !== 'error' && e.type !== 'permission' && e.type !== 'question') return
    if (e.type === 'question' && e.question) {
      const updated = updateQuestion(t.messages, e.question)
      if (updated) { t.messages = updated; return notifyThread(t) }
      if (!e.question.questions.length && e.question.resolved) return
    }
    let m: ThreadMessage | undefined = t.messages[t.messages.length - 1]
    if (!m || m.role !== 'assistant') t.messages.push((m = { id: `m${t.messages.length}`, role: 'assistant', parts: [], at: new Date().toISOString() }))
    const tail = m.parts[m.parts.length - 1]
    if (e.type === 'text') {
      if (tail?.kind === 'text') tail.text += e.text ?? ''
      else m.parts.push({ kind: 'text', text: e.text ?? '' })
    } else if (e.type === 'tool') {
      if (tail?.kind === 'tool' && tail.tool === e.tool && (tail.state === 'pending' || tail.state === 'running')) Object.assign(tail, { detail: e.detail ?? tail.detail, state: e.text })
      else m.parts.push({ kind: 'tool', tool: e.tool ?? 'tool', detail: e.detail, state: e.text })
    } else if (e.type === 'error') m.parts.push({ kind: 'error', text: e.text ?? 'Unknown error' })
    else if (e.type === 'question' && e.question) m.parts.push({ kind: 'question', ...e.question })
    else if (e.permission) {
      const p = m.parts.find((x): x is Extract<ThreadPart, { kind: 'permission' }> => x.kind === 'permission' && x.id === e.permission!.id)
      if (p) p.resolved = e.permission.resolved ?? p.resolved
      else if (e.permission.type) m.parts.push({ kind: 'permission', id: e.permission.id, type: e.permission.type, title: e.permission.title, patterns: e.permission.patterns, resolved: e.permission.resolved })
    }
    if (e.type !== 'text') notifyThread(t)
  }
  const emitAndRecord = (e: KernelEvent) => {
    recordEvent(e)
    emit(e)
  }
  const play = (sessionId: string, steps: Omit<KernelEvent, 'sessionId'>[], gap = 45) => {
    const ids = steps.map((e, i) => window.setTimeout(() => emitAndRecord({ sessionId, ...e }), 120 + i * gap))
    timers.set(sessionId, ids)
  }
  const timers = new Map<string, number[]>()

  // ?install=1 simulates the first-run kernel download; ?install=error fails it until Retry.
  const installMode = new URLSearchParams(location.search).get('install')
  let installStatus: KernelInstallStatus = { state: 'ready', version: '1.19.0', path: '/preview/opencode' }
  const installListeners = new Set<(s: KernelInstallStatus) => void>()
  let finishInstall: () => void = () => undefined
  let installReady: Promise<void> = Promise.resolve()
  const setInstall = (s: KernelInstallStatus) => {
    installStatus = s
    installListeners.forEach((cb) => cb(s))
  }
  const runInstall = (fail: boolean) => {
    installReady = new Promise<void>((resolve) => (finishInstall = resolve))
    setInstall({ state: 'checking', version: '1.19.0' })
    let pct = 0
    const tick = window.setInterval(() => {
      pct += 7
      if (fail && pct >= 43) {
        window.clearInterval(tick)
        return setInstall({ state: 'error', version: '1.19.0', error: 'network connection lost (sha256 not checked)' })
      }
      if (pct >= 100) {
        window.clearInterval(tick)
        setInstall({ state: 'ready', version: '1.19.0', percent: 100, path: '/preview/opencode' })
        return finishInstall()
      }
      setInstall({ state: 'downloading', version: '1.19.0', percent: pct })
    }, 700)
  }
  const menuListeners = new Set<(c: MenuCommand) => void>()
  ;(window as unknown as { __menu: (c: MenuCommand) => void }).__menu = (c) => menuListeners.forEach((cb) => cb(c))
  if (installMode) setTimeout(() => runInstall(installMode === 'error'), 0)
  const mode = new URLSearchParams(location.search).get('project')
  // ?program=real: a researcher's own project copied into public/preview/real/ (program.json + paper.pdf,
  // git-ignored, never committed). Loaded synchronously because the snapshot is built synchronously.
  const real = new URLSearchParams(location.search).get('program') === 'real' ? (() => {
    try { const r = new XMLHttpRequest(); r.open('GET', '/preview/real/program.json', false); r.send(); return r.status === 200 ? JSON.parse(r.responseText) : null } catch { return null }
  })() : null
  const buildMode = new URLSearchParams(location.search).get('build')
  const snapshot: ProjectSnapshot = {
    dir: '/preview/knobe-2003',
    name: mode === 'empty' ? 'Untitled study' : 'Knobe 2003 · browser preview',
    program: mode === 'empty' ? null : real ?? (new URLSearchParams(location.search).get('program') === 'broken' ? brokenProgram : sample), // ?program=broken: a program with agent slips
    artifacts: [],
    exports: [],
    pdf: { name: 'paper.pdf', path: '/preview/paper.pdf', url: real ? '/preview/real/paper.pdf' : '/preview/paper.pdf', ext: 'pdf' },
    tree: [],
  }
  // Files of the preview project, editable in memory so the Program tab can be tried out.
  const R = '/preview/knobe-2003/'
  const mins = (m: number) => Date.now() - m * 60_000
  const texts = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const versionStore = new Map<string, { id: string; at: number; text: string }[]>()
  const put = (rel: string, text: string, minutesAgo = 5) => {
    texts.set(R + rel, text)
    mtimes.set(R + rel, mins(minutesAgo))
  }
  const html = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:14px system-ui;padding:24px;color:#263d46">${body}`
  if (mode !== 'empty') {
    put('program.json', JSON.stringify(real ?? sample, null, 2) + '\n', 30)
    put('artifacts/participant-flow.html', html('Participant flow', '<h1 style="font-size:22px">Participant flow</h1><div style="display:flex;gap:10px;align-items:center;margin-top:20px"><b style="border:2px solid #247c91;border-radius:8px;padding:12px 16px">Read scenario</b>&rarr;<b style="border:2px solid #247c91;border-radius:8px;padding:12px 16px">Harm / Help</b>&rarr;<b style="border:2px solid #247c91;border-radius:8px;padding:12px 16px">Judge intentionality</b></div><p>A view the agent wrote (preview).</p>'), 12)
    put('artifacts/2026-10-11-change.md', '# Changes to the study\n\n- material-1-harm: wording corrected to match p. 2.\n- participants: N = 78 now cited.\n', 60 * 20)
  }
  if (mode === 'results') {
    put('artifacts/condition-comparison.html', html('Harm vs. help condition', '<h1 style="font-size:20px">Harm vs. help</h1><div style="display:flex;gap:30px;align-items:flex-end;height:220px;margin-top:16px"><div style="width:90px;height:82%;background:#247c91"></div><div style="width:90px;height:23%;background:#9ec3cd"></div></div><p>Share judging the side effect intentional: 82% vs. 23%.</p>'), 45)
    put('artifacts/simulations/2026-10-11-1420/report.md', '# Simulation report: side-effect effect\n\nThe model reproduced the asymmetry in both arms.\n\n| Condition | Paper | Simulated |\n| --- | --- | --- |\n| Harm | 82% | 79% |\n| Help | 23% | 31% |\n\n> 60 simulated participants per arm.\n', 25)
    put('artifacts/descriptives.csv', 'condition,n,intentional,mean_blame\nHarm,39,32,4.7\nHelp,39,9,1.4\nTotal,78,41,3.1\n', 90)
    put('exports/preregistration-draft.md', '# Preregistration draft\n\n## Hypotheses\n\nPeople judge a harmful side effect as intentional more often than a helpful one.\n\n## Analysis plan\n\nChi-square test on the share judging the side effect intentional. **Missing:** exclusion rule.\n', 8)
    put('exports/study-summary.docx', 'binary placeholder', 60 * 5)
    put('artifacts/effect-sizes.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 200"><rect width="320" height="200" fill="#fff"/><g fill="#247c91"><rect x="40" y="40" width="50" height="130"/><rect x="130" y="120" width="50" height="50" fill="#9ec3cd"/></g><text x="40" y="26" font-family="sans-serif" font-size="13">Effect of side-effect valence</text></svg>', 60 * 30)
    const v = (rel: string, texts2: string[]) => versionStore.set(R + rel, texts2.map((tx, i) => ({ id: `2026101${i}T10000000${i}Z.html`, at: mins(300 - i * 80), text: tx })))
    v('artifacts/participant-flow.html', [
      html('Participant flow', '<h1>Participant flow</h1><p>First draft: two boxes.</p>'),
      html('Participant flow', '<h1>Participant flow</h1><p>Second draft: three stages, no arrows.</p>'),
      texts.get(R + 'artifacts/participant-flow.html')!,
    ])
  }
  // Simulation tab: the example run every sample project ships with, and scripted runs of your own.
  const simMode = new URLSearchParams(location.search).get('sim')
  // A complete package (the eight files the Simulation tab checks); ?sim=incomplete leaves only a stub adapter.
  const PKG = 'package/knobe-2003-intentional-action/'
  const putPackage = () => {
    put(PKG + 'study.json', '{"title": "Knobe (2003)", "readiness": {"status": "ready", "blocking": []}}\n', 30)
    for (const f of ['source/paper_metadata.json', 'source/evidence.json', 'materials/materials.json', 'task/task.json', 'audit/missing_information.json']) put(PKG + f, '{}\n', 30)
    put(PKG + 'task/adapter.py', '# Replay adapter (browser preview)\ndef run_sessions(llm, seed, n, arms=None):\n    return []\n', 30)
    put(PKG + 'evaluation/evaluation.py', '# Scoring (browser preview)\ndef evaluate(sessions):\n    return {}\n', 30)
  }
  if (mode !== 'empty') {
    put(`${EXAMPLE_RUN}/results.html`, exampleResults, 60 * 24 * 3)
    put(`${EXAMPLE_RUN}/summary.json`, exampleSummary, 60 * 24 * 3)
    put(`${EXAMPLE_RUN}/progress.json`, exampleProgress, 60 * 24 * 3)
    put(`${EXAMPLE_RUN}/report.md`, exampleReport, 60 * 24 * 3)
    if (simMode === 'incomplete') put(PKG + 'task/adapter.py', '# Replay adapter (browser preview)\n', 30)
    else if (simMode && simMode !== 'unbuilt') putPackage()
  }
  const stampOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
  const touched = () => { buildTree(); changed.forEach((cb) => cb(snapshot.dir)) }
  /** A scripted run: progress.json ticks like simkit writes it; with `finish`, results and summary follow. */
  const simulateRun = (perCondition: number, opts: { startDone?: number; finish: boolean; minutesAgo?: number; onEnd?: () => void }) => {
    const rel = `artifacts/simulations/${stampOf(new Date(Date.now() - (opts.minutesAgo ?? 0) * 60_000))}`
    const total = perCondition * 2
    const startedAt = new Date(Date.now() - (opts.minutesAgo ?? 0) * 60_000).toISOString()
    let done = opts.startDone ?? 0
    let stage = done ? 'running' : 'preparing'
    const write = (message?: string) => {
      const half = (k: number) => Math.min(perCondition, Math.ceil(done / 2) - (k ? (done % 2) : 0))
      texts.set(R + rel + '/progress.json', JSON.stringify({ stage, done, total, failed: 0, conditions: [{ id: 'condition-harm', done: half(0), total: perCondition }, { id: 'condition-help', done: Math.max(0, done - half(0)), total: perCondition }], model: 'anthropic/claude-haiku-5.5', startedAt, updatedAt: new Date().toISOString(), ...(message ? { message } : {}) }))
      mtimes.set(R + rel + '/progress.json', Date.now())
      touched()
    }
    const steps: [number, () => void][] = []
    if (!done) steps.push([2500, () => { stage = 'trial'; write() }], [3500, () => { stage = 'running'; write() }])
    const tick = () => {
      if (texts.has(R + rel + '/STOP')) { stage = 'stopped'; write('Stopped by the researcher'); opts.onEnd?.(); return }
      if (done < total) { done = Math.min(total, done + 2); write(); window.setTimeout(tick, opts.finish ? 700 : 2600); return }
      if (!opts.finish) return
      stage = 'scoring'; write()
      window.setTimeout(() => { stage = 'writing'; write() }, 1500)
      window.setTimeout(() => {
        put(`${rel}/results.html`, exampleResults, 0)
        put(`${rel}/summary.json`, exampleSummary.replace('"example": true', '"example": false'), 0)
        stage = 'done'; write(); opts.onEnd?.()
      }, 3200)
    }
    let at = 0
    for (const [ms, fn] of steps) { at += ms; window.setTimeout(fn, at) }
    window.setTimeout(tick, at + 900)
    write()
  }
  if (mode !== 'empty' && simMode === 'running') setTimeout(() => simulateRun(20, { startDone: 12, finish: false, minutesAgo: 3 }), 0)
  if (mode !== 'empty' && simMode === 'done') {
    const rel = `artifacts/simulations/${stampOf(new Date(Date.now() - 40 * 60_000))}`
    put(`${rel}/results.html`, exampleResults, 40)
    put(`${rel}/summary.json`, exampleSummary.replace('"example": true', '"example": false'), 40)
    put(`${rel}/progress.json`, exampleProgress, 40)
  }
  const MIME: Record<string, string> = { svg: 'image/svg+xml', html: 'text/html', png: 'image/png' }
  const bytes = (rel: string) => ((texts.get(R + rel) ?? '').length)
  void bytes
  const buildTree = () => {
    const root = snapshot.dir
    const dirs = new Map<string, import('../preload/types').ProjectEntry>()
    const top: import('../preload/types').ProjectEntry[] = []
    const folder = (rel: string): import('../preload/types').ProjectEntry[] => {
      if (!rel) return top
      let d = dirs.get(rel)
      if (!d) {
        const name = rel.split('/').pop()!
        d = { name, path: `${root}/${rel}`, rel, kind: 'dir', ext: '', children: [] }
        dirs.set(rel, d)
        folder(rel.split('/').slice(0, -1).join('/')).push(d)
      }
      return d.children!
    }
    const files = [...texts.keys(), '/preview/knobe-2003/paper.pdf']
    for (const path of files) {
      const rel = path.slice(root.length + 1)
      const name = rel.split('/').pop()!
      folder(rel.split('/').slice(0, -1).join('/')).push({ name, path, rel, kind: 'file', ext: name.split('.').pop()!.toLowerCase(), url: name === 'paper.pdf' ? '/preview/paper.pdf' : texts.get(path) === exampleResults ? exampleResultsUrl : `data:${MIME[name.split('.').pop()!.toLowerCase()] ?? 'text/plain'};charset=utf-8,` + encodeURIComponent(texts.get(path) ?? ''), size: (texts.get(path) ?? '').length, mtime: mtimes.get(path) ?? mins(3) })
    }
    const sortTree = (list: import('../preload/types').ProjectEntry[]) => {
      list.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name))
      list.forEach((e) => e.children && sortTree(e.children))
    }
    sortTree(top)
    snapshot.tree = top
    snapshot.artifacts = (dirs.get('artifacts')?.children ?? []).filter((e) => e.kind === 'file').map((e) => ({ name: e.name, path: e.path, url: e.url!, ext: e.ext }))
  }
  buildTree()
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const projects: ProjectSummary[] = [
    { dir: snapshot.dir, name: mode === 'empty' ? 'Untitled study' : 'Knobe 2003 · side-effect effect', updatedAt: ago(14), hasPaper: true, hasProgram: mode !== 'empty', artifactCount: mode === 'results' ? 6 : 2 },
    { dir: '/preview/untitled', name: 'Untitled project', updatedAt: ago(60 * 26), hasPaper: false, hasProgram: false, artifactCount: 0 },
  ]
  const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'
  const settings: Settings = {
    theme: 'system',
    busyEnter: 'queue',
    permission: 'project',
    model: 'anthropic/claude-haiku-5.5',
    projectsRoot: '~/HumanStudy Hub',
    notifications: true,
  }
  const providers: ProviderStatus[] = [
    { id: 'openrouter', label: 'OpenRouter', configured: false },
    { id: 'anthropic', label: 'Anthropic', configured: false },
    { id: 'deepseek', label: 'DeepSeek', configured: false },
  ]
  const account: AccountStatus = {
    signedIn: false,
    unlocked: false,
    server: 'https://humanstudy-hub-web.vercel.app',
    modelAccess: 'none',
  }
  const query = new URLSearchParams(location.search)
  // ?declined=1: signed in and unlocked, but "Not now" was chosen, so the agent is locked.
  if (query.has('agent')) Object.assign(account, { signedIn: true, email: 'researcher@example.edu', unlocked: true, keyExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() })
  if (query.has('declined')) Object.assign(account, { signedIn: true, email: 'researcher@example.edu', unlocked: true, keyExpiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() })
  let folderBlocked = query.has('folderError')
  const accountStatus = (): AccountStatus => ({
    ...account,
    models: ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash'],
    modelAccess: query.has('devkeys') && providers.some((p) => p.id === 'openrouter' && p.configured)
      ? 'own-key'
      : account.unlocked
        ? 'hosted'
        : 'none',
  })
  // Research data: in-memory consent and events, so the consent dialog and Settings → Research data
  // can be reviewed. Nothing leaves the browser; "sent" is simulated.
  const research = { decided: query.has('declined') || query.has('agent'), usage: query.has('agent'), content: query.has('agent'), sent: 0, decidedAt: undefined as string | undefined }
  const recentEvents: TelemetryRecent[] = []
  const previewSession = crypto.randomUUID()
  const researchStatus = (): TelemetryStatus => {
    const on = account.signedIn && research.decided
    return {
      consentVersion: 2,
      signedIn: account.signedIn,
      decided: on,
      usage: on && research.usage,
      content: on && research.usage && research.content,
      decidedAt: on ? research.decidedAt : undefined,
      sent: research.sent,
      pending: recentEvents.filter((r) => r.status === 'pending').length,
    }
  }
  const record = (type: string, opts: TelemetryTrackOptions = {}, force = false) => {
    const st = researchStatus()
    if (!force && (!st.usage || (type.startsWith('conversation.') && !st.content))) return
    const row: TelemetryRow = {
      id: crypto.randomUUID(),
      install_id: 'preview-install',
      session_id: previewSession,
      project_id: opts.projectId ?? null,
      event_type: type,
      occurred_at: new Date().toISOString(),
      target: opts.target?.slice(0, 160) ?? null,
      duration_ms: typeof opts.durationMs === 'number' ? Math.round(opts.durationMs) : null,
      metadata: opts.metadata ?? {},
      app_version: '0.0.0-preview',
      platform: 'darwin',
      consent_version: 2,
    }
    recentEvents.push({ row, status: 'pending' })
    if (recentEvents.length > 100) recentEvents.shift()
  }
  const markSent = () => {
    for (const r of recentEvents)
      if (r.status === 'pending') {
        r.status = 'sent'
        research.sent++
      }
  }
  globalThis.setInterval(markSent, 15_000)
  const reply = (text: string) => `This is a browser preview with a scripted agent, so nothing here comes from a model. You asked: “${text.slice(0, 120)}”.

## What I found

The program has **four studies** and a few gaps. See [the paper](https://github.com/HumanStudy-Hub/HumanStudy-Bench) for the original numbers.

| Item | Status | Source |
| --- | --- | --- |
| Participants | N = 78 | p. 2 |
| Conditions | Harm / Help | p. 3 |
| Analysis | \`chi-square\` | missing |

> Nothing below is filled in from memory; gaps stay labelled \`missing\`.

1. Read \`program.json\`
2. Check the materials against the paper
3. Write the change to \`artifacts/\`

\`\`\`python
def intentional(harm: float, help_: float) -> float:
    # difference in the share judging the side effect intentional
    return harm - help_
\`\`\`
`
  const SAMPLE_DIFF = `--- a/program.json
+++ b/program.json
@@ -42,7 +42,7 @@
       "id": "participants",
-      "value": "Undergraduates",
+      "value": "78 undergraduates (reported, p. 2)",
       "state": "proposed"
@@ -88,6 +88,7 @@
       "id": "analysis",
+      "note": "Chi-square on the share judging the side effect intentional",
       "origin": "agent"`
  if (!new URLSearchParams(location.search).has('fresh') && mode !== 'empty') {
    const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
    const seed = (id: string, title: string, hours: number, user: string, answer: string, usage: Thread['usage']) =>
      threadStore.set(id, {
        id, title, createdAt: ago(hours + 0.2), updatedAt: ago(hours), kernel: 'mock', kernelSessionId: `seed-${id}`, usage,
        messages: [
          { id: 'm0', role: 'user', parts: [{ kind: 'text', text: user }], at: ago(hours + 0.2) },
          { id: 'm1', role: 'assistant', parts: [{ kind: 'tool', tool: 'read', detail: 'program.json', state: 'completed' }, { kind: 'text', text: answer }], at: ago(hours + 0.19) },
        ],
      })
    seed('thr_a', 'Build the study from the paper', 3, 'Build the study from the paper', 'I read the paper and wrote **four studies** into `program.json`. Participants and conditions are `reported`; the analysis plan is still `missing`.', { input: 12400, output: 3100, cost: 0.08 })
    seed('thr_b', 'Which items are still missing?', 26, 'Which items are still missing?', 'Three items carry the `missing` label: the exact exclusion rule, the order of vignettes, and the debriefing text.', { input: 4200, output: 610, cost: 0.02 })
    seed('thr_c', 'Export a preregistration draft', 24 * 5, 'Export a preregistration draft', 'The draft is in `exports/preregistration.md`.', { input: 8800, output: 1900, cost: 0 })
  }
  // The "Build the study from the paper" run, slowly, so the stage list can be watched.
  const pdf = (n: number) => ({ type: 'tool' as const, tool: 'bash', detail: `pdftotext -f ${n} -l ${n + 1} paper.pdf -`, input: { command: `pdftotext -f ${n} -l ${n + 1} paper.pdf -` } })
  const buildScript = (sessionId: string): Omit<KernelEvent, 'sessionId'>[] => {
    void sessionId
    const writeStudy = () => {
      texts.set(R + 'program.json', JSON.stringify(sample, null, 2) + '\n')
      mtimes.set(R + 'program.json', Date.now())
      snapshot.program = sample
      buildTree()
      changed.forEach((cb) => cb(snapshot.dir))
    }
    const early: Omit<KernelEvent, 'sessionId'>[] = [
      { type: 'status', text: 'Reading the project' },
      { type: 'tool', tool: 'glob', detail: '**/*', input: { pattern: '**/*' } },
      { ...pdf(1), text: 'completed' },
      { ...pdf(3), text: 'completed' },
      { type: 'text', text: 'The paper reports two experiments with a harm and a help condition. ' },
    ]
    if (buildMode === 'hold') return early
    const write: Omit<KernelEvent, 'sessionId'>[] = [
      { type: 'tool', tool: 'bash', detail: 'mkdir -p package/knobe-2003', input: { command: 'mkdir -p package/knobe-2003' }, text: 'completed' },
      { type: 'tool', tool: 'edit', text: 'completed', detail: SAMPLE_DIFF, input: { filePath: R + 'program.json' } },
      { type: 'text', text: 'I wrote the study document. ' },
      { type: 'tool', tool: 'read', detail: 'program.json', input: { filePath: R + 'program.json' }, text: 'completed' },
    ]
    const late: Omit<KernelEvent, 'sessionId'>[] = [
      { type: 'tool', tool: 'bash', detail: 'python3 check_package.py package/knobe-2003', input: { command: 'python3 check_package.py package/knobe-2003' }, text: 'completed' },
      { type: 'text', text: 'The study is built. Three items are still marked **missing** (exclusion rule, vignette order, debriefing text). Open the Study tab to read it.' },
      { type: 'usage', usage: { input: 9000, output: 1800, reasoning: 0, cost: 0.05 } },
      { type: 'done' },
    ]
    window.setTimeout(writeStudy, early.length * 1100 + 1100)
    return [...early, ...write, ...late]
  }
  const script = (text: string): Omit<KernelEvent, 'sessionId'>[] => [
    { type: 'status', text: 'Reading the project' },
    { type: 'tool', tool: 'read', detail: 'program.json' },
    { type: 'tool', tool: 'read', detail: 'paper.pdf · pages 1–2' },
    { type: 'tool', tool: 'edit', text: 'completed', detail: SAMPLE_DIFF },
    ...reply(text)
      .split(/(?<=\s)/)
      .map((w) => ({ type: 'text' as const, text: w })),
    { type: 'usage', usage: { input: 1800, output: 140, reasoning: 0, cost: 0.004 } },
    { type: 'done' },
  ]
  // Real titles, authors, years and descriptions copied from HumanStudy-Bench's studies_index.json.
  const communityStudies: CommunityStudy[] = [
    {
      "id": "study_001",
      "title": "The “False Consensus Effect”: An Egocentric Bias in Social Perception and Attribution Processes",
      "authors": [
        "Lee Ross",
        "David Greene",
        "Pamela House"
      ],
      "year": 1977,
      "description": "Evidence from four studies demonstrates that social observers tend to perceive a “false consensus” with respect to the relative commonness of their own responses. A related bias was shown to exist in the observers’ social inferences. Thus, raters estimated particular responses to be relatively common and relatively unrevealing concerning the actors’ distinguishing personal dispositions when the responses in question were similar to the raters’ own responses; responses differing from those of the rater, by contrast, were perceived to be relatively uncommon and revealing of the actor. These results were obtained both in questionnaire studies presenting subjects with hypothetical situations and choices and in authentic conflict situations. The implications of these findings for our understanding of social perception phenomena and for our analysis of the divergent perceptions of actors and observers are discussed. Finally, cognitive and perceptual mechanisms are proposed which might account for distortions in perceived consensus and for corresponding biases in social inference and attributional processes....",
      "contributors": []
    },
    {
      "id": "study_002",
      "title": "Measures of Anchoring in Estimation Tasks",
      "authors": [
        "Karen E. Jacowitz",
        "Daniel Kahneman"
      ],
      "year": 1995,
      "description": "The authors describe a method for the quantitative study of anchoring effects in estimation tasks. A calibration group provides estimates of a set of uncertain quantities. Subjects in the anchored condition first judge whether a specified number (the anchor) is higher or lower than the true value before estimating each quantity. The anchors are set at predetermined percentiles of the distribution of estimates in the calibration group (15th and 85th percentiles in this study). This procedure permits the transformation of anchored estimates into percentiles in the calibration group, allows pooling of results across problems, and provides a natural measure of the size of the effect. The authors illustrate the method by a demonstration that the initial judgment of the anchor is susceptible to an anchoring-like bias and by an analysis of the relation between anchoring and subjective confidence....",
      "contributors": []
    },
    {
      "id": "study_005",
      "title": "Intentional Action and Side-Effects in Ordinary Language",
      "authors": [
        "Joshua Knobe"
      ],
      "year": null,
      "description": "The paper addresses a controversy in the concept of intentional action: whether side-effects of an action are brought about intentionally. The author hypothesizes that people's intuitions are influenced by their attitude toward the specific side-effect. Through two experiments, the author demonstrates an asymmetry: people are considerably more willing to say a side-effect was brought about intentionally when they regard that side-effect as bad (harmful) than when they regard it as good (helpful). This finding suggests that the assignment of praise and blame is at the root of how people apply the concept of intentionality....",
      "contributors": []
    },
    {
      "id": "study_006",
      "title": "FORMING IMPRESSIONS OF PERSONALITY",
      "authors": [
        "S. E. ASCH"
      ],
      "year": 1946,
      "description": "This classic study investigates the processes by which unified impressions of personality are formed. The author challenges the view that impressions are formed by the simple summation of independent traits. Through a series of experiments, Asch demonstrates that certain 'central' traits (such as 'warm' and 'cold') have a disproportionate effect on the final impression, while other 'peripheral' traits have less impact. The research also explores how the meaning of a trait changes depending on its context and the order in which information is received (the primacy effect). The findings suggest that impressions are structured wholes rather than mere collections of discrete characteristics....",
      "contributors": []
    }
  ]
  const communityFiles: Record<string, [string, number][]> = {
    "study_001": [
      [
        "index.json",
        1359
      ],
      [
        "source/4705-Ross-et-al-False-Consensus-Effect.pdf",
        1607159
      ],
      [
        "source/metadata.json",
        3724
      ],
      [
        "source/specification.json",
        1897
      ],
      [
        "source/ground_truth.json",
        13332
      ],
      [
        "source/materials/study_1_hypothetical_stories.json",
        5469
      ],
      [
        "source/materials/study_2_personal_description_items.json",
        7373
      ]
    ],
    "study_002": [
      [
        "index.json",
        1067
      ],
      [
        "source/jacowitz-kahneman-1995-measures-of-anchoring-in-estimation-tasks.pdf",
        1037381
      ],
      [
        "source/metadata.json",
        3934
      ],
      [
        "source/specification.json",
        2551
      ],
      [
        "source/ground_truth.json",
        13176
      ]
    ],
    "study_005": [
      [
        "index.json",
        781
      ],
      [
        "source/KNOBE.pdf",
        23232
      ],
      [
        "source/metadata.json",
        2383
      ],
      [
        "source/specification.json",
        1570
      ],
      [
        "source/ground_truth.json",
        5680
      ],
      [
        "source/materials/experiment_1_harm.json",
        1235
      ],
      [
        "source/materials/experiment_2_help.json",
        1141
      ],
      [
        "source/materials/experiment_2_harm.json",
        1120
      ]
    ],
    "study_006": [
      [
        "index.json",
        824
      ],
      [
        "source/Asch-Forming-Impressions-Of-Personality.pdf",
        2189141
      ],
      [
        "source/metadata.json",
        4881
      ],
      [
        "source/specification.json",
        2541
      ],
      [
        "source/ground_truth.json",
        26114
      ],
      [
        "source/materials/exp_6_order_effect.json",
        1493
      ],
      [
        "source/materials/exp_10_resemblance.json",
        1348
      ]
    ]
  }
  const REPO = 'https://github.com/HumanStudy-Hub/HumanStudy-Bench'
  const communityDetail = (id: string): CommunityStudyDetail => {
    const study = communityStudies.find((s) => s.id === id)
    if (!study) throw new Error(`Unknown study ${id}`)
    const base = `${REPO}/blob/main/studies/${id}`
    return {
      ...study,
      files: (communityFiles[id] ?? []).map(([path, size]) => ({ path, size, url: `${base}/${path}` })),
      // Clearly fake activity: the preview never talks to GitHub.
      activity: [
        { sha: 'preview0000001', message: 'Preview activity · not from GitHub', author: 'preview', date: ago(60 * 3), url: `${REPO}/commits/main/studies/${id}` },
        { sha: 'preview0000002', message: 'Preview activity · materials listing\n\nMock commit body.', author: 'preview', date: ago(60 * 24 * 5), url: `${REPO}/commits/main/studies/${id}` },
      ],
      repoUrl: `${REPO}/tree/main/studies/${id}`,
      discussionsUrl: `${REPO}/discussions`,
    }
  }
  const api: HumanStudyApi = {
    support: {
      status: async () => ({ available: false }),
      submit: async () => { throw new Error('Browser preview cannot send support requests.') },
    },
    projects: {
      list: async () => {
        if (folderBlocked) throw new Error(`macOS did not allow the app to read ${settings.projectsRoot}. Allow it under System Settings → Privacy & Security → Files and Folders, or choose another projects folder.`)
        return projects.map((p) => ({ ...p }))
      },
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
    community: {
      studies: async () => {
        await new Promise((r) => setTimeout(r, 350))
        return communityStudies.map((s) => ({ ...s }))
      },
      study: async (id) => {
        await new Promise((r) => setTimeout(r, 250))
        return communityDetail(id)
      },
      fork: async (id) => {
        const study = communityDetail(id)
        const name = `${study.authors[0]?.split(' ').pop() ?? 'Study'}${study.year ? ` ${study.year}` : ''} · ${study.title}`
        let dir = `/preview/${slug(study.id)}`
        for (let i = 2; projects.some((p) => p.dir === dir); i++) dir = `/preview/${slug(study.id)}-${i}`
        projects.unshift({ dir, name, updatedAt: new Date().toISOString(), hasPaper: true, hasProgram: false, artifactCount: 0 })
        return dir
      },
      openExternal: async (url) => {
        window.open(url, '_blank', 'noopener')
      },
    },
    account: {
      status: async () => accountStatus(),
      signIn: async (email, password) => {
        if (!email.trim() || !password) throw new Error('Enter your email and password.')
        Object.assign(account, { signedIn: true, email: email.trim() })
        return accountStatus()
      },
      signUp: async () => ({ needsConfirmation: true }),
      forgotPassword: async () => { throw new Error('Browser preview cannot send account emails/change account passwords. Use desktop app or website.') },
      resendConfirmation: async () => { throw new Error('Browser preview cannot send account emails/change account passwords. Use desktop app or website.') },
      changePassword: async () => { throw new Error('Browser preview cannot send account emails/change account passwords. Use desktop app or website.') },
      signOut: async () => {
        Object.assign(account, { signedIn: false, email: undefined, unlocked: false, keyExpiresAt: undefined })
        return accountStatus()
      },
      unlock: async (code) => {
        if (!account.signedIn) throw new Error('Sign in first, then enter your code.')
        if (code.trim() !== 'preview') throw new Error('That code is not valid.')
        account.unlocked = true
        account.keyExpiresAt = new Date(Date.now() + 30 * 86_400_000).toISOString()
        return accountStatus()
      },
    },
    settings: {
      get: async () => ({ ...settings }),
      set: async (patch) => ({ ...Object.assign(settings, patch) }),
      providers: async () => providers.map((p) => ({ ...p })),
      pickProjectsRoot: async () => {
        settings.projectsRoot = '~/Research/Studies'
        folderBlocked = false
        return { ...settings }
      },
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
          tree: [],
        }
      },
      reveal: async () => undefined,
      saveCopy: async (path) => `/Users/preview/Downloads/${path.split('/').pop()}`,
      versions: async (path) => {
        if (!texts.has(path)) return []
        let list = versionStore.get(path)
        if (!list) versionStore.set(path, (list = [{ id: `20261012T090000000Z.${path.split('.').pop()}`, at: Date.now() - 3_600_000, text: texts.get(path)! }]))
        return list.map((v) => ({ id: v.id, at: v.at, size: v.text.length }))
      },
      readVersion: async (path, id) => versionStore.get(path)?.find((v) => v.id === id)?.text ?? '',
      importFiles: async (dir, paths) =>
        paths.map((p) => {
          const name = p.split(/[\\/]/).pop() ?? p
          const isPaper = /\.pdf$/i.test(name) && !snapshot.pdf
          const path = `${dir}/${isPaper ? 'paper.pdf' : 'sources/' + name}`
          return { name: path.split('/').pop()!, path, url: path, ext: name.split('.').pop()?.toLowerCase() ?? '' }
        }),
      readText: async (path) => {
        const t = texts.get(path)
        if (t === undefined) throw new Error('no such file in the preview')
        return t
      },
      writeText: async (path, text) => {
        if (path.endsWith('program.json')) {
          JSON.parse(text)
          snapshot.program = JSON.parse(text)
        }
        const list = versionStore.get(path) ?? []
        if (list.length && list[list.length - 1].text !== text) list.push({ id: `${Date.now()}.${path.split('.').pop()}`, at: Date.now(), text })
        texts.set(path, text)
        mtimes.set(path, Date.now())
        buildTree()
        changed.forEach((cb) => cb(snapshot.dir))
      },
      onChanged: (cb) => {
        changed.add(cb)
        return () => changed.delete(cb)
      },
    },
    kernel: {
    export: async () => null,
    native: async () => { throw Error('Native OpenCode functions are unavailable in browser preview.') },
      questions: async (sid) => pendingQuestion.has(sid) ? [pendingQuestion.get(sid)!] : [],
      answerQuestion: async (sid, id, answers) => {
        const q = pendingQuestion.get(sid)
        if (!q || q.id !== id) throw new Error('This question is no longer pending.')
        validateAnswers(q, answers)
        pendingQuestion.delete(sid)
        play(sid, [{ type: 'question', question: { ...q, answers, resolved: 'answered' } },
          { type: 'text', text: `(Browser preview) Continuing with ${answers.map(a => a.join(', ')).join('; ')}.` }, { type: 'done' }])
      },
      rejectQuestion: async (sid, id) => {
        const q = pendingQuestion.get(sid)
        if (!q || q.id !== id) throw new Error('This question is no longer pending.')
        pendingQuestion.delete(sid)
        play(sid, [{ type: 'question', question: { ...q, resolved: 'rejected' } }, { type: 'done' }])
      },
      startSession: async () => {
        await installReady
        const sid = `preview-${++sessionCounter}`
        sessionThread.set(sid, '')
        return sid
      },
      send: async (sessionId, text, workspace) => {
        record('agent.turn_start', { metadata: { chars: text.length } })
        record('conversation.user', { metadata: { text, ...(workspace ? { workspace: JSON.stringify(workspace) } : {}) } })
        recordUser(sessionId, text, workspace)
        if (/ask question/i.test(text)) {
          const q: KernelQuestion = { id: `question-${++sessionCounter}`, questions: [
            { header: 'Participants', question: 'Which participant settings should I use?', options: [
              { label: 'Default to study', description: 'Use the population reported in the paper.' },
              { label: 'Customize', description: 'Specify a different population.' },
            ] },
            { header: 'Conditions', question: 'Which conditions should I include?', multiple: true, custom: false, options: [
              { label: 'Control', description: 'Baseline condition.' }, { label: 'Treatment', description: 'Experimental condition.' },
            ] },
          ] }
          pendingQuestion.set(sessionId, q)
          play(sessionId, [{ type: 'question', question: q }])
          return
        }
        if (text.startsWith('[Simulation scope approved]')) {
          const per = Number(/"perCondition":(\d+)/.exec(text)?.[1] ?? 20)
          play(sessionId, [{ type: 'text', text: 'The approved study matches program.json. I will run a trial with two AI participants, then the full run.\n\n' }, { type: 'tool', tool: 'bash', text: 'running', detail: 'python artifacts/simulations/run.py' }], 300)
          simulateRun(per, { finish: true, onEnd: () => play(sessionId, [{ type: 'tool', tool: 'bash', text: 'completed', detail: 'python artifacts/simulations/run.py' }, { type: 'text', text: '(Browser preview) The simulated participants showed the effect; the result is in the Simulation tab.' }, { type: 'done' }]) })
          return
        }
        if (/^Make the study runnable/.test(text) || /^请把研究做成可运行的/.test(text)) {
          play(sessionId, [{ type: 'text', text: 'I will write the runnable study package from program.json.\n\n' }, { type: 'tool', tool: 'write', text: 'running', detail: 'package/knobe-2003-intentional-action/task/adapter.py' }], 300)
          window.setTimeout(() => { putPackage(); touched(); play(sessionId, [{ type: 'tool', tool: 'write', text: 'completed', detail: 'package/knobe-2003-intentional-action/task/adapter.py' }, { type: 'text', text: 'The study is runnable; the package check passed.' }, { type: 'done' }]) }, 6000)
          return
        }
        let steps = /build the (study|human program)/i.test(text) ? buildScript(sessionId) : script(text)
        if (/\brun/i.test(text)) {
          // Scripted permission prompt: pauses until kernel.reply, like opencode asking before bash.
          const at = steps.findIndex((e) => e.type === 'tool')
          const id = `perm-${++sessionCounter}`
          pendingPermission.set(sessionId, {
            id,
            rest: [{ type: 'tool', tool: 'bash', text: 'running', detail: 'python run_simulation.py' }, { type: 'tool', tool: 'bash', text: 'completed', detail: 'python run_simulation.py' }, ...steps.slice(at)],
          })
          steps = [
            ...steps.slice(0, at),
            { type: 'permission', permission: { id, type: 'bash', title: 'python run_simulation.py', patterns: ['python run_simulation.py'] } },
          ]
        }
        play(sessionId, steps, /build the (study|human program)/i.test(text) ? 1100 : 45)
      },
      abort: async (sessionId) => {
        timers.get(sessionId)?.forEach((t) => clearTimeout(t))
        pendingPermission.delete(sessionId)
        pendingQuestion.delete(sessionId)
        emitAndRecord({ sessionId, type: 'done' })
      },
      reply: async (sessionId, permissionId, response: PermissionReply) => {
        const p = pendingPermission.get(sessionId)
        if (!p || p.id !== permissionId) throw new Error('no pending permission')
        pendingPermission.delete(sessionId)
        const resolved: Omit<KernelEvent, 'sessionId'> = { type: 'permission', permission: { id: permissionId, type: 'bash', resolved: response } }
        play(
          sessionId,
          response === 'reject'
            ? [resolved, resolved, { type: 'tool', tool: 'bash', text: 'error', detail: 'The user rejected this call' }, { type: 'text', text: 'Understood, I did not run it. ' }, { type: 'done' }]
            : [resolved, resolved, ...p.rest] // the follow-up can arrive twice
        )
      },
      onEvent: (cb) => {
        listeners.add(cb)
        return () => listeners.delete(cb)
      },
      install: {
        status: async () => installStatus,
        onProgress: (cb) => {
          installListeners.add(cb)
          return () => installListeners.delete(cb)
        },
        retry: async () => runInstall(false),
      },
    },
    app: { info: async () => ({ version: '0.1.0', platform: 'preview', arch: 'preview', kernelPath: '/preview/kernel/1.19.0/agent', home: '/Users/preview', devKeys: query.has('devkeys') }) },
    menu: {
      onCommand: (cb) => {
        menuListeners.add(cb)
        return () => menuListeners.delete(cb)
      },
    },
    threads: {
      list: async () =>
        [...threadStore.values()]
          .filter((t) => t.messages.length > 0)
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          .map((t) => ({ id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, messageCount: t.messages.length, usage: { ...t.usage } })),
      get: async (_dir, id) => {
        const t = threadStore.get(id)
        if (!t) throw new Error('no such thread')
        return structuredClone(t)
      },
      create: async () => {
        await installReady
        const sid = `preview-${++sessionCounter}`
        const now = new Date().toISOString()
        const t: Thread = { id: `thr_${sid}`, title: 'New thread', createdAt: now, updatedAt: now, kernel: 'mock', kernelSessionId: sid, messages: [], usage: { input: 0, output: 0, cost: 0 } }
        threadStore.set(t.id, t)
        sessionThread.set(sid, t.id)
        return structuredClone(t)
      },
      resume: async (_dir, id) => {
        await installReady
        const t = threadStore.get(id)
        if (!t) throw new Error('no such thread')
        if (!sessionThread.has(t.kernelSessionId)) {
          // A reload of the preview loses the scripted session: start a new one, keep the transcript.
          t.kernelSessionId = `preview-${++sessionCounter}`
          if (t.messages.length) t.resumedWithContext = true
        }
        sessionThread.set(t.kernelSessionId, t.id)
        return structuredClone(t)
      },
      rename: async (_dir, id, title) => {
        const t = threadStore.get(id)
        if (t) (t.title = title.trim() || t.title), (t.titleSource = 'user'), notifyThread(t)
      },
      delete: async (_dir, id) => {
        threadStore.delete(id)
        threadChanged.forEach((cb) => cb({ dir: snapshot.dir, id }))
      },
      onChanged: (cb) => {
        threadChanged.add(cb)
        return () => threadChanged.delete(cb)
      },
    },
    telemetry: {
      status: async () => researchStatus(),
      setConsent: async ({ usage, content }) => {
        if (!account.signedIn) throw new Error('Sign in to your HumanStudy Hub account first.')
        const prev = researchStatus()
        Object.assign(research, { decided: true, usage, content: usage && content, decidedAt: new Date().toISOString() })
        const metadata = { usageEvents: usage, conversationContent: usage && content, consentVersion: 2 }
        if (prev.usage && !usage) {
          recentEvents.forEach((r) => r.status === 'pending' && (r.status = 'dropped'))
          record('consent.withdrawn', { metadata }, true)
          markSent()
        } else if (usage && !prev.usage) record('consent.granted', { metadata })
        else if (usage && prev.content !== metadata.conversationContent) record('consent.changed', { metadata })
        return researchStatus()
      },
      track: async (type, opts) => {
        if (/^(consent|conversation|kernel|agent)\./.test(type)) return
        record(type, opts)
      },
      projectId: async (dir) => (dir && researchStatus().usage ? `preview-${slug(dir)}`.slice(0, 80) : null),
      recent: async () => recentEvents.slice().reverse().map((r) => ({ ...r })),
      flush: async () => {
        markSent()
        return researchStatus()
      },
      sessionId: async () => 'browser-preview-session',
      replayChunk: async () => false,
      exportMyData: async () => null,
      saveExport: async () => `/Users/preview/Downloads/humanstudy-research-data-${new Date().toISOString().slice(0, 10)}.json`,
    },
    files: { pathOf: (file) => file.name },
    updates: {
      status: async () => ({ version: '0.1.0-preview', state: 'none' }),
      check: async () => undefined,
      install: async () => undefined,
      onChange: () => () => undefined,
    },
  }
  ;(window as unknown as { humanstudy: HumanStudyApi }).humanstudy = api
}
