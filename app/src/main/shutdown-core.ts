/** Serializes quit/restart, blocks new turns, and never exits after a failed save. */
export function createShutdown(options: {
  busy: () => boolean
  confirm: (restart: boolean) => Promise<boolean>
  flush: () => Promise<void>
  dispose: () => Promise<void>
  failed: (error: unknown) => void
}) {
  let closing = false
  let ready = false
  let pending: Promise<boolean> | undefined
  function prepare(restart: boolean): Promise<boolean> {
    if (ready) return Promise.resolve(true)
    if (pending) return pending
    closing = true
    pending = (async () => {
      try {
        if (options.busy() && !await options.confirm(restart)) return false
        // Check disk before stopping the agent; then save its last events after shutdown.
        await options.flush()
        await options.dispose()
        await options.flush()
        ready = true
        return true
      } catch (error) {
        options.failed(error)
        return false
      } finally {
        if (!ready) closing = false
        pending = undefined
      }
    })()
    return pending
  }
  return { prepare, ready: () => ready, closing: () => closing }
}
