// Renderer-side research events. The main process decides whether anything is queued (consent,
// sign-in) and sanitizes every event, so calling track() is always safe and never throws.
import type { TelemetryTrackOptions } from '../preload/types'

let currentProjectId: string | undefined

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
    void window.humanstudy.telemetry
      ?.track(type, { ...opts, projectId: opts.projectId ?? currentProjectId })
      .catch(() => undefined)
  } catch {
    /* research data must never break the app */
  }
}
