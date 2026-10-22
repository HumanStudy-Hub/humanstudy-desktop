import type { NativeRequest } from '../shared/native'
import type { KernelQuestion } from '../shared/question'
// Contract for the kernel bridge implemented in ./kernel (owned by another agent).
export type KernelEventType = 'identity' | 'text' | 'tool' | 'status' | 'done' | 'error' | 'permission' | 'usage' | 'title' | 'question'

export type PermissionReply = 'once' | 'always' | 'reject'

/** A tool permission the agent is waiting on (opencode `permission.asked`). */
export interface KernelPermission {
  automatic?: boolean
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
  /** Native ids, when reported by the kernel. */
  toolCallId?: string
  messageId?: string
  type: KernelEventType
  text?: string
  tool?: string
  detail?: string
  /** type 'permission' */
  permission?: KernelPermission
  question?: KernelQuestion
  /** type 'usage' */
  usage?: KernelUsage
  /** type 'tool': the complete tool input, without a size-based clipping fallback. */
  input?: unknown
  /** type 'tool', once finished: the complete tool output (or error text). */
  output?: string
}

export interface Kernel {
  directory?(sessionId: string): string
  native?(sessionId: string, request: NativeRequest): Promise<unknown>

  setPermissionMode?(mode: 'ask' | 'project'): void
  startSession(projectDir: string): Promise<string>
  send(sessionId: string, text: string): Promise<void>
  abort(sessionId: string): Promise<void>
  reply(sessionId: string, permissionId: string, response: PermissionReply): Promise<void>
  answerQuestion(sessionId: string, questionId: string, answers: string[][]): Promise<void>
  rejectQuestion(sessionId: string, questionId: string): Promise<void>
  questions(sessionId: string): Promise<KernelQuestion[]>
  resumeSession(projectDir: string, sessionId: string): Promise<string | null>
  onEvent(cb: (e: KernelEvent) => void): void | (() => void)
}
