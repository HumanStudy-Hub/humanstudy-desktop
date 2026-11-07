// Back: the places the reader left, newest last. A handler records the place before it moves the
// reader (switching a tab, following a citation, opening a project or a library study); ⌘[, the
// mouse back button, a trackpad swipe and Go > Back return to it. Restoring never records a place.
// An undo that finds nothing left to do returns false, and Back moves on to the next place.

type Undo = () => boolean | void
const stack: { scope: string; undo: Undo }[] = []
const LIMIT = 50
let restoring = false
let last = 0

export function remember(scope: string, undo: Undo): void {
  if (restoring) return
  stack.push({ scope, undo })
  if (stack.length > LIMIT) stack.shift()
}

/** Returns to the newest place that still exists. False when there is nowhere to go back to. */
export function goBack(): boolean {
  // The menu accelerator and the page's own key handler can both see one ⌘[.
  const now = Date.now()
  if (now - last < 120) return true
  last = now
  while (stack.length) {
    const { undo } = stack.pop()!
    restoring = true
    let moved: boolean | void
    try {
      moved = undo()
    } finally {
      restoring = false
    }
    if (moved !== false) return true
  }
  return false
}

/** Drops the places of one scope, e.g. a project's tabs once the project is closed. */
export function forget(scope: string): void {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].scope === scope) stack.splice(i, 1)
}

/** For tests. */
export function resetNav(): void {
  stack.length = 0
  last = 0
}
