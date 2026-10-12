// Types shared between preload and renderer (the window.humanstudy bridge).
export type KernelEventType = 'text' | 'tool' | 'status' | 'done' | 'error' | 'permission' | 'usage' | 'title'

export type PermissionReply = 'once' | 'always' | 'reject'

/** A tool permission the agent is waiting on (opencode `permission.asked`). */
export interface KernelPermission {
  /** Pass to `kernel.reply`. */
  id: string
  /** What is being asked for: bash | edit | write | webfetch | external_directory | ... */
  type: string
  /** Short human-readable description (command, file path, URL). */
  title?: string
  patterns?: string[]
  metadata?: Record<string, unknown>
  /** Set on the follow-up event once the request was answered (by the user, auto-approval or elsewhere). */
  resolved?: PermissionReply
}

/** Tokens and cost of one finished assistant message. */
export interface KernelUsage {
  input: number
  output: number
  reasoning?: number
  cost?: number
}
export interface KernelEvent {
  sessionId: string
  type: KernelEventType
  text?: string
  tool?: string
  detail?: string
  /** type 'permission' */
  permission?: KernelPermission
  /** type 'usage' */
  usage?: KernelUsage
}

/** One piece of a thread message; the same shape the agent pane renders. */
export type ThreadPart =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; tool: string; detail?: string; state?: string }
  | { kind: 'error'; text: string }
  | {
      kind: 'permission'
      id: string
      type: string
      title?: string
      patterns?: string[]
      /** Absent while the agent is still waiting for an answer. */
      resolved?: PermissionReply
    }

export interface ThreadMessage {
  id: string
  role: 'user' | 'assistant'
  parts: ThreadPart[]
  /** ISO time the message started. */
  at: string
}

export interface ThreadUsage {
  input: number
  output: number
  cost: number
}

/** A conversation with the agent, stored in <project>/.humanstudy/threads/<id>.json. */
export interface Thread {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** Kernel implementation that holds the session ("opencode" | "mock"). */
  kernel: string
  /** Live kernel session; send/abort/reply on it with window.humanstudy.kernel. Empty until started. */
  kernelSessionId: string
  messages: ThreadMessage[]
  usage: ThreadUsage
  /** Set when the kernel session was lost and a new one was started; the stored transcript is sent as
   *  context with the next prompt. */
  resumedWithContext?: boolean
  /** Who set the title: the first user message, the kernel, or the user. */
  titleSource?: 'auto' | 'kernel' | 'user'
}

/** Thread without its messages, for the list. */
export interface ThreadSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messageCount: number
  usage: ThreadUsage
}

export interface ProjectFile {
  name: string
  /** Absolute path on disk. */
  path: string
  /** hsfile:// URL the renderer can load (iframe, img, fetch). */
  url: string
  ext: string
}

/** One entry of the project file tree (the Program tab). Folders carry children; files carry a url. */
export interface ProjectEntry {
  name: string
  /** Absolute path on disk. */
  path: string
  /** Path relative to the project folder, with forward slashes. */
  rel: string
  kind: 'file' | 'dir'
  ext: string
  url?: string
  size?: number
  children?: ProjectEntry[]
}

export interface ProjectSnapshot {
  dir: string
  name: string
  program: unknown | null
  programError?: string
  artifacts: ProjectFile[]
  exports: ProjectFile[]
  pdf: ProjectFile | null
  /** Everything in the project folder except app/kernel internals (.humanstudy, .opencode, caches). */
  tree: ProjectEntry[]
}

export interface ProjectSummary {
  dir: string
  name: string
  /** ISO time of the most recent change to the project folder. */
  updatedAt: string
  hasPaper: boolean
  hasProgram: boolean
  artifactCount: number
}

export type Theme = 'light' | 'dark' | 'system'
export interface Settings {
  theme: Theme
  /** What Enter does while the agent is running. */
  busyEnter: 'queue' | 'interrupt'
  /** Default permission for new sessions: ask before running commands, or allow inside the project. */
  permission: 'ask' | 'project'
  /** Model id used by the kernel, e.g. anthropic/claude-haiku-5.5. */
  model: string
  /** Folder that holds projects. */
  projectsRoot: string
}
export interface ProviderStatus {
  id: 'openrouter' | 'anthropic' | 'deepseek'
  label: string
  configured: boolean
}

/** A study in the community library (HumanStudy-Bench on GitHub). Only real fields; no invented metrics. */
export interface CommunityStudy {
  id: string
  title: string
  authors: string[]
  year: number | null
  description: string
  contributors: { name: string; github?: string }[]
}
export interface CommunityStudyDetail extends CommunityStudy {
  /** Files in the study folder, e.g. source/materials/*.json, the paper PDF. */
  files: { path: string; size: number; url: string }[]
  /** Recent commits touching the study folder. */
  activity: { sha: string; message: string; author: string; avatarUrl?: string; date: string; url: string }[]
  repoUrl: string
  discussionsUrl: string
}

/** The signed-in HumanStudy Hub account and access to hosted models (no API key needed). */
export interface AccountStatus {
  signedIn: boolean
  email?: string
  /** True once a promo code has been redeemed and a desktop key is held. */
  unlocked: boolean
  keyExpiresAt?: string
  /** Base URL of the HumanStudy Hub server. */
  server: string
  /** Which model access new sessions use: hosted (via the Hub), own key, or none. */
  modelAccess: 'hosted' | 'own-key' | 'none'
}

/** Auto-update state (electron-updater, GitHub Releases). Packaged builds only. */
export interface UpdateStatus {
  /** The running app version. */
  version: string
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error'
  /** Download progress, 0-100. */
  progress?: number
  error?: string
  /** The version being downloaded or ready to install. */
  nextVersion?: string
}

export interface HumanStudyApi {
  projects: {
    list(): Promise<ProjectSummary[]>
    /** Creates a project folder (copying the PDF to paper.pdf when given) and returns its dir. */
    create(input: { name: string; pdfPath?: string; sample?: boolean }): Promise<string>
    pickPdf(): Promise<string | null>
    rename(dir: string, name: string): Promise<string>
    /** Moves the project folder to the Trash. */
    trash(dir: string): Promise<void>
  }
  community: {
    /** The library index; cached, refreshed when online. */
    studies(): Promise<CommunityStudy[]>
    study(id: string): Promise<CommunityStudyDetail>
    /** Creates a local project from the study (paper, materials, description) and returns its dir. */
    fork(id: string): Promise<string>
    openExternal(url: string): Promise<void>
  }
  account: {
    status(): Promise<AccountStatus>
    signIn(email: string, password: string): Promise<AccountStatus>
    /** Creates the account; the user must confirm by email before signing in. */
    signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }>
    signOut(): Promise<AccountStatus>
    /** Redeems a promo code for a desktop key that unlocks hosted models. */
    unlock(code: string): Promise<AccountStatus>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    providers(): Promise<ProviderStatus[]>
    /** Stores the key encrypted with the OS keychain (Electron safeStorage); empty string removes it. */
    setKey(provider: ProviderStatus['id'], key: string): Promise<ProviderStatus[]>
  }
  project: {
    open(): Promise<string | null>
    read(dir: string): Promise<ProjectSnapshot>
    reveal(path: string): Promise<void>
    /** Text of a file inside an opened project (UTF-8, at most 4 MB). */
    readText(path: string): Promise<string>
    /** Writes a file inside an opened project, creating folders as needed. program.json must stay valid JSON. */
    writeText(path: string, text: string): Promise<void>
    onChanged(cb: (dir: string) => void): () => void
  }
  kernel: {
    startSession(projectDir: string): Promise<string>
    send(sessionId: string, text: string): Promise<void>
    abort(sessionId: string): Promise<void>
    /** Answer a `permission` event: once = Allow once, always = Allow for this project, reject = Deny. */
    reply(sessionId: string, permissionId: string, response: PermissionReply): Promise<void>
    onEvent(cb: (e: KernelEvent) => void): () => void
  }
  threads: {
    /** Newest first; threads without messages are not listed. */
    list(dir: string): Promise<ThreadSummary[]>
    get(dir: string, id: string): Promise<Thread>
    /** Starts a kernel session and returns the (still empty) thread; it is saved with its first message. */
    create(dir: string): Promise<Thread>
    /** Re-attaches to the thread's kernel session, or starts a new one (resumedWithContext). Returns the thread with a live kernelSessionId. */
    resume(dir: string, id: string): Promise<Thread>
    rename(dir: string, id: string, title: string): Promise<void>
    delete(dir: string, id: string): Promise<void>
    /** Fires when a thread is created, changes (new message, title, usage) or is deleted. */
    onChanged(cb: (e: { dir: string; id: string }) => void): () => void
  }
  updates: {
    status(): Promise<UpdateStatus>
    check(): Promise<void>
    /** Quits and installs a downloaded update, then relaunches. */
    install(): Promise<void>
    onChange(cb: (s: UpdateStatus) => void): () => void
  }
}

// ---- research data (telemetry) ---------------------------------------------------------
/** The two separate consent choices. Conversation content requires usage events. */
export interface TelemetryConsent {
  /** Usage events: lifecycle, features and panes used, clicks (ids only), timings, agent turn metadata. */
  usage: boolean
  /** Conversation content: the text of messages to and from the agent. */
  content: boolean
}
export interface TelemetryStatus {
  consentVersion: number
  signedIn: boolean
  /** True once the signed-in account has answered the current consent version. */
  decided: boolean
  usage: boolean
  content: boolean
  decidedAt?: string
  /** Events uploaded from this computer since the last deletion. */
  sent: number
  /** Events waiting to be uploaded for the signed-in account. */
  pending: number
  lastSentAt?: string
  lastError?: string
}
/** Exactly the row inserted into public.desktop_events (owner_id is set by the server). */
export interface TelemetryRow {
  id: string
  install_id: string
  session_id: string
  project_id: string | null
  event_type: string
  occurred_at: string
  target: string | null
  duration_ms: number | null
  metadata: Record<string, unknown>
  app_version: string
  platform: 'darwin' | 'win32' | 'linux'
  consent_version: number
}
export interface TelemetryRecent {
  row: TelemetryRow
  status: 'pending' | 'sent' | 'dropped'
}
export interface TelemetryTrackOptions {
  target?: string
  durationMs?: number
  metadata?: Record<string, unknown>
  /** Random project id from .humanstudy/project.json (see telemetry.projectId). */
  projectId?: string
}
export interface TelemetryApi {
  status(): Promise<TelemetryStatus>
  setConsent(consent: TelemetryConsent): Promise<TelemetryStatus>
  /** Queued only when consent allows; conversation.* and consent.* are main-process only. */
  track(type: string, opts?: TelemetryTrackOptions): Promise<void>
  /**
   * Marks `dir` as the open project (null: none) and returns its random research id, created in
   * .humanstudy/project.json when missing; null while usage events are off.
   */
  projectId(dir: string | null): Promise<string | null>
  /** The last 100 events built for upload, newest first, exactly as sent. */
  recent(): Promise<TelemetryRecent[]>
  /** Deletes every desktop_events row owned by the signed-in user and clears the local queue. */
  deleteMyData(): Promise<TelemetryStatus>
  flush(): Promise<TelemetryStatus>
}
export interface HumanStudyApi {
  telemetry: TelemetryApi
}
