import type { HostApi } from './host-api'
import type { SessionHistoryPage, SessionSubagentRequest } from '@solus/contracts/session-history'

export interface SubagentHistoryState {
  phase: 'idle' | 'loading' | 'ready' | 'error'
  /** The pages read so far, oldest first. A failed read keeps them. */
  page: SessionHistoryPage
  error?: string
}

const IDLE: SubagentHistoryState = { phase: 'idle', page: { messages: [], before: null } }

/**
 * The history of one provider subagent, for one open child view. It reads
 * only when asked (open, refresh, earlier pages, retry) and never polls.
 * Reads stay separate from the parent's live feed.
 */
export class SubagentHistoryStore {
  private state = IDLE
  private pending: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly api: Pick<HostApi, 'loadSessionSubagent'>,
    private readonly request: Omit<SessionSubagentRequest, 'before'>,
  ) {}

  read = (): SubagentHistoryState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The newest page, or with `older` the page before the ones read. A read
   *  already in flight answers every call made meanwhile. */
  load(older = false): Promise<void> {
    if (this.pending) return this.pending
    const page = this.state.page
    if (older && !page.before) return Promise.resolve()
    this.set({ phase: 'loading', page })
    this.pending = this.api.loadSessionSubagent({ ...this.request, before: older ? page.before ?? undefined : undefined })
      .then(
        (loaded) => this.set({
          phase: 'ready',
          page: older ? { messages: [...loaded.messages, ...page.messages], before: loaded.before } : loaded,
        }),
        (error) => this.set({ phase: 'error', page, error: error instanceof Error ? error.message : 'Could not read this agent.' }),
      )
      .finally(() => {
        this.pending = null
      })
    return this.pending
  }

  private set(state: SubagentHistoryState): void {
    this.state = state
    for (const listener of this.listeners) listener()
  }
}
