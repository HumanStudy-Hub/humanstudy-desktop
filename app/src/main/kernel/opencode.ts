import { nativeRoute, hideCredentials } from './native-api'
import { startRequestTransport } from './request-transport'
import { NATIVE_SESSION_MUTATIONS, NATIVE_TURNS, type NativeRequest, type NativeSelection } from '../../shared/native'
import { validateAnswers, type KernelQuestion } from '../../shared/question'
// opencode kernel: one `opencode serve` process per project directory, driven over HTTP + SSE.
//
// API shapes below were checked against the live OpenAPI spec (`GET /doc`) of opencode 1.18.21, re-verified live on 1.19.0
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
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute, resolve, sep } from 'node:path'
import { kernelRuntimeEnv } from '../runtime-core'
import { Emitter } from './types'
import type { Kernel, KernelEvent, KernelPermission, PermissionReply } from './types'

/** Per-command bash rules (opencode: last matching pattern wins, compound commands are checked per
 *  command). Read-only commands run without a prompt; anything unlisted, and the risky forms of the
 *  listed ones (find -delete/-exec, rg --pre, output redirection), still asks. */
const READ_ONLY_BASH = ['ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pdftotext', 'pdfinfo', 'hs-pdf', 'file', 'pwd', 'echo']
export const BASH_PERMISSION: Record<string, 'ask' | 'allow'> = {
  '*': 'ask',
  ...Object.fromEntries(READ_ONLY_BASH.flatMap((c) => [[c, 'allow'], [`${c} *`, 'allow']])),
  'find *-delete*': 'ask',
  'find *-exec*': 'ask',
  'find *-ok*': 'ask',
  'find *-fprint*': 'ask',
  'rg *--pre*': 'ask',
  '*>*': 'ask',
}

export const DEFAULT_PROVIDER = 'humanstudy'
export const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5'
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

interface NativeMessage {
  info: {
    id: string
    role: string
    time?: { created?: number; completed?: number }
    error?: { name?: string; data?: { message?: string } }
    [key: string]: unknown
  }
  parts?: Array<{ id: string; type: string; [key: string]: unknown }>
}

interface Server {
  dir: string
  proc: ChildProcess
  base: string
  auth: string
  sse: AbortController
  connected: Promise<void>
  exited: boolean
  stderrTail: string
  eventsOnline: boolean
  transport?: Awaited<ReturnType<typeof startRequestTransport>>
}

interface SessionState {
  server: Server
  inFlight: boolean
  roles: Map<string, string> // messageID -> role
  partTypes: Map<string, string> // partID -> part type
  emitted: Map<string, number> // text partID -> chars already emitted
  toolStatus: Map<string, string> // tool partID -> last emitted status
  finishSent: Set<string> // completion metadata may arrive after the usage snapshot
  pendingQuestions: Set<string>
  usageSent: Set<string> // assistant messageIDs whose usage was already emitted
  turnBaseline: Set<string>
  snapshotParts: Set<string>
  awaitingAssistant: boolean
  failed: boolean
  pendingPermissions: Map<string, KernelPermission>
  recovery: { epoch: number; attempts: number; pending: boolean; running: boolean; cancelled: boolean; progress: boolean; reason?: 'output_limit' | 'invalid_tool_call'; assistantId?: string }
  expectUserIdentity?: boolean
  selection?: NativeSelection
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
   *  approved automatically. Default: HUMANSTUDY_PERMISSION env (set from Settings), else 'project'. */
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
  private catchingUp = new Set<Server>()
  private syncLoops = new Set<Server>()
  private reconnectIntervalMs = 1000
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
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 404 || res.status === 400) return null
    if (!res.ok) throw new Error(`opencode GET /session/${sessionId} -> ${res.status}`)
    this.register(sessionId, server)
    // The local thread already contains previous turns. Seed their IDs so a later
    // connection repair cannot append the entire native history as a new answer.
    await this.seedHistory(sessionId)
    return sessionId
  }

  private async seedHistory(sessionId:string):Promise<void>{
    const state=this.session(sessionId)
    const messages=await (await this.request(state.server,'GET','/session/'+encodeURIComponent(sessionId)+'/message')).json() as NativeMessage[]
    for(const {info} of messages)if(info?.id&&info.role)state.roles.set(info.id,info.summary?'summary':info.role)
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
      finishSent: new Set(),
      pendingQuestions: new Set(),
      turnBaseline: new Set(),
      snapshotParts: new Set(),
      awaitingAssistant: false,
      failed: false,
      title: '',
      pendingPermissions: new Map(),
      recovery: { epoch: 0, attempts: 0, pending: false, running: false, cancelled: true, progress: false },
    })
  }

  async reply(sessionId: string, permissionId: string, response: PermissionReply): Promise<void> {
    const s = this.session(sessionId)
    await this.replyTo(s.server, sessionId, permissionId, response)
    s.pendingPermissions.delete(permissionId)
    if (response === 'reject') { s.recovery.cancelled = true; s.recovery.pending = false }
  }

  private async replyTo(server: Server, sessionId: string, permissionId: string, response: PermissionReply): Promise<void> {
    const post = (path: string, body: unknown): Promise<Response> =>
      fetch(server.base + path, {
        method: 'POST',
        headers: { authorization: server.auth, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      })
    let res = await post(`/permission/${encodeURIComponent(permissionId)}/reply`, { reply: response })
    if (res.status === 404 || res.status === 405) {
      const text = await res.clone().text()
      // Older servers only have the (now deprecated) per-session route.
      if (!text.includes('PermissionNotFound'))
        res = await post(`/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, { response })
    }
    if (!res.ok) throw new Error(`opencode permission reply -> ${res.status} ${(await res.text().catch(() => ''))}`)
  }

  async questions(sessionId: string): Promise<KernelQuestion[]> {
    const pending = await this.listQuestions(sessionId)
    const s = this.session(sessionId)
    s.pendingQuestions = new Set(pending.map(q => q.id))
    if (pending.length) s.inFlight = true
    return pending
  }

  private async listQuestions(sessionId: string): Promise<KernelQuestion[]> {
    const res = await this.request(this.session(sessionId).server, 'GET', '/question')
    const requests = await res.json() as { id: string; sessionID: string; questions: KernelQuestion['questions'] }[]
    const pending = requests.filter(q => q.sessionID === sessionId).map(q => ({ id: q.id, questions: q.questions }))
    return pending
  }

  async answerQuestion(sessionId: string, questionId: string, answers: string[][]): Promise<void> {
    const question = (await this.questions(sessionId)).find(q => q.id === questionId)
    if (!question) throw new Error('This question is no longer pending.')
    validateAnswers(question, answers)
    await this.request(this.session(sessionId).server, 'POST', `/question/${encodeURIComponent(questionId)}/reply`, { answers })
    this.session(sessionId).pendingQuestions.delete(questionId)
    this.emitter.emit({ sessionId, type: 'question', question: { ...question, answers, resolved: 'answered' } })
  }

  async rejectQuestion(sessionId: string, questionId: string): Promise<void> {
    const question = (await this.questions(sessionId)).find(q => q.id === questionId)
    if (!question) throw new Error('This question is no longer pending.')
    await this.request(this.session(sessionId).server, 'POST', `/question/${encodeURIComponent(questionId)}/reject`)
    const s = this.session(sessionId)
    s.pendingQuestions.delete(questionId)
    s.recovery.cancelled = true; s.recovery.pending = false
    this.emitter.emit({ sessionId, type: 'question', question: { ...question, resolved: 'rejected' } })
  }

  async send(sessionId: string, text: string): Promise<void> {
    const s = this.session(sessionId)
    s.turnBaseline = new Set(s.roles.keys())
    s.awaitingAssistant = true
    s.expectUserIdentity = true
    s.failed = false
    s.recovery = { epoch: s.recovery.epoch + 1, attempts: 0, pending: false, running: false, cancelled: false, progress: false }
    s.inFlight = true
    try {
      await this.request(s.server, 'POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        parts: [{ type: 'text', text }],
        ...(s.selection?.agent ? {agent:s.selection.agent} : {}),
        ...(s.selection?.variant ? {variant:s.selection.variant} : {}),
        ...(s.selection?.model ? {model:s.selection.model} : this.provider ? { model: { providerID: this.provider, modelID: this.model } } : {}),
      })
      if (s.server.eventsOnline === false) this.beginCatchup(s.server)
    } catch (err) {
      s.inFlight = false
      throw err
    }
  }

  directory(sessionId:string):string { return this.session(sessionId).server.dir }

  /** Native OpenCode functions, scoped to a session already owned by this app. */
  async native(sessionId: string, request: NativeRequest): Promise<unknown> {
    const s = this.session(sessionId)
    if (NATIVE_SESSION_MUTATIONS.has(request.operation) && s.inFlight) throw Error('Stop the current response before changing this session.')
    if (request.operation === 'select') {
      const input = request.input ?? {}, next: NativeSelection = { ...s.selection }
      if ('agent' in input) {
        const agents = await (await this.request(s.server, 'GET', '/agent')).json() as Array<{name:string;hidden?:boolean;mode?:string}>
        if (typeof input.agent !== 'string' || !agents.some(a => a.name === input.agent && !a.hidden && a.mode!=='subagent')) throw Error('Unknown agent.')
        next.agent = input.agent
      }
      if ('variant' in input) {
        if (typeof input.variant !== 'string') throw Error('Invalid model variant.')
        next.variant = input.variant || undefined
      }
      if ('model' in input) {
        const model = input.model as NativeSelection['model']
        if (!model || typeof model.providerID !== 'string' || typeof model.modelID !== 'string') throw Error('Choose a provider and model.')
        const providers = await (await this.request(s.server, 'GET', '/provider')).json() as { all:Array<{id:string;models:Record<string,unknown>}>; connected:string[] }
        if (!providers.connected.includes(model.providerID) || !providers.all.some(p => p.id === model.providerID && p.models[model.modelID])) throw Error('Connect this provider before selecting its model.')
        next.model = model
        if(!('variant' in input))delete next.variant
      }
      if(next.variant){
        const model=next.model??{providerID:this.provider,modelID:this.model}
        const providers=await (await this.request(s.server,'GET','/provider')).json() as {all:Array<{id:string;models:Record<string,{variants?:Record<string,unknown>}>}>}
        const variants=providers.all.find(p=>p.id===model.providerID)?.models[model.modelID]?.variants??{}
        if(!(next.variant in variants))throw Error('This model does not offer that reasoning variant.')
      }
      s.selection = next
      return next
    }
    if (request.operation === 'catalog') {
      const [commands,agents,skills] = await Promise.all(['/command','/agent','/skill'].map(async path => (await this.request(s.server,'GET',path)).json()))
      return {commands,agents,skills,selection:{model:{providerID:this.provider,modelID:this.model},...s.selection}}
    }
    if (request.operation === 'open') {
      const id=String(request.input?.id??'')
      const info=await (await this.request(s.server,'GET','/session/'+encodeURIComponent(id))).json() as {directory:string}
      if (realpathSync(info.directory)!==realpathSync(s.server.dir)) throw Error('Open this session from its own project.')
      if (!this.sessions.has(id)) this.register(id,s.server)
      await this.seedHistory(id)
      await this.request(s.server,'PATCH','/session/'+encodeURIComponent(id),{time:{archived:0}})
      return {id}
    }
    if (request.operation === 'file' || request.operation === 'files') {
      const target=realpathSync(resolve(s.server.dir,String(request.input?.path??'.'))),root=realpathSync(s.server.dir)
      const rel=relative(root,target)
      if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))throw Error('Files must stay inside this project.')
    }
    if(request.operation==='share'){
      const history=await (await this.request(s.server,'GET','/session/'+encodeURIComponent(sessionId)+'/message')).json()
      const hash=createHash('sha256').update(JSON.stringify(history)).digest('hex')
      if(request.input?.previewHash!==hash)throw Error('Review the current conversation before sharing. It may have changed since the preview opened.')
    }
    const defaults = { providerID: this.provider, modelID: this.model }
    const route = nativeRoute(sessionId, request, s.selection ?? {}, defaults)
    const turn = NATIVE_TURNS.has(request.operation)
    if (turn) {
      s.turnBaseline = new Set(s.roles.keys()); s.inFlight = true; s.awaitingAssistant = true; s.expectUserIdentity = request.operation!=='compact'; s.failed = false
      s.recovery = { epoch: s.recovery.epoch + 1, attempts: 0, pending: false, running: false, cancelled: request.operation === 'compact', progress: false }
      this.emitter.emit({sessionId,type:'status',text:request.operation === 'compact' ? 'compacting' : 'busy'})
    }
    try {
      const result = await (await this.request(s.server, route.method, route.path, route.body, turn || ['mcpAuthenticate','providerCallback'].includes(request.operation) ? 10 * 60_000 : 15_000, request.operation==='terminalConnect'?{'x-opencode-ticket':'1'}:undefined)).json()
      if (request.operation === 'fork') {
        const id = (result as {id?:string}).id
        if (!id) throw Error('OpenCode did not return a forked session.')
        this.register(id,s.server); this.session(id).selection = { ...s.selection }
        await this.seedHistory(id)
      }
      if (request.operation === 'terminalConnect') {
        const token = (result as {ticket?:string}).ticket
        if (!token) throw Error('The terminal connection token is unavailable.')
        return {url:s.server.base.replace(/^http/,'ws')+'/pty/'+encodeURIComponent(String(request.input?.id))+'/connect?ticket='+encodeURIComponent(token)}
      }
      return route.redact ? hideCredentials(result) : result
    } catch (error) {
      if(turn)this.emitter.emit({sessionId,type:'error',text:String(error)})
      throw error
    } finally {
      // These endpoints await the native operation. SSE normally sends idle first.
      if(turn && s.inFlight && !s.recovery.pending && !s.recovery.running) this.beginCatchup(s.server)
    }
  }

  async abort(sessionId: string): Promise<void> {
    const s = this.session(sessionId)
    s.recovery.cancelled = true
    s.recovery.pending = false
    s.awaitingAssistant = false
    await this.request(s.server, 'POST', `/session/${encodeURIComponent(sessionId)}/abort`)
    // Native abort can leave a question in the server's pending list. Explicitly dismiss
    // those requests, otherwise reopening this conversation resurrects a stopped turn.
    const pending = await this.listQuestions(sessionId)
    s.pendingQuestions.clear()
    for (const q of pending) {
      await this.request(s.server, 'POST', `/question/${encodeURIComponent(q.id)}/reject`)
      this.emitter.emit({ sessionId, type: 'question', question: { ...q, resolved: 'rejected' } })
    }
    // session.idle normally emits done; clearing a leftover request must not mark it busy again.
    if (s.inFlight) {
      s.inFlight = false
      this.emitter.emit({ sessionId, type: 'done' })
    }
  }

  onEvent(cb: (e: KernelEvent) => void): () => void {
    return this.emitter.on(cb)
  }

  private async recover(sessionId: string, s: SessionState): Promise<void> {
    const r = s.recovery
    const epoch = r.epoch
    const reason = r.reason ?? 'output_limit'
    const recoveryProvider=s.selection?.model?.providerID??this.provider
    s.expectUserIdentity=false
    // Defer beyond the idle callback; never submit while the native turn is still active.
    await Promise.resolve()
    if (this.disposed || r.cancelled || s.recovery.epoch !== epoch || !r.running) { r.running = false; return }
    if (s.pendingPermissions.size || s.pendingQuestions.size) { r.pending = true; r.running = false; return }
    const attempt = ++r.attempts
    r.progress = false
    this.emitter.emit({ sessionId, type: 'status', text: 'recovering', detail: `Recovery ${attempt}/2: checking saved work and splitting the remaining task into smaller steps.`, input: { attempt, reason, strategy: 'checkpoints_smaller_units', model: s.selection?.model?.modelID??this.model, ...(recoveryProvider === HOSTED_PROVIDER ? { reasoningEffort: 'low' } : {}) } })
    s.awaitingAssistant = true
    try {
      await this.request(s.server, 'POST', `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
        ...(s.selection?.model ? {model:s.selection.model} : this.provider ? { model: { providerID: this.provider, modelID: this.model } } : {}),
        ...(s.selection?.agent?{agent:s.selection.agent}:{}),
        ...(recoveryProvider === HOSTED_PROVIDER ? { variant: 'humanstudy-recovery' } : s.selection?.variant?{variant:s.selection.variant}:{}),
        parts: [{ type: 'text', text: `[HumanStudy automatic recovery ${attempt}/2: ${reason === 'invalid_tool_call' ? 'the previous tool call had malformed arguments and may not have executed' : 'the previous model response exhausted its generation budget'}; this is not a new research request.]
Keep the original user's task and all scientific requirements. First inspect existing files and validation results to establish what actually completed. Do not assume an interrupted tool call wrote a file. Do not repeat completed actions or rerun simulations, submissions, uploads or other external actions. Existing permission and simulation approval requirements still apply.
Adjust the execution plan: finish the smallest coherent pending unit, save and validate it, then advance one unit at a time. For a large human program, use small complete JSON batches and program_io.py when available, or separate complete intermediate files per study/section, and assemble the final schema-valid program.json from those files. Preserve every required detail, verbatim quotation and source reference; split the work rather than shorten or omit content. Do not overwrite valid existing work unnecessarily or announce a plan and ask permission to start again. Act on the task already authorized; ask only for genuinely missing research decisions. If a tool invocation was incomplete, construct a smaller valid invocation after checking the filesystem.
${attempt === 2 ? 'The first adjusted attempt was interrupted again but made progress. Further reduce the size of each write/tool call and complete the remaining units from saved checkpoints.' : 'Avoid spending the whole response thinking through the entire paper before making the first checkpoint.'}` }],
      })
    } catch (err) {
      if (!this.disposed && !r.cancelled && s.recovery.epoch === epoch) {
        this.emitter.emit({ sessionId, type: 'error', text: `Automatic recovery could not start: ${String(err)}. Saved work has been kept.` })
        s.inFlight = false
        this.emitter.emit({ sessionId, type: 'done' })
      }
    } finally { r.running = false }
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

  private autoReplies = new Set<string>()
  setPermissionMode(mode: 'ask' | 'project'): void {
    this.permission = mode
    if (mode !== 'project') return
    for (const [sid, s] of this.sessions) for (const p of s.pendingPermissions.values()) {
      if (isInsideProject(s.server.dir, p)) this.autoApprove(sid, s, p)
    }
  }
  private autoApprove(sessionId: string, s: SessionState, perm: KernelPermission): void {
    if (this.autoReplies.has(perm.id)) return
    this.autoReplies.add(perm.id)
    // One call only: an Auto approval must not become a permanent native permission
    // grant that would silently survive switching Auto off.
    this.replyTo(s.server, sessionId, perm.id, 'once').then(() => {
      s.pendingPermissions.delete(perm.id)
      this.emitter.emit({ sessionId, type: 'permission', permission: { ...perm, automatic: true, resolved: 'once' } })
    }, () => this.emitter.emit({ sessionId, type: 'permission', permission: perm }))
      .finally(() => this.autoReplies.delete(perm.id))
  }

  private permissionMode(): 'ask' | 'project' {
    return this.permission ?? (process.env.HUMANSTUDY_PERMISSION === 'ask' ? 'ask' : 'project')
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

  private configContent(transport?: { baseURL: string; token: string }): string {
    const model = this.provider ? `${this.provider}/${this.model}` : undefined
    // The fork bakes in the humanstudy provider, its models and the share/autoupdate/telemetry defaults.
    // Here only what the app decides per run: the chosen model (inline config outranks any config file)
    // and edit/bash approval, which the app answers (user prompt, or auto-approval in the project, see handle()).
    const cfg: Record<string, unknown> = {
      $schema: 'https://opencode.ai/config.json',
      ...(model ? { model, small_model: model } : {}), // small_model: otherwise titles go to opencode's own default
      permission: { edit: 'ask', bash: BASH_PERMISSION, external_directory: 'ask' },
    }
    if (this.provider === HOSTED_PROVIDER) {
      cfg.provider = { [HOSTED_PROVIDER]: { ...(transport ? { options: { baseURL: transport.baseURL, apiKey: transport.token } } : {}), models: { [this.model]: {
        ...(!BAKED_HOSTED_MODELS.includes(this.model) ? { name: this.model, tool_call: true } : {}),
        variants: { 'humanstudy-recovery': { reasoningEffort: 'low' } },
      } } } }
    }
    // Developer path only (HUMANSTUDY_DEV_KEYS=1): the key stays in the env, opencode substitutes it.
    if (this.provider === 'openrouter') cfg.provider = { openrouter: { options: { apiKey: '{env:OPENROUTER_API_KEY}' } } }
    return JSON.stringify(cfg)
  }

  /** Env for the kernel process: its own XDG dirs, so ~/.config/opencode and ~/.local/share/opencode of
   *  a personal install are never read, and sessions persist under <home>/data per project. */
  private kernelEnv(password: string, transport?: { baseURL: string; token: string }): NodeJS.ProcessEnv {
    const xdg = {
      XDG_CONFIG_HOME: join(this.home, 'config'),
      XDG_DATA_HOME: join(this.home, 'data'),
      XDG_CACHE_HOME: join(this.home, 'cache'),
      XDG_STATE_HOME: join(this.home, 'state'),
    }
    for (const d of Object.values(xdg)) mkdirSync(d, { recursive: true })
    // The managed research runtime (Python, PDF tools) goes first on PATH, so `python3` / `pdftotext` in the
    // agent's bash resolve there and never to the system Python (HUMANSTUDY_RUNTIME_BIN is set by the app).
    const env: NodeJS.ProcessEnv = kernelRuntimeEnv({
      ...process.env,
      ...xdg,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CONFIG_CONTENT: this.configContent(transport),
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_CLAUDE_CODE_PROMPT: '1', // no ~/.claude/CLAUDE.md from the user's own Claude Code
      // humanstudy_llm (simulations) defaults to the model the researcher selected.
      ...(this.provider === HOSTED_PROVIDER ? { HUMANSTUDY_MODEL: this.model } : {}),
    })
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
    const transport = this.provider === HOSTED_PROVIDER && process.env.HUMANSTUDY_DESKTOP_KEY ? await startRequestTransport({
      project: dir,
      upstream: process.env.HUMANSTUDY_HOSTED_BASEURL || 'https://humanstudy-hub.com/api/desktop/v1',
      key: process.env.HUMANSTUDY_DESKTOP_KEY,
      bypass: process.env.HUMANSTUDY_SERVER_BYPASS,
      onAdjust: () => {
        for (const [id, state] of this.sessions) if (state.server.dir === dir && state.inFlight)
          this.emitter.emit({ sessionId: id, type: 'status', text: 'Preparing source context', detail: 'Full source files are kept locally and can be reopened for verification.' })
      },
    }) : undefined
    if (this.disposed) { transport?.close(); throw new Error('kernel disposed') }
    // Packaged Electron pages send file:// as their WebSocket origin. PTY access still
    // requires a single-use ticket issued through the authenticated main process.
    const proc = spawn(this.binary, ['serve', '--port', String(port), '--hostname', '127.0.0.1', '--cors', 'file://'], {
      cwd: dir,
      env: this.kernelEnv(password, transport),
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
      eventsOnline: false,
      transport,
    }
    this.live.add(server)
    const keep = (chunk: Buffer): void => {
      server.stderrTail = (server.stderrTail + chunk.toString()).slice(-2000)
    }
    proc.stdout?.on('data', keep)
    proc.stderr?.on('data', keep)
    proc.on('exit', (code) => {
      transport?.close()
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
      transport?.close()
      server.exited = true
    })

    try {
      await this.waitReady(server)
      server.connected = this.openEvents(server)
      await server.connected
    } catch (err) {
      transport?.close()
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
      srv.transport?.close()
      srv.sse.abort()
      if (!srv.exited) srv.proc.kill(sig)
    }
  }

  private async request(server: Server, method: string, path: string, body?: unknown, timeoutMs = 15_000, extraHeaders?: Record<string,string>): Promise<Response> {
    const res = await fetch(server.base + path, {
      method,
      headers: {
        authorization: server.auth,
        ...extraHeaders,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      const msg = (await res.text().catch(() => ''))
      throw new Error(`opencode ${method} ${path} -> ${res.status} ${msg}`)
    }
    return res
  }

  // ---- SSE ----------------------------------------------------------------------------

  /** Repair observation only. Never retry prompts, tools, uploads or simulations here. */
  private beginCatchup(server: Server): void {
    this.catchingUp.add(server)
    if (this.syncLoops.has(server)) return
    this.syncLoops.add(server)
    void (async () => {
      let failures = 0
      try {
        while (!this.disposed && !server.exited && !server.sse?.signal.aborted) {
          if (![...this.sessions.values()].some(s => s.server === server && s.inFlight)) break
          try { await this.restoreSnapshot(server); failures = 0 }
          catch {
            if (++failures >= 5) {
              for (const [sessionId, s] of this.sessions) {
                if (s.server !== server || !s.inFlight) continue
                s.recovery.cancelled = true
                s.recovery.pending = false
                s.inFlight = false
                this.emitter.emit({ sessionId, type: 'error', text: 'The connection could not be restored. Received messages and saved files are kept. The study may still be running; reopen this conversation to check its state before sending the task again.' })
                this.emitter.emit({ sessionId, type: 'done' })
              }
              break
            }
          }
          if ([...this.sessions.values()].some(s => s.server === server && s.inFlight)) await sleep(this.reconnectIntervalMs)
        }
      } finally { this.syncLoops.delete(server); this.catchingUp.delete(server) }
    })()
  }

  private async restoreSnapshot(server: Server): Promise<void> {
    const active = [...this.sessions].filter(([, s]) => s.server === server && s.inFlight)
      .map(([id, s]) => ({ id, s, epoch: s.recovery.epoch }))
    const [statusRes, permissionsRes, questionsRes] = await Promise.all([
      this.request(server, 'GET', '/session/status', undefined, 5000),
      this.request(server, 'GET', '/permission', undefined, 5000),
      this.request(server, 'GET', '/question', undefined, 5000),
    ])
    const statuses = await statusRes.json() as Record<string, { type?: string; message?: string }>
    const permissions = await permissionsRes.json() as Array<Record<string, any>>
    const questions = await questionsRes.json() as Array<{ id: string; sessionID: string; questions: KernelQuestion['questions'] }>
    for (const { id: sessionId, s, epoch } of active) {
      const response = await this.request(server, 'GET', `/session/${encodeURIComponent(sessionId)}/message`, undefined, 5000)
      const messages = await response.json() as NativeMessage[]
      if (!s.inFlight || this.sessions.get(sessionId) !== s || s.recovery.epoch !== epoch || this.disposed) continue
      const current = messages.filter(({ info }) => info?.id && !s.turnBaseline.has(info.id))
      for (const { info, parts } of current) {
        // Parts must precede completion: the recovery progress gate needs visible
        // text or a successful tool, and usage must not suppress the final text.
        this.handle({ type: 'message.updated', properties: { info: { ...info, sessionID: sessionId, time: { ...info.time, completed: undefined } } } })
        for (const part of parts ?? []) {
          if (part.type === 'text' && part.id) s.snapshotParts.add(part.id)
          this.handle({ type: 'message.part.updated', properties: { part: { ...part, sessionID: sessionId, messageID: info.id } } })
        }
        this.handle({ type: 'message.updated', properties: { info: { ...info, sessionID: sessionId } } })
        if (info.error && !s.failed) this.handle({ type: 'session.error', properties: { sessionID: sessionId, error: info.error } })
      }
      const pendingPermissions = permissions.filter(p => p.sessionID === sessionId)
      for (const p of pendingPermissions) if (!s.pendingPermissions.has(String(p.id))) this.handle({ type: 'permission.asked', properties: p })
      const pendingQuestions = questions.filter(q => q.sessionID === sessionId)
      for (const q of pendingQuestions) this.handle({ type: 'question.asked', properties: q })
      const status = statuses[sessionId]
      const latest = current.filter(m => m.info.role === 'assistant').at(-1)?.info
      if ((!status || status.type === 'idle') && !pendingPermissions.length && !pendingQuestions.length && !s.awaitingAssistant && (latest?.time?.completed || s.failed)) {
        this.handle({ type: 'session.idle', properties: { sessionID: sessionId } })
      } else if (status && status.type !== 'idle') {
        this.handle({ type: 'session.status', properties: { sessionID: sessionId, status } })
      }
    }
  }

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
              if (data.type === 'server.connected') {
                server.eventsOnline = true
                if (first) { first = false; resolve() }
              }
              // Once a stream has a gap, use absolute saved parts for the rest of
              // this turn. Replaying relative deltas over a snapshot duplicates text.
              if (this.catchingUp.has(server) && /^(message\.|session\.(idle|status)$)/.test(data.type)) return
              this.handle(data)
            })
          } catch (err) {
            if (server.sse.signal.aborted) break
            if (first) return reject(err as Error)
          }
          if (!server.exited && !this.disposed && !server.sse.signal.aborted) {
            server.eventsOnline = false
            for (const [sessionId, s] of this.sessions) if (s.server === server && s.inFlight)
              this.emitter.emit({ sessionId, type: 'status', text: 'reconnecting' })
            this.beginCatchup(server)
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
      buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, '\n')
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
      case 'question.asked':
        s.pendingQuestions.add(p.id)
        s.inFlight = true
        emit({ type: 'question', question: { id: p.id, questions: p.questions ?? [] } })
        return
      case 'question.replied':
        s.pendingQuestions.delete(p.requestID)
        emit({ type: 'question', question: { id: p.requestID, questions: [], answers: p.answers, resolved: 'answered' } })
        return
      case 'question.rejected':
        s.pendingQuestions.delete(p.requestID)
        s.recovery.cancelled = true; s.recovery.pending = false
        emit({ type: 'question', question: { id: p.requestID, questions: [], resolved: 'rejected' } })
        return

      case 'message.updated': {
        const info = p.info
        if(info?.role==='user'&&s.expectUserIdentity&&s.inFlight&&!s.roles.has(info.id)){
          s.expectUserIdentity=false
          emit({type:'identity',detail:info.id})
        }
        if (info?.role === 'assistant' && !s.roles.has(info.id)) {
          s.awaitingAssistant = false
          s.recovery.running = false
          // Native may repair a malformed call itself. Keep that failure pending until
          // a real tool succeeds, rather than mistaking another promise to act for a repair.
          if (s.recovery.reason !== 'invalid_tool_call') s.recovery.pending = false
          s.recovery.assistantId = info.id
        }
        if (info?.id && info.role) s.roles.set(info.id, info.summary ? 'summary' : info.role)
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
        // Usage and finish can arrive separately; deduplicating usage must not hide a late limit.
        if (info?.role === 'assistant' && info.time?.completed && info.finish && !s.finishSent.has(info.id)) {
          s.finishSent.add(info.id)
          if (info.finish === 'length' && !info.error) {
            const r = s.recovery
            if (s.inFlight && !r.cancelled && info.id === r.assistantId && !s.turnBaseline.has(info.id)) {
              r.pending = true
              r.reason = 'output_limit'
            } else if (!s.inFlight || r.cancelled) {
              emit({ type: 'error', text: 'The model reached its response limit. All received output and saved files have been kept. This inactive or stopped request was not retried.' })
            }
          }
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
        if (s.snapshotParts.has(p.partID)) return
        const type = s.partTypes.get(p.partID)
        const role = s.roles.get(p.messageID)
        if (role === 'user' || role === 'summary') return
        if (type ? type !== 'text' : role !== 'assistant') return // skip reasoning etc.
        s.emitted.set(p.partID, (s.emitted.get(p.partID) ?? 0) + p.delta.length)
        if (p.delta.trim()) s.recovery.progress = true
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
            if (full.slice(shown).trim()) s.recovery.progress = true
            emit({ type: 'text', text: full.slice(shown) })
          }
        } else if (part.type === 'tool') {
          const st = part.state ?? {}
          const status: string = st.status ?? 'pending'
          const detail =
            status === 'error' ? String(st.error ?? '') : toolDetail(part.tool, st.title, st.input)
          // Re-emit when the input arrives (command, path) even if the status did not change.
          const key = `${status}\n${detail}`
          if (s.toolStatus.get(part.id) === key) return
          s.toolStatus.set(part.id, key)
          const done = status === 'completed' || status === 'error'
          // `invalid` is OpenCode's synthetic tool for a malformed model invocation; it
          // did not perform the requested write. Recover only if native stops here.
          const malformed = part.tool === 'invalid' && done
          if (malformed && s.inFlight && !s.recovery.cancelled && part.messageID === s.recovery.assistantId) {
            s.recovery.reason = 'invalid_tool_call'
            s.recovery.pending = true
          } else if (status === 'completed' && part.tool !== 'invalid' && !s.turnBaseline.has(part.messageID)) {
            s.recovery.progress = true
            if (s.recovery.reason === 'invalid_tool_call') s.recovery.pending = false
          }
          const out = status === 'error' ? st.error : st.output
          emit({
            type: 'tool',
            tool: part.tool,
            text: status,
            detail,
            input: st.input,
            output: done && out != null ? (typeof out === 'string' ? out : JSON.stringify(out)) : undefined,
          })
        }
        return
      }

      case 'session.status': {
        const st = p.status ?? {}
        if (st.type === 'idle') return // session.idle handles completion
        emit({ type: 'status', text: s.recovery.attempts > 0 && !s.recovery.cancelled ? 'recovering' : st.type, detail: st.message })
        return
      }

      case 'session.idle':
        if (!s.inFlight) return // opencode repeats idle; only one `done` per turn
        if (s.recovery.running && !s.recovery.cancelled) return
        if (s.recovery.pending && !s.recovery.cancelled) {
          // Waiting for a researcher is not a model failure. Never auto-answer or bypass it.
          if (s.pendingPermissions.size || s.pendingQuestions.size) return
          const r = s.recovery
          if (r.attempts >= 2 || (r.attempts > 0 && !r.progress)) {
            r.pending = false
            emit({ type: 'error', text: `Automatic recovery stopped after ${r.attempts} adjusted attempt(s). ${!r.progress ? 'The adjusted attempt produced no visible output or successful tool action. ' : ''}All received output and saved files have been kept. No further automatic requests will be sent.` })
            s.inFlight = false
            emit({ type: 'done' })
            return
          }
          s.recovery.pending = false
          s.recovery.running = true
          void this.recover(sessionId, s)
          return
        }
        s.inFlight = false
        s.pendingPermissions.clear()
        // Retain offsets/status IDs: late full snapshots must not repeat a finished turn.
        emit({ type: 'done' })
        return

      case 'session.error': {
        s.failed = true
        s.awaitingAssistant = false
        s.recovery.pending = false
        s.recovery.cancelled = true
        const err = p.error ?? {}
        if (err.name === 'MessageAbortedError') emit({ type: 'status', text: 'aborted' })
        else emit({ type: 'error', text: err.data?.message ?? err.name ?? 'unknown error' })
        return
      }

      case 'permission.asked': {
        const perm = toKernelPermission(p)
        if (!perm) return
        s.pendingPermissions.set(perm.id, perm)
        if (this.permissionMode() === 'project' && isInsideProject(s.server.dir, perm)) {
          this.autoApprove(sessionId, s, perm)
          return
        }
        emit({ type: 'permission', permission: perm })
        return
      }

      case 'permission.replied': {
        if (p.requestID) s.pendingPermissions.delete(p.requestID)
        if ((p.reply ?? p.response) === 'reject') { s.recovery.cancelled = true; s.recovery.pending = false }
        const reply = p.reply ?? p.response
        if (p.requestID && (reply === 'once' || reply === 'always' || reply === 'reject'))
          emit({ type: 'permission', permission: { id: p.requestID, type: '', resolved: reply, ...(this.autoReplies.has(p.requestID) ? { automatic: true } : {}) } })
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
  return { id: p.id, type: p.permission ?? 'unknown', title, patterns, metadata: md }
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

/** One line for a tool row: a bash call shows its command (the title is only the description). */
export function toolDetail(tool: string, title: unknown, input: unknown): string {
  if (tool === 'bash' && input && typeof input === 'object') {
    const c = (input as Record<string, unknown>).command
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return (typeof title === 'string' && title) || summarizeInput(input)
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object' || Object.keys(input).length === 0) return ''
  const o = input as Record<string, unknown>
  for (const k of ['filePath', 'path', 'command', 'pattern', 'url', 'description']) {
    if (typeof o[k] === 'string') return (o[k] as string)
  }
  return JSON.stringify(o)
}

function redact(s: string): string {
  for (const key of [process.env.OPENROUTER_API_KEY, process.env.HUMANSTUDY_DESKTOP_KEY, process.env.HUMANSTUDY_SERVER_BYPASS]) {
    if (key) s = s.split(key).join('[redacted]')
  }
  return s
}

export const HOSTED_PROVIDER = 'humanstudy'
