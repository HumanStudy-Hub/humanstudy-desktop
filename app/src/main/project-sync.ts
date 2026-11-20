// Project sync, the engine: keeps each project's cloud copy current (project-sync-core.ts says what is in it and what
// to do; project-sync-cloud.ts moves it). Electron-free (the cloud, the account, timers and the app's hooks are
// injected), so src/main/project-sync.test.mjs runs it against temp folders and a stubbed Supabase; index.ts wires it.
//
// When: a push about DEBOUNCE_MS after the last change in an open project, when a project is closed, when the app
// quits (best effort, bounded), and for projects with unsynced work when the project list is shown. A pull only when a
// project opens, the cloud is newer and this copy has no unsynced changes (and no agent is working in it). Failures
// (offline, server) retry with backoff and never block work; signed out, nothing runs and the app is local only.
//
// Never overwrite, never delete silently: when both sides changed since the base revision, the cloud version becomes
// a new project "<name> (synced copy from <device>, <date>)" and this copy then pushes on top. A pull replaces only
// files of a copy that matches its base revision exactly (checked again after the new files are staged), so everything
// it replaces is in the cloud; it notes itself in sync.json first, so an interrupted pull is finished, or the copy is
// kept as a conflict, never uploaded as a half-updated mix. Deleting a
// project is a soft delete in the cloud (deleted_at), restorable for RESTORE_DAYS; other devices keep their copy as
// local only.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { checkManifest, FORMAT, FORMAT_VERSION, LIMITS, readMarker, writeMarker, type Limits, type Manifest, type ManifestFile } from './study-transfer'
import { safeName } from './project-name'
import {
  CACHE_FILE, conflictName, decide, DEBOUNCE_MS, manifestDigest, MAX_PROJECT_BYTES, parseState, retryDelay, scanSnapshot,
  snapshotBytes, splitCloud, STATE_FILE, syncIncluded, SyncError, type CloudRow, type ScanCache, type Snapshot, type SyncState,
} from './project-sync-core'
import type { Cloud, CloudOps } from './project-sync-cloud'
import type { CloudProject, ProjectSyncEntry, ProjectSyncStatus, SyncListing, SyncOpenResult } from '../preload/types'

export interface SyncEngineDeps {
  cloud: Cloud
  /** The signed-in account's id without network (null: signed out, local only). */
  signedInUser(): string | null
  projectsRoot(): string
  /** True for a folder that may sync: a HumanStudy project inside the projects folder (one opened from elsewhere
   *  stays local). */
  syncable(dir: string): boolean
  /** The project folders in the projects folder. */
  localProjects(): Promise<string[]>
  /** "synced copy from <device>". */
  device: string
  platform: 'desktop' | 'online'
  appVersion: string
  /** After a project was downloaded or updated: re-install the app's agent files (they never travel). */
  afterInstall(dir: string): Promise<void>
  /** True while the agent is working in the project: it is not replaced under it. */
  busy(dir: string): boolean
  /** Before files of a project are replaced: stop watching it and drop in-memory conversations (the next read
   *  loads them again). */
  release(dir: string): Promise<void> | void
  /** The status of some project changed (the renderer re-reads the list). */
  onChange(): void
  /** Deletes made while offline, sent later (a small file in app storage). */
  readPending(): string[]
  writePending(ids: string[]): void
  now?(): number
  random?(): number
  setTimer?(fn: () => void, ms: number): unknown
  clearTimer?(t: unknown): void
  maxBytes?: number
  debounceMs?: number
  limits?: Limits
}

interface Live {
  syncing: boolean
  dirty: boolean
  attempt: number
  debounce?: unknown
  retry?: unknown
  problem?: { code: SyncError['code'] | 'failed'; file?: string }
}

/** By name, not instanceof: the error can come from another bundle's copy of the class (tests bundle per module). */
const isSyncError = (e: unknown): e is SyncError => e instanceof Error && e.name === 'SyncError' && typeof (e as SyncError).code === 'string'
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const RETRYABLE = new Set(['offline', 'server', 'busy', 'failed', 'conflict'])
/** How long opening a project waits for the cloud before it opens the local copy as it is. */
const OPEN_CHECK_MS = 6_000

export type SyncEngine = ReturnType<typeof createProjectSync>

export function createProjectSync(deps: SyncEngineDeps) {
  const now = (): number => (deps.now ? deps.now() : Date.now())
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => { const t = setTimeout(fn, ms); t.unref?.(); return t })
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout))
  const maxBytes = deps.maxBytes ?? MAX_PROJECT_BYTES
  const limits = deps.limits ?? LIMITS
  const live = new Map<string, Live>()
  const locks = new Map<string, Promise<unknown>>()
  /** Folders that share a project id with another folder (a copy made outside the app): never synced. */
  const duplicates = new Set<string>()
  let checkedAll = false
  /** When the list last scheduled a project, so a status that does not settle cannot become a request loop. */
  const listScheduled = new Map<string, number>()
  /** Bumped when the signed-in account changes: every cloud operation of a run started before fails ('auth'). */
  let epoch = 0
  let lastUser: string | null | undefined
  try { lastUser = deps.signedInUser() } catch { /* not known yet */ }
  /** The cloud for one run on behalf of `uid`: valid while that account is signed in and no switch happened since. */
  const cloudFor = (uid: string): CloudOps => {
    const started = epoch
    return deps.cloud.forUser(uid, () => epoch === started && deps.signedInUser() === uid)
  }

  const liveOf = (dir: string): Live => {
    let l = live.get(dir)
    if (!l) live.set(dir, (l = { syncing: false, dirty: false, attempt: 0 }))
    return l
  }
  function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve()
    const next = prev.catch(() => undefined).then(fn)
    const tail = next.catch(() => undefined)
    locks.set(key, tail)
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key) })
    return next
  }
  // Background syncs one at a time, so a large first upload does not saturate the connection.
  let queue: Promise<unknown> = Promise.resolve()
  const background = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => undefined).then(fn)
    queue = next.catch(() => undefined)
    return next
  }

  // ---- local files ------------------------------------------------------------------------------------------------
  async function readJson(dir: string, rel: readonly string[]): Promise<string | null> {
    return readFile(join(dir, ...rel), 'utf8').catch(() => null)
  }
  async function writeAtomic(dir: string, rel: readonly string[], text: string): Promise<void> {
    const target = join(dir, ...rel)
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(tmp, text, { flag: 'wx' })
    await rename(tmp, target)
  }
  const readState = async (dir: string): Promise<SyncState | null> => parseState(await readJson(dir, STATE_FILE))
  const writeState = (dir: string, s: SyncState): Promise<void> => writeAtomic(dir, STATE_FILE, JSON.stringify(s, null, 2) + '\n')
  async function readCache(dir: string): Promise<ScanCache> {
    try {
      const c = JSON.parse((await readJson(dir, CACHE_FILE)) ?? '{}') as { files?: ScanCache }
      return c && typeof c.files === 'object' && c.files ? c.files : {}
    } catch {
      return {}
    }
  }
  const writeCache = (dir: string, files: ScanCache): Promise<void> => writeAtomic(dir, CACHE_FILE, JSON.stringify({ files })).catch(() => undefined)
  async function scan(dir: string): Promise<Snapshot> {
    const snap = await scanSnapshot(dir, await readCache(dir), { maxBytes, limits })
    await writeCache(dir, snap.cache)
    return snap
  }
  /** The project's id from its marker; null when the marker is missing or unreadable (never synced then). */
  async function projectId(dir: string): Promise<string | null> {
    const m = await readMarker(dir)
    if (!m || m === 'unreadable') return null
    if (typeof m.id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(m.id)) return m.id
    const id = randomUUID()
    try { await writeMarker(dir, { ...m, id }) } catch { return null }
    return id
  }

  /** The state after a sync at `revision`/`digest`, keeping what belongs to this copy (conflict-copy mark, name). */
  const synced = (uid: string, pid: string, revision: number, digest: string, prev: SyncState | null, name: string): SyncState => ({
    format: 1, userId: uid, projectId: pid, baseRevision: revision, baseDigest: digest, syncedAt: new Date(now()).toISOString(), name,
    ...(prev?.conflictCopy ? { conflictCopy: prev.conflictCopy } : {}),
  })
  /** True when the folder was renamed here since the last sync (an older state without a name counts as not). */
  const renamedHere = (dir: string, state: SyncState | null): boolean => Boolean(state?.name) && basename(dir) !== state!.name
  /** Throws when a folder on the way to `rel` is a link: a pull never writes through one (outside the project). A
   *  regular file on the way is allowed only when the pull removes it first (`removing`: files of the copy, which
   *  matches its base revision, that the new revision no longer has), as when `materials` became
   *  `materials/items.csv`; then nothing below it exists yet. */
  async function assertNoLink(dir: string, rel: string, removing: ReadonlySet<string> = new Set()): Promise<void> {
    const parts = rel.split('/')
    for (let i = 1; i < parts.length; i++) {
      const sub = parts.slice(0, i).join('/')
      const st = await lstat(join(dir, ...parts.slice(0, i))).catch(() => null)
      if (!st) return
      if (st.isFile() && removing.has(sub)) return
      if (st.isSymbolicLink() || !st.isDirectory()) throw new SyncError('busy', 'a folder on the way is a link or a file', rel)
    }
  }
  /** Staging folders a crash left in the project's .humanstudy. */
  async function sweepStaging(dir: string): Promise<void> {
    for (const name of await readdir(join(dir, '.humanstudy')).catch(() => [] as string[]))
      if (name.startsWith('sync-incoming-')) await rm(join(dir, '.humanstudy', name), { recursive: true, force: true }).catch(() => undefined)
  }

  function manifestFor(pid: string, name: string, snap: Snapshot): Manifest {
    return {
      format: FORMAT,
      version: FORMAT_VERSION,
      projectId: pid,
      name,
      source: { platform: deps.platform, appVersion: deps.appVersion },
      exportedAt: new Date(now()).toISOString(),
      includes: { conversations: true, privateFiles: snap.files.filter((f) => /(?:^|\/)sources\/(?:private|researcher|quarantine)\/|(?:^|\/)original-text\//i.test(f.path)).map((f) => f.path) },
      files: snap.files,
    }
  }

  /** The cloud's manifest for a row, every name and hash checked as when a study file is opened. */
  async function fetchManifest(c: CloudOps, row: Pick<CloudRow, 'project_id' | 'manifest_sha256'>): Promise<Manifest> {
    let m: Manifest
    try {
      m = checkManifest(await c.getManifest(row.project_id, row.manifest_sha256), limits)
    } catch (e) {
      if (isSyncError(e)) throw e
      throw new SyncError('damaged', (e as Error).message)
    }
    if (manifestDigest(m.files) !== row.manifest_sha256) throw new SyncError('damaged', 'the file list does not match its revision')
    for (const f of m.files) if (!syncIncluded(f.path)) throw new SyncError('damaged', 'a file that is never synced', f.path)
    return m
  }

  async function blob(c: CloudOps, pid: string, sha: string, size: number): Promise<Buffer> {
    const data = await c.getBlob(pid, sha, size)
    if (data.length !== size || sha256(data) !== sha) throw new SyncError('damaged', 'a downloaded file does not match its hash')
    return data
  }

  // ---- push -------------------------------------------------------------------------------------------------------
  async function push(c: CloudOps, dir: string, uid: string, pid: string, snap: Snapshot, state: SyncState | null, current: CloudRow | null): Promise<CloudRow | 'conflict'> {
    const present = new Set((await c.list(pid, 'blobs')).map((o) => o.name))
    const sent = new Set<string>()
    for (const f of snap.files) {
      if (present.has(f.sha256) || sent.has(f.sha256)) continue
      const data = await snapshotBytes(dir, f.path)
      // Changed since the scan: the next sync (soon) sees the new version.
      if (sha256(data) !== f.sha256) throw new SyncError('busy', 'a file changed while syncing', f.path)
      try {
        await c.putBlob(pid, f.sha256, data)
      } catch (e) {
        if (isSyncError(e) && e.code === 'file-too-large') throw new SyncError('file-too-large', e.message, f.path)
        throw e
      }
      sent.add(f.sha256)
    }
    // The name: this folder's when it was renamed here (or is new); otherwise the cloud's, which may carry a rename made
    // on another device that this copy takes when it next opens.
    const local = basename(dir)
    const name = !current || !state?.name || renamedHere(dir, state) ? local : current.name || local
    await c.putManifest(pid, snap.digest, JSON.stringify(manifestFor(pid, name, snap)))
    const row = await c.commit({ projectId: pid, base: state?.baseRevision ?? 0, digest: snap.digest, bytes: snap.bytes, files: snap.files.length, name, device: deps.device })
    if (row === 'conflict') return row
    await writeState(dir, synced(uid, pid, row.revision, snap.digest, state, name === local ? local : state?.name ?? local))
    // No cleanup of cloud objects the new revision does not use: another device may have committed a newer revision
    // (or be uploading one) that still references them, and a client-side delete raced with it. Old blobs and manifests
    // are kept until the whole project is purged.
    // TODO: coordinated garbage collection on the server (knows every revision and in-flight push).
    return row
  }

  // ---- pull: bring an unchanged copy up to the cloud revision ------------------------------------------------------
  const fold = (p: string): string => p.normalize('NFC').toLowerCase()

  /** Replaces this copy's files with the manifest's. `local` is the copy now; it must match its base revision (or, when
   *  finishing an interrupted pull, consist only of base and target files). */
  async function applyManifest(c: CloudOps, dir: string, pid: string, manifest: Manifest, local: Snapshot): Promise<void> {
    const localSha = new Map(local.files.map((f) => [f.path, f.sha256]))
    const twin = new Map(local.files.map((f) => [f.sha256, f.path]))
    const changed = manifest.files.filter((f) => localSha.get(f.path) !== f.sha256)
    const wanted = new Set(manifest.files.map((f) => f.path))
    const removed = local.files.filter((f) => !wanted.has(f.path)).map((f) => f.path)
    // Everything new is staged (and checked) before the first file of the project is touched.
    const staging = join(dir, '.humanstudy', `sync-incoming-${randomUUID()}`)
    await mkdir(staging, { recursive: true })
    try {
      for (const f of changed) {
        const staged = join(staging, f.sha256)
        if (existsSync(staged)) continue
        const from = twin.get(f.sha256)
        const data = from ? await snapshotBytes(dir, from).catch(() => null) : null
        await writeFile(staged, data && sha256(data) === f.sha256 ? data : await blob(c, pid, f.sha256, f.size))
      }
      const removing = new Set(removed)
      for (const f of changed) await assertNoLink(dir, f.path, removing)
      await deps.release(dir)
      // Saved while the files were downloading (an editor, a conversation written by release): stop, nothing replaced.
      const again = await scan(dir)
      if (again.digest !== local.digest) throw new SyncError('busy', 'the project changed while its update was downloading')
      // Removals first: a file renamed only in capitals (data.csv -> Data.csv) is one file on macOS and Windows, and
      // removing the old name after writing the new one would remove both.
      const incoming = new Set(changed.map((f) => fold(f.path)))
      for (const rel of removed) {
        await rm(join(dir, ...rel.split('/')), { force: true })
        // Folders left empty by the removal go too (never the project folder itself).
        for (let parent = dirname(rel); parent !== '.' && parent !== ''; parent = dirname(parent)) {
          if (incoming.has(fold(parent))) break
          try { await rmdir(join(dir, ...parent.split('/'))) } catch { break }
        }
      }
      for (const f of changed) {
        const target = join(dir, ...f.path.split('/'))
        await mkdir(dirname(target), { recursive: true })
        const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
        await copyFile(join(staging, f.sha256), tmp)
        await rename(tmp, target)
      }
    } finally {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  async function pull(c: CloudOps, dir: string, uid: string, row: CloudRow, local: Snapshot, state: SyncState | null): Promise<void> {
    const manifest = await fetchManifest(c, row)
    const base = state ?? synced(uid, row.project_id, 0, '', null, basename(dir))
    // Noted before the first file changes: an interrupted pull is finished (or kept as a conflict) next time.
    await writeState(dir, { ...base, pulling: { revision: row.revision, digest: row.manifest_sha256 } })
    try {
      await applyManifest(c, dir, row.project_id, manifest, local)
    } catch (e) {
      // Nothing was replaced when the check after staging failed: forget the note.
      if (isSyncError(e) && e.code === 'busy') await writeState(dir, base).catch(() => undefined)
      throw e
    }
    await writeState(dir, synced(uid, row.project_id, row.revision, row.manifest_sha256, state, state?.name ?? basename(dir)))
    await scan(dir).catch(() => undefined) // refresh the hash cache for the files just written
    await deps.afterInstall(dir).catch(() => undefined)
  }

  /** A pull that did not finish (a crash, a file another program held open). It is finished only when every file is
   *  still either the base revision's or the target's, so no edit made since is replaced; otherwise the copy is kept
   *  and the target revision becomes a synced copy (the conflict path). */
  async function recover(c: CloudOps, dir: string, uid: string, state: SyncState, snap: Snapshot): Promise<SyncState> {
    const target = state.pulling!
    const pid = state.projectId
    const { pulling: _done, ...rest } = state
    const plain = rest as SyncState
    try {
      const want = await fetchManifest(c, { project_id: pid, manifest_sha256: target.digest })
      const before = state.baseDigest ? await fetchManifest(c, { project_id: pid, manifest_sha256: state.baseDigest }) : null
      const known = new Set([...want.files, ...(before?.files ?? [])].map((f: ManifestFile) => `${f.path}\n${f.sha256}`))
      if (before && snap.files.every((f) => known.has(`${f.path}\n${f.sha256}`))) {
        await applyManifest(c, dir, pid, want, snap)
        const next = synced(uid, pid, target.revision, target.digest, state, state.name ?? basename(dir))
        await writeState(dir, next)
        await deps.afterInstall(dir).catch(() => undefined)
        return next
      }
    } catch (e) {
      if (isSyncError(e) && (e.code === 'offline' || e.code === 'auth')) throw e // try again later, the note stays
    }
    // Not finishable: this copy counts as changed, so the cloud revision is kept as a copy and this one pushes on top.
    const next = { ...plain, baseDigest: '' }
    await writeState(dir, next)
    return next
  }

  /** The folder takes a name given on another device, when it was not renamed here and the name is free. */
  async function adoptName(dir: string, uid: string, state: SyncState | null, row: CloudRow | null): Promise<string> {
    if (!row?.name || !state || state.userId !== uid || renamedHere(dir, state) || deps.busy(dir)) return dir
    const name = safeName(row.name)
    if (name === basename(dir) || existsSync(join(dirname(dir), name))) return dir
    await deps.release(dir)
    const to = join(dirname(dir), name)
    try { await rename(dir, to) } catch { return dir }
    await writeState(to, { ...state, name }).catch(() => undefined)
    return to
  }

  // ---- a new local project from a cloud revision: a cloud-only project, or the other side of a conflict -----------
  async function materialize(c: CloudOps, uid: string, row: CloudRow, kind: 'download' | 'conflict', localName = ''): Promise<string> {
    const root = deps.projectsRoot()
    const manifest = await fetchManifest(c, row)
    const temp = join(root, `.syncing-${randomUUID()}`)
    await mkdir(temp, { recursive: true })
    try {
      const bySha = new Map<string, string[]>()
      for (const f of manifest.files) bySha.set(f.sha256, [...(bySha.get(f.sha256) ?? []), f.path])
      for (const f of manifest.files) {
        const paths = bySha.get(f.sha256)
        if (!paths) continue
        bySha.delete(f.sha256)
        const data = await blob(c, row.project_id, f.sha256, f.size)
        for (const p of paths) {
          const target = join(temp, ...p.split('/'))
          await mkdir(dirname(target), { recursive: true })
          await writeFile(target, data, { flag: 'wx' })
        }
      }
      const at = new Date(now())
      const found = await readMarker(temp)
      const meta = found && found !== 'unreadable' ? found : { format: 1, createdAt: at.toISOString() }
      const id = kind === 'download' ? row.project_id : randomUUID()
      await writeMarker(temp, { ...meta, id, ...(kind === 'conflict' ? { copyOf: row.project_id, syncedCopyAt: at.toISOString() } : {}) })
      const name = kind === 'download' ? safeName(row.name || 'Project') : conflictName(localName || row.name, row.updated_by_device, at)
      const state: SyncState = kind === 'download'
        ? { format: 1, userId: uid, projectId: id, baseRevision: row.revision, baseDigest: row.manifest_sha256, syncedAt: at.toISOString(), name: row.name || name }
        : { format: 1, userId: uid, projectId: id, baseRevision: 0, baseDigest: '', syncedAt: '', conflictCopy: { device: row.updated_by_device || 'another device', at: at.toISOString() } }
      await writeState(temp, state)
      let dir = ''
      for (let i = 1; !dir; i++) {
        if (i > 1000) throw new SyncError('server', 'no free folder name')
        const candidate = join(root, i === 1 ? name : `${name} ${i}`)
        if (existsSync(candidate)) continue
        try {
          await rename(temp, candidate)
          dir = candidate
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code
          if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR') throw e
        }
      }
      await deps.afterInstall(dir).catch(() => undefined)
      await scan(dir).catch(() => undefined)
      return dir
    } catch (e) {
      await rm(temp, { recursive: true, force: true }).catch(() => undefined)
      throw e
    }
  }

  // ---- one project: decide and act --------------------------------------------------------------------------------
  type Outcome = { dir: string; copy?: { dir: string; name: string; device: string } }

  async function syncOne(dir: string, mode: 'background' | 'open'): Promise<Outcome> {
    if (!deps.signedInUser() || duplicates.has(dir) || !deps.syncable(dir)) return { dir }
    return lock(dir, async () => {
      const l = liveOf(dir)
      l.syncing = true
      deps.onChange()
      let outcome: Outcome = { dir }
      try {
        const expected = deps.signedInUser()
        const uid = await deps.cloud.userId()
        if (!expected || uid !== expected) throw new SyncError('auth', 'the account changed during the sync')
        const c = cloudFor(uid)
        let state = await readState(dir)
        if (state && state.userId !== uid) { l.dirty = false; l.problem = undefined; return outcome }
        const pid = await projectId(dir)
        if (!pid) throw new SyncError('damaged', 'the project marker cannot be read')
        if (state && state.projectId !== pid) state = null // the marker changed: a different project now
        l.dirty = false
        await sweepStaging(dir)
        if (state?.pulling) {
          if (deps.busy(dir)) throw new SyncError('busy', 'the agent is working in this project')
          state = await recover(c, dir, uid, state, await scan(dir))
        }
        let settled = false
        for (let round = 0; round < 3 && !settled; round++) {
          const snap = await scan(dir)
          const row = await c.row(pid)
          // Restored on another device since this copy saw the delete: it syncs again.
          if (state?.cloudDeleted && row && !row.deleted_at) {
            const { cloudDeleted: _restored, ...rest } = state
            state = rest as SyncState
            await writeState(dir, state)
          }
          const d = decide({ signedIn: true, userId: uid, state, localDigest: snap.digest, cloud: row })
          if (d === 'deleted') {
            // Only a delete seen in the cloud is remembered; a missing row is checked again next time.
            if (row?.deleted_at && !state?.cloudDeleted) await writeState(dir, { ...(state ?? synced(uid, pid, 0, '', null, basename(dir))), cloudDeleted: true })
            settled = true
          } else if (d === 'up-to-date') {
            if (row && (!state || state.baseRevision !== row.revision || state.baseDigest !== row.manifest_sha256 || !state.name)) {
              state = synced(uid, pid, row.revision, row.manifest_sha256, state, state?.name ?? (row.name || basename(dir)))
              await writeState(dir, state)
            }
            if (row && state && renamedHere(dir, state)) {
              await c.rename(pid, basename(dir))
              state = { ...state, name: basename(dir) }
              await writeState(dir, state)
            }
            settled = true
          } else if (d === 'push') {
            settled = (await push(c, dir, uid, pid, snap, state, row)) !== 'conflict' // lost the race: decide again
            if (settled) state = await readState(dir)
          } else if (d === 'pull') {
            if (mode === 'open' && !deps.busy(dir)) {
              await pull(c, dir, uid, row!, snap, state)
              state = await readState(dir)
            } // else shown as "Update available"; pulled when the project opens
            settled = true
          } else if (d === 'conflict') {
            // Keep both: the cloud version becomes a new project; this copy then continues from that revision.
            const copy = await materialize(c, uid, row!, 'conflict', basename(dir))
            outcome = { ...outcome, copy: { dir: copy, name: basename(copy), device: row!.updated_by_device || 'another device' } }
            state = synced(uid, pid, row!.revision, row!.manifest_sha256, state, state?.name ?? basename(dir))
            await writeState(dir, state)
            schedule(copy, 1_000)
          } else settled = true // local-only, other-account
        }
        if (!settled) throw new SyncError('conflict', 'other devices kept pushing; trying again shortly')
        // Opening takes a name given on another device.
        if (mode === 'open') outcome = { ...outcome, dir: await adoptName(dir, uid, state, await c.row(pid).catch(() => null)) }
        l.problem = undefined
        l.attempt = 0
        return outcome
      } catch (e) {
        const code = isSyncError(e) ? e.code : 'failed'
        l.problem = { code, ...(isSyncError(e) && e.file ? { file: e.file } : {}) }
        if (code === 'auth') return outcome // signed out meanwhile: nothing to retry until the next sign-in
        if (RETRYABLE.has(code)) {
          const wait = retryDelay(l.attempt++, deps.random)
          l.dirty = true
          clearTimer(l.retry)
          l.retry = setTimer(() => { l.retry = undefined; void background(() => syncOne(dir, 'background')).catch(() => undefined) }, wait)
        }
        if (mode === 'open') return outcome // opening never fails because of sync
        throw e
      } finally {
        l.syncing = false
        deps.onChange()
      }
    })
  }

  function schedule(dir: string, ms: number): void {
    if (!deps.signedInUser() || !deps.syncable(dir)) return
    const l = liveOf(dir)
    l.dirty = true
    clearTimer(l.debounce)
    l.debounce = setTimer(() => {
      l.debounce = undefined
      void background(() => syncOne(dir, 'background')).catch(() => undefined)
    }, ms)
  }

  async function sendPendingDeletes(): Promise<void> {
    const pending = deps.readPending()
    if (!pending.length) return
    const left: string[] = []
    for (const id of pending) {
      try { await deps.cloud.setDeleted(id, true) } catch (e) { if (!isSyncError(e) || e.code === 'offline') left.push(id) }
    }
    deps.writePending(left)
  }

  async function purge(uid: string, rows: CloudRow[]): Promise<void> {
    const c = cloudFor(uid)
    for (const r of rows) {
      try {
        // The row first: the server decides whether the 30 days are over (this computer's clock may be wrong).
        if (!(await c.dropRow(r.project_id))) continue
        const names = [...(await c.list(r.project_id, 'blobs')).map((o) => `blobs/${o.name}`), ...(await c.list(r.project_id, 'manifests')).map((o) => `manifests/${o.name}`)]
        await c.remove(r.project_id, names)
      } catch {
        /* next time */
      }
    }
  }

  const cloudProject = (r: CloudRow): CloudProject => ({
    projectId: r.project_id, name: r.name, updatedAt: r.updated_at, device: r.updated_by_device, bytes: r.size_bytes, ...(r.deleted_at ? { deletedAt: r.deleted_at } : {}),
  })

  function statusOf(dir: string, uid: string, state: SyncState | null, row: CloudRow | undefined, rowsKnown: boolean): ProjectSyncEntry {
    const l = live.get(dir)
    const entry = (status: ProjectSyncStatus, extra: Partial<ProjectSyncEntry> = {}): ProjectSyncEntry => ({ dir, status, ...extra })
    if (duplicates.has(dir)) return entry('not-synced', { detail: 'duplicate' })
    if (l?.syncing) return entry('syncing')
    if (state && state.userId !== uid) return entry('other-account')
    if (row?.deleted_at || (state?.cloudDeleted && !(rowsKnown && row)) || (rowsKnown && !row && (state?.baseRevision ?? 0) > 0)) return entry('deleted')
    if (l?.problem?.code === 'too-large') return entry('too-large')
    if (l?.problem) return entry('not-synced', { detail: l.problem.code === 'file-too-large' || l.problem.code === 'unsafe-name' ? l.problem.code : 'retrying', ...(l.problem.file ? { file: l.problem.file } : {}) })
    if (!state || state.baseRevision === 0 || state.pulling || (rowsKnown && !row)) return entry('not-synced')
    if (row && row.revision > state.baseRevision) return entry('behind')
    if (l?.dirty) return entry('not-synced')
    return entry(state.conflictCopy ? 'conflict-copy' : 'synced')
  }

  return {
    /** A change in a project (a file written, a conversation saved): push after the project is quiet. */
    touch(dir: string): void {
      schedule(dir, deps.debounceMs ?? DEBOUNCE_MS)
    },

    /** Syncs one project now (in the background queue) and resolves when done; throws what failed. */
    syncNow(dir: string): Promise<SyncOpenResult> {
      return background(() => syncOne(dir, 'background'))
    },

    /** The status the list would show for a project (tests, diagnostics). */
    async statusOf(dir: string): Promise<ProjectSyncEntry> {
      const uid = deps.signedInUser()
      if (!uid) return { dir, status: 'not-synced' }
      return statusOf(dir, uid, await readState(dir), undefined, false)
    },

    /** Closing a project (or switching away): push now. */
    closed(dir: string): void {
      schedule(dir, 0)
    },

    /** Before a project opens: pull a newer cloud revision into an unchanged copy, or keep both when both changed.
     *  Never throws: offline or failing, the local copy opens as it is. */
    async beforeOpen(dir: string): Promise<SyncOpenResult> {
      const uid = deps.signedInUser()
      // An upload of this project is running (it was just closed): open now; anything newer shows as an update.
      if (!uid || !deps.syncable(dir) || locks.has(dir)) return { dir }
      try {
        const state = await readState(dir)
        const pid = state?.projectId ?? (await readMarker(dir).then((m) => (m && m !== 'unreadable' && typeof m.id === 'string' ? m.id : null)).catch(() => null))
        if (!pid) return { dir }
        // A short look first, so a slow or absent connection never holds the project up.
        const row = await deps.cloud.row(pid, OPEN_CHECK_MS)
        const current = row && state && state.userId === uid && !state.pulling && !state.cloudDeleted && !row.deleted_at &&
          row.revision <= state.baseRevision && (!state.name || row.name === state.name || renamedHere(dir, state))
        if (current || !row) return { dir }
        return await syncOne(dir, 'open')
      } catch {
        return { dir }
      }
    },

    /** Downloads a cloud-only project as a local project and returns its folder. */
    async download(projectIdToGet: string): Promise<string> {
      if (!deps.signedInUser()) throw new SyncError('auth', 'Sign in to open your cloud projects.')
      return lock(`download:${projectIdToGet}`, async () => {
        for (const dir of await deps.localProjects()) if ((await projectId(dir).catch(() => null)) === projectIdToGet) return dir
        const uid = await deps.cloud.userId()
        if (uid !== deps.signedInUser()) throw new SyncError('auth', 'the account changed')
        const c = cloudFor(uid)
        const row = await c.row(projectIdToGet)
        if (!row || row.deleted_at) throw new SyncError('server', 'This project is no longer in your account.')
        return materialize(c, uid, row, 'download')
      })
    },

    /** Before a project goes to the Trash: its cloud copy is soft-deleted (restorable for RESTORE_DAYS). */
    async trashed(dir: string): Promise<void> {
      const uid = deps.signedInUser()
      const state = await readState(dir)
      if (!uid || !state || state.userId !== uid || state.baseRevision === 0) return
      // Noted here first, then sent; moving to the Trash waits at most two seconds for the network (the list sends a
      // delete still pending later).
      deps.writePending([...new Set([...deps.readPending(), state.projectId])])
      const l = live.get(dir)
      if (l) { clearTimer(l.debounce); clearTimer(l.retry) }
      live.delete(dir)
      await Promise.race([sendPendingDeletes().catch(() => undefined), new Promise((r) => { const t = setTimeout(r, 2_000); t.unref?.() })])
    },

    /** Restores a deleted cloud project; a local copy that was kept as local only syncs again. */
    async restore(pid: string): Promise<void> {
      await deps.cloud.setDeleted(pid, false)
      deps.writePending(deps.readPending().filter((id) => id !== pid))
      for (const dir of await deps.localProjects()) {
        const state = await readState(dir)
        if (state?.projectId === pid && state.cloudDeleted) {
          const { cloudDeleted: _gone, ...rest } = state
          await writeState(dir, rest as SyncState)
          schedule(dir, 0)
        }
      }
      deps.onChange()
    },

    /** The project list's sync side: each local project's status, the account's cloud-only and deleted projects. */
    async list(): Promise<SyncListing> {
      const uid = deps.signedInUser()
      const empty: SyncListing = { signedIn: false, offline: false, local: [], cloudOnly: [], deleted: [], maxBytes }
      if (!uid) return empty
      // Signed in now: a sign-in problem from before is gone.
      for (const [, l] of live) if (l.problem?.code === 'auth') l.problem = undefined
      const dirs = await deps.localProjects()
      const ids = new Map<string, string>()
      duplicates.clear()
      const states = new Map<string, SyncState | null>()
      for (const dir of [...dirs].sort()) {
        const m = await readMarker(dir).catch(() => null)
        const id = m && m !== 'unreadable' && typeof m.id === 'string' ? m.id : ''
        if (id && ids.has(id)) duplicates.add(dir)
        else if (id) ids.set(id, dir)
        states.set(dir, await readState(dir))
      }
      let rows: CloudRow[] | null = null
      try {
        await sendPendingDeletes()
        rows = await deps.cloud.rows()
      } catch {
        rows = null
      }
      const pending = new Set(deps.readPending())
      const byId = new Map((rows ?? []).map((r) => [r.project_id, r]))
      const split = splitCloud((rows ?? []).filter((r) => !pending.has(r.project_id)), new Set(ids.keys()), now())
      if (split.expired.length) void purge(uid, split.expired)
      const local = dirs.map((dir) => {
        const state = states.get(dir) ?? null
        const id = [...ids.entries()].find(([, d]) => d === dir)?.[0]
        return statusOf(dir, uid, state, id ? byId.get(id) : undefined, rows !== null)
      })
      // Unsynced work (never synced, or changed while the app was closed) goes up in the background; once per run
      // every project is checked, later only those not synced.
      for (const e of local) {
        const l = live.get(e.dir)
        // A problem that waits for the researcher (a file name, a file too large) is tried again on the next change.
        const recently = now() - (listScheduled.get(e.dir) ?? -Infinity) < 60_000
        if (e.status === 'not-synced' && e.detail !== 'duplicate' && !l?.problem && !l?.retry && !l?.debounce && !recently) {
          listScheduled.set(e.dir, now())
          schedule(e.dir, 2_000)
        }
        else if (!checkedAll && (e.status === 'synced' || e.status === 'conflict-copy' || e.status === 'behind')) schedule(e.dir, 5_000)
      }
      checkedAll = true
      return { signedIn: true, offline: rows === null, local, cloudOnly: split.cloudOnly.map(cloudProject), deleted: split.deleted.map(cloudProject), maxBytes }
    },

    /** Quit: push what changed, within `ms`. */
    async flushAll(ms: number): Promise<void> {
      if (!deps.signedInUser()) return
      const dirty = [...live.entries()].filter(([, l]) => l.dirty || l.debounce).map(([dir]) => dir)
      if (!dirty.length) return
      for (const [, l] of live) { clearTimer(l.debounce); l.debounce = undefined }
      await Promise.race([
        Promise.all(dirty.map((dir) => syncOne(dir, 'background').catch(() => undefined))),
        new Promise((r) => { const t = setTimeout(r, ms); t.unref?.() }),
      ])
    },

    /** The app's account changed (sign-in, sign-out, another account): a sync running for the previous account stops
     *  at its next cloud operation (it never continues in the new account's storage), and its scheduled work is
     *  dropped. The new account's projects are scheduled again by the next list. */
    accountChanged(): void {
      const user = deps.signedInUser()
      if (user === lastUser) return
      lastUser = user
      epoch++
      for (const [, l] of live) { clearTimer(l.debounce); clearTimer(l.retry); l.debounce = undefined; l.retry = undefined; l.dirty = false; l.attempt = 0; l.problem = undefined }
      listScheduled.clear()
      checkedAll = false
      deps.onChange()
    },

    /** Stops timers (sign-out, tests). */
    stop(): void {
      for (const [, l] of live) { clearTimer(l.debounce); clearTimer(l.retry); l.debounce = undefined; l.retry = undefined }
    },
  }
}

/** A hidden download folder a crash left behind (the app sweeps them on start). */
export async function sweepSyncTemps(projectsRoot: string): Promise<void> {
  for (const d of await readdir(projectsRoot, { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory() && d.name.startsWith('.syncing-')) await rm(join(projectsRoot, d.name), { recursive: true, force: true }).catch(() => undefined)
  }
}
