// Kernel contract. Structurally identical to ../kernel-types.ts (owned by the app shell);
// declared here so the kernel folder stands alone.

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

/**
 * One streamed step of an agent turn.
 * - text:   assistant text delta (append `text` to the current reply)
 * - tool:   tool step; `tool` = tool name, `text` = state (pending|running|completed|error),
 *           `detail` = title / input summary / error message
 * - status: session status change (`text` = busy|retry|aborted|permission|...), `detail` optional
 * - done:   the turn finished (session went idle)
 * - error:  the turn failed; `text` = human-readable message
 * - permission: the agent waits for approval (`permission`); answer with `Kernel.reply`. A second
 *           event with the same `permission.id` and `permission.resolved` follows when answered.
 * - usage:  tokens and cost of one finished assistant message (`usage`), sent before `done`
 * - title:  the kernel's own title for the session (`text`)
 */
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
  /** Human-readable name of the implementation ("opencode" or "mock"). */
  readonly name: string
  startSession(projectDir: string): Promise<string>
  send(sessionId: string, text: string): Promise<void>
  abort(sessionId: string): Promise<void>
  /** Answer a `permission` event. Rejects when the request is gone (already answered, session over). */
  reply(sessionId: string, permissionId: string, response: PermissionReply): Promise<void>
  /**
   * Re-attach to a session started earlier (possibly by a previous run of the app). Resolves with the
   * session id when the kernel still has it, null when it is gone and a new one must be started.
   */
  resumeSession(projectDir: string, sessionId: string): Promise<string | null>
  onEvent(cb: (e: KernelEvent) => void): () => void
  dispose(): Promise<void>
}

/** Small listener set shared by both implementations. */
export class Emitter {
  private listeners = new Set<(e: KernelEvent) => void>()

  on(cb: (e: KernelEvent) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  emit(e: KernelEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e)
      } catch {
        // a broken listener must not break the stream
      }
    }
  }

  clear(): void {
    this.listeners.clear()
  }
}
