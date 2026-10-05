import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { NotificationKind, NotificationView } from '@solus/contracts/notification-hub'
import { NotificationHubClient, type HubSourceState } from '@solus/client-core/notifications/hub-client'
import type { HubRow } from '@solus/client-core/notifications/merge'
import { serverNotificationLink } from '@solus/client-core/notifications/server-link'
import { notificationSources, type NotificationSourceList } from '@solus/client-core/notifications/sources'
import { accountStore } from '../account/account.store.svelte'
import { serversStore } from '../connections/servers.store.svelte'

/**
 * The notifications hub's renderer state (plans/015-notifications-hub.md §6): one
 * engine per signed-in identity over every host and organization home this
 * client reaches, whatever organization the window selected. Delivery of
 * sounds, toasts, and system alerts stays in `notifications.store`; this store
 * holds history and never alerts.
 *
 * The engine writes the `SvelteMap`s below entry by entry, so a row's change
 * invalidates that row alone.
 */
class NotificationHubStore {
  readonly rows = new SvelteMap<string, HubRow>()
  readonly sources = new SvelteMap<string, HubSourceState>()
  readonly pending = new SvelteSet<string>()
  view = $state<NotificationView>('all')
  kinds = $state<NotificationKind[]>([])
  /** Sources the page shows; empty shows every source. */
  sourceIds = $state<string[]>([])
  /** Organization ids two directories list, which no single service answers for. */
  conflicts = $state<string[]>([])
  private client: NotificationHubClient | null = null
  private stopTracking: (() => void) | null = null

  /** The identity a feed is read for: a signed-in account, or this device's own hosts. */
  private get identity(): string {
    const account = accountStore.state
    return account.kind === 'signed-in' ? `account:${account.profile.id}` : 'device'
  }

  private get sourceList(): NotificationSourceList {
    return notificationSources(
      serversStore.servers.map((server) => ({ serverId: server.id, label: server.label, installationId: server.installationId })),
      serversStore.workspaces,
    )
  }

  /** Begin reading; the shells call it once at boot. Answers the stop. */
  start(): () => void {
    if (this.stopTracking) return this.stopTracking
    const onVisible = () => { if (document.visibilityState === 'visible') void this.client?.refresh() }
    document.addEventListener('visibilitychange', onVisible)
    const stopEffects = $effect.root(() => {
      // The engine is outside Svelte; the identity and the source list are synced into it.
      $effect(() => {
        const identity = this.identity
        if (this.client?.identity === identity) return
        this.client?.signOut()
        this.client = new NotificationHubClient({
          identity,
          connect: (source) => serverNotificationLink(source),
          rows: this.rows,
          sources: this.sources,
          pending: this.pending,
        })
        this.client.setFilter(this.filter)
        this.client.setSources(this.sourceList.sources)
      })
      $effect(() => {
        const list = this.sourceList
        this.conflicts = list.conflicts
        this.client?.setSources(list.sources)
      })
    })
    this.stopTracking = () => {
      stopEffects()
      document.removeEventListener('visibilitychange', onVisible)
      this.client?.stop()
      this.client = null
      this.stopTracking = null
    }
    return this.stopTracking
  }

  private get filter() {
    return this.kinds.length ? { view: this.view, kinds: [...this.kinds] } : { view: this.view }
  }

  setView(view: NotificationView): void {
    this.view = view
    this.client?.setFilter(this.filter)
  }

  setKinds(kinds: NotificationKind[]): void {
    this.kinds = kinds
    this.client?.setFilter(this.filter)
  }

  /** Read every source again, as a person asked. */
  refresh(): Promise<void> {
    return this.client?.refresh() ?? Promise.resolve()
  }

  loadMore(): Promise<void> {
    return this.client?.loadMore() ?? Promise.resolve()
  }

  /** The merged rows the page shows, newest first. */
  get entries(): HubRow[] {
    // Read both maps so the derivation tracks them; the engine merges.
    void this.rows.size
    void this.sources.size
    const sourceIds = this.sourceIds.length ? new Set(this.sourceIds) : undefined
    return this.client?.entries(sourceIds) ?? []
  }

  get unreadCount(): { unread: number; isCapped: boolean; isComplete: boolean } {
    void this.sources.size
    for (const state of this.sources.values()) void state.count
    return this.client?.unreadCount() ?? { unread: 0, isCapped: false, isComplete: true }
  }

  get hasMore(): boolean {
    for (const state of this.sources.values()) if (state.hasMore) return true
    return false
  }

  get isLoading(): boolean {
    for (const state of this.sources.values()) if (state.status === 'loading') return true
    return false
  }

  canChange(rowKey: string): boolean {
    void this.pending.size
    for (const state of this.sources.values()) void state.status
    return this.client?.canChange(rowKey) ?? false
  }

  setRead(rowKey: string, read: boolean): Promise<boolean> {
    return this.client?.setRead(rowKey, read) ?? Promise.resolve(false)
  }

  setArchived(rowKey: string, archived: boolean): Promise<boolean> {
    return this.client?.setArchived(rowKey, archived) ?? Promise.resolve(false)
  }
}

export const notificationHubStore = new NotificationHubStore()
