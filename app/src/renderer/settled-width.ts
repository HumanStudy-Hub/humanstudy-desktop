/** Keep CSS resizing fluid; rasterize expensive content only after its width settles. */
export function observeSettledWidth(element: Element, apply: (width: number) => void, delay = 120): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending = -1
  let applied = 0
  const commit = (width: number) => { if (width !== applied) { applied = width; apply(width) } }
  const observer = new ResizeObserver(entries => {
    const width = Math.max(0, Math.round(entries[0].contentRect.width))
    if (width === pending) return
    pending = width
    clearTimeout(timer)
    // Cancel stale painting immediately; the existing bitmap still scales smoothly in CSS.
    commit(0)
    if (!width) return
    timer = setTimeout(() => commit(width), delay)
  })
  observer.observe(element)
  return () => { clearTimeout(timer); observer.disconnect() }
}
