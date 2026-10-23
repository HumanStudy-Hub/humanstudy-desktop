// One semantic adapter for the desktop and headless Kernel interface. UI code never supplies
// authoritative assistant/tool output. Partial text checkpoints are coalesced, not one disk write
// per token. Native ids correlate parallel calls; fallback ids are explicitly marked.
//
// Causality (T10): every operation has exactly one action.invoke, emitted here the first time any
// path reports it (`action`). Downstream records carry its id as action_id, the record that caused
// them as caused_by and an enclosing operation as metadata.parent_action_id. thread_id is the native
// OpenCode session id; message/part/tool-call ids are OpenCode's own when reported.
import { randomUUID } from 'node:crypto'
import type { KernelEvent } from './kernel-types'
import type { ResearchCapture } from './research-collector'
import type { ActionRef } from '../shared/research-operations'
import { ACTION_VIA, type ActionVia } from '../shared/research-contract'
import { researchInteraction } from '../shared/research-interactions'

type Sink = (event: ResearchCapture, context?: { projectDir?: string }) => Promise<unknown>
type Turn = { started: number; message: string; text: string; failed: boolean; action: string; userMessage: string; userEvent?: string
  native?: string; nativeUser?: string; parts: Set<string>; partOf: Map<string, number>
  project?: string; dir?: string; model: string; timer?: ReturnType<typeof setTimeout> }
type Call = { id: string; sid: string; started: number; start?: string; end?: string; ended?: number; input?: unknown
  inputText: string; action?: string; dir?: string; message?: string; part?: string }
/** Causal columns for a record that is not itself produced by the agent adapter. */
export interface ResearchLink {
  action_id?: string
  caused_by?: string
  thread_id?: string
  tool_call_id?: string
  metadata: Record<string, unknown>
}
const RECENT_TOOL_MS = 60_000, RECENT_TURN_MS = 120_000, HISTORY = 400, REMEMBERED = 5_000
const norm = (p: string) => p.split('\\').join('/').replace(/\/+$/, '')

export function createResearchAgent(capture: Sink) {
  const turns = new Map<string, Turn>()
  const contexts = new Map<string, { project?: string; dir?: string; model: string }>()
  const tools = new Map<string, Call>()
  const history: Call[] = []
  const lastTurn = new Map<string, { action: string; dir?: string; ended: number }>()
  const emitted = new Set<string>()
  const replies = new Map<string, ActionRef>() // `${sid}:q:${id}` / `${sid}:p:${id}` -> the answering operation
  const promises = new Set<Promise<unknown>>()
  const track = (promise: Promise<unknown>) => { promises.add(promise); void promise.catch(() => undefined).finally(() => promises.delete(promise)) }
  const emit = (sid: string, fields: ResearchCapture): string => {
    const t = turns.get(sid), ctx = t ?? contexts.get(sid)
    const id = fields.id ?? randomUUID()
    const previous = t ? undefined : lastTurn.get(sid)
    // Activity of a session after its turn ended (a late tool status) still belongs to that turn's
    // operation; activity no operation of this process started is labelled, not left unlinked.
    const link = t ? { action_id: t.action, caused_by: t.action } : previous ? { action_id: previous.action, caused_by: previous.action } : {}
    const metadata = !t && fields.event_type !== 'action.invoke'
      ? { ...(previous ? { action_link: 'previous-turn' } : { trigger: 'external' }), ...fields.metadata } : fields.metadata
    track(capture({ id, thread_id: sid, project_id: ctx?.project, ...link, ...fields, ...(metadata ? { metadata } : {}) }, { projectDir: ctx?.dir }))
    return id
  }
  /** Record an operation's single action.invoke, once, whichever path reports it first. */
  function action(ref: ActionRef, fields: { project_id?: string; thread_id?: string; view?: string; metadata?: Record<string, unknown>; dir?: string } = {}): string {
    if (emitted.has(ref.id)) return ref.id
    emitted.add(ref.id)
    if (emitted.size > REMEMBERED) emitted.delete(emitted.values().next().value as string)
    const ctx = fields.thread_id ? contexts.get(fields.thread_id) : undefined
    track(capture({ id: ref.id, event_type: 'action.invoke', target: ref.target, view: fields.view ?? 'workspace',
      project_id: fields.project_id ?? ctx?.project, ...(fields.thread_id ? { thread_id: fields.thread_id } : {}),
      metadata: { ...fields.metadata, via: ref.via, ...(ref.parent ? { parent_action_id: ref.parent } : {}) } }, { projectDir: fields.dir ?? ctx?.dir }))
    return ref.id
  }
  const systemRef = (target: string): ActionRef => ({ id: randomUUID(), target, via: 'system' })
  function checkpoint(sid: string, status: string) {
    const t = turns.get(sid); if (!t) return
    clearTimeout(t.timer); t.timer = undefined
    if (!t.text) return
    const message = t.native ?? t.message, part = t.partOf.get(message) ?? 0
    emit(sid, { event_type: 'conversation.message', message_id: message, ...(t.userEvent ? { caused_by: t.userEvent } : {}),
      metadata: { role: 'assistant', part, part_kind: 'text', status, text: t.text, native_id_reported: Boolean(t.native),
        ...(t.parts.size ? { native_part_ids: [...t.parts] } : {}) } })
    // Each checkpoint is a consecutive segment; concatenate by message/part, not latest snapshot.
    t.text = ''; t.partOf.set(message, part + 1); t.parts = new Set()
  }
  function finish(sid: string, status: string, stoppedBy?: string) {
    const t = turns.get(sid); if (!t) return
    checkpoint(sid, status === 'complete' ? 'complete' : 'partial')
    for (const [key, tool] of tools) if (key.startsWith(sid + ':')) {
      if (!tool.ended) {
        tool.ended = Date.now()
        tool.end = emit(sid, { event_type: 'tool.end', tool_call_id: tool.id, target: key.slice(sid.length + 1).split(':')[0],
          caused_by: tool.start, duration_ms: Math.min(86400000, Date.now() - tool.started), metadata: { status: 'interrupted', output_absent: true,
            ...(tool.message ? { native_message_id: tool.message } : {}), ...(tool.part ? { native_part_id: tool.part } : {}) } })
      }
      tools.delete(key)
    }
    emit(sid, { event_type: 'agent.turn_end', duration_ms: Math.min(86400000, Date.now() - t.started), ...(stoppedBy ? { caused_by: stoppedBy } : {}),
      metadata: { status, user_message_id: t.userMessage, ...(t.nativeUser ? { native_user_message_id: t.nativeUser } : {}),
        ...(stoppedBy ? { stopped_by_action_id: stoppedBy } : {}) } })
    lastTurn.set(sid, { action: t.action, dir: t.dir, ended: Date.now() })
    turns.delete(sid)
  }
  /** The tool call (or, failing that, the turn) that most plausibly wrote `rel` in `dir`. */
  function writer(dir: string, rel: string): ResearchLink | null {
    const root = norm(dir), file = norm(rel), now = Date.now()
    const inProject = (c: Call) => !c.dir || norm(c.dir) === root
    const live = (c: Call) => !c.ended || now - c.ended <= RECENT_TOOL_MS
    const candidates = history.filter(c => inProject(c) && live(c) && c.action).reverse()
    const named = candidates.find(c => c.inputText.includes(file) || c.inputText.includes(root + '/' + file))
    const running = candidates.find(c => !c.ended)
    const call = named ?? running ?? candidates[0]
    if (call) return { action_id: call.action, caused_by: call.end ?? call.start, thread_id: call.sid, tool_call_id: call.id,
      metadata: { trigger: 'agent-tool', writer_link: named ? 'tool-input' : running ? 'tool-running' : 'tool-recent',
        ...(call.message ? { native_message_id: call.message } : {}), ...(call.part ? { native_part_id: call.part } : {}) } }
    for (const [sid, t] of turns) if (!t.dir || norm(t.dir) === root)
      return { action_id: t.action, caused_by: t.action, thread_id: sid, metadata: { trigger: 'agent-turn', writer_link: 'turn' } }
    for (const [sid, t] of lastTurn) if ((!t.dir || norm(t.dir) === root) && now - t.ended <= RECENT_TURN_MS)
      return { action_id: t.action, caused_by: t.action, thread_id: sid, metadata: { trigger: 'agent-turn', writer_link: 'recent-turn' } }
    return null
  }
  return {
    action,
    /**
     * A semantic UI event (desktop renderer or main process). One action.invoke per operation: a
     * secondary name of an operation already recorded adds no row; result records link to it.
     */
    interaction(type: string, opts: { target?: string; durationMs?: number; metadata?: Record<string, unknown>; action?: ActionRef } = {},
      ctx: { project_id?: string; dir?: string } = {}): void {
      const unified = researchInteraction(type, opts), ref = opts.action
      if (unified?.event_type === 'action.invoke') {
        const via = ACTION_VIA.includes(unified.metadata?.via as ActionVia) ? unified.metadata!.via as ActionVia : 'system'
        const op: ActionRef = ref ? (ref.primary ? { ...ref, target: unified.target! } : ref) : { id: randomUUID(), target: unified.target!, via }
        action(op, { project_id: ctx.project_id, view: unified.view ?? undefined, dir: ctx.dir, metadata: ref && !ref.primary ? {} : unified.metadata })
      } else if (unified) {
        if (ref) action(ref, { project_id: ctx.project_id, dir: ctx.dir })
        track(capture({ ...unified, project_id: ctx.project_id, ...(ref ? { action_id: ref.id, caused_by: ref.id } : {}) }, { projectDir: ctx.dir }))
      } else if (ref) action(ref, { project_id: ctx.project_id, dir: ctx.dir })
    },
    bind(sid: string, project?: string, dir?: string, model = 'not-reported') { contexts.set(sid, { project, dir, model }) },
    /** A submitted message. `ref` is the user operation or command that sent it. */
    start(sid: string, text: string, ref?: ActionRef): string {
      const ctx = contexts.get(sid) ?? { model: 'not-reported' }
      const op = ref ?? systemRef('composer.send')
      const running = turns.get(sid)
      action(running ? { ...op, parent: op.parent ?? running.action } : op, { project_id: ctx.project, thread_id: sid, view: 'agent' })
      if (running) {
        // A rejected/queued send must not close or reattribute the still-running turn.
        emit(sid, { event_type: 'conversation.message', message_id: randomUUID(), action_id: op.id, caused_by: op.id, metadata: {
          role: 'user', part: 0, part_kind: 'text', status: 'submitted_while_busy', text, parent_action_id: running.action } })
        return op.id
      }
      const t: Turn = { ...ctx, started: Date.now(), message: randomUUID(), userMessage: randomUUID(), text: '', failed: false,
        action: op.id, parts: new Set(), partOf: new Map() }
      turns.set(sid, t)
      const turnStart = emit(sid, { event_type: 'agent.turn_start', metadata: { model: t.model, ...(op.parent ? { parent_action_id: op.parent } : {}) } })
      t.userEvent = emit(sid, { event_type: 'conversation.message', message_id: t.userMessage, caused_by: turnStart,
        metadata: { role: 'user', part: 0, part_kind: 'text', status: 'complete', text } })
      return op.id
    },
    /** The researcher (or a headless command) answered or dismissed a question. Call before the kernel. */
    answer(sid: string, questionId: string, ref: ActionRef, fields: Parameters<typeof action>[1] = {}) {
      const parent = turns.get(sid)?.action ?? lastTurn.get(sid)?.action
      const op = parent && !ref.parent ? { ...ref, parent } : ref
      replies.set(`${sid}:q:${questionId}`, op)
      action(op, { thread_id: sid, view: 'agent', ...fields, metadata: { ...fields.metadata, question_id: questionId } })
    },
    /** A permission reply by the researcher. Automatic decisions stay with the turn. */
    permit(sid: string, permissionId: string, ref: ActionRef, fields: Parameters<typeof action>[1] = {}) {
      const parent = turns.get(sid)?.action ?? lastTurn.get(sid)?.action
      const op = parent && !ref.parent ? { ...ref, parent } : ref
      replies.set(`${sid}:p:${permissionId}`, op)
      action(op, { thread_id: sid, view: 'agent', ...fields, metadata: { ...fields.metadata, permission_id: permissionId } })
    },
    event(e: KernelEvent) {
      const sid = e.sessionId, t = turns.get(sid)
      if (!contexts.has(sid)) return
      if (e.type === 'identity' && t) t.nativeUser = e.detail
      else if (e.type === 'text' && t) {
        if (e.messageId && t.native && e.messageId !== t.native) checkpoint(sid, 'partial')
        if (e.messageId) t.native = e.messageId
        if (e.partId) t.parts.add(e.partId)
        t.text += e.text ?? ''
        if (!t.timer) { t.timer = setTimeout(() => checkpoint(sid, 'partial'), 1000); t.timer.unref?.() }
      } else if (e.type === 'tool') {
        checkpoint(sid, 'partial')
        const key = `${sid}:${e.tool ?? 'tool'}:${e.toolCallId ?? 'unreported'}`
        let call = tools.get(key)
        if (!call || (call.ended && !e.toolCallId)) {
          const ctx = t ?? contexts.get(sid)
          call = { id: e.toolCallId ?? randomUUID(), sid, started: Date.now(), inputText: '', dir: ctx?.dir,
            action: t?.action ?? lastTurn.get(sid)?.action }
          tools.set(key, call); history.push(call); if (history.length > HISTORY) history.shift()
        }
        if (e.messageId) call.message = e.messageId
        if (e.partId) call.part = e.partId
        const native = { native_id_reported: Boolean(e.toolCallId), ...(call.message ? { native_message_id: call.message } : {}),
          ...(call.part ? { native_part_id: call.part } : {}) }
        if (!call.start || (e.input !== undefined && JSON.stringify(e.input) !== JSON.stringify(call.input))) {
          call.input = e.input
          call.inputText = norm(typeof e.input === 'string' ? e.input : JSON.stringify(e.input ?? ''))
          call.start = emit(sid, { event_type: 'tool.start', tool_call_id: call.id, target: e.tool ?? 'tool', metadata: {
            ...(e.input === undefined ? { input_absent: true } : { input: typeof e.input === 'string' ? e.input : JSON.stringify(e.input) }),
            ...native, state: e.text ?? 'pending' } })
        }
        if ((e.text === 'completed' || e.text === 'error') && !call.ended) {
          call.ended = Date.now()
          call.end = emit(sid, { event_type: 'tool.end', tool_call_id: call.id, target: e.tool ?? 'tool', caused_by: call.start,
            duration_ms: Math.min(86400000, Date.now() - call.started), metadata: { status: e.text, ...native,
              ...(e.output === undefined ? { output_absent: true } : { output: e.output }) } })
        }
      } else if (e.type === 'question' && e.question) {
        const q = e.question, by = q.resolved ? replies.get(`${sid}:q:${q.id}`) : undefined
        if (by) replies.delete(`${sid}:q:${q.id}`)
        emit(sid, { event_type: 'conversation.question', message_id: q.id, ...(by ? { action_id: by.id, caused_by: by.id } : {}),
          metadata: { question_id: q.id, status: q.resolved ?? 'asked', questions: JSON.stringify(q.questions),
            ...(q.answers ? { answers: JSON.stringify(q.answers) } : {}), ...(by?.parent ? { parent_action_id: by.parent } : {}),
            ...(q.resolved && !by ? { answered_by: 'not-this-app' } : {}) } })
      } else if (e.type === 'permission' && e.permission) {
        const p = e.permission, by = p.resolved && !p.automatic ? replies.get(`${sid}:p:${p.id}`) : undefined
        if (by) replies.delete(`${sid}:p:${p.id}`)
        emit(sid, { event_type: p.resolved ? 'permission.decision' : 'permission.request', target: p.type || 'not-reported',
          ...(by ? { action_id: by.id, caused_by: by.id } : {}),
          metadata: { permission_id: p.id, ...(p.resolved ? { reply: p.resolved, automatic: Boolean(p.automatic) } : {}),
            ...(by?.parent ? { parent_action_id: by.parent } : {}),
            ...(p.title ? { title: p.title } : {}), ...(p.patterns ? { patterns: p.patterns } : {}) } })
      } else if (e.type === 'usage' && e.usage) {
        emit(sid, { event_type: 'agent.usage', message_id: e.messageId ?? t?.native ?? t?.message ?? randomUUID(),
          metadata: { model: t?.model ?? contexts.get(sid)?.model ?? 'not-reported', native_id_reported: Boolean(e.messageId), ...e.usage } })
      } else if (e.type === 'error') {
        if (t) t.failed = true
        checkpoint(sid, 'partial')
        emit(sid, { event_type: 'conversation.error', metadata: { status: 'error', text: e.text ?? e.detail ?? 'Unknown error' } })
      } else if (e.type === 'status' && e.text === 'recovering') {
        emit(sid, { event_type: 'agent.recovery', metadata: { reason: 'runtime-recovery', detail: e.detail ?? '', ...((e.input ?? {}) as Record<string, unknown>) } })
      } else if (e.type === 'done') finish(sid, t?.failed ? 'error' : e.detail === 'shutdown' ? 'interrupted' : 'complete')
    },
    /** Stop the running turn; `ref` is the stop operation when a person or command asked for it. */
    abort(sid: string, ref?: ActionRef) {
      if (ref) action(turns.get(sid) && !ref.parent ? { ...ref, parent: turns.get(sid)!.action } : ref, { thread_id: sid, view: 'agent' })
      finish(sid, 'aborted', ref?.id)
    },
    /**
     * Causal columns for a captured file/program version. A save links to the researcher's save
     * operation; an agent write links to the tool call that wrote it (#32 write attribution decides
     * who); anything else is labelled `baseline` or `external` instead of being left unlinked.
     */
    versionLink(dir: string, rel: string, by: string, human?: ActionRef): ResearchLink {
      if (by === 'human') {
        if (human) { action(human); return { action_id: human.id, caused_by: human.id, metadata: { trigger: 'human-save' } } }
        return { metadata: { trigger: 'human-save', action_link: 'not-reported' } }
      }
      if (by === 'open' || by === 'baseline') return { metadata: { trigger: 'baseline' } }
      return writer(dir, rel) ?? { metadata: { trigger: 'external' } }
    },
    /** Link for a source import (`ref` is the import/create operation, when one is known). */
    sourceLink(ref?: ActionRef, trigger = 'import'): ResearchLink {
      if (!ref) return { metadata: { trigger: trigger === 'import' ? 'baseline' : trigger } }
      action(ref)
      return { action_id: ref.id, caused_by: ref.id, metadata: { trigger } }
    },
    async drain() { for (const sid of turns.keys()) checkpoint(sid, 'partial'); await Promise.allSettled([...promises]) },
    async close() { for (const sid of turns.keys()) finish(sid, 'interrupted'); await Promise.allSettled([...promises]) },
  }
}
