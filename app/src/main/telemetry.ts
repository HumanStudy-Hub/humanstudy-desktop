// Electron wiring for research data (logic in telemetry-core.ts): userData storage, the account's
// PostgREST credentials, project ids, IPC, and main-process capture of kernel/session events.
import { app, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { getAccount } from './account'
import { createTelemetry, FLUSH_INTERVAL_MS, type StoredState, type Telemetry } from './telemetry-core'
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
    t.track(type, { ...opts, projectId }, { projectDir: dirFor })
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
  // Only queued with conversation-content consent (telemetry-core drops it otherwise).
  track('conversation.user', { metadata: { text } }, dir)
}

export function trackTurnAbort(sessionId: string): void {
  const turn = turns.get(sessionId)
  if (!turn) return
  turns.delete(sessionId)
  const dir = sessionDirs.get(sessionId)
  track('agent.turn_abort', { durationMs: Date.now() - turn.startedAt, metadata: turnMeta(turn) }, dir)
  if (turn.reply) track('conversation.assistant', { metadata: { text: turn.reply, partial: true } }, dir)
}

export function onKernelEvent(e: KernelEvent): void {
  const turn = turns.get(e.sessionId)
  if (!turn) return
  const dir = sessionDirs.get(e.sessionId)
  if (e.type === 'text') {
    if (getTelemetry().status().content && turn.reply.length < 20_000) turn.reply += e.text ?? ''
  } else if (e.type === 'tool') {
    if (e.tool) turn.tools.add(e.tool.slice(0, 60))
    if (e.text === 'completed' || e.text === 'error') turn.toolSteps++
    if (e.text === 'error') turn.toolErrors++
  } else if (e.type === 'done' || e.type === 'error') {
    turns.delete(e.sessionId)
    const durationMs = Date.now() - turn.startedAt
    if (e.type === 'done') track('agent.turn_end', { durationMs, metadata: turnMeta(turn) }, dir)
    else track('agent.turn_error', { durationMs, metadata: { ...turnMeta(turn), error: errorLine(e.text ?? e.detail) } }, dir)
    if (turn.reply) track('conversation.assistant', { metadata: { text: turn.reply } }, dir)
  }
}

const turnMeta = (t: Turn): Record<string, unknown> => ({
  tools: [...t.tools],
  toolSteps: t.toolSteps,
  toolErrors: t.toolErrors,
  replyChars: t.reply.length || undefined,
})
/** First line of an error, at most 160 chars; the sanitizer removes paths, emails and keys. */
const errorLine = (err: unknown): string =>
  String(err instanceof Error ? err.message : (err ?? 'error'))
    .split('\n')[0]
    .slice(0, 160)

// ---- artifacts and exports ------------------------------------------------------------
const seenFiles = new Map<string, Set<string>>()
/** Emits artifact.created / export.created for files that appear in an open project. */
export function noteProjectFiles(snap: ProjectSnapshot): void {
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

// ---- IPC ------------------------------------------------------------------------------
/** Renderer events may not impersonate consent records or carry conversation text. */
const RENDERER_DENY = /^(consent|conversation|kernel|agent)\./

export function registerTelemetry(): void {
  const t = getTelemetry()
  ipcMain.handle('telemetry:status', () => t.status())
  ipcMain.handle('telemetry:setConsent', (_e, c: { usage: boolean; content: boolean }) => t.setConsent(c))
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
  ipcMain.handle('telemetry:deleteMyData', () => t.deleteMyData())
  ipcMain.handle('telemetry:flush', async () => {
    await t.flush({ force: true })
    return t.status()
  })

  const startedAt = Date.now()
  track('app.session_start', { metadata: { arch: process.arch } })
  const timer = setInterval(() => void t.tick(), FLUSH_INTERVAL_MS)
  timer.unref?.()
  app.on('before-quit', () => {
    // Persisted to the queue; uploaded on the next launch if this quit outruns the request.
    track('app.session_end', { durationMs: Date.now() - startedAt })
    void t.flush({ force: true })
  })
}
