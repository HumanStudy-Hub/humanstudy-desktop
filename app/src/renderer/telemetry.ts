// Renderer-side research events. The main process decides whether anything is queued (consent,
// sign-in) and sanitizes every event, so calling track() is always safe and never throws.
import type { ActionRef, TelemetryTrackOptions } from '../preload/types'
import type { ActionVia } from '../shared/research-contract'
import { createOperations } from '../shared/research-operations'

let currentProjectId: string | undefined
const send = (type: string, opts: TelemetryTrackOptions): void => {
  try {
    void window.humanstudy.telemetry
      ?.track(type, { ...opts, projectId: opts.projectId ?? currentProjectId })
      .catch(() => undefined)
  } catch {
    /* research data must never break the app */
  }
}
// One primary action per user operation; see shared/research-operations.ts.
const operations = createOperations({
  send,
  uuid: () => crypto.randomUUID(),
  now: () => Date.now(),
  later: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  microtask: (fn) => queueMicrotask(fn),
})
/** A click, shortcut or composer Enter begins one operation; its semantic event (or a generic one) names it. */
export function beginActivation(target: string, via: ActionVia, fallbackType?: string): ActionRef {
  try { return operations.begin(target, via, fallbackType) } catch { return { id: crypto.randomUUID(), target, via } }
}
/** A native menu command (accelerator presses join the shortcut operation already in progress). */
export function beginMenuCommand(command: string, accelerator: boolean): void {
  try { operations.menu(command, accelerator) } catch { /* ignore */ }
}
/**
 * The operation a downstream request (send, save, import, answer) belongs to. Pass the result to
 * the request so the main process links what it records to the same single action.
 */
export function claimAction(name: string, announce = false, via: ActionVia = 'system'): ActionRef {
  try { return operations.claim(name, announce, via) } catch { return { id: crypto.randomUUID(), target: name, via } }
}
/** Keep the current operation claimable across an awaited step (until the next user input). */
export function holdAction(ms = 60_000): ActionRef | undefined {
  try { return operations.hold(ms) } catch { return undefined }
}

/** Resolves the open project's research id so later events carry project_id. */
export async function setTelemetryProject(dir: string | null): Promise<void> {
  currentProjectId = undefined
  try {
    // Also tells the main process which project is open (null when back on Home).
    currentProjectId = (await window.humanstudy.telemetry?.projectId(dir)) ?? undefined
  } catch {
    /* ignore */
  }
}

/** `action` attributes an event to an operation captured before an await. */
export function track(type: string, opts: TelemetryTrackOptions = {}, action?: ActionRef): void {
  try {
    operations.track(type, opts, action)
  } catch {
    /* research data must never break the app */
  }
}

// ---- spans: how long something stayed in its previous state -----------------------------------
const since = new Map<string, number>()
/** Milliseconds since the last `lap(key)` for this key (undefined the first time); restarts the span. */
export function lap(key: string): number | undefined {
  const now = Date.now()
  const prev = since.get(key)
  since.set(key, now)
  return prev === undefined ? undefined : now - prev
}
