// Window-wide research events that no single component owns: keyboard shortcuts and the start of
// typing in the message composer. Everything goes through track(), which the main process gates on
// consent, so installing the listeners is always safe.
import { track } from './telemetry'

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
      if (which) track('shortcut', { target: which, metadata: { which } })
    },
    true,
  )
  // A typing episode starts with the first input after 8 s of quiet in the composer.
  let lastInput = 0
  document.addEventListener(
    'input',
    (e) => {
      const el = e.target as HTMLElement | null
      if (!el || el.tagName !== 'TEXTAREA' || !el.closest('.composer')) return
      const now = Date.now()
      if (now - lastInput > 8_000) track('composer.typing_start', { metadata: { existingChars: (el as HTMLTextAreaElement).value.length } })
      lastInput = now
    },
    true,
  )
}
