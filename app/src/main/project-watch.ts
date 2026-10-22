// Watch an open project folder. Editors and file managers rarely write in place: they write a temporary
// file and rename it over the original, or delete and recreate it, and on Windows fs.watch reports that
// as a burst of rename/change events, sometimes for the temporary name only. Events are therefore
// coalesced (debounced) into one "something changed" call after the folder settles, and the renderer
// re-reads the project and compares each file's version stamp (shared/file-version.ts) instead of
// trusting event names. A watcher that errors (EPERM when a watched folder is replaced on Windows) is
// closed and reported, so the caller can watch again on the next read rather than crash or go silent.
import { watch, type FSWatcher } from 'node:fs'

export interface FolderWatch {
  close(): void
}

export function watchFolder(
  dir: string,
  opts: {
    /** Every event, with the path relative to the folder when the platform reports one. */
    onFile?(rel: string): void
    /** Once per burst of events, after `debounceMs` without another. */
    onSettled(): void
    /** The watcher died; it is closed already. */
    onError?(e: unknown): void
    ignore?(rel: string): boolean
    debounceMs?: number
  },
): FolderWatch {
  let timer: NodeJS.Timeout | undefined
  let closed = false
  const debounce = opts.debounceMs ?? 250
  const w: FSWatcher = watch(dir, { recursive: true }, (_event, file) => {
    const rel = file ? String(file) : ''
    if (rel && opts.ignore?.(rel)) return
    if (rel) opts.onFile?.(rel)
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!closed) opts.onSettled()
    }, debounce)
  })
  const close = () => {
    if (closed) return
    closed = true
    clearTimeout(timer)
    try {
      w.close()
    } catch {
      /* already closed */
    }
  }
  w.on('error', (e) => {
    close()
    opts.onError?.(e)
  })
  return { close }
}
