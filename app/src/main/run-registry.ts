// The runs the main process has given model access to: each session's current run relay, and the projects that
// have a run going. Every removal names its owner (review 5, M2): a stopped run whose process exits late closes
// and forgets only its own relay, never the next run's relay registered under the same session or project.
export interface RelayEntry { project: string; close(): Promise<void> }

export class RunRegistry {
  /** Session id -> the relay its latest approval started. */
  readonly relays = new Map<string, RelayEntry>()
  private readonly projects = new Map<string, object>()

  /** A token for the project's one run, or null when a run is already going there. */
  claim(project: string): object | null {
    if (this.projects.has(project)) return null
    const owner = {}
    this.projects.set(project, owner)
    return owner
  }
  /** Free the project, only if `owner` still holds it. */
  release(project: string, owner: object): void {
    if (this.projects.get(project) === owner) this.projects.delete(project)
  }
  busy(project: string): boolean { return this.projects.has(project) }
  register(id: string, entry: RelayEntry): void { this.relays.set(id, entry) }
  /** Forget the session's relay, only if it is still `close`'s relay. */
  forget(id: string, close: () => Promise<void>): void {
    if (this.relays.get(id)?.close === close) this.relays.delete(id)
  }
  /** Close and forget whatever relay the session has now (an explicit abort or Stop). */
  async closeCurrent(id: string): Promise<void> {
    const relay = this.relays.get(id)
    if (relay) { this.relays.delete(id); await relay.close() }
  }
}
