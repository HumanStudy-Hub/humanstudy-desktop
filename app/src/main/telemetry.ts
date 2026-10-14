// Electron wiring for research data (logic in telemetry-core.ts): userData storage, the account's
// PostgREST credentials, project ids, IPC, and main-process capture of kernel/session events.
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { storeResearchContent } from './research-content'
import { strToU8, zipSync } from 'fflate'
import { getAccount } from './account'
import { accountHash, createTelemetry, FLUSH_INTERVAL_MS, programDiff, scrubString, type StoredState, type Telemetry } from './telemetry-core'
import { createReplay, REPLAY_FLUSH_MS, type Replay, type ReplayFile, type ReplayFs } from './replay-core'
import type { Capture } from './threads-core'
import type { KernelEvent } from './kernel-types'
import type { ProjectSnapshot, TelemetryRecent, TelemetryTrackOptions } from '../preload/types'

const dir = (): string => app.getPath('userData')
const files = {
  state: () => join(dir(), 'telemetry.json'),
  queue: () => join(dir(), 'telemetry-queue.jsonl'),
  recent: () => join(dir(), 'telemetry-recent.json'),
}
const readJson = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null
  }
}
const write = (p: string, s: string): void => {
  mkdirSync(dir(), { recursive: true })
  writeFileSync(p, s, { mode: 0o600 })
}

let telemetry: Telemetry | null = null
export function getTelemetry(): Telemetry {
  if (telemetry) return telemetry
  const acct = getAccount()
  telemetry = createTelemetry({
    fetch: (...args) => fetch(...args),
    storage: {
      readState: () => readJson<StoredState>(files.state()),
      writeState: (s) => write(files.state(), JSON.stringify(s, null, 2)),
      readQueue: () => {
        try {
          return readFileSync(files.queue(), 'utf8')
        } catch {
          return ''
        }
      },
      appendQueue: (lines) => {
        mkdirSync(dir(), { recursive: true })
        appendFileSync(files.queue(), lines, { mode: 0o600 })
      },
      writeQueue: (content) => write(files.queue(), content),
      readRecent: () => readJson<TelemetryRecent[]>(files.recent()) ?? [],
      writeRecent: (r) => write(files.recent(), JSON.stringify(r)),
    },
    accountEmail: () => acct.status().email ?? null,
    auth: () => acct.restAuth(),
    appVersion: app.getVersion(),
    platform: process.platform,
  })
  return telemetry
}

// ---- project ids ----------------------------------------------------------------------
const projectIds = new Map<string, string>() // id -> absolute dir
/**
 * The random research id stored in <project>/.humanstudy/project.json; added when missing. Only
 * HumanStudy projects (folders that already carry the marker file) get one, so tracking never
 * turns an arbitrary folder into something that looks like a project.
 */
export function projectIdFor(projectDir: string): string | null {
  const root = resolve(projectDir)
  const p = join(root, '.humanstudy', 'project.json')
  if (!existsSync(p)) return null
  try {
    const meta = readJson<Record<string, unknown>>(p)
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
    let id = typeof meta.id === 'string' && meta.id.length >= 8 && meta.id.length <= 80 ? meta.id : ''
    if (!id) {
      id = randomUUID()
      writeFileSync(p, JSON.stringify({ ...meta, id }, null, 2) + '\n')
    }
    projectIds.set(id, root)
    return id
  } catch {
    return null
  }
}

/** The project open in the window; renderer events without a project id are attributed to it. */
let rendererProjectDir: string | undefined

/** Track from the main process; `projectDir` makes paths project-relative and sets project_id. */
export function track(type: string, opts: TelemetryTrackOptions = {}, projectDir?: string): void {
  try {
    const t = getTelemetry()
    if (!t.status().usage) return
    const projectId = opts.projectId ?? (projectDir ? (projectIdFor(projectDir) ?? undefined) : undefined)
    const dirFor = projectDir ?? (projectId ? projectIds.get(projectId) : undefined)
    let metadata = opts.metadata
    if (metadata && Buffer.byteLength(JSON.stringify(metadata)) > 12_000) {
      const blob = putBlob(JSON.stringify(metadata), dirFor)
      if (blob) metadata = { metadata_blob: blob }
    }
    t.track(type, { ...opts, metadata, projectId }, { projectDir: dirFor })
  } catch {
    /* research data must never break the app */
  }
}

// ---- kernel / agent capture -----------------------------------------------------------
interface Turn {
  startedAt: number
  tools: Set<string>
  toolSteps: number
  toolErrors: number
  reply: string
}
const sessionDirs = new Map<string, string>()
const turns = new Map<string, Turn>()

export function trackSessionStart(sessionId: string, projectDir: string, kernelName: string, startedAt: number): void {
  sessionDirs.set(sessionId, resolve(projectDir))
  track('kernel.session_start', { durationMs: Date.now() - startedAt, metadata: { kernel: kernelName } }, projectDir)
}
export function trackSessionError(projectDir: string, err: unknown, startedAt: number): void {
  track('kernel.session_error', { durationMs: Date.now() - startedAt, metadata: { error: errorLine(err) } }, projectDir)
}

export function trackTurnStart(sessionId: string, text: string): void {
  turns.set(sessionId, { startedAt: Date.now(), tools: new Set(), toolSteps: 0, toolErrors: 0, reply: '' })
  const dir = sessionDirs.get(sessionId)
  track('agent.turn_start', { metadata: { chars: text.length } }, dir)
  const attached = /^\[Attached: ([^\]]*)\]/.exec(text)
  track('composer.send', { metadata: { chars: text.length, attachments: attached ? attached[1].split(',').filter((x) => x.trim()).length : 0 } }, dir)
}

export function trackTurnAbort(sessionId: string): void {
  const turn = turns.get(sessionId)
  if (!turn) return
  turns.delete(sessionId)
  const dir = sessionDirs.get(sessionId)
  track('agent.turn_abort', { durationMs: Date.now() - turn.startedAt, metadata: turnMeta(turn) }, dir)
}

export function onKernelEvent(e: KernelEvent): void {
  const turn = turns.get(e.sessionId)
  if (!turn) return
  const dir = sessionDirs.get(e.sessionId)
  if (e.type === 'status' && e.text === 'recovering' && e.input) {
    track('agent.recovery', { metadata: e.input as Record<string, unknown> }, dir)
  } else if (e.type === 'text') {
    if (getTelemetry().status().content) turn.reply += e.text ?? ''
  } else if (e.type === 'tool') {
    if (e.tool) turn.tools.add(e.tool.slice(0, 60))
    if (e.text === 'completed' || e.text === 'error') turn.toolSteps++
    if (e.text === 'error') turn.toolErrors++
  } else if (e.type === 'done' || e.type === 'error') {
    turns.delete(e.sessionId)
    const durationMs = Date.now() - turn.startedAt
    if (e.type === 'done') track('agent.turn_end', { durationMs, metadata: turnMeta(turn) }, dir)
    else track('agent.turn_error', { durationMs, metadata: { ...turnMeta(turn), error: errorLine(e.text ?? e.detail) } }, dir)
  }
}

const turnMeta = (t: Turn): Record<string, unknown> => ({
  tools: [...t.tools],
  toolSteps: t.toolSteps,
  toolErrors: t.toolErrors,
  replyChars: t.reply.length || undefined,
})
/** Preserve the full error; the sanitizer removes paths, emails and keys. */
const errorLine = (err: unknown): string =>
  String(err instanceof Error ? err.message : (err ?? 'error'))

// ---- artifacts and exports ------------------------------------------------------------
const seenFiles = new Map<string, Set<string>>()
/** Emits artifact.created / export.created for files that appear in an open project. */
export function noteProjectFiles(snap: ProjectSnapshot): void {
  if (snap.program) noteFsChange(snap.dir, 'program.json') // baseline version when the project opens
  const now = new Set([...snap.artifacts.map((f) => `artifacts/${f.name}`), ...snap.exports.map((f) => `exports/${f.name}`)])
  const before = seenFiles.get(snap.dir)
  seenFiles.set(snap.dir, now)
  if (!before) return
  for (const rel of now) {
    if (before.has(rel)) continue
    const kind = rel.startsWith('artifacts/') ? 'artifact.created' : 'export.created'
    track(kind, { target: rel, metadata: { ext: extname(rel).slice(1).toLowerCase() } }, snap.dir)
  }
}

// ---- replay storage ---------------------------------------------------------------------
const replayRoot = (): string => join(dir(), 'replay')
const diskFs: ReplayFs = {
  write(rel, data) {
    const p = join(replayRoot(), rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, data, { mode: 0o600 })
  },
  read(rel) {
    try {
      return new Uint8Array(readFileSync(join(replayRoot(), rel)))
    } catch {
      return null
    }
  },
  remove(rel) {
    try {
      unlinkSync(join(replayRoot(), rel))
    } catch {
      /* already gone */
    }
  },
  list() {
    const out: ReplayFile[] = []
    const walk = (base: string, rel: string, depth: number): void => {
      let names: string[] = []
      try {
        names = readdirSync(base)
      } catch {
        return
      }
      for (const n of names) {
        const full = join(base, n)
        try {
          const st = statSync(full)
          if (st.isDirectory()) depth < 3 && walk(full, rel ? `${rel}/${n}` : n, depth + 1)
          else out.push({ rel: rel ? `${rel}/${n}` : n, size: st.size, mtimeMs: st.mtimeMs })
        } catch {
          /* vanished */
        }
      }
    }
    walk(replayRoot(), '', 0)
    return out
  },
  clear() {
    rmSync(replayRoot(), { recursive: true, force: true })
  },
}

let replay: Replay | null = null
export function getReplay(): Replay {
  if (replay) return replay
  const acct = getAccount()
  replay = createReplay({
    fs: diskFs,
    fetch: (...args) => fetch(...args),
    auth: () => acct.restAuth(),
    allowed: () => {
      const st = getTelemetry().status()
      return st.usage && st.content
    },
    acct: () => {
      const email = acct.status().email
      return email ? accountHash(email) : null
    },
    appVersion: app.getVersion(),
    onDropped: (info) => track('replay.dropped', { metadata: info }),
  })
  return replay
}

/** Gzips `text` (after removing emails, keys and absolute paths) into the replay store; returns the blob name. */
function putBlob(text: string, projectDir?: string): string | null {
  try {
    const t = getTelemetry()
    if (!t.status().content) return null
    const clean = scrubString(text, { projectDir, email: getAccount().status().email })
    return storeResearchContent(clean, bytes => getReplay().addBlob(t.sessionId, bytes))
  } catch {
    return null
  }
}

/** `value` inline up to `maxBytes`; longer values keep a prefix inline and the whole text in a blob. */
function fit(out: Record<string, unknown>, key: string, value: string | undefined, maxBytes: number, projectDir?: string): void {
  if (value === undefined || value === '') return
  if (Buffer.byteLength(value) <= maxBytes) {
    out[key] = value
    return
  }
  const blob = putBlob(value, projectDir)
  out[`${key}_chars`] = value.length
  if (blob) out[`${key}_blob`] = blob
  else out[key] = value // Never lose the payload when local blob storage is unavailable.

}

// ---- agent transcript -------------------------------------------------------------------
/** Called by the thread store for every final message part and per-message usage. */
export function onThreadCapture(c: Capture): void {
  try {
    if (!getTelemetry().status().content) return
    if (c.kind === 'usage') {
      track('conversation.usage', { metadata: { thread_id: c.threadId, message_id: c.messageId, ...c.usage } }, c.dir)
      return
    }
    const base: Record<string, unknown> = { thread_id: c.threadId, message_id: c.messageId, part: c.index, message_at: c.at }
    if (c.workspace) fit(base, 'workspace', JSON.stringify(c.workspace), 5_500, c.dir)
    const p = c.part
    if (p.kind === 'text') {
      fit(base, 'text', p.text, 11_000, c.dir)
      track(c.role === 'user' ? 'conversation.user' : 'conversation.assistant', { metadata: base }, c.dir)
    } else if (p.kind === 'tool') {
      base.state = p.state
      fit(base, 'detail', p.detail, 400, c.dir)
      if (p.input !== undefined) fit(base, 'input', typeof p.input === 'string' ? p.input : JSON.stringify(p.input), 5_500, c.dir)
      fit(base, 'output', p.output, 5_500, c.dir)
      track('conversation.tool', { target: p.tool, metadata: base }, c.dir)
    } else if (p.kind === 'question') {
      base.question_id = p.id
      base.resolved = p.resolved ?? null
      if (c.unresolved) base.unresolved = true
      fit(base, 'questions', JSON.stringify(p.questions), 5_500, c.dir)
      if (p.answers) fit(base, 'answers', JSON.stringify(p.answers), 5_500, c.dir)
      track('conversation.question', { metadata: base }, c.dir)
    } else if (p.kind === 'permission') {
      base.permission_id = p.id
      base.automatic = Boolean(p.automatic)
      base.resolved = p.resolved ?? null
      if (c.unresolved) base.unresolved = true
      fit(base, 'detail', p.title, 400, c.dir)
      base.patterns = p.patterns
      track('conversation.permission', { target: p.type, metadata: base }, c.dir)
    } else {
      fit(base, 'text', p.text, 4_000, c.dir)
      track('conversation.error', { metadata: base }, c.dir)
    }
  } catch {
    /* research data must never break the app */
  }
}

// ---- project snapshots: program.json versions and agent-written files --------------------
const TEXT_EXTS = new Set(['txt', 'md', 'json', 'csv', 'tsv', 'html', 'htm', 'py', 'r', 'js', 'ts', 'tex', 'bib', 'yaml', 'yml', 'xml', 'svg', 'qmd', 'rmd', 'css', 'sql', 'jl', 'do', 'sps', 'ipynb', 'log', 'toml', 'ini'])
const WATCHED_DIRS = /^(artifacts|exports|package)\//
const programState = new Map<string, { hash: string; json: unknown; version: number }>()
const fileHashes = new Map<string, string>()
const humanWrites = new Map<string, number>()
const fsTimers = new Map<string, NodeJS.Timeout>()

/** The researcher saved this file in the app (so the resulting change is not the agent's). */
export function noteHumanWrite(path: string): void {
  humanWrites.set(resolve(path), Date.now())
}
const byWhom = (abs: string): 'human' | 'agent' => ((humanWrites.get(abs) ?? 0) > Date.now() - 5_000 ? 'human' : 'agent')

/** A file under a watched project changed; versions/snapshots are queued after a short settle. */
export function noteFsChange(projectDir: string, rel: string): void {
  const r = rel.split('\\').join('/')
  const isProgram = r === 'program.json'
  if (!isProgram && !WATCHED_DIRS.test(r)) return
  if (r.startsWith('sources/') || basename(r) === 'paper.pdf' || r.includes('/.')) return
  const key = `${projectDir}\0${r}`
  clearTimeout(fsTimers.get(key))
  const timer = setTimeout(() => {
    fsTimers.delete(key)
    void (isProgram ? snapshotProgram(projectDir) : snapshotFile(projectDir, r)).catch(() => undefined)
  }, 700)
  timer.unref?.()
  fsTimers.set(key, timer)
}

async function snapshotProgram(projectDir: string): Promise<void> {
  if (!getTelemetry().status().content) return
  const path = join(projectDir, 'program.json')
  const raw = await readFile(path, 'utf8')
  const hash = createHash('sha1').update(raw).digest('hex')
  const prev = programState.get(projectDir)
  if (prev?.hash === hash) return
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return // mid-write; the next change event retries
  }
  const version = (prev?.version ?? 0) + 1
  programState.set(projectDir, { hash, json, version })
  const metadata: Record<string, unknown> = {
    version,
    initial: !prev,
    by: prev ? byWhom(resolve(path)) : 'open',
    bytes: Buffer.byteLength(raw),
    hash: hash.slice(0, 12),
  }
  if (prev) metadata.diff = programDiff(prev.json, json)
  const blob = putBlob(raw, projectDir)
  if (blob) metadata.blob = blob
  track('project.program_version', { target: 'program.json', metadata }, projectDir)
}

async function snapshotFile(projectDir: string, rel: string): Promise<void> {
  if (!getTelemetry().status().content) return
  const path = join(projectDir, rel)
  const st = await stat(path).catch(() => null)
  if (!st?.isFile()) return
  const ext = extname(rel).slice(1).toLowerCase()
  const metadata: Record<string, unknown> = { size: st.size, ext, by: byWhom(resolve(path)) }
  if (TEXT_EXTS.has(ext)) {
    const text = await readFile(path, 'utf8')
    const hash = createHash('sha1').update(text).digest('hex')
    const key = `${projectDir}\0${rel}`
    if (fileHashes.get(key) === hash) return
    fileHashes.set(key, hash)
    const blob = putBlob(text, projectDir)
    if (blob) metadata.blob = blob
    metadata.chars = text.length
  }
  track('project.file_written', { target: rel, metadata }, projectDir)
}

// ---- export ---------------------------------------------------------------------------------
async function fetchAllEvents(): Promise<unknown[]> {
  const auth = await getAccount().restAuth()
  if (!auth) throw new Error('Your session has ended. Sign in again.')
  const out: unknown[] = []
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${auth.supabaseUrl}/rest/v1/desktop_events?owner_id=eq.${encodeURIComponent(auth.userId)}&order=occurred_at.asc&limit=1000&offset=${offset}`, {
      headers: { apikey: auth.supabaseKey, authorization: `Bearer ${auth.accessToken}` },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`could not read your events (${res.status})`)
    const page = (await res.json()) as unknown[]
    out.push(...page)
    if (page.length < 1000) return out
  }
}

/** Zip of everything kept about the user: events, threads of known projects and replay chunks. */
export async function exportMyData(parent?: BrowserWindow | null): Promise<string | null> {
  const t = getTelemetry()
  const acct = getAccount()
  if (!acct.status().email) throw new Error('Sign in to your HumanStudy Hub account first.')
  const opts = { title: 'Export my research data', defaultPath: join(app.getPath('downloads'), `humanstudy-research-data-${new Date().toISOString().slice(0, 10)}.zip`), filters: [{ name: 'Zip', extensions: ['zip'] }] }
  const pick = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
  if (pick.canceled || !pick.filePath) return null
  await t.flush({ force: true })
  await getReplay().flush({ force: true })
  const files: Record<string, Uint8Array> = {}
  files['events.json'] = strToU8(JSON.stringify(await fetchAllEvents(), null, 1))
  const currentAcct = accountHash(acct.status().email!)
  const pendingLines = await readFile(join(dir(), 'telemetry-queue.jsonl'), 'utf8').catch(() => '')
  const pending = pendingLines.split('\n').flatMap(line => {
    try { const item = JSON.parse(line); return item.acct === currentAcct ? [item.row] : [] } catch { return [] }
  })
  files['events-unsent.json'] = strToU8(JSON.stringify(pending, null, 1))
  // Threads of the projects opened in this app run (conversation events carry the rest).
  for (const [id, root] of projectIds) {
    const tdir = join(root, '.humanstudy', 'threads')
    let names: string[] = []
    try {
      names = readdirSync(tdir)
    } catch {
      continue
    }
    for (const n of names) if (n.endsWith('.json')) files[`threads/${id}/${n}`] = new Uint8Array(readFileSync(join(tdir, n)))
  }
  const auth = await acct.restAuth()
  const r = getReplay()
  if (auth) {
    const rows = await r.listRemoteChunks(auth)
    files['replay/index.json'] = strToU8(JSON.stringify(rows, null, 1))
    for (const row of rows) {
      try {
        files[`replay/${row.session_id}/${row.seq}.json.gz`] = await r.download(auth, row.path)
      } catch {
        /* listed in index.json; the object may be gone */
      }
    }
    for (const o of await r.listObjects(auth).catch(() => [] as string[])) {
      if (!o.includes('/blobs/')) continue
      try {
        files[`replay/${o.slice(auth.userId.length + 1)}`] = await r.download(auth, o)
      } catch {
        /* skip */
      }
    }
  }
  for (const f of diskFs.list()) {
    if (f.rel.endsWith('.meta.json')) continue
    const meta = diskFs.read(f.rel.replace(/\.(json\.gz|gz)$/, '.meta.json'))
    try { if (!meta || JSON.parse(Buffer.from(meta).toString('utf8')).acct !== currentAcct) continue } catch { continue }
    const b = diskFs.read(f.rel)
    if (b) files[`replay-unsent/${f.rel}`] = b
  }
  await writeFile(pick.filePath, zipSync(files))
  return pick.filePath
}

// ---- IPC ------------------------------------------------------------------------------
/** Renderer events may not impersonate consent records or carry conversation text. */
const RENDERER_DENY = /^(consent|conversation|kernel|agent|replay)\.|^project\.(program_version|file_written)$/

export function registerTelemetry(): void {
  const t = getTelemetry()
  ipcMain.handle('telemetry:status', () => t.status())
  let sessionStartLogged = false
  const logSessionStart = (late: boolean): void => {
    if (sessionStartLogged || !t.status().usage) return
    sessionStartLogged = true
    // replay_session_id equals every event's session_id and the session_id of the replay chunk rows.
    track('app.session_start', { metadata: { arch: process.arch, replay_session_id: t.sessionId, ...(late ? { late: true } : {}) } })
  }
  ipcMain.handle('telemetry:setConsent', async (_e, c: unknown) => {
    const v = c && typeof c === 'object' ? (c as Record<string, unknown>) : {}
    // One agreement: both choices follow the same answer.
    const agreed = v.usage === true && v.content === true
    const st = await t.setConsent({ usage: agreed, content: agreed })
    logSessionStart(true) // consent given after launch: the session still gets its start event
    if (st.content && rendererProjectDir) noteFsChange(rendererProjectDir, 'program.json')
    if (!st.content) getReplay().clearLocal() // withdrawn: nothing recorded stays on disk
    return st
  })
  ipcMain.handle('telemetry:sessionId', () => t.sessionId)
  ipcMain.handle('telemetry:replayChunk', (e, c: unknown) => {
    const v = c && typeof c === 'object' ? (c as Record<string, unknown>) : null
    if (!v || v.sessionId !== t.sessionId || !(v.bytes instanceof Uint8Array)) return false
    const seq = getReplay().addChunk({
      sessionId: v.sessionId,
      startedAt: Number(v.startedAt),
      endedAt: Number(v.endedAt),
      bytes: v.bytes,
      windowId: e.sender.id,
    })
    return seq !== null
  })
  ipcMain.handle('telemetry:exportMyData', (e) => exportMyData(BrowserWindow.fromWebContents(e.sender)))
  ipcMain.handle('telemetry:saveExport', async (e, json: unknown) => {
    if (typeof json !== 'string') throw new Error('Nothing to save.')
    const parent = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title: 'Download my research data',
      defaultPath: join(app.getPath('downloads'), `humanstudy-research-data-${new Date().toISOString().slice(0, 10)}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    }
    const pick = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts)
    if (pick.canceled || !pick.filePath) return null
    await writeFile(pick.filePath, json, 'utf8')
    return pick.filePath
  })
  ipcMain.handle('telemetry:track', (_e, type: string, opts?: TelemetryTrackOptions) => {
    if (typeof type !== 'string' || RENDERER_DENY.test(type)) return
    const o = opts && typeof opts === 'object' ? opts : {}
    // Only ids this process resolved are accepted; otherwise the open project's id is used.
    const known = typeof o.projectId === 'string' && projectIds.has(o.projectId) ? o.projectId : undefined
    const dir = known ? projectIds.get(known) : rendererProjectDir
    const target = typeof o.target === 'string' ? o.target : undefined
    const durationMs = typeof o.durationMs === 'number' ? o.durationMs : undefined
    const metadata = o.metadata && typeof o.metadata === 'object' && !Array.isArray(o.metadata) ? o.metadata : undefined
    track(type, { target, durationMs, metadata, projectId: known }, dir)
  })
  // Remembers the open project; the id (and .humanstudy/project.json's `id`) only exists once
  // usage events are on, so a project is never touched for research without consent.
  ipcMain.handle('telemetry:projectId', (_e, projectDir: string | null) => {
    rendererProjectDir = typeof projectDir === 'string' && projectDir ? resolve(projectDir) : undefined
    if (!rendererProjectDir || !t.status().usage) return null
    return projectIdFor(rendererProjectDir)
  })
  ipcMain.handle('telemetry:recent', () => t.recent())
  ipcMain.handle('telemetry:flush', async () => {
    await t.flush({ force: true })
    return t.status()
  })

  const startedAt = Date.now()
  logSessionStart(false)
  const timer = setInterval(() => void t.tick(), FLUSH_INTERVAL_MS)
  timer.unref?.()
  const replayTimer = setInterval(() => void getReplay().flush().catch(() => undefined), REPLAY_FLUSH_MS)
  replayTimer.unref?.()
  void getReplay().flush().catch(() => undefined) // chunks left from a previous run
  app.on('before-quit', () => {
    // Persisted to the queue; uploaded on the next launch if this quit outruns the request.
    track('app.session_end', { durationMs: Date.now() - startedAt })
    void t.flush({ force: true })
    void getReplay().flush({ force: true }).catch(() => undefined)
  })
}
