/** Serializes quit/restart, blocks new turns, and never exits after a failed save. */
export function createShutdown(options: {
  busy: () => boolean
  confirm: (restart: boolean) => Promise<boolean>
  flush: () => Promise<void>
  quiesce: () => Promise<void>
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
        // Stop the turn, not the session/server: a failed save or installer must be reversible.
        await options.flush()
        await options.quiesce()
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
  return {
    prepare,
    ready: () => ready,
    closing: () => closing,
    reset: () => {
      // A launch failure can roll back only after the save barrier has finished.
      if (pending) return false
      ready = false
      closing = false
      return true
    },
  }
}


/** Keep the deadline live even when a stalled upload is the only outstanding work. */
export async function flushWithin(flush: () => Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      new Promise<void>(resolve => { timer = setTimeout(resolve, ms) }),
      Promise.resolve().then(flush),
    ])
  } catch {
    // Capture and upload retain their pending work on disk.
  } finally {
    clearTimeout(timer)
  }
}
