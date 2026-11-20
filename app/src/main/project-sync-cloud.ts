// Project sync, the cloud part: the account's private Storage bucket `projects` and its table public.project_sync,
// both in the HumanStudy Hub Supabase project (humanstudy-hub-web supabase/migrations/*_project_sync.sql).
//
// Transport: the main process calls Supabase directly with the signed-in user's own access token and the
// publishable key from /api/desktop/config, as research data already does (account-core.ts restAuth). Row-level
// security and the bucket's policies let a user read and write only their own rows and their own folder; no service
// key is ever on this side. Electron-free; fetch is injected so tests run against a stub.
//
// Layout, all under <auth user id>/<project id>/ in the bucket:
//   blobs/<sha256>            one file's bytes (the snapshot form, project-sync-core.ts snapshotBytes)
//   manifests/<digest>.json   a study-transfer manifest (humanstudy-study.json) whose files hash to <digest>
// and one row per project: its revision (incremented by one on every push, enforced by the table), the current
// manifest's digest, its size, which device pushed it, and deleted_at for a restorable delete.
import type { RestAuth } from './account-core'
import { SyncError, type CloudRow } from './project-sync-core'

export const BUCKET = 'projects'
const COLUMNS = 'project_id,name,revision,manifest_sha256,size_bytes,file_count,updated_at,updated_by_device,deleted_at'
const ID_RE = /^[A-Za-z0-9_-]{8,80}$/
const SHA_RE = /^[0-9a-f]{64}$/

export interface CloudDeps {
  auth(): Promise<RestAuth | null>
  fetch: typeof fetch
  /** Per request; uploads and downloads of large files get longer (see `transferTimeout`). */
  timeoutMs?: number
}

export interface CommitInput {
  projectId: string
  /** The revision this push is based on (0: the project is new in the cloud). */
  base: number
  digest: string
  bytes: number
  files: number
  name: string
  device: string
}

export type Cloud = ReturnType<typeof createCloud>

export function createCloud(deps: CloudDeps) {
  const timeout = deps.timeoutMs ?? 20_000
  /** A large file gets a minute plus a second per 100 kB (about 1 Mbit/s). */
  const transferTimeout = (bytes: number): number => Math.max(timeout, 60_000 + Math.ceil(bytes / 100_000) * 1000)

  async function who(): Promise<RestAuth> {
    let a: RestAuth | null
    try {
      a = await deps.auth()
    } catch (e) {
      throw new SyncError('offline', (e as Error).message || 'offline')
    }
    if (!a || !a.userId) throw new SyncError('auth', 'not signed in')
    return a
  }

  async function request(a: RestAuth, path: string, init: RequestInit & { ms?: number } = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('apikey', a.supabaseKey)
    headers.set('authorization', `Bearer ${a.accessToken}`)
    let res: Response
    try {
      res = await deps.fetch(`${a.supabaseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(init.ms ?? timeout) })
    } catch (e) {
      throw new SyncError('offline', (e as Error).message || 'network error')
    }
    return res
  }

  async function failed(res: Response, what: string): Promise<never> {
    const body = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) throw new SyncError('auth', `${what}: ${res.status}`)
    if (res.status === 413 || /payload too large|maximum allowed size|exceeded the maximum/i.test(body)) throw new SyncError('file-too-large', `${what}: too large for cloud storage`)
    throw new SyncError(res.status >= 500 || res.status === 429 || res.status === 408 ? 'offline' : 'server', `${what}: ${res.status}`)
  }

  const checkId = (projectId: string): string => {
    if (typeof projectId !== 'string' || !ID_RE.test(projectId)) throw new SyncError('damaged', 'invalid project id')
    return projectId
  }
  const key = (a: RestAuth, projectId: string, rest: string): string => `${encodeURIComponent(a.userId)}/${checkId(projectId)}/${rest}`

  const asRow = (v: unknown): CloudRow | null => {
    const r = v as Partial<CloudRow> | null
    if (!r || typeof r !== 'object' || typeof r.project_id !== 'string' || !ID_RE.test(r.project_id)) return null
    if (!Number.isSafeInteger(r.revision) || typeof r.manifest_sha256 !== 'string' || !SHA_RE.test(r.manifest_sha256)) return null
    return {
      project_id: r.project_id,
      name: typeof r.name === 'string' ? r.name.slice(0, 200) : '',
      revision: r.revision as number,
      manifest_sha256: r.manifest_sha256,
      size_bytes: Number(r.size_bytes) || 0,
      file_count: Number(r.file_count) || 0,
      updated_at: typeof r.updated_at === 'string' ? r.updated_at : '',
      updated_by_device: typeof r.updated_by_device === 'string' ? r.updated_by_device.slice(0, 80) : '',
      deleted_at: typeof r.deleted_at === 'string' ? r.deleted_at : null,
    }
  }

  return {
    /** Every project row of the signed-in account (RLS returns only theirs), deleted ones included. */
    async rows(): Promise<CloudRow[]> {
      const a = await who()
      const res = await request(a, `/rest/v1/project_sync?select=${COLUMNS}&user_id=eq.${encodeURIComponent(a.userId)}&order=updated_at.desc&limit=1000`)
      if (!res.ok) return failed(res, 'list projects')
      const list = (await res.json().catch(() => [])) as unknown[]
      return Array.isArray(list) ? list.map(asRow).filter((r): r is CloudRow => r !== null) : []
    },

    async row(projectId: string, ms?: number): Promise<CloudRow | null> {
      const a = await who()
      if (!ID_RE.test(projectId)) return null
      const res = await request(a, `/rest/v1/project_sync?select=${COLUMNS}&user_id=eq.${encodeURIComponent(a.userId)}&project_id=eq.${projectId}&limit=1`, ms ? { ms } : {})
      if (!res.ok) return failed(res, 'read project')
      const list = (await res.json().catch(() => [])) as unknown[]
      return Array.isArray(list) && list.length ? asRow(list[0]) : null
    },

    /** Uploads one file by its hash; an object already there under that hash is the same bytes. */
    async putBlob(projectId: string, sha: string, data: Uint8Array): Promise<void> {
      const a = await who()
      const res = await request(a, `/storage/v1/object/${BUCKET}/${key(a, projectId, `blobs/${sha}`)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'x-upsert': 'false' },
        body: data as unknown as BodyInit,
        ms: transferTimeout(data.length),
      })
      if (res.ok) return
      const text = await res.clone().text().catch(() => '')
      if (res.status === 409 || /duplicate|already exists/i.test(text)) return
      return failed(res, 'upload a file')
    },

    async getBlob(projectId: string, sha: string, size: number): Promise<Buffer> {
      const a = await who()
      const res = await request(a, `/storage/v1/object/authenticated/${BUCKET}/${key(a, projectId, `blobs/${sha}`)}`, { ms: transferTimeout(size) })
      if (!res.ok) return failed(res, 'download a file')
      return Buffer.from(await res.arrayBuffer())
    },

    async putManifest(projectId: string, digest: string, json: string): Promise<void> {
      const a = await who()
      const res = await request(a, `/storage/v1/object/${BUCKET}/${key(a, projectId, `manifests/${digest}.json`)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-upsert': 'true' },
        body: json,
      })
      if (!res.ok) return failed(res, 'upload the file list')
    },

    async getManifest(projectId: string, digest: string): Promise<unknown> {
      const a = await who()
      const res = await request(a, `/storage/v1/object/authenticated/${BUCKET}/${key(a, projectId, `manifests/${digest}.json`)}`)
      if (!res.ok) return failed(res, 'download the file list')
      try {
        return JSON.parse(await res.text())
      } catch {
        throw new SyncError('damaged', 'the file list cannot be read')
      }
    },

    /** Records a new revision only if the cloud is still at `base` (compare-and-set); 'conflict' otherwise. */
    async commit(c: CommitInput): Promise<CloudRow | 'conflict'> {
      const a = await who()
      checkId(c.projectId)
      const fields = { name: c.name.slice(0, 200), manifest_sha256: c.digest, size_bytes: c.bytes, file_count: c.files, updated_by_device: c.device.slice(0, 80) }
      const res = c.base === 0
        ? await request(a, '/rest/v1/project_sync', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ ...fields, project_id: c.projectId, user_id: a.userId, revision: 1 }),
        })
        : await request(a, `/rest/v1/project_sync?user_id=eq.${encodeURIComponent(a.userId)}&project_id=eq.${c.projectId}&revision=eq.${c.base}&deleted_at=is.null`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', Prefer: 'return=representation' },
          body: JSON.stringify({ ...fields, revision: c.base + 1 }),
        })
      if (res.status === 409) return 'conflict' // the row already exists: another device pushed first
      if (!res.ok) return failed(res, 'save the revision')
      const list = (await res.json().catch(() => [])) as unknown[]
      const row = Array.isArray(list) && list.length ? asRow(list[0]) : null
      return row ?? 'conflict'
    },

    async rename(projectId: string, name: string): Promise<void> {
      const a = await who()
      checkId(projectId)
      const res = await request(a, `/rest/v1/project_sync?user_id=eq.${encodeURIComponent(a.userId)}&project_id=eq.${projectId}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ name: name.slice(0, 200) }),
      })
      if (!res.ok) return failed(res, 'rename')
    },

    /** Soft delete (restorable for RESTORE_DAYS) or restore. */
    async setDeleted(projectId: string, deleted: boolean): Promise<void> {
      const a = await who()
      checkId(projectId)
      const res = await request(a, `/rest/v1/project_sync?user_id=eq.${encodeURIComponent(a.userId)}&project_id=eq.${projectId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ deleted_at: deleted ? new Date().toISOString() : null }),
      })
      if (!res.ok) return failed(res, deleted ? 'delete' : 'restore')
    },

    /** Objects under <user>/<project>/<folder>/ with their creation time. */
    async list(projectId: string, folder: 'blobs' | 'manifests'): Promise<{ name: string; createdAt: number }[]> {
      const a = await who()
      checkId(projectId)
      const out: { name: string; createdAt: number }[] = []
      for (let offset = 0; offset < 100_000; offset += 1000) {
        const res = await request(a, `/storage/v1/object/list/${BUCKET}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prefix: `${a.userId}/${projectId}/${folder}/`, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
        })
        if (!res.ok) return failed(res, 'list files')
        const page = (await res.json().catch(() => [])) as { name?: unknown; created_at?: unknown }[]
        if (!Array.isArray(page)) break
        for (const o of page) if (typeof o.name === 'string') out.push({ name: o.name, createdAt: Date.parse(String(o.created_at ?? '')) || 0 })
        if (page.length < 1000) break
      }
      return out
    },

    async remove(projectId: string, names: string[]): Promise<void> {
      if (!names.length) return
      const a = await who()
      checkId(projectId)
      for (let i = 0; i < names.length; i += 500) {
        const res = await request(a, `/storage/v1/object/${BUCKET}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prefixes: names.slice(i, i + 500).map((n) => `${a.userId}/${projectId}/${n}`) }),
        })
        if (!res.ok) return failed(res, 'remove files')
      }
    },

    /** Removes the row of a project deleted longer than RESTORE_DAYS ago; the table's policy checks the 30 days with
     *  the server's clock. True when it was removed (only then are its files removed). */
    async dropRow(projectId: string): Promise<boolean> {
      const a = await who()
      checkId(projectId)
      const res = await request(a, `/rest/v1/project_sync?user_id=eq.${encodeURIComponent(a.userId)}&project_id=eq.${projectId}&deleted_at=not.is.null`, { method: 'DELETE', headers: { Prefer: 'return=representation' } })
      if (!res.ok) return failed(res, 'remove the project')
      const list = (await res.json().catch(() => [])) as unknown[]
      return Array.isArray(list) && list.length > 0
    },

    async userId(): Promise<string> {
      return (await who()).userId
    },
  }
}
