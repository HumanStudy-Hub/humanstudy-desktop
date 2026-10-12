// opencode kernel: one `opencode serve` process per project directory, driven over HTTP + SSE.
//
// API shapes below were checked against the live OpenAPI spec (`GET /doc`) of opencode 1.18.21
// and against https://opencode.ai/docs/server/ + /docs/config/:
//   - auth: HTTP basic, user `opencode`, password from OPENCODE_SERVER_PASSWORD   (docs + live)
//   - GET  /global/health -> {healthy:true, version}                                (live spec)
//   - POST /session {title?} -> Session {id:"ses_..."}                              (live)
//   - POST /session/:id/prompt_async {parts:[{type:"text",text}], model?:{providerID,modelID}}
//          -> 204                                                                   (live)
//   - POST /session/:id/abort -> boolean                                            (live)
//   - GET  /event: SSE, `data: {id,type,properties}` frames, first `server.connected` (live)
//   - Event types used: message.updated {info:{id,role}}, message.part.updated {part},
//     message.part.delta {messageID,partID,field,delta}, session.status {status:{type}},
//     session.idle, session.error {error:{name,data:{message}}}, permission.asked  (live; tool parts
//     and permissions observed live in wave M2)
//   - OPENCODE_CONFIG_CONTENT (inline config, highest precedence) and `{env:VAR}`
//     substitution are documented; verified live that the config is applied.
//
// Added in wave M2 (all verified live on 1.18.21, using a local OpenAI-compatible stub as the model so
// real bash/write tool calls and a real title/usage round trip happened):
//   - Permissions: config key `permission: {edit:"ask", bash:"ask"}` (PermissionConfig in the spec;
//     values ask|allow|deny; per the docs opencode allows most tools by default). Event
//     `permission.asked` properties = {id:"per_..", sessionID, permission:"bash"|"edit"|
//     "external_directory"|.., patterns[], metadata, always[], tool?}. metadata: bash {command},
//     edit {filepath, diff}; external_directory {filepath, parentDir}. NOTE edit `patterns` are relative
//     to opencode's worktree root ("/" outside git), so the absolute `metadata.filepath` is used.
//   - Reply: POST /permission/{requestID}/reply {reply:"once"|"always"|"reject"} -> true.
//     Unknown id -> 404 {_tag:"PermissionNotFoundError"}. The older POST
//     /session/{id}/permissions/{permissionID} {response} still exists and is the fallback.
//     `permission.replied` {sessionID, requestID, reply} follows every reply. A rejected call ends as
//     tool state `error` ("The user rejected permission ...") and the turn still reaches idle.
//   - Usage: `message.updated` for an assistant message carries info.tokens {input, output, reasoning,
//     total, cache{read,write}} and info.cost (number); `info.time.completed` is set when the message
//     is final. One assistant message per model step, so a tool-using turn yields several.
//   - Title: sessions created without a title get "New session - <iso>"; opencode then renames them
//     via `session.updated` {info:{title}} after the first reply (needs small_model, which we set).
//   - Sessions persist on disk: a freshly started server answers GET /session/{id} (200) for a session
//     made by an earlier server (404 {name:"NotFoundError"} when it does not exist), so resume works
//     across app restarts. GET /session/{id}/message and GET /session exist (see spec) but are unused.
// Not verified: whether `message.part.delta` is emitted for every provider (we also fall back
// to diffing `message.part.updated` text), and the real OpenRouter / hosted proxy token counts.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute, resolve } from 'node:path'
import { truncateString, truncateValue } from '../truncate'
import { Emitter } from './types'
import type { Kernel, KernelEvent, KernelPermission, PermissionReply } from './types'

export const DEFAULT_PROVIDER = 'humanstudy'
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5'
/** Models the HumanStudy edition of opencode already declares under provider.humanstudy
 *  (packages/opencode/src/config/humanstudy.ts in HumanStudy-Hub/opencode). Any other hosted model
 *  the server offers is declared in the inline config. */
const BAKED_HOSTED_MODELS = ['anthropic/claude-sonnet-5.5', 'anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4.1-flash']

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Server {
  dir: string
  proc: ChildProcess
  base: string
  auth: string
  sse: AbortController
  connected: Promise<void>
  exited: boolean
  stderrTail: string
}

interface SessionState {
  server: Server
  inFlight: boolean
  roles: Map<string, string> // messageID -> role
  partTypes: Map<string, string> // partID -> part type
  emitted: Map<string, number> // text partID -> chars already emitted
  toolStatus: Map<string, string> // tool partID -> last emitted status
  usageSent: Set<string> // assistant messageIDs whose usage was already emitted
  title: string // last session title emitted
}

export interface OpencodeOptions {
  /** Path of the HumanStudy opencode binary (required: the app never looks for a system opencode). */
  binary: string
  /** Folder that holds the kernel's own XDG config/data/cache/state. Default: HUMANSTUDY_KERNEL_HOME,
   *  else a temp folder. The app points it at userData/kernel so a personal opencode setup never leaks in. */
  home?: string
  provider?: string
  model?: string
  /** 'ask': every edit/bash call goes to the renderer. 'project': those inside the project folder are
   *  approved automatically. Default: HUMANSTUDY_PERMISSION env (set from Settings), else 'ask'. */
  permission?: 'ask' | 'project'
  readyTimeoutMs?: number
}

export class OpencodeKernel implements Kernel {
  readonly name = 'opencode'
  private emitter = new Emitter()
  private servers = new Map<string, Promise<Server>>()
  private live = new Set<Server>()
  private sessions = new Map<string, SessionState>()
  private disposed = false
  private binary: string
  private home: string
  private provider: string
  private model: string
  private readyTimeoutMs: number
  private permission: 'ask' | 'project' | undefined
  private exitHook = (): void => this.killAll('SIGKILL')

  constructor(opts: OpencodeOptions) {
    if (!opts?.binary) throw new Error('opencode binary not given')
    this.binary = opts.binary
    this.home = opts.home ?? process.env.HUMANSTUDY_KERNEL_HOME ?? join(tmpdir(), 'humanstudy-kernel')
    // An empty provider means "do not force a model" (no hosted access and no dev key).
    this.provider = opts.provider ?? process.env.HUMANSTUDY_PROVIDER ?? DEFAULT_PROVIDER
    this.model = opts.model ?? process.env.HUMANSTUDY_MODEL ?? DEFAULT_MODEL
    // Own OpenRouter keys are a developer path only.
    if (this.provider === 'openrouter' && !(process.env.HUMANSTUDY_DEV_KEYS === '1' && process.env.OPENROUTER_API_KEY)) this.provider = ''
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000
    this.permission = opts.permission
    process.once('exit', this.exitHook)
  }

  // ---- public API ---------------------------------------------------------------------

  async startSession(projectDir: string): Promise<string> {
    const server = await this.serverFor(projectDir)
    // No title: opencode names a default-titled session itself after the first reply (session.updated).
    const res = await this.request(server, 'POST', '/session', {})
    const info = (await res.json()) as { id?: string }
    if (!info.id) throw new Error('opencode: session create returned no id')
    this.register(info.id, server)
    return info.id
  }

  async resumeSession(projectDir: string, sessionId: string): Promise<string | null> {
    const known = this.sessions.get(sessionId)
    if (known && !known.server.exited) return sessionId
    // opencode keeps sessions on disk, so a freshly started server may still know this one.
    const server = await this.serverFor(projectDir)
    const res = await fetch(server.base + `/session/${encodeURIComponent(sessionId)}`, {
      headers: { authorization: server.auth },
    })
    if (res.status === 404 || res.status === 400) return null
    if (!res.ok) throw new Error(`opencode GET /session/${sessionId} -> ${res.status}`)
    this.register(sessionId, server)
    return sessionId
  }

  private register(id: string, server: Server): void {
    this.sessions.set(id, {
      server,
      inFlight: false,
      roles: new Map(),
      partTypes: new Map(),
      emitted: new Map(),
      toolStatus: new Map(),
      usageSent: new Set(),
      title: '',
    })
  }

  async reply(sessionId: string, permissionId: string, response: PermissionReply): Promise<void> {
    await this.replyTo(this.session(sessionId).server, sessionId, permissionId, response)
  }

  private async replyTo(server: Server, sessionId: string, permissionId: string, response: PermissionReply): Promise<void> {
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(server.base + path, {
        method: 'POST',
        headers: { authorization: server.auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    let res = await post(`/permission/${encodeURIComponent(permissionId)}/reply`, { reply: response })
    if (res.status === 404 || res.status === 405) {
      const text = await res.clone().text()
      // Older servers only have the (now deprecated) per-session route.
      if (!text.includes('PermissionNotFound'))
        res = await post(`/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, { response })
    }
    if (!res.ok) throw new Error(`opencode permission reply -> ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`)
  }

  async send(sessionId: string, text: string): Promise<void> {
    const s = this.session(sessionId)
    s.inFlight = true
    try {
      await this.request(s.server, 'POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        parts: [{ type: 'text', text }],
        ...(this.provider ? { model: { providerID: this.provider, modelID: this.model } } : {}),
      })
    } catch (err) {
      s.inFlight = false
      throw err
    }
  }

  async abort(sessionId: string): Promise<void> {
    const s = this.session(sessionId)
    await this.request(s.server, 'POST', `/session/${encodeURIComponent(sessionId)}/abort`)
    // opencode follows an abort with session.idle, which emits `done`.
  }

  onEvent(cb: (e: KernelEvent) => void): () => void {
    return this.emitter.on(cb)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    process.removeListener('exit', this.exitHook)
    const procs = [...this.live]
    this.killAll('SIGTERM')
    await Promise.all(
      procs.map(
        (srv) =>
          new Promise<void>((resolve) => {
            if (srv.exited) return resolve()
            const t = setTimeout(() => {
              srv.proc.kill('SIGKILL')
              resolve()
            }, 3000)
            srv.proc.once('exit', () => {
              clearTimeout(t)
              resolve()
            })
          })
      )
    )
    this.sessions.clear()
    this.servers.clear()
    this.emitter.clear()
  }

  // ---- server lifecycle ---------------------------------------------------------------

  private permissionMode(): 'ask' | 'project' {
    return this.permission ?? (process.env.HUMANSTUDY_PERMISSION === 'project' ? 'project' : 'ask')
  }

  private session(id: string): SessionState {
    const s = this.sessions.get(id)
    if (!s) throw new Error(`unknown session ${id}`)
    if (s.server.exited) throw new Error('opencode server has exited')
    return s
  }

  private serverFor(dir: string): Promise<Server> {
    let p = this.servers.get(dir)
    if (!p) {
      p = this.launch(dir)
      this.servers.set(dir, p)
      p.catch(() => this.servers.delete(dir))
    }
    return p
  }

  private configContent(): string {
    const model = this.provider ? `${this.provider}/${this.model}` : undefined
    // The fork bakes in the humanstudy provider, its models and the share/autoupdate/telemetry defaults.
    // Here only what the app decides per run: the chosen model (inline config outranks any config file)
    // and edit/bash approval, which the app answers (user prompt, or auto-approval in the project, see handle()).
    const cfg: Record<string, unknown> = {
      $schema: 'https://opencode.ai/config.json',
      ...(model ? { model, small_model: model } : {}), // small_model: otherwise titles go to opencode's own default
      permission: { edit: 'ask', bash: 'ask', external_directory: 'ask' },
    }
    if (this.provider === HOSTED_PROVIDER && !BAKED_HOSTED_MODELS.includes(this.model)) {
      cfg.provider = { [HOSTED_PROVIDER]: { models: { [this.model]: { name: this.model, tool_call: true } } } }
    }
    // Developer path only (HUMANSTUDY_DEV_KEYS=1): the key stays in the env, opencode substitutes it.
    if (this.provider === 'openrouter') cfg.provider = { openrouter: { options: { apiKey: '{env:OPENROUTER_API_KEY}' } } }
    return JSON.stringify(cfg)
  }

  /** Env for the kernel process: its own XDG dirs, so ~/.config/opencode and ~/.local/share/opencode of
   *  a personal install are never read, and sessions persist under <home>/data per project. */
  private kernelEnv(password: string): NodeJS.ProcessEnv {
    const xdg = {
      XDG_CONFIG_HOME: join(this.home, 'config'),
      XDG_DATA_HOME: join(this.home, 'data'),
      XDG_CACHE_HOME: join(this.home, 'cache'),
      XDG_STATE_HOME: join(this.home, 'state'),
    }
    for (const d of Object.values(xdg)) mkdirSync(d, { recursive: true })
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...xdg,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: this.configContent(),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', // no ~/.claude/CLAUDE.md from the user's own Claude Code
    }
    delete env.OPENCODE_CONFIG // a personal config file path
    delete env.OPENCODE_CONFIG_DIR
    if (this.provider !== HOSTED_PROVIDER) {
      delete env.HUMANSTUDY_DESKTOP_KEY
    }
    return env
  }

  private async launch(dir: string): Promise<Server> {
    if (this.disposed) throw new Error('kernel disposed')
    const port = await freePort()
    const password = randomBytes(24).toString('base64url')
    const proc = spawn(this.binary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: dir,
      env: this.kernelEnv(password),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const server: Server = {
      dir,
      proc,
      base: `http://127.0.0.1:${port}`,
      auth: 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64'),
      sse: new AbortController(),
      connected: Promise.resolve(),
      exited: false,
      stderrTail: '',
    }
    this.live.add(server)
    const keep = (chunk: Buffer): void => {
      server.stderrTail = (server.stderrTail + chunk.toString()).slice(-2000)
    }
    proc.stdout?.on('data', keep)
    proc.stderr?.on('data', keep)
    proc.on('exit', (code) => {
      server.exited = true
      server.sse.abort()
      this.live.delete(server)
      this.servers.delete(dir)
      if (this.disposed) return
      for (const [id, s] of this.sessions) {
        if (s.server !== server) continue
        this.emitter.emit({ sessionId: id, type: 'error', text: `opencode exited (code ${code})` })
        if (s.inFlight) this.emitter.emit({ sessionId: id, type: 'done' })
        this.sessions.delete(id)
      }
    })
    proc.on('error', () => {
      server.exited = true
    })

    try {
      await this.waitReady(server)
      server.connected = this.openEvents(server)
      await server.connected
    } catch (err) {
      proc.kill('SIGKILL')
      const tail = redact(server.stderrTail).trim().split('\n').slice(-5).join('\n')
      throw new Error(`${(err as Error).message}${tail ? `\nopencode output:\n${tail}` : ''}`)
    }
    return server
  }

  private async waitReady(server: Server): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline) {
      if (server.exited) throw new Error('opencode serve exited during startup')
      try {
        const res = await fetch(server.base + '/global/health', {
          headers: { authorization: server.auth },
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) return
      } catch {
        // not listening yet
      }
      await sleep(250)
    }
    throw new Error('opencode serve did not become ready in time')
  }

  private killAll(sig: NodeJS.Signals): void {
    for (const srv of this.live) {
      srv.sse.abort()
      if (!srv.exited) srv.proc.kill(sig)
    }
  }

  private async request(server: Server, method: string, path: string, body?: unknown): Promise<Response> {
    const res = await fetch(server.base + path, {
      method,
      headers: {
        authorization: server.auth,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const msg = (await res.text().catch(() => '')).slice(0, 300)
      throw new Error(`opencode ${method} ${path} -> ${res.status} ${msg}`)
    }
    return res
  }

  // ---- SSE ----------------------------------------------------------------------------

  /** Opens /event; resolves once `server.connected` arrives. Reconnects while the server lives. */
  private openEvents(server: Server): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let first = true
      const loop = async (): Promise<void> => {
        let backoff = 250
        while (!server.exited && !this.disposed) {
          try {
            const res = await fetch(server.base + '/event', {
              headers: { authorization: server.auth, accept: 'text/event-stream' },
              signal: server.sse.signal,
            })
            if (!res.ok || !res.body) throw new Error(`/event -> ${res.status}`)
            backoff = 250
            await this.readStream(res.body, (data) => {
              if (data.type === 'server.connected' && first) {
                first = false
                resolve()
              }
              this.handle(data)
            })
          } catch (err) {
            if (server.sse.signal.aborted) break
            if (first) return reject(err as Error)
          }
          await sleep(backoff)
          backoff = Math.min(backoff * 2, 5000)
        }
        if (first) reject(new Error('event stream closed before server.connected'))
      }
      void loop()
    })
  }

  private async readStream(body: ReadableStream<Uint8Array>, onData: (d: OcEvent) => void): Promise<void> {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let idx: number
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n')
        if (!data) continue
        try {
          onData(JSON.parse(data) as OcEvent)
        } catch {
          // ignore malformed frames
        }
      }
    }
  }

  /** Map one opencode bus event onto zero or more KernelEvents. */
  private handle(ev: OcEvent): void {
    const p = ev.properties ?? {}
    const sessionId: string | undefined = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID
    if (!sessionId) return
    const s = this.sessions.get(sessionId)
    if (!s) return // child/sub-agent sessions and sessions we did not start
    const emit = (e: Omit<KernelEvent, 'sessionId'>): void => this.emitter.emit({ sessionId, ...e })

    switch (ev.type) {
      case 'message.updated': {
        const info = p.info
        if (info?.id && info.role) s.roles.set(info.id, info.role)
        // Once an assistant message is complete, report its tokens/cost (one `usage` per message).
        if (info?.role === 'assistant' && info.time?.completed && !s.usageSent.has(info.id)) {
          s.usageSent.add(info.id)
          const t = info.tokens ?? {}
          emit({
            type: 'usage',
            usage: {
              input: Number(t.input) || 0,
              output: Number(t.output) || 0,
              reasoning: Number(t.reasoning) || 0,
              cost: typeof info.cost === 'number' ? info.cost : undefined,
            },
          })
        }
        return
      }

      case 'session.updated': {
        const title: unknown = p.info?.title
        if (typeof title === 'string' && title && title !== s.title) {
          s.title = title
          if (!isDefaultTitle(title)) emit({ type: 'title', text: title })
        }
        return
      }

      case 'message.part.delta': {
        if (p.field !== 'text' || typeof p.delta !== 'string') return
        const type = s.partTypes.get(p.partID)
        const role = s.roles.get(p.messageID)
        if (role === 'user') return
        if (type ? type !== 'text' : role !== 'assistant') return // skip reasoning etc.
        s.emitted.set(p.partID, (s.emitted.get(p.partID) ?? 0) + p.delta.length)
        emit({ type: 'text', text: p.delta })
        return
      }

      case 'message.part.updated': {
        const part = p.part
        if (!part?.id) return
        s.partTypes.set(part.id, part.type)
        if (part.type === 'text') {
          if (s.roles.get(part.messageID) !== 'assistant' || part.synthetic) return
          // Fallback when no deltas were streamed: emit whatever we have not shown yet.
          const shown = s.emitted.get(part.id) ?? 0
          const full: string = part.text ?? ''
          if (full.length > shown) {
            s.emitted.set(part.id, full.length)
            emit({ type: 'text', text: full.slice(shown) })
          }
        } else if (part.type === 'tool') {
          const st = part.state ?? {}
          const status: string = st.status ?? 'pending'
          if (s.toolStatus.get(part.id) === status) return
          s.toolStatus.set(part.id, status)
          const detail =
            status === 'error' ? String(st.error ?? '') : st.title || summarizeInput(st.input)
          const done = status === 'completed' || status === 'error'
          const out = status === 'error' ? st.error : st.output
          emit({
            type: 'tool',
            tool: part.tool,
            text: status,
            detail,
            input: st.input === undefined ? undefined : truncateValue(st.input),
            output: done && out != null ? truncateString(typeof out === 'string' ? out : JSON.stringify(out)) : undefined,
          })
        }
        return
      }

      case 'session.status': {
        const st = p.status ?? {}
        if (st.type === 'idle') return // session.idle handles completion
        emit({ type: 'status', text: st.type, detail: st.message })
        return
      }

      case 'session.idle':
        if (!s.inFlight) return // opencode repeats idle; only one `done` per turn
        s.inFlight = false
        s.emitted.clear()
        s.toolStatus.clear()
        emit({ type: 'done' })
        return

      case 'session.error': {
        const err = p.error ?? {}
        if (err.name === 'MessageAbortedError') emit({ type: 'status', text: 'aborted' })
        else emit({ type: 'error', text: err.data?.message ?? err.name ?? 'unknown error' })
        return
      }

      case 'permission.asked': {
        const perm = toKernelPermission(p)
        if (!perm) return
        if (this.permissionMode() === 'project' && isInsideProject(s.server.dir, perm)) {
          // Settings -> "allow inside the project": answer without bothering the user.
          this.replyTo(s.server, sessionId, perm.id, 'always').then(
            () => emit({ type: 'permission', permission: { ...perm, resolved: 'always' } }),
            () => emit({ type: 'permission', permission: perm }) // could not auto-reply: ask the user
          )
          return
        }
        emit({ type: 'permission', permission: perm })
        return
      }

      case 'permission.replied': {
        const reply = p.reply ?? p.response
        if (p.requestID && (reply === 'once' || reply === 'always' || reply === 'reject'))
          emit({ type: 'permission', permission: { id: p.requestID, type: '', resolved: reply } })
        return
      }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OcEvent = { type: string; properties?: any }

const isDefaultTitle = (t: string): boolean => /^(new session|child session)\b/i.test(t) || t === 'HumanStudy'

/** opencode `permission.asked` properties -> KernelPermission. */
export function toKernelPermission(p: {
  id?: string
  permission?: string
  patterns?: string[]
  metadata?: Record<string, unknown>
}): KernelPermission | null {
  if (!p.id) return null
  const patterns = Array.isArray(p.patterns) ? p.patterns.filter((x): x is string => typeof x === 'string') : []
  const md = p.metadata ?? {}
  const pick = (k: string): string | undefined => (typeof md[k] === 'string' && md[k] ? (md[k] as string) : undefined)
  const title = pick('command') ?? pick('filepath') ?? pick('filePath') ?? pick('description') ?? (patterns.join(' ') || undefined)
  return { id: p.id, type: p.permission ?? 'unknown', title: title?.slice(0, 300), patterns, metadata: md }
}

/** Tool permissions that are safe to auto-approve when "inside the project": edit/write patterns that
 *  resolve under `dir`, and bash commands that name no path outside it. Anything else is asked. */
export function isInsideProject(dir: string, perm: KernelPermission): boolean {
  const inside = (p: string): boolean => {
    const abs = isAbsolute(p) ? p : resolve(dir, p)
    const rel = relative(dir, abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  if (perm.type === 'edit' || perm.type === 'write') {
    // patterns are relative to opencode's worktree root ("/" outside git), so prefer the absolute filepath.
    const fp = perm.metadata?.filepath ?? perm.metadata?.filePath
    const paths = typeof fp === 'string' && fp ? [fp] : perm.patterns?.length ? perm.patterns : []
    return paths.length > 0 && paths.every((x) => inside(x.replace(/[*?].*$/, '') || '.'))
  }
  if (perm.type === 'bash') {
    // Patterns are command lines. Reject absolute/home/parent paths and shell indirection we cannot judge.
    return (perm.patterns ?? []).length > 0 &&
      (perm.patterns ?? []).every((cmd) => {
        if (/[`$]\(|`|\$\{|\|\s*(sh|bash|zsh)\b|\bsudo\b|\brm\s+-\w*[rf]/.test(cmd)) return false
        return cmd
          .split(/\s+/)
          .every((tok) => {
            const t = tok.replace(/^["']|["']$/g, '')
            if (t.startsWith('~') || t === '..' || t.startsWith('../') || t.includes('/../')) return false
            return !isAbsolute(t) || inside(t)
          })
      })
  }
  return false
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const k of ['filePath', 'path', 'command', 'pattern', 'url', 'description']) {
    if (typeof o[k] === 'string') return (o[k] as string).slice(0, 200)
  }
  return JSON.stringify(o).slice(0, 200)
}

function redact(s: string): string {
  for (const key of [process.env.OPENROUTER_API_KEY, process.env.HUMANSTUDY_DESKTOP_KEY, process.env.HUMANSTUDY_SERVER_BYPASS]) {
    if (key) s = s.split(key).join('[redacted]')
  }
  return s
}

export const HOSTED_PROVIDER = 'humanstudy'
