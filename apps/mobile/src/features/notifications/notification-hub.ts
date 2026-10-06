import type { NotificationView } from '@solus/contracts/notification-hub'
import { NotificationHubClient, type HubSourceState, type HubUnreadCount, type NotificationSource, type NotificationSourceLink } from '@solus/client-core/notifications/hub-client'
import type { HubRow } from '@solus/client-core/notifications/merge'
import { Listeners } from '../../lib/listeners'
import type { HostConnection, HostConnections } from '../hosts/host-connections'
import type { HostRegistry } from '../hosts/host-registry'

/** A map that tells its listeners about each change, so the native screen re-renders. */
class ObservedMap<K, V> extends Map<K, V> {
  constructor(private readonly onChange: () => void) {
    super()
  }

  override set(key: K, value: V): this {
    super.set(key, value)
    this.onChange()
    return this
  }

  override delete(key: K): boolean {
    const deleted = super.delete(key)
    if (deleted) this.onChange()
    return deleted
  }

  override clear(): void {
    super.clear()
    this.onChange()
  }
}

class ObservedSet<V> extends Set<V> {
  constructor(private readonly onChange: () => void) {
    super()
  }

  override add(value: V): this {
    super.add(value)
    this.onChange()
    return this
  }

  override delete(value: V): boolean {
    const deleted = super.delete(value)
    if (deleted) this.onChange()
    return deleted
  }

  override clear(): void {
    super.clear()
    this.onChange()
  }
}

export interface NotificationHubSnapshot {
  view: NotificationView
  entries: HubRow[]
  sources: HubSourceState[]
  unread: HubUnreadCount
  hasMore: boolean
}

export interface NativeNotificationHubDeps {
  registry: HostRegistry
  connections: HostConnections
  /** The signed-in account, or this device alone: a new identity reads a new feed. */
  identity(): string
}

/**
 * The native client's notifications hub (plans/015-notifications-hub.md §6): the
 * shared engine over every host this device knows, read through the host
 * connections the app already holds. It opens no socket and stores nothing.
 */
export class NativeNotificationHub {
  readonly changes = new Listeners()
  private readonly rows = new ObservedMap<string, HubRow>(() => this.changed())
  private readonly sources = new ObservedMap<string, HubSourceState>(() => this.changed())
  private readonly pending = new ObservedSet<string>(() => this.changed())
  private client: NotificationHubClient | null = null
  private view: NotificationView = 'all'
  private cached: NotificationHubSnapshot | null = null
  private historyReaders = 0

  constructor(private readonly deps: NativeNotificationHubDeps) {}

  /** Begin reading; answers the stop. Follows the hosts and the identity as they change. */
  start(identityChanges: Listeners): () => void {
    this.open()
    const stopHosts = this.deps.registry.changes.subscribe(() => this.client?.setSources(this.hostSources()))
    // A source that could not be read is read again once its host is connected.
    const stopConnections = this.deps.connections.changes.subscribe(() => {
      for (const state of this.sources.values()) {
        if (state.status === 'offline' && this.deps.connections.state(state.source.serverId)?.phase === 'connected') void this.client?.refresh(state.source.sourceId)
      }
    })
    const stopIdentity = identityChanges.subscribe(() => {
      if (this.client?.identity !== this.deps.identity()) this.open()
    })
    return () => {
      stopHosts()
      stopConnections()
      stopIdentity()
      this.client?.stop()
      this.client = null
    }
  }

  /** The app came back to the foreground: every source is read again. */
  refresh(): Promise<void> {
    return this.client?.refresh() ?? Promise.resolve()
  }

  loadMore(): Promise<void> {
    return this.client?.loadMore() ?? Promise.resolve()
  }

  /** Native navigation focus owns history; badges keep only the count live. */
  showHistory(): () => void {
    this.historyReaders++
    this.client?.setHistoryVisible(true)
    let released = false
    return () => {
      if (released) return
      released = true
      if (--this.historyReaders === 0) this.client?.setHistoryVisible(false)
    }
  }

  setView(view: NotificationView): void {
    this.view = view
    this.client?.setFilter({ view })
    this.changed()
  }

  canChange(rowKey: string): boolean {
    return this.client?.canChange(rowKey) ?? false
  }

  setRead(rowKey: string, read: boolean): Promise<boolean> {
    return this.client?.setRead(rowKey, read) ?? Promise.resolve(false)
  }

  setArchived(rowKey: string, archived: boolean): Promise<boolean> {
    return this.client?.setArchived(rowKey, archived) ?? Promise.resolve(false)
  }

  /** One stable object per change, as `useSyncExternalStore` needs. */
  snapshot = (): NotificationHubSnapshot => {
    this.cached ??= {
      view: this.view,
      entries: this.client?.entries() ?? [],
      sources: [...this.sources.values()],
      unread: this.client?.unreadCount() ?? { unread: 0, isCapped: false, isComplete: true },
      hasMore: [...this.sources.values()].some((state) => state.hasMore),
    }
    return this.cached
  }

  private changed(): void {
    this.cached = null
    this.changes.notify()
  }

  private open(): void {
    this.client?.signOut()
    this.client = new NotificationHubClient({
      identity: this.deps.identity(),
      connect: (source) => this.link(source.serverId),
      rows: this.rows,
      sources: this.sources,
      pending: this.pending,
    })
    this.client.setFilter({ view: this.view })
    this.client.setHistoryVisible(this.historyReaders > 0)
    this.client.setSources(this.hostSources())
  }

  private hostSources(): NotificationSource[] {
    return this.deps.registry.hosts().map((host) => ({ sourceId: `host:${host.id}`, serverId: host.id, kind: 'host', label: host.label }))
  }

  /**
   * A source read through the app's own connection to the host. A host with no
   * connection answers as unreachable; its listeners attach to the connection
   * once there is one.
   */
  private link(hostId: string): NotificationSourceLink {
    const changed: (() => void)[] = []
    const reconnected: ((initialConnection?: boolean) => void)[] = []
    let hasConnected = this.deps.connections.state(hostId)?.phase === 'connected'
    let attachedTo: HostConnection | null = null
    let detach: (() => void)[] = []
    const attach = (): HostConnection | null => {
      const found = this.deps.connections.connection(hostId)
      if (found && found !== attachedTo) {
        for (const stop of detach) stop()
        detach = [
          ...changed.map((listener) => found.events.subscribe('notifications.changed', () => listener())),
          found.onAccepted(() => {
            const initialConnection = !hasConnected
            hasConnected = true
            for (const listener of reconnected) listener(initialConnection)
          }),
        ]
        attachedTo = found
      }
      return found
    }
    const connection = (): HostConnection => {
      const found = attach()
      if (!found) throw new Error('This host has no connection yet.')
      return found
    }
    const listen = (list: (() => void)[], listener: () => void) => {
      list.push(listener)
      attachedTo = null
      attach()
      return () => { list.splice(list.indexOf(listener), 1) }
    }
    return {
      api: {
        notificationsCapability: () => connection().api.notificationsCapability(),
        notificationsList: (request) => connection().api.notificationsList(request),
        notificationsCount: () => connection().api.notificationsCount(),
        notificationsSetRead: (request) => connection().api.notificationsSetRead(request),
        notificationsSetArchived: (request) => connection().api.notificationsSetArchived(request),
      },
      onChanged: (listener) => listen(changed, listener),
      onReconnected: (listener) => {
        reconnected.push(listener)
        attachedTo = null
        attach()
        return () => { reconnected.splice(reconnected.indexOf(listener), 1) }
      },
      // The app owns the connection; the hub only stops listening.
      release: () => { for (const stop of detach) stop() },
    }
  }
}
