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
//     session.idle, session.error {error:{name,data:{message}}}, permission.asked  (live spec;
//     text/error/idle path observed live, tool parts only from the schema - not observed,
//     because no real OpenRouter key was available while writing this)
//   - OPENCODE_CONFIG_CONTENT (inline config, highest precedence) and `{env:VAR}`
//     substitution are documented; verified live that the config is applied.
// Not verified: whether `message.part.delta` is emitted for every provider (we also fall back
// to diffing `message.part.updated` text), and permission-reply flow (we only surface it).

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { Emitter } from './types'
import type { Kernel, KernelEvent } from './types'

export const DEFAULT_PROVIDER = 'openrouter'
export const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5'

/** Find the opencode binary. Electron started from Finder (or the Start menu) has a minimal PATH,
 *  so also probe the usual install locations. Returns an absolute path or null.
 *  On Windows only a real opencode.exe is accepted: npm's opencode.cmd shim cannot be spawned
 *  without a shell, so the platform package's binary inside the npm global tree is used instead. */
export function findOpencode(): string | null {
  const win = process.platform === 'win32'
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  const home = homedir()
  if (win) {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const npmRoots = [process.env.npm_config_prefix, join(appData, 'npm'), process.env.NVM_SYMLINK].filter(
      (d): d is string => Boolean(d)
    )
    dirs.push(
      join(home, '.opencode', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, 'scoop', 'shims'),
      join(localAppData, 'Microsoft', 'WinGet', 'Links'),
      join(process.env.ProgramData ?? 'C:\\ProgramData', 'chocolatey', 'bin'),
      ...npmRoots
    )
    // npm i -g opencode-ai: the exe lives in the platform package (nested or hoisted).
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    for (const root of npmRoots) {
      for (const pkg of [`opencode-windows-${arch}`, `opencode-windows-${arch}-baseline`]) {
        dirs.push(
          join(root, 'node_modules', 'opencode-ai', 'node_modules', pkg, 'bin'),
          join(root, 'node_modules', pkg, 'bin')
        )
      }
    }
  } else {
    dirs.push(
      '/usr/local/bin',
      '/opt/homebrew/bin',
      join(home, '.opencode', 'bin'),
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.npm-global', 'bin')
    )
  }
  for (const d of dirs) {
    const p = join(d, win ? 'opencode.exe' : 'opencode')
    try {
      accessSync(p, win ? constants.F_OK : constants.X_OK)
      return p
    } catch {
      // keep looking
    }
  }
  return null
}

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
}

export interface OpencodeOptions {
  binary?: string
  provider?: string
  model?: string
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
  private provider: string
  private model: string
  private readyTimeoutMs: number
  private exitHook = (): void => this.killAll('SIGKILL')

  constructor(opts: OpencodeOptions = {}) {
    const bin = opts.binary ?? findOpencode()
    if (!bin) throw new Error('opencode binary not found')
    this.binary = bin
    this.provider = opts.provider ?? process.env.HUMANSTUDY_PROVIDER ?? DEFAULT_PROVIDER
    this.model = opts.model ?? process.env.HUMANSTUDY_MODEL ?? DEFAULT_MODEL
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 30_000
    process.once('exit', this.exitHook)
  }

  // ---- public API ---------------------------------------------------------------------

  async startSession(projectDir: string): Promise<string> {
    const server = await this.serverFor(projectDir)
    const res = await this.request(server, 'POST', '/session', { title: 'HumanStudy' })
    const info = (await res.json()) as { id?: string }
    if (!info.id) throw new Error('opencode: session create returned no id')
    this.sessions.set(info.id, {
      server,
      inFlight: false,
      roles: new Map(),
      partTypes: new Map(),
      emitted: new Map(),
      toolStatus: new Map(),
    })
    return info.id
  }

  async send(sessionId: string, text: string): Promise<void> {
    const s = this.session(sessionId)
    s.inFlight = true
    try {
      await this.request(s.server, 'POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        parts: [{ type: 'text', text }],
        model: { providerID: this.provider, modelID: this.model },
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
    const model = `${this.provider}/${this.model}`
    const cfg: Record<string, unknown> = {
      $schema: 'https://opencode.ai/config.json',
      model,
      small_model: model, // otherwise title generation goes to opencode's own default model
      autoupdate: false,
      share: 'disabled',
    }
    // Only point at the env var when it is set: an unset {env:} becomes "" and would clobber
    // credentials the user stored with `opencode auth login`. The key itself never enters
    // this string; opencode substitutes it from its own environment.
    if (this.provider === 'openrouter' && process.env.OPENROUTER_API_KEY) {
      cfg.provider = { openrouter: { options: { apiKey: '{env:OPENROUTER_API_KEY}' } } }
    }
    // Hosted models through HumanStudy Hub: a custom OpenAI-compatible provider
    // (https://opencode.ai/docs/providers/ "Custom provider"). The desktop key stays in the env.
    if (this.provider === HOSTED_PROVIDER) cfg.provider = { [HOSTED_PROVIDER]: hostedProviderConfig(this.model) }
    return JSON.stringify(cfg)
  }

  private async launch(dir: string): Promise<Server> {
    if (this.disposed) throw new Error('kernel disposed')
    const port = await freePort()
    const password = randomBytes(24).toString('base64url')
    const proc = spawn(this.binary, ['serve', '--port', String(port), '--hostname', '127.0.0.1'], {
      cwd: dir,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: this.configContent(),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      },
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
      case 'message.updated':
        if (p.info?.id && p.info.role) s.roles.set(p.info.id, p.info.role)
        return

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
          emit({ type: 'tool', tool: part.tool, text: status, detail })
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

      case 'permission.asked':
        // Surfaced only; replying (POST /permission/:id/reply) is left to the app layer.
        emit({ type: 'status', text: 'permission', detail: `${p.permission} ${(p.patterns ?? []).join(' ')}`.trim() })
        return
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OcEvent = { type: string; properties?: any }

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  for (const k of ['filePath', 'path', 'command', 'pattern', 'url', 'description']) {
    if (typeof o[k] === 'string') return (o[k] as string).slice(0, 200)
  }
  return JSON.stringify(o).slice(0, 200)
}

function redact(s: string): string {
  for (const key of [process.env.OPENROUTER_API_KEY, process.env.HUMANSTUDY_DESKTOP_KEY]) {
    if (key) s = s.split(key).join('[redacted]')
  }
  return s
}

export const HOSTED_PROVIDER = 'humanstudy'

/** opencode `provider.humanstudy` entry, from env set by the app (src/main/account.ts). */
export function hostedProviderConfig(model: string): Record<string, unknown> {
  let ids: string[] = []
  try {
    const parsed = JSON.parse(process.env.HUMANSTUDY_HOSTED_MODELS ?? '[]') as unknown
    if (Array.isArray(parsed)) ids = parsed.filter((m): m is string => typeof m === 'string')
  } catch {
    /* fall back to the selected model only */
  }
  if (!ids.includes(model)) ids.push(model)
  return {
    npm: '@ai-sdk/openai-compatible',
    name: 'HumanStudy',
    options: {
      baseURL: process.env.HUMANSTUDY_HOSTED_BASEURL ?? 'https://humanstudy-hub-web.vercel.app/api/desktop/v1',
      apiKey: '{env:HUMANSTUDY_DESKTOP_KEY}',
    },
    models: Object.fromEntries(ids.map((id) => [id, { name: id }])),
  }
}
