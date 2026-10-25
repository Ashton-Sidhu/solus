import type { SessionSuggestion, SuggestionDecision } from '@solus/contracts/session-suggestions'
import type { IpcContext } from '@solus/contracts/types'
import type { HostConnection } from '../hosts/host-connections'
import { Listeners } from '../../lib/listeners'

/**
 * One session's suggestions on the phone (docs/plans/custom-roles.md §7): what a
 * guest proposed, read from the host and again on `session.suggestionsChanged`.
 * The phone is a member's or the owner's, never a link guest's, so it decides
 * suggestions; it does not make them.
 */
export class SessionSuggestionsFeed {
  list: readonly SessionSuggestion[] = []
  /** The suggestion a Send or Dismiss is waiting on. */
  deciding: string | null = null
  readonly changes = new Listeners()
  private read = 0
  private readonly stop: () => void

  constructor(
    private readonly connection: HostConnection,
    private readonly sessionId: () => string,
    private readonly context: () => IpcContext,
  ) {
    this.stop = connection.events.subscribe('session.suggestionsChanged', (payload) => {
      if (payload.sessionId === this.sessionId()) void this.refresh()
    })
  }

  async refresh(): Promise<void> {
    const read = ++this.read
    const list = await this.connection.api.sessionSuggestions(this.context()).catch(() => [])
    if (read !== this.read) return
    this.list = list
    this.changes.notify()
  }

  /** Send runs the suggestion as this person's own turn; dismiss removes it and its files. */
  async decide(suggestionId: string, decision: SuggestionDecision): Promise<boolean> {
    if (this.deciding) return false
    this.deciding = suggestionId
    this.changes.notify()
    try {
      return await this.connection.api.sessionSuggestionDecide(this.context(), suggestionId, decision)
    } finally {
      this.deciding = null
      await this.refresh()
    }
  }

  close(): void {
    this.read += 1
    this.stop()
  }
}
