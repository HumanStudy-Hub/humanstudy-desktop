// Session replay storage: rrweb chunks and large research payloads (program versions, file
// contents, long tool output) are written to disk first, then uploaded to Supabase Storage and
// recorded in public.desktop_replay_chunks. Electron-free (disk, fetch, auth and clock are
// injected) so it is tested with an in-memory disk and a stubbed fetch (telemetry.test.mjs).
//
// Rules:
// - Nothing is written unless `allowed()` (usage events AND conversation content consent).
//   Losing consent clears every pending local file.
// - A local file is deleted only after the server confirmed it (object stored and, for chunks,
//   row inserted). Failures back off exponentially; transient errors never drop data.
// - Disk use is capped (200 MB); the oldest pending files go first and the loss is reported.
import { randomUUID } from 'node:crypto'
import type { TelemetryAuth } from './telemetry-core'

export const REPLAY_BUCKET = 'desktop-replays'
export const DISK_CAP = 200 * 1024 * 1024
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024
export const REPLAY_FLUSH_MS = 20_000
const MAX_BACKOFF_MS = 10 * 60_000
const SESSION_RE = /^[A-Za-z0-9_-]{8,80}$/

export interface ReplayFile {
  rel: string
  size: number
  mtimeMs: number
}
/** Everything lives under one root folder (userData/replay); paths are relative with `/`. */
export interface ReplayFs {
  write(rel: string, data: Uint8Array | string): void
  read(rel: string): Uint8Array | null
  remove(rel: string): void
  list(): ReplayFile[]
  /** Removes the whole root. */
  clear(): void
}

export interface ReplayDeps {
  fs: ReplayFs
  fetch: typeof fetch
  auth(): Promise<TelemetryAuth | null>
  /** True only while usage events and conversation content are both consented to. */
  allowed(): boolean
  /** Hash of the signed-in account; files are uploaded only for the account that recorded them. */
  acct(): string | null
  appVersion: string
  now?(): number
  capBytes?: number
  /** Called when files were removed to stay under the cap (feeds the `replay.dropped` event). */
  onDropped?(info: { files: number; bytes: number; reason: 'cap' | 'rejected' }): void
}

interface Meta {
  kind: 'chunk' | 'blob'
  acct: string
  startedAt?: number
  endedAt?: number
  bytes: number
  windowId?: number
}
export interface ChunkInput {
  sessionId: string
  startedAt: number
  endedAt: number
  bytes: Uint8Array
  windowId?: number
}
export interface ChunkRow {
  session_id: string
  seq: number
  started_at: string
  ended_at: string
  bytes: number
  path: string
  window_id: number | null
  app_version: string
  id?: string
  created_at?: string
}

const isMeta = (rel: string): boolean => rel.endsWith('.meta.json')
const metaOf = (rel: string): string => rel.replace(/\.(json\.gz|gz)$/, '.meta.json')
const enc = (s: string): string => s.split('/').map(encodeURIComponent).join('/')

export function createReplay(deps: ReplayDeps) {
  const fs = deps.fs
  const now = (): number => (deps.now ? deps.now() : Date.now())
  const cap = deps.capBytes ?? DISK_CAP
  const nextSeq = new Map<string, number>()
  let failures = 0
  let nextAttemptAt = 0
  let lastError: string | undefined
  let inflight: Promise<void> | null = null

  const dataFiles = (): ReplayFile[] => fs.list().filter((f) => !isMeta(f.rel))
  const readMeta = (rel: string): Meta | null => {
    const b = fs.read(metaOf(rel))
    if (!b) return null
    try {
      const m = JSON.parse(Buffer.from(b).toString('utf8')) as Meta
      return m && (m.kind === 'chunk' || m.kind === 'blob') && typeof m.acct === 'string' ? m : null
    } catch {
      return null
    }
  }
  const removeBoth = (rel: string): void => {
    fs.remove(rel)
    fs.remove(metaOf(rel))
  }

  function enforceCap(): void {
    const files = dataFiles().sort((a, b) => a.mtimeMs - b.mtimeMs || (a.rel < b.rel ? -1 : 1))
    let total = files.reduce((n, f) => n + f.size, 0)
    let dropped = 0
    let bytes = 0
    for (const f of files) {
      if (total <= cap) break
      removeBoth(f.rel)
      total -= f.size
      dropped++
      bytes += f.size
    }
    if (dropped) deps.onDropped?.({ files: dropped, bytes, reason: 'cap' })
  }

  function seqFor(sessionId: string): number {
    let n = nextSeq.get(sessionId)
    if (n === undefined) {
      n = 0
      for (const f of fs.list()) {
        const m = /^([^/]+)\/(\d+)\.json\.gz$/.exec(f.rel)
        if (m && m[1] === sessionId) n = Math.max(n, Number(m[2]) + 1)
      }
    }
    nextSeq.set(sessionId, n + 1)
    return n
  }

  /** Stores one rrweb chunk (already gzipped). Returns its seq, or null when not allowed/invalid. */
  function addChunk(c: ChunkInput): number | null {
    const acct = deps.acct()
    if (!deps.allowed() || !acct) return null
    if (!SESSION_RE.test(c.sessionId) || !(c.bytes instanceof Uint8Array) || !c.bytes.length || c.bytes.length > MAX_CHUNK_BYTES) return null
    const seq = seqFor(c.sessionId)
    const rel = `${c.sessionId}/${seq}.json.gz`
    const meta: Meta = {
      kind: 'chunk',
      acct,
      startedAt: Number.isFinite(c.startedAt) ? c.startedAt : now(),
      endedAt: Number.isFinite(c.endedAt) ? c.endedAt : now(),
      bytes: c.bytes.length,
      windowId: typeof c.windowId === 'number' ? c.windowId : undefined,
    }
    fs.write(rel, c.bytes)
    fs.write(metaOf(rel), JSON.stringify(meta))
    enforceCap()
    return seq
  }

  /** Stores a large payload (gzipped) next to the replay; returns its session-relative path or null. */
  function addBlob(sessionId: string, bytes: Uint8Array): string | null {
    const acct = deps.acct()
    if (!deps.allowed() || !acct || !SESSION_RE.test(sessionId) || !bytes.length || bytes.length > MAX_CHUNK_BYTES) return null
    const name = `blobs/${randomUUID()}.gz`
    const rel = `${sessionId}/${name}`
    fs.write(rel, bytes)
    fs.write(metaOf(rel), JSON.stringify({ kind: 'blob', acct, bytes: bytes.length } satisfies Meta))
    enforceCap()
    return name
  }

  const headers = (auth: TelemetryAuth, extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: auth.supabaseKey,
    authorization: `Bearer ${auth.accessToken}`,
    ...extra,
  })
  const retryable = (status: number): boolean => status >= 500 || [401, 403, 408, 429].includes(status)

  function fail(message: string): void {
    failures++
    lastError = message
    nextAttemptAt = now() + Math.min(REPLAY_FLUSH_MS * 2 ** (failures - 1), MAX_BACKOFF_MS)
  }

  async function doFlush(force: boolean): Promise<void> {
    if (!deps.allowed()) {
      if (fs.list().length) fs.clear()
      return
    }
    const acct = deps.acct()
    if (!acct) return
    if (!force && now() < nextAttemptAt) return
    // Orphans (a data file without its sidecar, or the reverse) cannot be uploaded; remove them.
    const all = fs.list()
    const names = new Set(all.map((f) => f.rel))
    for (const f of all) {
      if (isMeta(f.rel)) {
        if (!names.has(f.rel.replace(/\.meta\.json$/, '.json.gz')) && !names.has(f.rel.replace(/\.meta\.json$/, '.gz'))) fs.remove(f.rel)
      } else if (!names.has(metaOf(f.rel))) fs.remove(f.rel)
    }
    const pending = dataFiles().sort((a, b) => a.mtimeMs - b.mtimeMs || (a.rel < b.rel ? -1 : 1))
    if (!pending.length) return
    let auth: TelemetryAuth | null
    try {
      auth = await deps.auth()
    } catch (e) {
      return fail((e as Error).message || 'offline')
    }
    if (!auth || !auth.userId) return
    let rejected = 0
    let rejectedBytes = 0
    for (const f of pending) {
      const meta = readMeta(f.rel)
      if (!meta || meta.acct !== acct) continue
      const body = fs.read(f.rel)
      if (!body) continue
      const objectPath = `${auth.userId}/${f.rel}`
      let res: Response
      try {
        res = await deps.fetch(`${auth.supabaseUrl}/storage/v1/object/${REPLAY_BUCKET}/${enc(objectPath)}`, {
          method: 'POST',
          headers: headers(auth, { 'content-type': 'application/gzip', 'x-upsert': 'true' }),
          body: body as unknown as BodyInit,
          signal: AbortSignal.timeout(60_000),
        })
      } catch (e) {
        return fail((e as Error).message || 'network error')
      }
      if (!res.ok) {
        if (retryable(res.status)) return fail(`storage returned ${res.status}`)
        removeBoth(f.rel) // the server will never accept this file (too large, bad type)
        rejected++
        rejectedBytes += f.size
        lastError = `storage rejected a file (${res.status})`
        continue
      }
      if (meta.kind === 'chunk') {
        const [sessionId, file] = f.rel.split('/')
        const row: ChunkRow = {
          session_id: sessionId,
          seq: Number(file.split('.')[0]),
          started_at: new Date(meta.startedAt ?? now()).toISOString(),
          ended_at: new Date(meta.endedAt ?? now()).toISOString(),
          bytes: meta.bytes,
          path: objectPath,
          window_id: meta.windowId ?? null,
          app_version: deps.appVersion.slice(0, 40),
        }
        let r2: Response
        try {
          r2 = await deps.fetch(`${auth.supabaseUrl}/rest/v1/desktop_replay_chunks?on_conflict=owner_id,session_id,seq`, {
            method: 'POST',
            headers: headers(auth, { 'content-type': 'application/json', prefer: 'resolution=ignore-duplicates,return=minimal' }),
            body: JSON.stringify({ ...row, owner_id: auth.userId }),
            signal: AbortSignal.timeout(20_000),
          })
        } catch (e) {
          return fail((e as Error).message || 'network error')
        }
        if (!r2.ok) {
          if (retryable(r2.status)) return fail(`server returned ${r2.status}`)
          removeBoth(f.rel)
          rejected++
          rejectedBytes += f.size
          lastError = `server rejected a replay chunk (${r2.status})`
          continue
        }
      }
      removeBoth(f.rel)
      failures = 0
      nextAttemptAt = 0
      lastError = undefined
    }
    if (rejected) deps.onDropped?.({ files: rejected, bytes: rejectedBytes, reason: 'rejected' })
  }

  function flush(opts: { force?: boolean } = {}): Promise<void> {
    if (inflight) return inflight
    inflight = doFlush(Boolean(opts.force)).finally(() => {
      inflight = null
    })
    return inflight
  }

  // ---- remote: delete and export ----
  async function listFolder(auth: TelemetryAuth, prefix: string): Promise<Array<{ name: string; id: string | null }>> {
    const out: Array<{ name: string; id: string | null }> = []
    for (let offset = 0; ; offset += 1000) {
      const res = await deps.fetch(`${auth.supabaseUrl}/storage/v1/object/list/${REPLAY_BUCKET}`, {
        method: 'POST',
        headers: headers(auth, { 'content-type': 'application/json' }),
        body: JSON.stringify({ prefix, limit: 1000, offset }),
        signal: AbortSignal.timeout(20_000),
      })
      if (!res.ok) throw new Error(`could not list stored replays (${res.status})`)
      const page = (await res.json()) as Array<{ name: string; id: string | null }>
      out.push(...page)
      if (page.length < 1000) return out
    }
  }
  /** Every object path under `<userId>/` (folders walked recursively). */
  async function listObjects(auth: TelemetryAuth, prefix = auth.userId, depth = 0): Promise<string[]> {
    if (depth > 4) return []
    const out: string[] = []
    for (const e of await listFolder(auth, prefix)) {
      if (e.id === null) out.push(...(await listObjects(auth, `${prefix}/${e.name}`, depth + 1)))
      else out.push(`${prefix}/${e.name}`)
    }
    return out
  }

  /** Deletes the user's chunk rows and storage objects, then every local replay file. */
  async function deleteAll(): Promise<void> {
    if (inflight) await inflight.catch(() => undefined)
    const auth = await deps.auth()
    if (!auth || !auth.userId) throw new Error('Your session has ended. Sign in again.')
    const res = await deps.fetch(`${auth.supabaseUrl}/rest/v1/desktop_replay_chunks?owner_id=eq.${encodeURIComponent(auth.userId)}`, {
      method: 'DELETE',
      headers: headers(auth, { prefer: 'return=minimal' }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`HumanStudy Hub could not delete your replay data (${res.status}). Try again later.`)
    const objects = await listObjects(auth)
    for (let i = 0; i < objects.length; i += 500) {
      const r = await deps.fetch(`${auth.supabaseUrl}/storage/v1/object/${REPLAY_BUCKET}`, {
        method: 'DELETE',
        headers: headers(auth, { 'content-type': 'application/json' }),
        body: JSON.stringify({ prefixes: objects.slice(i, i + 500) }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!r.ok) throw new Error(`HumanStudy Hub could not delete your stored replays (${r.status}). Try again later.`)
    }
    fs.clear()
    nextSeq.clear()
  }

  /** Chunk rows of the signed-in user (for the export), oldest first. */
  async function listRemoteChunks(auth: TelemetryAuth): Promise<ChunkRow[]> {
    const out: ChunkRow[] = []
    for (let offset = 0; ; offset += 1000) {
      const res = await deps.fetch(
        `${auth.supabaseUrl}/rest/v1/desktop_replay_chunks?owner_id=eq.${encodeURIComponent(auth.userId)}&order=started_at.asc&limit=1000&offset=${offset}`,
        { headers: headers(auth), signal: AbortSignal.timeout(20_000) }
      )
      if (!res.ok) throw new Error(`could not read replay chunks (${res.status})`)
      const page = (await res.json()) as ChunkRow[]
      out.push(...page)
      if (page.length < 1000) return out
    }
  }
  async function download(auth: TelemetryAuth, objectPath: string): Promise<Uint8Array> {
    const res = await deps.fetch(`${auth.supabaseUrl}/storage/v1/object/authenticated/${REPLAY_BUCKET}/${enc(objectPath)}`, {
      headers: headers(auth),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`could not download ${objectPath} (${res.status})`)
    return new Uint8Array(await res.arrayBuffer())
  }

  return {
    addChunk,
    addBlob,
    flush,
    deleteAll,
    listRemoteChunks,
    listObjects,
    download,
    /** Bytes of replay data waiting on disk. */
    pendingBytes: (): number => dataFiles().reduce((n, f) => n + f.size, 0),
    pendingFiles: (): number => dataFiles().length,
    clearLocal: (): void => {
      fs.clear()
      nextSeq.clear()
    },
    lastError: (): string | undefined => lastError,
  }
}

export type Replay = ReturnType<typeof createReplay>
