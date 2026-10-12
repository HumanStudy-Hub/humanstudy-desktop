// Contract for the kernel bridge implemented in ./kernel (owned by another agent).
export type KernelEventType = 'text' | 'tool' | 'status' | 'done' | 'error'

export interface KernelEvent {
  sessionId: string
  type: KernelEventType
  text?: string
  tool?: string
  detail?: string
}

export interface Kernel {
  startSession(projectDir: string): Promise<string>
  send(sessionId: string, text: string): Promise<void>
  abort(sessionId: string): Promise<void>
  onEvent(cb: (e: KernelEvent) => void): void | (() => void)
}
