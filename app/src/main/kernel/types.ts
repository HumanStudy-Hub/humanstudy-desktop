// Kernel contract. Structurally identical to ../kernel-types.ts (owned by the app shell);
// declared here so the kernel folder stands alone.

export type KernelEventType = 'text' | 'tool' | 'status' | 'done' | 'error'

/**
 * One streamed step of an agent turn.
 * - text:   assistant text delta (append `text` to the current reply)
 * - tool:   tool step; `tool` = tool name, `text` = state (pending|running|completed|error),
 *           `detail` = title / input summary / error message
 * - status: session status change (`text` = busy|retry|aborted|permission|...), `detail` optional
 * - done:   the turn finished (session went idle)
 * - error:  the turn failed; `text` = human-readable message
 */
export interface KernelEvent {
  sessionId: string
  type: KernelEventType
  text?: string
  tool?: string
  detail?: string
}

export interface Kernel {
  /** Human-readable name of the implementation ("opencode" or "mock"). */
  readonly name: string
  startSession(projectDir: string): Promise<string>
  send(sessionId: string, text: string): Promise<void>
  abort(sessionId: string): Promise<void>
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
