// Mock kernel: streams a plausible reply with one tool step, for UI work without opencode.
import { Emitter } from './types'
import type { Kernel, KernelEvent, PermissionReply } from './types'

export interface MockOptions {
  /** Delay between streamed chunks in ms (default 40). Tests pass 0. */
  tickMs?: number
}

type Step = Omit<KernelEvent, 'sessionId'>

export class MockKernel implements Kernel {
  readonly name = 'mock'
  private emitter = new Emitter()
  private sessions = new Map<
    string,
    { dir: string; timers: Set<NodeJS.Timeout>; busy: boolean; pending?: { id: string; rest: Step[] } }
  >()
  private counter = 0
  private tickMs: number

  constructor(opts: MockOptions = {}) {
    this.tickMs = opts.tickMs ?? 40
  }

  async startSession(projectDir: string): Promise<string> {
    const id = `mock_${Date.now().toString(36)}_${++this.counter}`
    this.sessions.set(id, { dir: projectDir, timers: new Set(), busy: false })
    return id
  }

  async send(sessionId: string, text: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s) throw new Error(`unknown session ${sessionId}`)
    if (s.busy) throw new Error('session is busy')
    s.busy = true

    const steps: Step[] = [{ type: 'status', text: 'busy' }]
    const say = (t: string): void => {
      for (const w of t.match(/\S+\s*/g) ?? []) steps.push({ type: 'text', text: w })
    }
    const prompt = text.trim().slice(0, 80)
    say(`(mock kernel) You asked: "${prompt}". Let me look at the project first. `)
    steps.push({ type: 'tool', tool: 'read', text: 'running', detail: 'program.json' })
    steps.push({ type: 'tool', tool: 'read', text: 'completed', detail: 'program.json' })
    say(
      'The Human Program has 2 conditions and 1 dependent measure. ' +
        'Items without a verbatim source are labelled missing. ' +
        'Install opencode and set OPENROUTER_API_KEY to talk to a real agent.'
    )
    const tokens = Math.max(1, Math.ceil(text.length / 4))
    const tail: Step[] = [{ type: 'usage', usage: { input: tokens, output: 60, reasoning: 0, cost: 0 } }, { type: 'done' }]

    // A resumed thread prefixes the old transcript; only the new message decides.
    if (/\brun/i.test(text.split('</transcript>').pop() ?? text)) {
      // Pause for approval, like a bash call under opencode's "ask" permission.
      const head = steps.splice(0, steps.findIndex((e) => e.type === 'tool'))
      const id = `mockperm_${++this.counter}`
      s.pending = { id, rest: [...steps, ...tail] }
      head.push({
        type: 'permission',
        permission: { id, type: 'bash', title: 'python run_simulation.py', patterns: ['python run_simulation.py'] },
      })
      this.play(sessionId, head)
      return
    }
    this.play(sessionId, [...steps, ...tail])
  }

  async reply(sessionId: string, permissionId: string, response: PermissionReply): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s?.pending || s.pending.id !== permissionId) throw new Error(`no pending permission ${permissionId}`)
    const { rest } = s.pending
    s.pending = undefined
    const steps: Step[] = [{ type: 'permission', permission: { id: permissionId, type: 'bash', resolved: response } }]
    if (response === 'reject') {
      steps.push({ type: 'tool', tool: 'bash', text: 'error', detail: 'The user rejected this call' })
      steps.push({ type: 'text', text: 'Understood, I did not run it. ' })
      steps.push(...rest.filter((e) => e.type === 'usage' || e.type === 'done'))
    } else {
      steps.push({ type: 'tool', tool: 'bash', text: 'running', detail: 'python run_simulation.py' })
      steps.push({ type: 'tool', tool: 'bash', text: 'completed', detail: 'python run_simulation.py' })
      steps.push(...rest)
    }
    this.play(sessionId, steps)
  }

  async resumeSession(_projectDir: string, sessionId: string): Promise<string | null> {
    return this.sessions.has(sessionId) ? sessionId : null
  }

  private play(sessionId: string, steps: Step[]): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    let delay = 0
    for (const step of steps) {
      delay += this.tickMs
      const t = setTimeout(() => {
        s.timers.delete(t)
        if (step.type === 'done') s.busy = false
        this.emitter.emit({ sessionId, ...step })
      }, delay)
      s.timers.add(t)
    }
  }

  async abort(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId)
    if (!s || !s.busy) return
    for (const t of s.timers) clearTimeout(t)
    s.timers.clear()
    s.pending = undefined
    s.busy = false
    this.emitter.emit({ sessionId, type: 'status', text: 'aborted' })
    this.emitter.emit({ sessionId, type: 'done' })
  }

  onEvent(cb: (e: KernelEvent) => void): () => void {
    return this.emitter.on(cb)
  }

  async dispose(): Promise<void> {
    for (const s of this.sessions.values()) for (const t of s.timers) clearTimeout(t)
    this.sessions.clear()
    this.emitter.clear()
  }
}
