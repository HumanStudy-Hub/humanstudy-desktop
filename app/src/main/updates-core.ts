import type { UpdateStatus } from '../preload/types'

/** Only an actually empty release feed means there are no published versions. */
export function isNoReleaseError(message: string): boolean {
  return /no published versions/i.test(message)
}

export function shortError(message: string): string {
  const line = message.split('\n')[0].replace(/<[^>]*>/g, '').trim()
  return line.length > 140 ? line.slice(0, 137) + '…' : line
}

export function isTransientUpdateError(message: string): boolean {
  return /ERR_(NETWORK_CHANGED|INTERNET_DISCONNECTED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|NAME_NOT_RESOLVED)|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|HTTP[^\n]*\b(429|502|503|504)\b/i.test(message)
}

interface UpdateClient {
  checkForUpdates(): Promise<{ downloadPromise?: Promise<unknown> | null } | null>
  on(event: string, handler: (...args: any[]) => void): unknown
}

/** One download/check at a time, with bounded retries for connection failures only. */
export function createUpdateController(options: {
  client: UpdateClient
  version: string
  notify: (status: UpdateStatus) => void
  schedule?: (fn: () => void, delay: number) => () => void
}) {
  const { client, version, notify } = options
  const schedule = options.schedule ?? ((fn, delay) => {
    const timer = setTimeout(fn, delay)
    timer.unref?.()
    return () => clearTimeout(timer)
  })
  const delays = [15_000, 45_000, 120_000]
  let status: UpdateStatus = { version, state: 'idle' }
  let inFlight = false
  let stopped = false
  let retries = 0
  let cancelRetry: (() => void) | undefined
  function set(patch: Omit<UpdateStatus, 'version'>) {
    status = { version, ...patch }
    notify(status)
  }
  function clearRetry() { cancelRetry?.(); cancelRetry = undefined }
  function fail(error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    set({ state: 'error', nextVersion: status.nextVersion, error: shortError(message) })
  }
  client.on('checking-for-update', () => set({ state: 'checking' }))
  const alreadyInstalled = (next: unknown) => typeof next === 'string' && next.replace(/^v/, '') === version.replace(/^v/, '')
  client.on('update-available', info => set(alreadyInstalled(info.version) ? {state:'none'} : { state: 'available', nextVersion: info.version }))
  client.on('update-not-available', () => set({ state: 'none' }))
  client.on('download-progress', p => set({ state: 'downloading', nextVersion: status.nextVersion, progress: Math.round(p.percent) }))
  client.on('update-downloaded', info => { clearRetry(); retries = 0; set(alreadyInstalled(info.version) ? {state:'none'} : { state: 'ready', nextVersion: info.version, progress: 100 }) })
  // Handles native installer errors too; retry scheduling belongs to the awaited operation.
  client.on('error', fail)

  async function check(manual = true): Promise<void> {
    if (stopped || inFlight || status.state === 'ready') return
    clearRetry()
    if (manual) retries = 0
    inFlight = true
    try {
      const result = await client.checkForUpdates()
      // checkForUpdates resolves BEFORE its automatic download. Observe that promise as well.
      await result?.downloadPromise
      retries = 0
    } catch (error) {
      fail(error)
      const message = error instanceof Error ? error.message : String(error)
      if (!stopped && isTransientUpdateError(message) && retries < delays.length) {
        const delay = delays[retries++]
        set({ state: 'error', nextVersion: status.nextVersion, error: `Connection interrupted. Retrying in ${delay / 1000}s (${retries}/${delays.length}). You can also retry now.` })
        cancelRetry = schedule(() => { cancelRetry = undefined; void check(false) }, delay)
      }
    } finally {
      inFlight = false
    }
  }
  return { check, reportError: fail, status: () => status, stop: () => { stopped = true; clearRetry() } }
}

/** macOS ZIP verification/staging completes after electron-updater's download event. */
export function waitForNativeUpdate(client: {
  on(event: string, fn: (...args: any[]) => void): unknown
  removeListener(event: string, fn: (...args: any[]) => void): unknown
}, timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      client.removeListener('update-downloaded', ready)
      client.removeListener('error', failed)
    }
    const ready = () => { cleanup(); resolve() }
    const failed = (error: unknown) => { cleanup(); reject(error) }
    const timer = setTimeout(() => failed(new Error('The update is still being prepared. Please try restarting the update again shortly.')), timeoutMs)
    client.on('update-downloaded', ready)
    client.on('error', failed)
  })
}

/** Keep restart preparation reversible until the application actually begins exiting. */
export function createUpdateInstaller(options: {
  ready: () => boolean
  waitForNative: () => Promise<void>
  prepare: () => Promise<boolean>
  rollback: () => void
  launch: () => void
  report: (error: unknown) => void
  schedule?: (fn: () => void, delay: number) => () => void
}) {
  const schedule = options.schedule ?? ((fn, delay) => {
    const timer = setTimeout(fn, delay)
    timer.unref?.()
    return () => clearTimeout(timer)
  })
  let phase: 'idle' | 'preparing' | 'launching' = 'idle'
  let prepared = false
  let failure: unknown
  let cancelWatchdog: (() => void) | undefined
  function restore(error: unknown) {
    if (phase === 'idle') return
    cancelWatchdog?.(); cancelWatchdog = undefined
    if (prepared) options.rollback()
    prepared = false
    phase = 'idle'
    options.report(error)
  }
  async function run(): Promise<void> {
    if (phase !== 'idle' || !options.ready()) return
    phase = 'preparing'
    failure = undefined
    prepared = false
    try {
      await options.waitForNative()
      if (failure) throw failure
      prepared = await options.prepare()
      if (failure) throw failure
      if (!prepared) { phase = 'idle'; return }
      phase = 'launching'
      // Some updater implementations emit an error and return false internally instead of throwing.
      cancelWatchdog = schedule(() => restore(new Error('The update could not restart the app. You can keep working and retry the update later.')), 15_000)
      options.launch()
    } catch (error) { restore(error) }
  }
  return {
    run,
    failed: (error: unknown) => {
      if (phase === 'preparing') failure = error // Do not unblock new turns during a pending save.
      else if (phase === 'launching') restore(error)
    },
    exiting: () => { cancelWatchdog?.(); cancelWatchdog = undefined },
  }
}
