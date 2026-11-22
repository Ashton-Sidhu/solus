import type { SessionTree } from '@solus/contracts/session-digest'
import type { HostApi } from './host-api'
import type { HostEventSubscriber } from './host-event-subscriber'

export interface SessionTreeView {
  /** The last answer. It stays when a read fails, and `stale` says so. Null before the first answer. */
  tree: SessionTree | null
  loading: boolean
  stale: boolean
}

export const EMPTY_SESSION_TREE_VIEW: SessionTreeView = { tree: null, loading: true, stale: false }

export interface SessionTreeWatchOptions {
  api: Pick<HostApi, 'sessionTree'>
  events: HostEventSubscriber
  sessionId: string
  onChange: (view: SessionTreeView) => void
}

/**
 * One session's tree as an open surface shows it (docs/plans/session-digests.md):
 * read from the host that holds the session, and read again when the host says
 * the session or a session below it changed, or a work the tree lists changed.
 * Plain TypeScript for desktop, web, and mobile. It runs only while a surface
 * holds it. Reads never overlap: a change heard during a read makes one more
 * read after it, so the last answer is never older than the last change.
 */
export class SessionTreeWatch {
  private view: SessionTreeView = EMPTY_SESSION_TREE_VIEW
  private stopEvents: (() => void)[] = []
  private reading = false
  private readAgain = false

  constructor(private readonly options: SessionTreeWatchOptions) {}

  start(): void {
    if (this.running) return
    const { events, sessionId } = this.options
    const named = (payload: { sessionId: string }) => {
      if (payload.sessionId === sessionId) void this.refresh()
    }
    this.stopEvents = [
      events.subscribe('session.digestChanged', named),
      events.subscribe('session.artifactsChanged', named),
      // A work's pin, preview, and time show in the tree's artifacts.
      events.subscribe('works.changed', ({ workId }) => {
        if (this.listsWork(workId)) void this.refresh()
      }),
    ]
    void this.refresh()
  }

  stop(): void {
    for (const stop of this.stopEvents) stop()
    this.stopEvents = []
  }

  /** Read the tree again: on a reconnect, which events cannot tell about. */
  async refresh(): Promise<void> {
    if (!this.running) return
    if (this.reading) {
      this.readAgain = true
      return
    }
    this.reading = true
    try {
      const tree = await this.options.api.sessionTree(this.options.sessionId)
      if (this.running) this.update({ tree, loading: false, stale: false })
    } catch {
      if (this.running) this.update({ loading: false, stale: true })
    } finally {
      this.reading = false
      if (this.readAgain) {
        this.readAgain = false
        void this.refresh()
      }
    }
  }

  private get running(): boolean {
    return this.stopEvents.length > 0
  }

  private listsWork(workId: string): boolean {
    return !!this.view.tree?.nodes.some((node) => node.artifacts.some((artifact) => artifact.kind === 'work' && artifact.workId === workId))
  }

  private update(change: Partial<SessionTreeView>): void {
    this.view = { ...this.view, ...change }
    this.options.onChange(this.view)
  }
}
