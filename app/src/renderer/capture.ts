// Window-wide research events that no single component owns: keyboard shortcuts and the start of
// typing in the message composer. Everything goes through track(), which the main process gates on
// consent, so installing the listeners is always safe.
import { beginActivation, track } from './telemetry'

const MODS = new Set(['Meta', 'Control', 'Alt', 'Shift'])
let installed = false

/** "cmd+shift+k": modifiers plus a key name (letters are lowercased; no text is recorded). */
export function shortcutName(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string | null {
  if (MODS.has(e.key) || !(e.metaKey || e.ctrlKey)) return null
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase().replace('arrow', '')
  return [e.metaKey && 'cmd', e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', k].filter(Boolean).join('+')
}

export function installCapture(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener(
    'keydown',
    (e) => {
      const which = shortcutName(e)
      // The shortcut begins an operation; the product action it triggers names it, so one key press
      // is never counted as both a shortcut and the action.
      if (which) beginActivation(`shortcut:${which}`, 'shortcut')
    },
    true,
  )
  document.addEventListener('click', e => {
    if (!(e.target instanceof Element)) return
    const el = e.target.closest('[data-event],button,a,input,select,textarea,[role]') ?? e.target
    // Opening the system file picker is not itself an operation; choosing files is (see attach/import).
    if (el instanceof HTMLInputElement && el.type === 'file') return
    const name = el.getAttribute('data-event') ?? el.tagName.toLowerCase()
    beginActivation(name, e.detail === 0 ? 'keyboard' : 'pointer')
  }, true)
  let visibleSince = document.visibilityState === 'visible' ? Date.now() : 0
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') visibleSince = Date.now()
    else if (visibleSince) { track('ui.foreground', { durationMs: Date.now() - visibleSince }); visibleSince = 0 }
  })
  // Only the settled position is captured; no mouse coordinates or per-frame scroll events.
  const runs = new Map<Element, { start: number; end: number; at: number; timer: ReturnType<typeof setTimeout> }>()
  document.addEventListener('scroll', e => {
    if (!(e.target instanceof Element)) return
    const el = e.target, range = el.scrollHeight - el.clientHeight
    if (range <= 0) return
    const end = Math.round(Math.max(0, Math.min(1, el.scrollTop / range)) * 1000), prior = runs.get(el)
    if (prior) clearTimeout(prior.timer)
    const run = { start: prior?.start ?? end, end, at: prior?.at ?? Date.now(), timer: undefined as unknown as ReturnType<typeof setTimeout> }
    run.timer = setTimeout(() => { runs.delete(el); track('ui.scroll', { durationMs: Date.now() - run.at,
      metadata: { endDepth: run.end, distance: Math.abs(run.end - run.start), direction: run.end >= run.start ? 'down' : 'up' } }) }, 800)
    runs.set(el, run)
  }, { capture: true, passive: true })
}
