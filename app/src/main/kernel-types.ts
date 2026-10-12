// Contract for the kernel bridge implemented in ./kernel (owned by another agent).
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
  /** type 'tool': the full tool input (single strings above 20 KB are truncated with a marker). */
  input?: unknown
  /** type 'tool', once finished: the tool's output (or error text), truncated like `input`. */
  output?: string
}

export interface Kernel {
  startSession(projectDir: string): Promise<string>
  send(sessionId: string, text: string): Promise<void>
  abort(sessionId: string): Promise<void>
  reply(sessionId: string, permissionId: string, response: PermissionReply): Promise<void>
  resumeSession(projectDir: string, sessionId: string): Promise<string | null>
  onEvent(cb: (e: KernelEvent) => void): void | (() => void)
}
