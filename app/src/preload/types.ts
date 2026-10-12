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

export interface HumanStudyApi {
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
