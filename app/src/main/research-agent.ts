// One semantic adapter for the desktop and headless Kernel interface. UI code never supplies
// authoritative assistant/tool output. Partial text checkpoints are coalesced, not one disk write
// per token. Native ids correlate parallel calls; fallback ids are explicitly marked.
import { randomUUID } from 'node:crypto'
import type { KernelEvent } from './kernel-types'
import type { ResearchCapture } from './research-collector'

type Sink = (event: ResearchCapture, context?: { projectDir?: string }) => Promise<unknown>
type Turn = { started: number; message: string; text: string; part: number; failed: boolean; action: string;
  project?: string; dir?: string; model: string; timer?: ReturnType<typeof setTimeout> }
export function createResearchAgent(capture: Sink) {
  const turns = new Map<string, Turn>()
  const contexts = new Map<string, { project?: string; dir?: string; model: string }>()
  const tools = new Map<string, { id: string; started: number; start?: string; ended?: boolean; input?: unknown }>()
  const promises = new Set<Promise<unknown>>()
  const emit = (sid: string, fields: ResearchCapture): string => {
    const t = turns.get(sid), ctx = t ?? contexts.get(sid)
    const id = fields.id ?? randomUUID()
    const promise = capture({ id, thread_id: sid, project_id: ctx?.project,
      ...(t ? { action_id: t.action, caused_by: t.action } : {}), ...fields }, { projectDir: ctx?.dir })
    promises.add(promise); void promise.catch(() => undefined).finally(() => promises.delete(promise))
    return id
  }
  function checkpoint(sid: string, status: string) {
    const t = turns.get(sid); if (!t) return
    clearTimeout(t.timer); t.timer = undefined
    if (!t.text) return
    emit(sid, { event_type: 'conversation.message', message_id: t.message,
      metadata: { role: 'assistant', part: t.part, part_kind: 'text', status, text: t.text } })
    // Each checkpoint is a consecutive segment; concatenate by message/part, not latest snapshot.
    t.text = ''; t.part++
  }
  function finish(sid: string, status: string) {
    const t = turns.get(sid); if (!t) return
    checkpoint(sid, status === 'complete' ? 'complete' : 'partial')
    for (const [key, tool] of tools) if (key.startsWith(sid + ':')) {
      if (!tool.ended) emit(sid, { event_type: 'tool.end', tool_call_id: tool.id, target: key.slice(sid.length + 1).split(':')[0],
        caused_by: tool.start, duration_ms: Math.min(86400000, Date.now() - tool.started), metadata: { status: 'interrupted', output_absent: true } })
      tools.delete(key)
    }
    emit(sid, { event_type: 'agent.turn_end', duration_ms: Math.min(86400000, Date.now() - t.started), metadata: { status } })
    turns.delete(sid)
  }
  return {
    bind(sid: string, project?: string, dir?: string, model = 'not-reported') { contexts.set(sid, { project, dir, model }) },
    start(sid: string, text: string) {
      if (turns.has(sid)) {
        // A rejected/queued send must not close or reattribute the still-running turn.
        emit(sid, { event_type: 'conversation.message', message_id: randomUUID(), metadata: {
          role: 'user', part: 0, part_kind: 'text', status: 'submitted_while_busy', text } })
        return
      }
      const ctx = contexts.get(sid) ?? { model: 'not-reported' }
      const action = randomUUID()
      emit(sid, { id: action, event_type: 'action.invoke', view: 'agent', target: 'composer.send', metadata: { via: 'system' } })
      const t: Turn = { ...ctx, started: Date.now(), message: randomUUID(), text: '', part: 0, failed: false, action }
      turns.set(sid, t)
      emit(sid, { event_type: 'agent.turn_start', metadata: { model: t.model } })
      emit(sid, { event_type: 'conversation.message', message_id: randomUUID(), metadata: { role: 'user', part: 0, part_kind: 'text', status: 'complete', text } })
    },
    event(e: KernelEvent) {
      const sid = e.sessionId, t = turns.get(sid)
      if (!contexts.has(sid)) return
      if (e.type === 'text' && t) {
        t.text += e.text ?? ''
        if (!t.timer) { t.timer = setTimeout(() => checkpoint(sid, 'partial'), 1000); t.timer.unref?.() }
      } else if (e.type === 'tool') {
        checkpoint(sid, 'partial')
        const key = `${sid}:${e.tool ?? 'tool'}:${e.toolCallId ?? 'unreported'}`
        let call = tools.get(key)
        if (!call || (call.ended && !e.toolCallId)) { call = { id: e.toolCallId ?? randomUUID(), started: Date.now() }; tools.set(key, call) }
        if (!call.start || (e.input !== undefined && JSON.stringify(e.input) !== JSON.stringify(call.input))) {
          call.input = e.input
          call.start = emit(sid, { event_type: 'tool.start', tool_call_id: call.id, target: e.tool ?? 'tool', metadata: {
            ...(e.input === undefined ? { input_absent: true } : { input: typeof e.input === 'string' ? e.input : JSON.stringify(e.input) }),
            native_id_reported: Boolean(e.toolCallId), state: e.text ?? 'pending' } })
        }
        if ((e.text === 'completed' || e.text === 'error') && !call.ended) {
          call.ended = true
          emit(sid, { event_type: 'tool.end', tool_call_id: call.id, target: e.tool ?? 'tool', caused_by: call.start,
            duration_ms: Math.min(86400000, Date.now() - call.started), metadata: { status: e.text,
              ...(e.output === undefined ? { output_absent: true } : { output: e.output }) } })
        }
      } else if (e.type === 'question' && e.question) {
        const q = e.question
        emit(sid, { event_type: 'conversation.question', message_id: q.id, metadata: { question_id: q.id,
          status: q.resolved ?? 'asked', questions: JSON.stringify(q.questions), ...(q.answers ? { answers: JSON.stringify(q.answers) } : {}) } })
      } else if (e.type === 'permission' && e.permission) {
        const p = e.permission
        emit(sid, { event_type: p.resolved ? 'permission.decision' : 'permission.request', target: p.type || 'not-reported',
          metadata: { permission_id: p.id, ...(p.resolved ? { reply: p.resolved, automatic: Boolean(p.automatic) } : {}),
            ...(p.title ? { title: p.title } : {}), ...(p.patterns ? { patterns: p.patterns } : {}) } })
      } else if (e.type === 'usage' && e.usage) {
        emit(sid, { event_type: 'agent.usage', message_id: e.messageId ?? t?.message ?? randomUUID(),
          metadata: { model: t?.model ?? contexts.get(sid)?.model ?? 'not-reported', ...e.usage } })
      } else if (e.type === 'error') {
        if (t) t.failed = true
        checkpoint(sid, 'partial')
        emit(sid, { event_type: 'conversation.error', metadata: { status: 'error', text: e.text ?? e.detail ?? 'Unknown error' } })
      } else if (e.type === 'status' && e.text === 'recovering') {
        emit(sid, { event_type: 'agent.recovery', metadata: { reason: 'runtime-recovery', detail: e.detail ?? '', ...((e.input ?? {}) as Record<string, unknown>) } })
      } else if (e.type === 'done') finish(sid, t?.failed ? 'error' : e.detail === 'shutdown' ? 'interrupted' : 'complete')
    },
    abort(sid: string) { finish(sid, 'aborted') },
    async drain() { for (const sid of turns.keys()) checkpoint(sid, 'partial'); await Promise.allSettled([...promises]) },
    async close() { for (const sid of turns.keys()) finish(sid, 'interrupted'); await Promise.allSettled([...promises]) },
  }
}
