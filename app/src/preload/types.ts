// Types shared between preload and renderer (the window.humanstudy bridge).
export type KernelEventType = 'text' | 'tool' | 'status' | 'done' | 'error'
export interface KernelEvent {
  sessionId: string
  type: KernelEventType
  text?: string
  tool?: string
  detail?: string
}

export interface ProjectFile {
  name: string
  /** Absolute path on disk. */
  path: string
  /** hsfile:// URL the renderer can load (iframe, img, fetch). */
  url: string
  ext: string
}

export interface ProjectSnapshot {
  dir: string
  name: string
  program: unknown | null
  programError?: string
  artifacts: ProjectFile[]
  exports: ProjectFile[]
  pdf: ProjectFile | null
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
    onChanged(cb: (dir: string) => void): () => void
  }
  kernel: {
    startSession(projectDir: string): Promise<string>
    send(sessionId: string, text: string): Promise<void>
    abort(sessionId: string): Promise<void>
    onEvent(cb: (e: KernelEvent) => void): () => void
  }
}
