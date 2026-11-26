// "Download this study" / "Open a downloaded study": one study as one file, <name>.humanstudy.zip, so a researcher can
// move it between this computer and the online workspace (the same main process runs in both; see web/README.md).
//
// Electron-free, so src/main/study-transfer.test.mjs runs it directly; index.ts wires it to the save/open dialogs and
// IPC. No new transport: on the web edition a save dialog already becomes a browser download and a picked file is
// already uploaded into the sandbox (web/electron-shim.cjs, web/browser-electron.ts).
//
// The file is a plain zip:
//   humanstudy-study.json   format, version, project id, where and when it was made, which optional parts it holds,
//                           and every file with its size and SHA-256
//   study/<path>            the project files, exactly as listed
//
// What goes in (`classify`): the study (program.json, protocol.json, package/, artifacts/ with simulation results,
// notes, sources, the paper, .humanstudy/project.json and community.json), the chat history (.humanstudy/threads and
// thread-history; the researcher can untick it) and the researcher's private files (sources/private/,
// sources/researcher/, sources/quarantine/, any original-text/ folder: the same rule research capture uses,
// telemetry-core.ts PRIVATE_MATERIAL). The study file is the researcher's own copy, like their cloud copy
// (project-sync.ts), so private files go in; privacy and copyright checks apply when publishing to the community
// (community.ts), not here. Except for a released (Library) study (exportFiles): its private files, every file the
// original-wording restore could read that the release did not ship, and (unless ticked) its chat history stay on
// this computer, since a study file may be handed on. Undo's archive (.humanstudy/thread-history) never goes in. Never: hidden files and folders (.git, .env, .opencode with its possible
// provider config, .DS_Store, ...), node_modules, caches, save temporaries, other study files, and from .humanstudy
// everything else (original-text.json, tmp/, versions/). Account, keys, settings, consent and the restored-wording
// cache live in app storage, outside the project, and the scan never leaves the project folder or follows a link.
//
// Opening is strict and always makes a NEW project. Before anything is written, the whole file is checked: a plain
// zip (no encryption, no zip64, no links, no folders, no overlapping or duplicate entries), every name safe on every
// platform and listed, nothing that is never part of a study, every file's size and SHA-256 as listed, and the
// limits below. It is then extracted into a hidden folder in the projects folder, checked again while writing, and
// renamed into place in one step; any failure removes the hidden folder, so no half project is ever listed.
import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, readFile, rename, rm, writeFile, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import * as zlib from 'node:zlib'
import { canCarryRestored, PRIVATE_MATERIAL, restorableBytes } from './telemetry-core'
import { safeName } from './project-name'
import type { StudyExportOptions, StudyExportPreview, StudyTransferErrorCode } from '../preload/types'

export const FORMAT = 'humanstudy-study'
export const FORMAT_VERSION = 1
export const MANIFEST_NAME = 'humanstudy-study.json'
export const FILE_PREFIX = 'study/'
export const PACKAGE_SUFFIX = '.humanstudy.zip'

const MiB = 1024 * 1024
/** Limits a study file has to stay within, checked on both sides (a study that downloads always opens):
 *  - maxFiles 20,000 files: far above a real study (the sample has under 100), far below the zip's 65,535 entries;
 *  - maxFileBytes 512 MiB per file: a long video or a large data set, still one buffer in memory;
 *  - maxTotalBytes 2 GiB in all, uncompressed: bounds a "zip bomb" and keeps every offset inside a plain zip;
 *  - maxPackageBytes 2 GiB for the file itself (online, the upload is capped lower by web/server.cjs: 200 MB);
 *  - maxManifestBytes 16 MiB, maxPathLength 400 characters, maxDepth 32 folders. */
export interface Limits {
  maxFiles: number
  maxFileBytes: number
  maxTotalBytes: number
  maxPackageBytes: number
  maxManifestBytes: number
  maxPathLength: number
  maxDepth: number
}
export const LIMITS: Readonly<Limits> = Object.freeze({
  maxFiles: 20_000,
  maxFileBytes: 512 * MiB,
  maxTotalBytes: 2048 * MiB,
  maxPackageBytes: 2048 * MiB,
  maxManifestBytes: 16 * MiB,
  maxPathLength: 400,
  maxDepth: 32,
})

export type Platform = 'desktop' | 'online'

export interface ManifestFile { path: string; size: number; sha256: string }
export interface Manifest {
  format: typeof FORMAT
  version: number
  projectId: string
  name: string
  source: { platform: Platform; appVersion: string }
  exportedAt: string
  includes: { conversations: boolean; privateFiles: string[] }
  files: ManifestFile[]
}

/** A reason with a code the renderer words, and the file it is about (project-relative), when there is one. */
export class TransferError extends Error {
  constructor(readonly code: StudyTransferErrorCode, message: string, readonly file?: string) {
    super(message)
    this.name = 'TransferError'
  }
}
const fail = (code: StudyTransferErrorCode, message: string, file?: string): never => {
  throw new TransferError(code, message, file)
}

// ---- what belongs in a study file -------------------------------------------------------------

export type FileKind = 'study' | 'conversation' | 'private' | 'never'
/** Folder names that are tools' working copies or caches wherever they appear. */
const NEVER_SEGMENTS = new Set(['node_modules', '__pycache__'])
/** File names the operating system leaves behind. */
const JUNK_FILES = new Set(['thumbs.db', 'ehthumbs.db', 'desktop.ini', 'icon\r'])
/** `<name>.<pid>.<uuid>.tmp`: an atomic save in progress (program-save.ts, program_io.py). */
const SAVE_TEMP = /\.\d+\.(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.tmp$/i
/** Agent configuration at the project root may hold a provider key; the app reinstalls its own agent files. */
const ROOT_NEVER = new Set(['opencode.json', 'opencode.jsonc'])
/** Of the app's own folder, only what belongs to the study travels. */
const STATE_FILES = new Set(['project.json', 'community.json'])
const STATE_CONVERSATIONS = new Set(['threads', 'thread-history'])
const STATE_DIRS = new Set(['program-conflicts'])

const junkSegments = (parts: string[]): boolean =>
  parts.some((p) => p.startsWith('.') || NEVER_SEGMENTS.has(p.toLowerCase()))
const junkName = (name: string): boolean => {
  const n = name.toLowerCase()
  return JUNK_FILES.has(n) || n.endsWith('.pyc') || n.endsWith('.pyo') || n.endsWith(PACKAGE_SUFFIX) || SAVE_TEMP.test(n)
}

/** What a project-relative path (forward slashes) is in a study file. Directories are classified by their own path
 *  too: a 'never' folder is not entered. */
export function classify(rel: string): FileKind {
  const parts = rel.split('/')
  const name = parts[parts.length - 1]
  if (!name || junkName(name)) return 'never'
  if (parts[0] === '.humanstudy') {
    if (parts.length === 1) return 'study' // the folder itself
    const second = parts[1].toLowerCase()
    if (parts.length === 2 && STATE_FILES.has(second)) return 'study'
    const rest = parts.slice(2)
    if (STATE_CONVERSATIONS.has(second)) return junkSegments(rest) ? 'never' : 'conversation'
    if (STATE_DIRS.has(second)) return junkSegments(rest) ? 'never' : 'study'
    return 'never'
  }
  if (junkSegments(parts)) return 'never'
  if (parts.length === 1 && ROOT_NEVER.has(name.toLowerCase())) return 'never'
  if (PRIVATE_MATERIAL.test(rel)) return 'private'
  return 'study'
}

export interface ScannedFile { path: string; size: number; kind: Exclude<FileKind, 'never'> }

/** In a published study, AI participants' replies can quote the restored wording, so its run outputs are offered as
 *  private files like the sources (research capture withholds the same folders: telemetry-core.ts mayCollectFile). */
const RUN_OUTPUTS = /^(?:artifacts\/simulations|runs)(?:\/|$)/
export function kindOf(rel: string, published: boolean): FileKind {
  const kind = classify(rel)
  return kind === 'study' && published && RUN_OUTPUTS.test(rel) ? 'private' : kind
}

/** Every file of the project that may go into a study file. Links are never followed and never included; folders
 *  that are never part of a study are not entered. */
export async function scanProject(root: string, limits: Limits = LIMITS, published = false): Promise<ScannedFile[]> {
  const out: ScannedFile[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    const entries = await readdir(rel ? join(root, ...rel.split('/')) : root, { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const d of entries) {
      const child = rel ? `${rel}/${d.name}` : d.name
      if (d.isSymbolicLink() || classify(child) === 'never') continue
      if (d.isDirectory()) {
        if (depth + 1 >= limits.maxDepth) fail('too-large', `folders nested deeper than ${limits.maxDepth}`, child)
        await walk(child, depth + 1)
      } else if (d.isFile()) {
        if (out.length >= limits.maxFiles * 2) fail('too-large', `more than ${limits.maxFiles} files`)
        const handle = await open(join(root, ...child.split('/')), 'r')
        const size = await handle.stat().then((s) => s.size).finally(() => handle.close())
        out.push({ path: child, size, kind: kindOf(child, published) as ScannedFile['kind'] })
      }
    }
  }
  await walk('', 0)
  return out
}

/** A released (Library) study (original-text.ts releasedStudy): `shipped` holds the sha256 of every file its
 *  release manifest lists (empty while the release is not confirmed). */
export interface Released { shipped: ReadonlySet<string> }
/** Whether a released study's file stays back: it can carry restored wording (by name or content) and its bytes are
 *  not a file the release shipped. Decided on the very bytes that would be written. */
export const keptBack = (rel: string, data: Uint8Array, released: Released): boolean =>
  canCarryRestored(rel, data) && !released.shipped.has(sha256(data))
export { canCarryRestored, restorableBytes }
/** Undo keeps the whole earlier conversation here (threads-core.ts fromNative): never in a study file. */
const UNDO_ARCHIVE = '.humanstudy/thread-history/'

/** What a study file may hold, from scanProject (shared with project sync, which keeps everything): never Undo's
 *  archive; and for a released study, a file restoration could read counts as private unless its bytes are a file
 *  the release shipped (a researcher's copy of a source, a screenshot, a paper under any name stay on this computer). */
export async function exportFiles(root: string, limits: Limits, o: { published?: boolean; released?: Released }): Promise<ScannedFile[]> {
  const files = (await scanProject(root, limits, o.published === true || Boolean(o.released))).filter((f) => !f.path.startsWith(UNDO_ARCHIVE))
  if (!o.released) return files
  for (const f of files) {
    if (f.kind !== 'study') continue
    const bytes = await readFile(join(root, ...f.path.split('/'))).catch(() => null)
    if (!bytes || keptBack(f.path, bytes, o.released)) f.kind = 'private'
  }
  return files
}

/** Whether the chat history goes in: never for a released (Library) study (conversations may quote original wording
 *  the researcher supplied for its held screens); an ordinary project's unless unticked, as before. */
export const includesChat = (released: boolean, requested: boolean | undefined): boolean =>
  !released && requested !== false

export const isThread = (rel: string): boolean => /^\.humanstudy\/threads\/[^/]+\.json$/.test(rel)
const threadCount = (files: { path: string }[]): number => files.filter((f) => isThread(f.path)).length

export async function previewExport(root: string, o: { published?: boolean; released?: Released; limits?: Limits } = {}): Promise<StudyExportPreview> {
  const limits = o.limits ?? LIMITS
  const files = await exportFiles(root, limits, o)
  const sum = (kind: ScannedFile['kind']) => files.filter((f) => f.kind === kind).reduce((n, f) => n + f.size, 0)
  const conversations = files.filter((f) => f.kind === 'conversation')
  return {
    name: basename(root),
    study: { files: files.filter((f) => f.kind === 'study').length, bytes: sum('study') },
    hasPaper: files.some((f) => f.path === 'paper.pdf' && f.kind === 'study'),
    released: Boolean(o.released),
    conversations: { count: threadCount(conversations), files: conversations.length, bytes: sum('conversation') },
    privateFiles: files.filter((f) => f.kind === 'private').map((f) => ({ path: f.path, bytes: f.size })),
    limits: { maxFiles: limits.maxFiles, maxTotalBytes: limits.maxTotalBytes, maxFileBytes: limits.maxFileBytes },
  }
}

// ---- the project's stable id ------------------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_-]{8,80}$/
const MARKER = ['.humanstudy', 'project.json'] as const

/** The marker's contents: null when there is none, 'unreadable' when it exists but is not a JSON object. */
export async function readMarker(root: string): Promise<Record<string, unknown> | null | 'unreadable'> {
  try {
    const meta = JSON.parse(await readFile(join(root, ...MARKER), 'utf8')) as unknown
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : 'unreadable'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable'
  }
}

export async function writeMarker(root: string, meta: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, '.humanstudy'), { recursive: true })
  const tmp = join(root, '.humanstudy', `project.json.${process.pid}.${randomUUID()}.tmp`)
  await writeFile(tmp, JSON.stringify(meta, null, 2) + '\n', { flag: 'wx' })
  await rename(tmp, join(root, ...MARKER))
}

/** The project's id in .humanstudy/project.json: the one already there (research data adds the same field), else a new
 *  random one, written back so the next download carries the same id. Only random; it names nothing. */
export async function ensureProjectId(root: string): Promise<string> {
  const found = await readMarker(root)
  // An unreadable marker is left as it is (never replaced); this download still gets an id of its own.
  if (found === 'unreadable') return randomUUID()
  const meta = found ?? { format: 1, createdAt: new Date().toISOString() }
  if (typeof meta.id === 'string' && ID_RE.test(meta.id)) return meta.id
  const id = randomUUID()
  // A read-only project still downloads; it just gets a new id next time.
  await writeMarker(root, { ...meta, id }).catch(() => undefined)
  return id
}

/** The ids of the projects in the projects folder (only folders that carry the marker). */
export async function projectIds(projectsRoot: string): Promise<Set<string>> {
  const ids = new Set<string>()
  for (const d of await readdir(projectsRoot, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    const meta = await readMarker(join(projectsRoot, d.name))
    if (meta && meta !== 'unreadable' && typeof meta.id === 'string') ids.add(meta.id)
  }
  return ids
}

/** A conversation's native model session belongs to the computer it ran on. Without it, the thread resumes as a fresh
 *  session that is given the saved history (threads-core.ts `resume`). */
export function withoutNativeSession(raw: Buffer): Buffer {
  let thread: unknown
  try { thread = JSON.parse(raw.toString('utf8')) } catch { return raw }
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) return raw
  const t = thread as Record<string, unknown>
  if (typeof t.kernelSessionId !== 'string' || t.kernelSessionId === '') return raw
  return Buffer.from(JSON.stringify({ ...t, kernelSessionId: '' }, null, 2), 'utf8')
}

// ---- zip, written and read by hand: small, and every field is checked --------------------------

// Compression runs on libuv's thread pool, so a large study does not stall the app (online: every request).
const deflateRaw = promisify(zlib.deflateRaw)
const inflateRaw = promisify(zlib.inflateRaw)

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()
export function crc32(buf: Uint8Array): number {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0 // Node 20.15+ (Electron 33, the sandbox's Node 24)
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107)
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

const UTF8_FLAG = 0x0800
const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_END = 0x06054b50

class ZipWriter {
  private offset = 0
  private central: Buffer[] = []
  private count = 0
  private stamp: { time: number; date: number }
  constructor(private fh: FileHandle, when: Date) {
    this.stamp = dosTime(when)
  }
  private async put(buf: Buffer): Promise<void> {
    let done = 0
    while (done < buf.length) done += (await this.fh.write(buf, done, buf.length - done, null)).bytesWritten
    this.offset += buf.length
  }
  async add(name: string, data: Buffer): Promise<void> {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    let method = 8
    let body: Buffer = await deflateRaw(data, { level: 6 })
    if (body.length >= data.length) { method = 0; body = data }
    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(this.stamp.time, 10)
    local.writeUInt16LE(this.stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    const cen = Buffer.alloc(46)
    cen.writeUInt32LE(SIG_CENTRAL, 0)
    cen.writeUInt16LE((3 << 8) | 20, 4) // made on Unix: the mode below says "regular file"
    cen.writeUInt16LE(20, 6)
    cen.writeUInt16LE(UTF8_FLAG, 8)
    cen.writeUInt16LE(method, 10)
    cen.writeUInt16LE(this.stamp.time, 12)
    cen.writeUInt16LE(this.stamp.date, 14)
    cen.writeUInt32LE(crc, 16)
    cen.writeUInt32LE(body.length, 20)
    cen.writeUInt32LE(data.length, 24)
    cen.writeUInt16LE(nameBuf.length, 28)
    cen.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    cen.writeUInt32LE(this.offset, 42)
    this.central.push(cen, nameBuf)
    this.count++
    await this.put(local)
    await this.put(nameBuf)
    await this.put(body)
  }
  async finish(): Promise<number> {
    const cd = Buffer.concat(this.central)
    const cdOffset = this.offset
    await this.put(cd)
    const end = Buffer.alloc(22)
    end.writeUInt32LE(SIG_END, 0)
    end.writeUInt16LE(this.count, 8)
    end.writeUInt16LE(this.count, 10)
    end.writeUInt32LE(cd.length, 12)
    end.writeUInt32LE(cdOffset, 16)
    await this.put(end)
    return this.offset
  }
}

interface ZipEntry { name: string; method: number; csize: number; usize: number; offset: number; dataStart: number }

async function readAt(fh: FileHandle, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let done = 0
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done)
    if (!bytesRead) fail('not-package', 'the file ends early')
    done += bytesRead
  }
  return buf
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

/** The central directory of a plain zip, every entry checked: no encryption, no links or folders, no zip64, entries
 *  that do not overlap, local headers that agree with the directory. */
async function readEntries(fh: FileHandle, size: number, limits: Limits): Promise<ZipEntry[]> {
  if (size > limits.maxPackageBytes) fail('too-large', `the file is larger than ${limits.maxPackageBytes} bytes`)
  if (size < 22) fail('not-package', 'too short for a zip file')
  const tailLength = Math.min(size, 22 + 0xffff)
  const tail = await readAt(fh, size - tailLength, tailLength)
  let at = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_END && i + 22 + tail.readUInt16LE(i + 20) <= tail.length) { at = i; break }
  }
  if (at < 0) fail('not-package', 'no zip directory')
  const disk = tail.readUInt16LE(at + 4), cdDisk = tail.readUInt16LE(at + 6)
  const onDisk = tail.readUInt16LE(at + 8), count = tail.readUInt16LE(at + 10)
  const cdSize = tail.readUInt32LE(at + 12), cdOffset = tail.readUInt32LE(at + 16)
  if (disk !== 0 || cdDisk !== 0 || onDisk !== count) fail('not-package', 'split zip files are not supported')
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('not-package', 'zip64 is not supported')
  if (count > limits.maxFiles + 1) fail('too-large', `more than ${limits.maxFiles} files`)
  const endAt = size - tailLength + at
  if (cdOffset + cdSize > endAt) fail('not-package', 'the zip directory is out of bounds')
  if (cdSize > (limits.maxFiles + 1) * (46 + 3 * limits.maxPathLength + 1024)) fail('too-large', 'the zip directory is too large')
  const cd = await readAt(fh, cdOffset, cdSize)
  const entries: ZipEntry[] = []
  let p = 0
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) fail('not-package', 'the zip directory is damaged')
    const madeBy = cd.readUInt16LE(p + 4), flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10)
    const csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24)
    const n = cd.readUInt16LE(p + 28), e = cd.readUInt16LE(p + 30), c = cd.readUInt16LE(p + 32)
    const external = cd.readUInt32LE(p + 38), offset = cd.readUInt32LE(p + 42)
    if (p + 46 + n + e + c > cd.length) fail('not-package', 'the zip directory is damaged')
    const raw = cd.subarray(p + 46, p + 46 + n)
    p += 46 + n + e + c
    let name: string
    try {
      if (!(flags & UTF8_FLAG) && raw.some((b) => b >= 0x80)) throw new Error('not utf-8')
      name = utf8.decode(raw)
    } catch {
      return fail('unsafe', 'a file name that cannot be read', raw.toString('latin1'))
    }
    const shown = name.startsWith(FILE_PREFIX) ? name.slice(FILE_PREFIX.length) : name
    if (flags & 0x41) fail('unsafe', 'an encrypted file', shown)
    if (method !== 0 && method !== 8) fail('unsafe', `compression method ${method}`, shown)
    const host = madeBy >> 8
    const type = (external >>> 16) & 0o170000
    if ((host === 3 || host === 19) && type === 0o120000) fail('unsafe', 'a link', shown)
    if (((host === 3 || host === 19) && type !== 0 && type !== 0o100000) || (external & 0x10) || name.endsWith('/'))
      fail('unsafe', 'a folder or special file', shown)
    if (usize > limits.maxFileBytes || csize > limits.maxFileBytes + MiB) fail('too-large', `a file larger than ${limits.maxFileBytes} bytes`, shown)
    entries.push({ name, method, csize, usize, offset, dataStart: 0 })
  }
  // Local headers: the same name, data inside the file and before the directory, no two entries sharing bytes.
  const byOffset = [...entries].sort((a, b) => a.offset - b.offset)
  let end = 0
  for (const entry of byOffset) {
    const shown = entry.name.startsWith(FILE_PREFIX) ? entry.name.slice(FILE_PREFIX.length) : entry.name
    if (entry.offset < end || entry.offset + 30 > cdOffset) fail('unsafe', 'overlapping zip entries', shown)
    const head = await readAt(fh, entry.offset, 30)
    if (head.readUInt32LE(0) !== SIG_LOCAL) fail('damaged', 'a damaged zip entry', shown)
    const n = head.readUInt16LE(26), e = head.readUInt16LE(28)
    const localName = await readAt(fh, entry.offset + 30, n)
    if (!localName.equals(Buffer.from(entry.name, 'utf8'))) fail('damaged', 'a zip entry whose names disagree', shown)
    entry.dataStart = entry.offset + 30 + n + e
    end = entry.dataStart + entry.csize
    if (end > cdOffset) fail('damaged', 'a zip entry out of bounds', shown)
  }
  return entries
}

/** One entry's bytes, never more than `expected`. */
async function inflateEntry(fh: FileHandle, entry: ZipEntry, expected: number, shown: string): Promise<Buffer> {
  if (entry.usize !== expected) fail('damaged', 'a file whose size is not the listed one', shown)
  const body = await readAt(fh, entry.dataStart, entry.csize)
  if (entry.method === 0) {
    if (body.length !== expected) fail('damaged', 'a file whose size is not the listed one', shown)
    return body
  }
  let out: Buffer
  try {
    out = await inflateRaw(body, { maxOutputLength: Math.max(expected, 1) })
  } catch {
    return fail('damaged', 'a file that cannot be decompressed (or is larger than listed)', shown)
  }
  if (out.length !== expected) fail('damaged', 'a file whose size is not the listed one', shown)
  return out
}

// ---- names: safe on macOS, Windows and Linux ----------------------------------------------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
/** The key two names collide under on a case-insensitive file system (macOS, Windows). */
const foldKey = (p: string): string => p.normalize('NFC').toLowerCase()

/** Throws unless `p` is a relative path that stays inside the project on every platform and may be in a study. */
export function checkPath(p: unknown, limits: Limits = LIMITS): string {
  const shown = typeof p === 'string' ? p.slice(0, 200) : String(p)
  if (typeof p !== 'string' || !p || p.length > limits.maxPathLength) return fail('unsafe', 'a missing or overlong file name', shown)
  if (/[\u0000-\u001f\u007f\\<>:"|?*]/.test(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p)) fail('unsafe', 'an absolute path or a character that is not allowed', shown)
  const parts = p.split('/')
  if (parts.length > limits.maxDepth) fail('unsafe', 'folders nested too deep', shown)
  for (const part of parts) {
    if (!part || part === '.' || part === '..') fail('unsafe', 'a path that leaves the study folder', shown)
    if (/[. ]$/.test(part) || WINDOWS_RESERVED.test(part)) fail('unsafe', 'a name Windows cannot store', shown)
  }
  if (classify(p) === 'never') fail('unsafe', 'a file that is never part of a study', shown)
  return p
}

/** Two paths that would be one file (or a file and a folder) on a case-insensitive file system: refused on both sides,
 *  so a study made on Linux (online) with Data.csv and data.csv fails when it is downloaded, not when it is opened. */
export function checkCollisions(paths: string[]): void {
  const seen = new Set<string>()
  const folders = new Set<string>()
  for (const path of paths) {
    const key = foldKey(path)
    if (seen.has(key) || folders.has(key)) fail('unsafe', 'two files with the same name', path)
    seen.add(key)
    const parts = key.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  for (const folder of folders) if (seen.has(folder)) fail('unsafe', 'a file and a folder with the same name', paths.find((p) => foldKey(p) === folder) ?? folder)
}

export function checkManifest(value: unknown, limits: Limits = LIMITS): Manifest {
  const m = value as Partial<Manifest> | null
  if (!m || typeof m !== 'object' || Array.isArray(m) || m.format !== FORMAT) return fail('not-package', 'not a HumanStudy study file')
  if (typeof m.version !== 'number' || !Number.isInteger(m.version) || m.version < 1) return fail('not-package', 'no format version')
  if (m.version > FORMAT_VERSION) return fail('newer', `format version ${m.version}`)
  if (!Array.isArray(m.files)) return fail('not-package', 'no file list')
  if (m.files.length > limits.maxFiles) fail('too-large', `more than ${limits.maxFiles} files`)
  let total = 0
  for (const f of m.files as unknown[]) {
    const file = f as Partial<ManifestFile> | null
    if (!file || typeof file !== 'object') return fail('not-package', 'a damaged file list')
    const path = checkPath(file.path, limits)
    if (typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) return fail('not-package', 'a damaged file list', path)
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) return fail('not-package', 'a damaged file list', path)
    if (file.size > limits.maxFileBytes) fail('too-large', `a file larger than ${limits.maxFileBytes} bytes`, path)
    total += file.size
    if (total > limits.maxTotalBytes) fail('too-large', `more than ${limits.maxTotalBytes} bytes in all`)
  }
  checkCollisions((m.files as ManifestFile[]).map((f) => f.path))
  const source = (m.source && typeof m.source === 'object' ? m.source : {}) as Partial<Manifest['source']>
  const includes = (m.includes && typeof m.includes === 'object' ? m.includes : {}) as Partial<Manifest['includes']>
  return {
    format: FORMAT,
    version: m.version,
    projectId: typeof m.projectId === 'string' && ID_RE.test(m.projectId) ? m.projectId : '',
    name: typeof m.name === 'string' ? m.name.slice(0, 200) : '',
    source: { platform: source.platform === 'online' ? 'online' : 'desktop', appVersion: typeof source.appVersion === 'string' ? source.appVersion.slice(0, 40) : '' },
    exportedAt: typeof m.exportedAt === 'string' ? m.exportedAt.slice(0, 40) : '',
    includes: {
      conversations: includes.conversations === true,
      privateFiles: Array.isArray(includes.privateFiles) ? includes.privateFiles.filter((x): x is string => typeof x === 'string').slice(0, limits.maxFiles) : [],
    },
    files: (m.files as ManifestFile[]).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
  }
}

// ---- download ---------------------------------------------------------------------------------

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** The file name a download is offered under: the project's name and the suffix that marks a study file. */
export const packageName = (projectName: string): string => safeName(projectName) + PACKAGE_SUFFIX

export interface ExportResult { path: string; bytes: number; files: number; manifest: Manifest }

/** Writes the study file to `outPath` (through a temporary next to it, so a failure never leaves a partial file). */
export async function exportStudy(root: string, outPath: string, o: StudyExportOptions & {
  source: { platform: Platform; appVersion: string }
  /** A published study: its run outputs are private files (see kindOf). */
  published?: boolean
  /** A released (Library) study: its private files stay on this computer (exportFiles). */
  released?: Released
  limits?: Limits
  now?: Date
}): Promise<ExportResult> {
  const limits = o.limits ?? LIMITS
  const now = o.now ?? new Date()
  const id = await ensureProjectId(root)
  // An ordinary project's private files are included (the researcher's own copy); a released study's stay on this
  // computer, since the file may be handed on and they can hold wording the release holds back. The chat history
  // can be left out.
  // what a released study keeps back is left out before the limits are checked (only what goes in counts), and
  // decided again on the very bytes written (keptBack)
  const chosen = (await exportFiles(root, limits, o)).filter((f) =>
    f.kind === 'study' || (f.kind === 'private' && !o.released) || (f.kind === 'conversation' && o.conversations === true && !o.released))
  if (chosen.length > limits.maxFiles) fail('too-large', `more than ${limits.maxFiles} files`)
  let planned = 0
  for (const f of chosen) {
    if (f.size > limits.maxFileBytes) fail('too-large', `a file larger than ${limits.maxFileBytes} bytes`, f.path)
    planned += f.size
  }
  if (planned > limits.maxTotalBytes) fail('too-large', `more than ${limits.maxTotalBytes} bytes in all`)
  for (const f of chosen) checkPath(f.path, limits) // a name another platform could not store fails here, not on opening
  checkCollisions(chosen.map((f) => f.path))
  // `<name>.<pid>.<uuid>.tmp`: the save-temporary form file watching and research capture already skip.
  const tmp = `${outPath}.${process.pid}.${randomUUID()}.tmp`
  const fh = await open(tmp, 'wx')
  const files: ManifestFile[] = []
  let total = 0
  try {
    const zip = new ZipWriter(fh, now)
    for (const f of chosen) {
      let data: Buffer = await readFile(join(root, ...f.path.split('/')))
      if (o.released && f.kind === 'study' && keptBack(f.path, data, o.released)) continue
      if (isThread(f.path)) data = withoutNativeSession(data)
      if (data.length > limits.maxFileBytes) fail('too-large', `a file larger than ${limits.maxFileBytes} bytes`, f.path)
      total += data.length
      if (total > limits.maxTotalBytes) fail('too-large', `more than ${limits.maxTotalBytes} bytes in all`)
      await zip.add(FILE_PREFIX + f.path, data)
      files.push({ path: f.path, size: data.length, sha256: sha256(data) })
    }
    const manifest: Manifest = {
      format: FORMAT,
      version: FORMAT_VERSION,
      projectId: id,
      name: basename(root),
      source: o.source,
      exportedAt: now.toISOString(),
      includes: { conversations: o.conversations === true && !o.released, privateFiles: chosen.filter((f) => f.kind === 'private').map((f) => f.path) },
      files,
    }
    await zip.add(MANIFEST_NAME, Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'))
    const bytes = await zip.finish()
    await fh.close()
    await rename(tmp, outPath)
    return { path: outPath, bytes, files: files.length, manifest }
  } catch (e) {
    await fh.close().catch(() => undefined)
    await rm(tmp, { force: true }).catch(() => undefined)
    throw e
  }
}

// ---- open ---------------------------------------------------------------------------------------

interface OpenedPackage { fh: FileHandle; manifest: Manifest; entries: Map<string, ZipEntry> }

async function openPackage(zipPath: string, limits: Limits): Promise<OpenedPackage> {
  let fh: FileHandle
  try {
    fh = await open(zipPath, 'r')
  } catch {
    return fail('not-package', 'the file cannot be read')
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) fail('not-package', 'not a file')
    const list = await readEntries(fh, st.size, limits)
    const entries = new Map<string, ZipEntry>()
    let manifestEntry: ZipEntry | undefined
    for (const entry of list) {
      const shown = entry.name.startsWith(FILE_PREFIX) ? entry.name.slice(FILE_PREFIX.length) : entry.name
      if (entry.name === MANIFEST_NAME) {
        if (manifestEntry) fail('unsafe', 'two file lists')
        manifestEntry = entry
        continue
      }
      if (!entry.name.startsWith(FILE_PREFIX)) fail('unsafe', 'a file outside the study', shown)
      if (entries.has(shown)) fail('unsafe', 'two files with the same name', shown)
      entries.set(shown, entry)
    }
    if (!manifestEntry) return fail('not-package', 'no file list')
    if (manifestEntry.usize > limits.maxManifestBytes) fail('too-large', 'the file list is too large')
    let manifestValue: unknown
    try {
      manifestValue = JSON.parse((await inflateEntry(fh, manifestEntry, manifestEntry.usize, MANIFEST_NAME)).toString('utf8'))
    } catch (e) {
      if (e instanceof TransferError && e.code !== 'damaged') throw e
      return fail('not-package', 'the file list cannot be read')
    }
    const manifest = checkManifest(manifestValue, limits)
    const listed = new Set(manifest.files.map((f) => f.path))
    for (const path of entries.keys()) if (!listed.has(path)) fail('unsafe', 'a file that is not in the list', path)
    for (const f of manifest.files) if (!entries.has(f.path)) fail('damaged', 'a listed file is missing', f.path)
    return { fh, manifest, entries }
  } catch (e) {
    await fh.close().catch(() => undefined)
    throw e
  }
}

/** Checks the whole study file without writing anything: what `importStudy` does first. */
async function verifyAll(pkg: OpenedPackage): Promise<void> {
  for (const f of pkg.manifest.files) {
    const data = await inflateEntry(pkg.fh, pkg.entries.get(f.path)!, f.size, f.path)
    if (sha256(data) !== f.sha256) fail('damaged', 'a file that changed after the study was downloaded', f.path)
  }
}

export async function verifyPackage(zipPath: string, limits: Limits = LIMITS): Promise<Manifest> {
  const pkg = await openPackage(zipPath, limits)
  try {
    await verifyAll(pkg)
    return pkg.manifest
  } finally {
    await pkg.fh.close().catch(() => undefined)
  }
}

export interface ImportResult {
  dir: string
  name: string
  /** True when a project with the same id was already here: the copy got a new name and a new id. */
  renamed: boolean
  id: string
  conversations: number
  privateFiles: number
  manifest: Manifest
}

const SUFFIX_FROM: Record<Platform, string> = { online: 'from online', desktop: 'from this computer' }
const shortDate = (d: Date): string => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d)

/** The new project's folder name: the study's name, and when that study is already here, where the copy came from. */
export function importName(manifest: Pick<Manifest, 'name' | 'source'>, duplicate: boolean, now: Date): string {
  const base = safeName(manifest.name || 'Downloaded study')
  if (!duplicate) return base
  const suffix = ` (${SUFFIX_FROM[manifest.source.platform]}, ${shortDate(now)})`
  return safeName(base.slice(0, Math.max(1, 80 - suffix.length)).trim() + suffix)
}

/** Opens a study file as a NEW project in `projectsRoot`. Never writes into an existing project: the whole file is
 *  verified first, extracted into a hidden folder, verified again, then renamed into place. */
export async function importStudy(zipPath: string, projectsRoot: string, o: { limits?: Limits; now?: Date } = {}): Promise<ImportResult> {
  const limits = o.limits ?? LIMITS
  const now = o.now ?? new Date()
  // One open file and one file list for both passes: the bytes extracted are the bytes verified (each file is hashed
  // again as it is written, too).
  const pkg = await openPackage(zipPath, limits)
  const { manifest } = pkg
  const temp = join(projectsRoot, `.importing-${randomUUID()}`)
  try {
    await verifyAll(pkg)
    await mkdir(temp)
    for (const f of manifest.files) {
      const data = await inflateEntry(pkg.fh, pkg.entries.get(f.path)!, f.size, f.path)
      if (sha256(data) !== f.sha256) fail('damaged', 'a file that changed after the study was downloaded', f.path)
      const target = join(temp, ...f.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, isThread(f.path) ? withoutNativeSession(data) : data, { flag: 'wx' })
    }
    await pkg.fh.close()
    // The id: kept when this study is new here; a copy of a study already here gets its own (never two projects
    // under one id) and the name says where it came from. Folder names are never used to match.
    const existing = await projectIds(projectsRoot)
    const duplicate = Boolean(manifest.projectId && existing.has(manifest.projectId))
    const id = manifest.projectId && !duplicate ? manifest.projectId : randomUUID()
    const found = await readMarker(temp)
    const meta = found && found !== 'unreadable' ? found : { format: 1, createdAt: now.toISOString() }
    await mkdir(join(temp, '.humanstudy'), { recursive: true })
    await writeFile(join(temp, ...MARKER), JSON.stringify({
      ...meta,
      id,
      importedAt: now.toISOString(),
      importedFrom: manifest.source.platform,
      ...(duplicate ? { copyOf: manifest.projectId } : {}),
    }, null, 2) + '\n')
    const name = importName(manifest, duplicate, now)
    let dir = ''
    for (let i = 1, busy = 0; !dir; ) {
      if (i > 1000) fail('failed', 'no free folder name')
      const candidate = join(projectsRoot, i === 1 ? name : `${name} ${i}`)
      if (existsSync(candidate)) { i++; continue }
      try {
        await rename(temp, candidate)
        dir = candidate
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'ENOTDIR') { i++; continue } // taken meanwhile
        // Windows: a virus scanner may still hold a file just written; try the same name again shortly.
        if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && busy++ < 10) { await new Promise((r) => setTimeout(r, 200)); continue }
        throw e
      }
    }
    return {
      dir,
      name: basename(dir),
      renamed: duplicate,
      id,
      conversations: threadCount(manifest.files),
      privateFiles: manifest.files.filter((f) => classify(f.path) === 'private').length,
      manifest,
    }
  } catch (e) {
    await pkg.fh.close().catch(() => undefined)
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
    throw e
  }
}

/** A hidden import folder a crash left behind (the app sweeps them on start). */
export async function sweepImports(projectsRoot: string): Promise<void> {
  for (const d of await readdir(projectsRoot, { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory() && d.name.startsWith('.importing-')) await rm(join(projectsRoot, d.name), { recursive: true, force: true }).catch(() => undefined)
  }
}
