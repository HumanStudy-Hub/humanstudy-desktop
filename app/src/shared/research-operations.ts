// One primary action per user operation (issue #27, T10). Pure: no DOM, Node or Electron APIs, so the
// renderer, the main process, the headless worker and the coverage tests share exactly this logic.
//
// A user operation starts at a click, a keyboard shortcut, a menu command, a composer Enter or a
// headless command. It gets one action id. The first semantic product action seen for it becomes the
// operation's single `action.invoke`; later semantic names for the same operation stay in the legacy
// stream only. Downstream records (messages, turns, tools, versions, imports) carry its id as
// action_id. A generic click/shortcut is recorded only when no semantic action claimed the operation.
import { ACTION_VIA, type ActionVia } from './research-contract'
import { researchInteraction } from './research-interactions'

/** The operation that initiated a chain of records. `primary` marks the one message that names it. */
export interface ActionRef {
  id: string
  target: string
  via: ActionVia
  /** Set by the renderer on the single track call that should become the action.invoke. */
  primary?: boolean
  /** Enclosing operation, when this one happened inside another (an answer during a turn). */
  parent?: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validates an action reference that crossed a process boundary (IPC, JSON-lines). */
export function actionRef(value: unknown): ActionRef | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || !UUID.test(v.id)) return undefined
  if (!(ACTION_VIA as readonly string[]).includes(v.via as string)) return undefined
  const target = typeof v.target === 'string' && v.target.trim() ? v.target.trim().slice(0, 160) : 'action'
  return { id: v.id.toLowerCase(), target, via: v.via as ActionVia, ...(v.primary === true ? { primary: true } : {}),
    ...(typeof v.parent === 'string' && UUID.test(v.parent) ? { parent: v.parent.toLowerCase() } : {}) }
}

/** How a legacy telemetry type relates to the operation: it names it, records a result, or neither. */
export function operationKind(type: string, opts: OperationTrack = {}): 'action' | 'record' | 'none' {
  const mapped = researchInteraction(type, opts)
  if (!mapped) return 'none'
  return mapped.event_type === 'action.invoke' ? 'action' : 'record'
}

export interface OperationTrack {
  target?: string
  durationMs?: number
  metadata?: Record<string, unknown>
  projectId?: string
  action?: ActionRef
  /** Research-v1 only: the legacy stream already has this operation under another name. */
  v1Only?: boolean
}

interface Op {
  ref: ActionRef
  /** Still inside the input event's synchronous dispatch (before the next microtask). */
  sync: boolean
  decided: boolean
  fallbackType: string
  buffer: Array<[string, OperationTrack]>
  timer?: unknown
  /** A claim may continue this operation until then (an awaited approval, a modal file dialog). */
  holdUntil: number
  decidedAt: number
}

export interface OperationDeps {
  send(type: string, opts: OperationTrack): void
  uuid(): string
  now(): number
  later(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
  microtask(fn: () => void): void
}

/** Wait this long for an asynchronous semantic handler before recording the generic input. */
export const FALLBACK_MS = 300

export function createOperations(deps: OperationDeps) {
  let current: Op | null = null

  function flush(op: Op, primaryType: string, primaryOpts: OperationTrack): void {
    op.decided = true
    op.decidedAt = deps.now()
    if (op.timer !== undefined) deps.cancel(op.timer)
    op.timer = undefined
    deps.send(primaryType, { ...primaryOpts, action: { ...op.ref, primary: true } })
    for (const [type, opts] of op.buffer.splice(0)) deps.send(type, { ...opts, action: { ...op.ref, primary: false } })
  }
  function fallback(op: Op): void {
    if (op.decided) return
    flush(op, op.fallbackType, { target: op.ref.target, metadata: { via: op.ref.via } })
  }

  /** A user input begins an operation. Inputs inside the same dispatch join the first one. */
  function begin(target: string, via: ActionVia, fallbackType = via === 'shortcut' ? 'shortcut' : 'ui.click'): ActionRef {
    if (current && current.sync) return current.ref // e.g. a shortcut handler calling button.click()
    if (current && !current.decided && current.timer !== undefined) {
      // An unclaimed earlier operation is finished: record its generic input before the next one.
      fallback(current)
    }
    const op: Op = { ref: { id: deps.uuid(), target: target.slice(0, 160) || 'action', via }, sync: true, decided: false,
      fallbackType, buffer: [], holdUntil: 0, decidedAt: 0 }
    current = op
    deps.microtask(() => {
      op.sync = false
      if (!op.decided) op.timer = deps.later(() => { op.timer = undefined; fallback(op) }, FALLBACK_MS)
    })
    return op.ref
  }

  /**
   * A menu command arrived. When its accelerator also reached the page as a shortcut keydown, the
   * pending shortcut operation is the same user operation; otherwise the command starts its own.
   */
  function menu(command: string, accelerator: boolean): ActionRef {
    const op = current
    if (accelerator && op && !op.decided && op.ref.via === 'shortcut') {
      op.fallbackType = 'menu.command'; op.ref = { ...op.ref, target: command.slice(0, 160) }
      return op.ref
    }
    return begin(command, accelerator ? 'shortcut' : 'menu', 'menu.command')
  }

  /** Passive, periodic summaries are never attributed to an operation. */
  const PASSIVE = /^ui\.(scroll|foreground)$/
  function attachable(op: Op | null): op is Op {
    return Boolean(op && (op.sync || !op.decided))
  }

  /**
   * Route one semantic event. With `explicit` (an operation captured before an await), the event is
   * attributed to it; otherwise only to an operation that is still being dispatched or undecided.
   */
  function track(type: string, opts: OperationTrack = {}, explicit?: ActionRef): void {
    if (PASSIVE.test(type) && !explicit) return deps.send(type, opts)
    const op = explicit ? (current && current.ref.id === explicit.id ? current : null) : current
    if (explicit && !op) return deps.send(type, { ...opts, action: { ...explicit, primary: false } })
    if (!attachable(op) && !explicit) return deps.send(type, opts)
    const live = op as Op
    const kind = operationKind(type, opts)
    if (live.decided) return deps.send(type, { ...opts, action: { ...live.ref, primary: false } })
    if (kind === 'action') return flush(live, type, opts)
    live.buffer.push([type, opts])
  }

  /**
   * A downstream request (send, save, import, answer) is about to cross to the main process with this
   * operation's id; the main process records the action when the request arrives. Without a user
   * operation in progress the request is a system operation of its own.
   */
  function claim(name: string, announce = false, via: ActionVia = 'system'): ActionRef {
    const op = current
    // A handler that awaits briefly between its semantic event and its request is still the same
    // operation; the next user input always starts a new one.
    const usable = op && (op.sync || !op.decided || deps.now() < Math.max(op.holdUntil, op.decidedAt + FALLBACK_MS))
    if (!usable) {
      // `via` names the input when the caller knows it (a drop, a file chosen in the system picker).
      const ref: ActionRef = { id: deps.uuid(), target: name.slice(0, 160), via }
      if (announce) deps.send(name, { target: name, metadata: { via }, action: { ...ref, primary: true }, v1Only: true })
      return ref
    }
    if (!op!.decided) {
      op!.ref = { ...op!.ref, target: name.slice(0, 160) }
      if (announce) flush(op!, name, { target: name, metadata: { via: op!.ref.via }, v1Only: true })
      else {
        // The primary is recorded by the main process with the downstream request; buffered records follow it.
        op!.decided = true
        op!.decidedAt = deps.now()
        if (op!.timer !== undefined) deps.cancel(op!.timer)
        op!.timer = undefined
        const buffered = op!.buffer.splice(0)
        deps.microtask(() => { for (const [type, opts] of buffered) deps.send(type, { ...opts, action: { ...op!.ref, primary: false } }) })
      }
    }
    return { ...op!.ref }
  }

  /** Let an awaited continuation of the current operation claim it (until the next user input). */
  function hold(ms: number): ActionRef | undefined {
    if (!current) return undefined
    current.holdUntil = deps.now() + ms
    return { ...current.ref }
  }

  /** The operation being dispatched right now, if any (to carry across an await). */
  function active(): ActionRef | undefined {
    return current && (current.sync || !current.decided) ? { ...current.ref } : undefined
  }

  return { begin, menu, track, claim, hold, active }
}
export type Operations = ReturnType<typeof createOperations>
