// Unsaved text edits, kept above the file editor so they survive tab switches, folding the pane and
// going back to Projects. A draft is the editor text plus the disk text it started from (`base`).
// Pure module state with no React, so it is testable in node.

export interface Draft {
  /** The path as the editor opened it. */
  path: string
  text: string
  /** The file's text on disk when the draft began (or at the last save). */
  base: string
}

/** Windows paths are case-insensitive and may use either separator; one file is one key. */
export function pathKey(path: string): string {
  const p = path.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(p) || path.includes('\\') ? p.toLowerCase() : p
}

const eol = (s: string) => s.replace(/\r\n?/g, '\n')

/** Whether the editor text differs from the disk text. A textarea reports CRLF files with LF line ends,
 *  so line endings alone are not an edit. */
export function isDirty(text: string, base: string | null): boolean {
  return base !== null && eol(text) !== eol(base)
}

/** The text to write: the editor's text with the line endings the file had on disk. */
export function toDisk(text: string, base: string | null): string {
  return base && /\r\n/.test(base) ? eol(text).replace(/\n/g, '\r\n') : text
}

const drafts = new Map<string, Draft>()
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

export const getDraft = (path: string): Draft | undefined => drafts.get(pathKey(path))

/** Keep the editor state; a text equal to its base is no draft. */
export function setDraft(path: string, text: string, base: string): void {
  const k = pathKey(path)
  const had = drafts.has(k)
  if (isDirty(text, base)) drafts.set(k, { path, text, base })
  else drafts.delete(k)
  if (had !== drafts.has(k)) emit()
}

export function clearDraft(path: string): void {
  if (drafts.delete(pathKey(path))) emit()
}

const inside = (path: string, dir: string) => {
  const d = pathKey(dir).replace(/\/+$/, '')
  return pathKey(path).startsWith(d + '/')
}

/** The drafts of files inside a project folder. */
export const draftsIn = (dir: string): Draft[] => [...drafts.values()].filter((d) => inside(d.path, dir))

export function clearDraftsIn(dir: string): void {
  let n = 0
  for (const d of draftsIn(dir)) if (drafts.delete(pathKey(d.path))) n++
  if (n) emit()
}

export const draftCount = (): number => drafts.size

/** Called whenever the set of files with drafts changes. */
export function onDraftsChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
