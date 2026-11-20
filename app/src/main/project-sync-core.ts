// Project sync, the pure part: what a project's cloud copy holds, how a snapshot is described, and what to do when
// the local copy and the cloud copy meet (push, pull, keep both). Electron-free and network-free, so
// src/main/project-sync.test.mjs runs it directly; project-sync.ts does the file work and project-sync-cloud.ts talks
// to Supabase.
//
// Like Claude or Codex: when the researcher is signed in, every project is stored privately under their account,
// private files and chats included. Privacy and copyright checks belong to publishing (community.ts), not here.
//
// The snapshot is the study-transfer format (study-transfer.ts): its manifest (humanstudy-study.json: every file's
// path, size and SHA-256) and the files themselves, stored once per content hash, so a push uploads only what
// changed. What goes in is study-transfer's `classify` with conversations and private files always on. Never in it:
// hidden files and folders (.git, .opencode, .env, ...), opencode.json (both can hold provider keys and are
// re-installed by the app on the other side), node_modules and other caches, OS junk, save temporaries, study files
// (*.humanstudy.zip), everything else of .humanstudy (versions/, original-text.json, tmp/, this sync state), and the
// app-installed schema/ folder (re-installed by refreshPack, and its version follows the app, so two app versions
// would otherwise trade it back and forth). Account, keys, settings, telemetry state and the original-text cache live
// in app storage, outside every project.
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { checkCollisions, checkPath, classify, isThread, LIMITS, scanProject, withoutNativeSession, type Limits, type ManifestFile } from './study-transfer'
import { safeName } from './project-name'

const MB = 1000 * 1000
/** A project larger than this (its files, uncompressed) is not synced; it stays on this computer, and says why. */
export const MAX_PROJECT_BYTES = 500 * MB
/** Push after this long without changes in an open project. */
export const DEBOUNCE_MS = 45_000
/** Failed syncs retry after 30 s, 1 min, 2 min, ... up to 30 min, with jitter. */
export const RETRY_BASE_MS = 30_000
export const RETRY_MAX_MS = 30 * 60_000
/** A deleted project can be restored this long; after it, its cloud copy is removed. */
export const RESTORE_DAYS = 30
/** Cloud objects no manifest refers to any more are removed once they are this old (a slower device's push in
 *  progress can still refer to them). */
export const GC_AGE_MS = 7 * 24 * 3600_000

/** Folders the app installs into every project and keeps at its own version: not synced (see the header). */
const SYNC_SKIP = /^schema(?:\/|$)/

/** A conversation being saved (threads-core.ts writes `<id>.json.tmp`, then renames it). */
const STATE_TEMP = /^\.humanstudy\/.*\.tmp$/i

/** True for a project-relative path (forward slashes) that is part of the cloud copy. */
export function syncIncluded(rel: string): boolean {
  return classify(rel) !== 'never' && !SYNC_SKIP.test(rel) && !STATE_TEMP.test(rel)
}

// ---- the per-device sync state: .humanstudy/sync.json -----------------------------------------------------------

export const STATE_FILE = ['.humanstudy', 'sync.json'] as const
export const CACHE_FILE = ['.humanstudy', 'sync-cache.json'] as const

export interface SyncState {
  format: 1
  /** The account this project syncs with; another account signed in on this computer leaves it alone. */
  userId: string
  projectId: string
  /** The cloud revision this copy last matched (0: never synced). */
  baseRevision: number
  /** manifestDigest of the files at that revision. */
  baseDigest: string
  syncedAt: string
  /** Made from another device's version when both had changed. */
  conflictCopy?: { device: string; at: string }
  /** The cloud copy was deleted (on any device): this copy stays here, local only, until restored. */
  cloudDeleted?: boolean
  /** The project's name when it last synced: tells a rename here from a rename on another device. */
  name?: string
  /** A pull to this revision was in progress (written before the first file is replaced, so a crash or a failed
   *  write is finished on the next sync instead of leaving a mix that looks like a local change). */
  pulling?: { revision: number; digest: string }
}

export function parseState(raw: string | null): SyncState | null {
  if (!raw) return null
  try {
    const s = JSON.parse(raw) as Partial<SyncState>
    if (!s || typeof s !== 'object' || s.format !== 1 || typeof s.userId !== 'string' || typeof s.projectId !== 'string') return null
    if (!Number.isSafeInteger(s.baseRevision) || (s.baseRevision as number) < 0 || typeof s.baseDigest !== 'string') return null
    return {
      format: 1,
      userId: s.userId,
      projectId: s.projectId,
      baseRevision: s.baseRevision as number,
      baseDigest: s.baseDigest,
      syncedAt: typeof s.syncedAt === 'string' ? s.syncedAt : '',
      ...(s.conflictCopy && typeof s.conflictCopy.device === 'string' ? { conflictCopy: { device: s.conflictCopy.device, at: String(s.conflictCopy.at ?? '') } } : {}),
      ...(s.cloudDeleted === true ? { cloudDeleted: true } : {}),
      ...(typeof s.name === 'string' ? { name: s.name } : {}),
      ...(s.pulling && Number.isSafeInteger(s.pulling.revision) && typeof s.pulling.digest === 'string' && /^[0-9a-f]{64}$/.test(s.pulling.digest)
        ? { pulling: { revision: s.pulling.revision, digest: s.pulling.digest } } : {}),
    }
  } catch {
    return null
  }
}

// ---- the cloud side: one row per project (public.project_sync) --------------------------------------------------

export interface CloudRow {
  project_id: string
  name: string
  revision: number
  manifest_sha256: string
  size_bytes: number
  file_count: number
  updated_at: string
  updated_by_device: string
  deleted_at: string | null
}

// ---- describing a snapshot --------------------------------------------------------------------------------------

/** The snapshot's identity: SHA-256 over its sorted [path, size, sha256] list. Names and times are not part of it,
 *  so the same files on two devices have the same digest. */
export function manifestDigest(files: readonly ManifestFile[]): string {
  const list = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => [f.path, f.size, f.sha256])
  return createHash('sha256').update(JSON.stringify(list)).digest('hex')
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** What a file is in the cloud copy: its bytes, with a conversation's device-bound model session cleared (as in a
 *  downloaded study), so the same conversation hashes the same on every device. */
export async function snapshotBytes(root: string, rel: string): Promise<Buffer> {
  const data = await readFile(join(root, ...rel.split('/')))
  return isThread(rel) ? withoutNativeSession(data) : data
}

/** Per file: [size on disk, mtime ms, sha256, snapshot size], so an unchanged file is not read again. */
export type ScanCache = Record<string, [number, number, string, number]>

export interface Snapshot {
  files: ManifestFile[]
  bytes: number
  digest: string
  cache: ScanCache
}

export class SyncError extends Error {
  constructor(readonly code: 'too-large' | 'file-too-large' | 'unsafe-name' | 'offline' | 'auth' | 'server' | 'damaged' | 'conflict' | 'busy', message: string, readonly file?: string) {
    super(message)
    this.name = 'SyncError'
  }
}

/** Every file of the cloud copy with its hash. Throws `too-large` over the project cap and `unsafe-name` for a name
 *  another platform cannot store (it would fail there, so it fails here, where it can be renamed). */
export async function scanSnapshot(root: string, cache: ScanCache = {}, o: { maxBytes?: number; limits?: Limits } = {}): Promise<Snapshot> {
  const limits = o.limits ?? LIMITS
  const maxBytes = o.maxBytes ?? MAX_PROJECT_BYTES
  let scanned
  try {
    scanned = (await scanProject(root, limits, false)).filter((f) => syncIncluded(f.path))
  } catch (e) {
    if ((e as { code?: string }).code === 'too-large') throw new SyncError('too-large', (e as Error).message)
    throw e
  }
  let planned = 0
  for (const f of scanned) planned += f.size
  if (planned > maxBytes) throw new SyncError('too-large', `the project holds ${planned} bytes, more than ${maxBytes}`)
  for (const f of scanned) {
    try { checkPath(f.path, limits) } catch { throw new SyncError('unsafe-name', 'a file name another computer cannot store', f.path) }
    if (f.size > limits.maxFileBytes) throw new SyncError('file-too-large', `a file larger than ${limits.maxFileBytes} bytes`, f.path)
  }
  try { checkCollisions(scanned.map((f) => f.path)) } catch (e) { throw new SyncError('unsafe-name', 'two files with the same name', (e as { file?: string }).file) }
  const next: ScanCache = {}
  const files: ManifestFile[] = []
  let bytes = 0
  for (const f of scanned) {
    const st = await stat(join(root, ...f.path.split('/'))).catch(() => null)
    if (!st) continue // removed while scanning; the next scan sees it
    const hit = cache[f.path]
    let entry: ScanCache[string]
    if (hit && hit[0] === st.size && hit[1] === st.mtimeMs) entry = hit
    else {
      const data = await snapshotBytes(root, f.path).catch(() => null)
      if (!data) continue
      entry = [st.size, st.mtimeMs, sha256(data), data.length]
    }
    next[f.path] = entry
    files.push({ path: f.path, size: entry[3], sha256: entry[2] })
    bytes += entry[3]
  }
  if (bytes > maxBytes) throw new SyncError('too-large', `the project holds ${bytes} bytes, more than ${maxBytes}`)
  return { files, bytes, digest: manifestDigest(files), cache: next }
}

// ---- the decision -------------------------------------------------------------------------------------------------

export type Decision =
  | 'local-only'     // signed out: nothing leaves this computer
  | 'other-account'  // synced with another account than the one signed in now
  | 'deleted'        // the cloud copy was deleted: stays local, never pushed again until restored
  | 'up-to-date'     // nothing to do (or only the base to record: same files on both sides)
  | 'push'           // local changed, cloud did not: upload a new revision
  | 'pull'           // cloud changed, local did not: bring this copy up to date
  | 'conflict'       // both changed: keep both; the incoming copy becomes a new project

export interface DecideInput {
  signedIn: boolean
  userId: string
  state: SyncState | null
  /** manifestDigest of the local files now. */
  localDigest: string
  cloud: CloudRow | null
}

export function decide(i: DecideInput): Decision {
  if (!i.signedIn || !i.userId) return 'local-only'
  const { state, cloud } = i
  if (state && state.userId !== i.userId) return 'other-account'
  if (cloud?.deleted_at) return 'deleted'
  // Deleted earlier and restored since (on any device): the row is back, so this copy syncs again.
  if (state?.cloudDeleted && !cloud) return 'deleted'
  const base = state?.baseRevision ?? 0
  if (!cloud) {
    // Synced before, and the row is gone: it was deleted and purged. Never bring it back on its own.
    if (base > 0) return 'deleted'
    return 'push'
  }
  const localChanged = !state || base === 0 || i.localDigest !== state.baseDigest
  const cloudChanged = cloud.revision > base
  if (i.localDigest === cloud.manifest_sha256) return 'up-to-date' // the same files: just record the revision
  if (!cloudChanged) return localChanged ? 'push' : 'up-to-date'
  if (!localChanged) return 'pull'
  return 'conflict'
}

// ---- names, retries, the merged list -----------------------------------------------------------------------------

const shortDate = (d: Date): string => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d)

/** "<name> (synced copy from <device>, <date>)": the other device's version when both changed. */
export function conflictName(name: string, device: string, when: Date): string {
  const suffix = ` (synced copy from ${(device || 'another device').slice(0, 40)}, ${shortDate(when)})`
  const base = safeName(name || 'Project')
  return safeName(base.slice(0, Math.max(1, 80 - suffix.length)).trim() + suffix)
}

/** How long to wait before retry number `attempt` (0 = the first retry). Exponential with jitter, capped. */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, Math.min(attempt, 20)))
  return Math.round(exp * (0.5 + 0.5 * random()))
}

/** This computer's name as the other side shows it ("synced copy from <device>"); online, the workspace. */
export function deviceLabel(platform: 'desktop' | 'online', hostname: string): string {
  if (platform === 'online') return 'online workspace'
  const h = hostname.replace(/\.(local|lan|home)$/i, '').replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (h || 'this computer').slice(0, 60)
}

export interface Listed<T> {
  /** Cloud projects with no local copy: opening one downloads it. */
  cloudOnly: T[]
  /** Deleted within RESTORE_DAYS: restorable. */
  deleted: T[]
  /** Deleted longer ago: their cloud copy is removed. */
  expired: T[]
}

/** Splits the account's cloud rows against the project ids present on this computer. */
export function splitCloud(rows: readonly CloudRow[], localIds: ReadonlySet<string>, now: number): Listed<CloudRow> {
  const out: Listed<CloudRow> = { cloudOnly: [], deleted: [], expired: [] }
  for (const r of rows) {
    if (r.deleted_at) {
      const at = Date.parse(r.deleted_at)
      if (Number.isFinite(at) && now - at > RESTORE_DAYS * 24 * 3600_000) out.expired.push(r)
      else out.deleted.push(r)
    } else if (!localIds.has(r.project_id)) out.cloudOnly.push(r)
  }
  return out
}
