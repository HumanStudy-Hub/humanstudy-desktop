// Renderer-side research events. The main process decides whether anything is queued (consent,
// sign-in) and sanitizes every event, so calling track() is always safe and never throws.
import type { TelemetryTrackOptions } from '../preload/types'

let currentProjectId: string | undefined
let activation: { seen: boolean; via: string } | null = null
/** A component's semantic event owns the activation; fallback captures otherwise unnamed clicks. */
export function beginActivation(target: string, via: string): void {
  const current = { seen: false, via }; activation = current
  queueMicrotask(() => {
    if (!current.seen) track('ui.click', { target, metadata: { via } })
    if (activation === current) activation = null
  })
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

export function track(type: string, opts: TelemetryTrackOptions = {}): void {
  try {
    if (activation) {
      activation.seen = true
      opts = { ...opts, metadata: { ...opts.metadata, via: activation.via } }
    }
    void window.humanstudy.telemetry
      ?.track(type, { ...opts, projectId: opts.projectId ?? currentProjectId })
      .catch(() => undefined)
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
