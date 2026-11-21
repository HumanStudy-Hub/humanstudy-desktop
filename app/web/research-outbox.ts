// Only submitted chat and semantic telemetry enter this store, after the sandbox confirms consent.
interface Entry {
  workspace: string
  visit: string
  scope: string
  id: string
  occurredAt: string
  order: number
  channel: string
  args: unknown[]
}

const STORE = 'events'
export function createResearchOutbox(workspace: string, visit: string, initialScope: string | null,
  send: (entry: Entry) => Promise<unknown>, getScope: () => Promise<unknown>) {
  let database: Promise<IDBDatabase> | undefined
  function open() {
    database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('humanstudy-research-outbox', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE, { keyPath: ['workspace', 'id'] }).createIndex('workspace', 'workspace')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }).catch(error => { database = undefined; throw error })
    return database
  }
  async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open()
    return new Promise<T>((resolve, reject) => {
      const tx = mode === 'readwrite'
        ? db.transaction(STORE, mode, { durability: 'strict' })
        : db.transaction(STORE, mode)
      const request = operation(tx.objectStore(STORE))
      tx.oncomplete = () => resolve(request.result)
      tx.onabort = () => reject(tx.error ?? request.error)
      if (mode === 'readwrite') tx.commit?.()
    })
  }
  const entries = () => transaction<Entry[]>('readonly', store => store.index('workspace').getAll(workspace))
  const everything = () => transaction<Entry[]>('readonly', store => store.getAll())
  const remove = (entry: Entry) => transaction('readwrite', store => store.delete([entry.workspace, entry.id]))
  let scope = initialScope
  let verifying: Promise<void> | undefined
  let scopeRevision = 0
  let verifyAgain = false
  let flushing = false
  let wake = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = 1000

  function setScope(next: string | null) {
    const previous = scope
    scopeRevision++
    scope = next
    // Withdrawal, sign-out or a different account/agreement ends every earlier scope in this browser
    // origin, including rows other workspaces left behind. A first grant keeps other workspaces' rows.
    const ended = next === null || (previous !== null && previous !== next)
    void (ended ? everything() : entries()).then(async rows => {
      if (scope === next) await Promise.all(rows.filter(row => row.scope !== next || (ended && row.workspace !== workspace)).map(remove))
    }).catch(() => undefined)
  }

  function refresh() {
    if (verifying) { verifyAgain = true; return verifying }
    const revision = scopeRevision
    verifying = getScope().then(next => {
      if (revision === scopeRevision) {
        const confirmed = typeof next === 'string' ? next : null
        // A denied/revoked answer opens an existing store even on a fresh page, to remove old consent data.
        setScope(confirmed)
      }
    }).catch(() => undefined).finally(() => {
      verifying = undefined
      if (verifyAgain) { verifyAgain = false; void refresh() }
      else replay()
    })
    return verifying
  }

  function replay() {
    clearTimeout(timer)
    if (!scope) return
    if (flushing) { wake = true; return }
    flushing = true
    const current = scope
    let retry = false
    void entries().then(async rows => {
      for (const entry of rows.sort((a, b) => a.order - b.order)) {
        if (scope !== current) break
        if (entry.scope !== current) continue
        try {
          const reply = await send(entry) as { status?: string; id?: string } | null
          if ((reply?.status === 'ack' && reply.id === entry.id) || reply?.status === 'ignored') await remove(entry)
          else if (reply?.status === 'scope_changed') { void refresh(); break }
          else retry = true
        } catch { retry = true }
      }
    }).catch(() => { retry = true }).finally(() => {
      flushing = false
      if (wake) { wake = false; replay() }
      else if (retry && scope) {
        timer = setTimeout(replay, delay)
        delay = Math.min(delay * 2, 15_000)
      } else delay = 1000
    })
  }

  async function append(channel: string, args: unknown[]) {
    if (!scope) return
    const entry = { workspace, visit, scope, id: crypto.randomUUID(), occurredAt: new Date().toISOString(), order: performance.timeOrigin + performance.now(), channel, args }
    try {
      await transaction('readwrite', store => store.add(entry))
      if (scope !== entry.scope) await remove(entry)
      else replay()
    } catch {
      // When storage is unavailable, still try to deliver while the page is open.
      if (scope === entry.scope) await send(entry).catch(() => undefined)
    }
  }
  return { append, refresh, replay, suspend: () => setScope(null) }
}
