import { SvelteMap } from 'svelte/reactivity'
import type { HostApi } from '@solus/client-core/host-api'
import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { SessionSuggestion, SessionSuggestRequest, SuggestionDecision } from '@solus/contracts/session-suggestions'
import type { IpcContext } from '@solus/contracts/types'
import { toasts } from '../../lib/toasts'

/** Where one session's suggestions are read and changed: its host and the context its calls carry. */
export interface SuggestionTarget {
  serverId: string
  sessionId: string
  api: HostApi
  ctx: IpcContext
}

function keyOf(serverId: string, sessionId: string): string {
  return `${serverId}|${sessionId}`
}

/**
 * The suggestions of each session a mounted conversation shows
 * (docs/plans/custom-roles.md §7). The host owns them; this store keeps what it
 * answered and reads it again on `session.suggestionsChanged`. A read that a newer
 * read overtook is dropped, so a slow answer never replaces a newer one.
 */
export class SuggestionsStore {
  readonly lists = new SvelteMap<string, SessionSuggestion[]>()
  private readonly targets = new Map<string, SuggestionTarget>()
  private readonly reads = new Map<string, number>()
  private stopWatching: (() => void) | null = null

  listFor(serverId: string | null | undefined, sessionId: string | null | undefined): SessionSuggestion[] {
    if (!serverId || !sessionId) return []
    return this.lists.get(keyOf(serverId, sessionId)) ?? []
  }

  /** Read once for a mounted conversation; later changes arrive as events. */
  ensure(target: SuggestionTarget): void {
    this.watch()
    const key = keyOf(target.serverId, target.sessionId)
    this.targets.set(key, target)
    if (!this.lists.has(key) && !this.reads.has(key)) void this.refresh(key)
  }

  async suggest(target: SuggestionTarget, request: SessionSuggestRequest): Promise<boolean> {
    try {
      await target.api.sessionSuggest(target.ctx, request)
      this.ensure(target)
      await this.refresh(keyOf(target.serverId, target.sessionId))
      return true
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : "Couldn't send the suggestion")
      return false
    }
  }

  async decide(target: SuggestionTarget, suggestionId: string, decision: SuggestionDecision): Promise<void> {
    try {
      const done = await target.api.sessionSuggestionDecide(target.ctx, suggestionId, decision)
      if (!done) toasts.info('Someone already decided this suggestion.')
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : decision === 'send' ? "Couldn't send the suggestion" : "Couldn't dismiss the suggestion")
    }
    await this.refresh(keyOf(target.serverId, target.sessionId))
  }

  async withdraw(target: SuggestionTarget, suggestionId: string): Promise<void> {
    try {
      await target.api.sessionSuggestionWithdraw(target.ctx, suggestionId)
    } catch (error) {
      toasts.error(error instanceof Error ? error.message : "Couldn't withdraw the suggestion")
    }
    await this.refresh(keyOf(target.serverId, target.sessionId))
  }

  private watch(): void {
    if (this.stopWatching) return
    this.stopWatching = subscribeAllHosts('session.suggestionsChanged', (serverId, { sessionId }) => {
      const key = keyOf(serverId, sessionId)
      if (this.targets.has(key)) void this.refresh(key)
    })
  }

  private async refresh(key: string): Promise<void> {
    const target = this.targets.get(key)
    if (!target) return
    const read = (this.reads.get(key) ?? 0) + 1
    this.reads.set(key, read)
    try {
      const list = await target.api.sessionSuggestions(target.ctx)
      if (this.reads.get(key) === read) this.lists.set(key, list)
    } catch {
      // A host without suggestions, or a caller it refuses: nothing to show.
      if (this.reads.get(key) === read) this.lists.set(key, [])
    }
  }
}

export const suggestionsStore = new SuggestionsStore()
