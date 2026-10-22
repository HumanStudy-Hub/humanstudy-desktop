// Version history of the files the agent writes: every change to a file under artifacts/, exports/ or
// program.json is copied to .humanstudy/versions/<rel>/<timestamp>.<ext>. Pure fs, no electron, so it can be tested.
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

export interface FileVersion {
  /** File name inside the version folder; pass back to readVersion. */
  id: string
  /** ms since the epoch */
  at: number
  size: number
}

const LIMIT = 4 * 1024 * 1024
const KEEP = 60

/** Which project files get a history. `rel` uses forward slashes. */
export function isVersioned(rel: string): boolean {
  // A run's progress.json is live status (its heartbeat moves every 15 s), not a document; keeping
  // each beat would push real versions out of the history. Temporary files are never versions.
  if (/^artifacts\/simulations\/.+\/progress\.json$/.test(rel) || rel.endsWith('.tmp')) return false
  return rel === 'program.json' || rel.startsWith('artifacts/') || rel.startsWith('exports/')
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace('.', '')
const parseStamp = (id: string): number => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z/.exec(id)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]) : 0
}

function versionDir(root: string, rel: string): string {
  return join(root, '.humanstudy', 'versions', ...rel.split('/'))
}
export function relOf(root: string, file: string): string {
  return relative(resolve(root), resolve(file)).split(sep).join('/')
}

export async function listVersions(root: string, rel: string): Promise<FileVersion[]> {
  const dir = versionDir(root, rel)
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^\d{8}T\d{9}Z/.test(n)).sort()
  const out: FileVersion[] = []
  for (const id of names) out.push({ id, at: parseStamp(id), size: (await stat(join(dir, id)).catch(() => null))?.size ?? 0 })
  return out
}

/** Copy the file to a new version unless it equals the newest one. Returns the version, or null. */
export async function snapshot(root: string, rel: string, now = Date.now()): Promise<FileVersion | null> {
  if (!isVersioned(rel)) return null
  const file = join(root, ...rel.split('/'))
  const st = await stat(file).catch(() => null)
  if (!st || !st.isFile() || st.size > LIMIT) return null
  const bytes = await readFile(file)
  const dir = versionDir(root, rel)
  const have = await listVersions(root, rel)
  const last = have[have.length - 1]
  if (last && last.size === bytes.length && (await readFile(join(dir, last.id))).equals(bytes)) return null
  await mkdir(dir, { recursive: true })
  let at = now
  if (last && at <= last.at) at = last.at + 1
  const id = `${stamp(at)}${extname(rel)}`
  await writeFile(join(dir, id), bytes)
  // Keep the newest KEEP versions.
  const all = [...have.map((v) => v.id), id]
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) await unlink(join(dir, old)).catch(() => undefined)
  return { id, at, size: bytes.length }
}

/** The versions of a file; the first call on a file that has none records its current state as v1. */
export async function versionsOf(root: string, rel: string): Promise<FileVersion[]> {
  if (!isVersioned(rel)) return []
  const have = await listVersions(root, rel)
  if (have.length) return have
  await snapshot(root, rel)
  return listVersions(root, rel)
}

export async function readVersion(root: string, rel: string, id: string): Promise<string> {
  if (!/^[\dT]+Z[\w.]*$/.test(id)) throw new Error('bad version id')
  return readFile(join(versionDir(root, rel), id), 'utf8')
}
