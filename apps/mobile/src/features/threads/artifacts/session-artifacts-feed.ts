import type { SessionArtifacts } from '@solus/contracts/session-artifacts'
import { Listeners } from '../../../lib/listeners'

export type SessionArtifactsState =
  | { kind: 'loading' }
  | { kind: 'ready'; artifacts: SessionArtifacts }
  | { kind: 'error'; message: string }

export interface SessionArtifactsSnapshot {
  readonly state: SessionArtifactsState
  /** The list changed since the person last opened Artifacts. */
  readonly unread: boolean
}

/**
 * What one session produced or linked, as its host lists it
 * (docs/plans/session-artifacts.md). A phone shows one pane, so a new link
 * does not change the screen: it marks the Artifacts entry unread until the
 * person opens Artifacts.
 */
export class SessionArtifactsFeed {
  readonly changes = new Listeners()
  snapshot: SessionArtifactsSnapshot = { state: { kind: 'loading' }, unread: false }
  private viewers = 0
  /** Bumped by each read: an answer for an older read does not land. */
  private reads = 0

  constructor(private readonly read: () => Promise<SessionArtifacts>) {}

  /** Reads the list again. A failed reload keeps the list already shown. */
  async load(): Promise<void> {
    const read = ++this.reads
    if (this.snapshot.state.kind === 'error') this.set({ state: { kind: 'loading' } })
    try {
      const artifacts = await this.read()
      if (read === this.reads) this.set({ state: { kind: 'ready', artifacts } })
    } catch (error) {
      if (read !== this.reads || this.snapshot.state.kind === 'ready') return
      this.set({ state: { kind: 'error', message: error instanceof Error ? error.message : String(error) } })
    }
  }

  /** The host says the list changed: read it again, unread unless Artifacts is open. */
  changed(): Promise<void> {
    if (this.viewers === 0 && !this.snapshot.unread) this.set({ unread: true })
    return this.load()
  }

  /** Artifacts is open; nothing is unread while it is. Returns the close. */
  view(): () => void {
    this.viewers += 1
    if (this.snapshot.unread) this.set({ unread: false })
    return () => { this.viewers -= 1 }
  }

  private set(change: Partial<SessionArtifactsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change }
    this.changes.notify()
  }
}
