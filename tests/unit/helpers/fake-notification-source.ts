import type { HubNotification, NotificationListRequest, NotificationPage, NotificationStateResult } from '@solus/contracts/notification-hub'
import type { NotificationSourceLink } from '@solus/client-core/notifications/hub-client'
import { HostRpcError } from '@solus/client-core/rpc-error'

/**
 * One source as the hub client sees it, in memory, following the server's rules
 * (plans/015 v2 §4): newest-first pages bound to their filter, and set-style read
 * and archive writes. A test can make it fail, hold its list answers, or be an
 * older host that does not know the hub.
 */
export class FakeNotificationSource {
  readonly items = new Map<string, HubNotification>()
  private readonly changedListeners = new Set<() => void>()
  private readonly reconnectedListeners = new Set<(initialConnection?: boolean) => void>()
  /** Every call throws this while it is set: the source is unreachable. */
  failure: Error | null = null
  /** Writes throw this, once applied, while it is set: the answer was lost. */
  lostAnswer: Error | null = null
  /** An older host: the hub's methods are unknown. */
  isUnsupported = false
  /** While set, list answers wait for it. */
  hold: Promise<void> | null = null
  releases = 0
  calls: string[] = []

  add(notification: Partial<HubNotification> & { id: string; createdAt: number }): HubNotification {
    const full: HubNotification = {
      eventId: `event-${notification.id}`, organizationId: 'local', facts: { kind: 'task.assigned' },
      resource: { kind: 'task', taskId: `task-${notification.id}` }, by: { kind: 'system' },
      summary: { title: notification.id }, readAt: null, archivedAt: null,
      ...notification,
    }
    this.items.set(full.id, full)
    return full
  }

  update(id: string, patch: Partial<HubNotification>): void {
    const current = this.items.get(id)
    if (!current) throw new Error(`no row ${id}`)
    this.items.set(id, { ...current, ...patch })
  }

  emitChanged(): void {
    for (const listener of this.changedListeners) listener()
  }

  emitReconnected(initialConnection = false): void {
    for (const listener of this.reconnectedListeners) listener(initialConnection)
  }

  private guard(method: string): void {
    this.calls.push(method)
    if (this.isUnsupported) throw new HostRpcError(`Unknown method "${method}"`)
    if (this.failure) throw this.failure
  }

  link(): NotificationSourceLink {
    return {
      api: {
        notificationsCapability: async () => { this.guard('notificationsCapability'); return { version: 2 } },
        notificationsList: (request) => this.list(request),
        notificationsCount: async () => {
          this.guard('notificationsCount')
          const unread = [...this.items.values()].filter((item) => item.readAt === null && item.archivedAt === null).length
          return { unread, isCapped: false }
        },
        notificationsSetRead: async ({ id, read }) => this.set('notificationsSetRead', id, { readAt: read ? (this.items.get(id)?.readAt ?? 10_000) : null }),
        notificationsSetArchived: async ({ id, archived }) => this.set('notificationsSetArchived', id, { archivedAt: archived ? (this.items.get(id)?.archivedAt ?? 10_000) : null }),
      },
      onChanged: (listener) => { this.changedListeners.add(listener); return () => this.changedListeners.delete(listener) },
      onReconnected: (listener) => { this.reconnectedListeners.add(listener); return () => this.reconnectedListeners.delete(listener) },
      release: () => { this.releases++ },
    }
  }

  private async list(request: NotificationListRequest): Promise<NotificationPage> {
    this.guard('notificationsList')
    const hold = this.hold
    const view = request.filter?.view ?? 'all'
    const kinds = request.filter?.kinds
    if (hold) await hold
    const sorted = [...this.items.values()]
      .filter((item) => (!kinds?.length || kinds.includes(item.facts.kind))
        && (view === 'archived' ? item.archivedAt !== null : item.archivedAt === null && (view === 'all' || item.readAt === null)))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1))
    const start = request.cursor ? Number(request.cursor) : 0
    const limit = request.limit ?? 50
    return { items: sorted.slice(start, start + limit), cursor: start + limit < sorted.length ? String(start + limit) : null }
  }

  private set(method: string, id: string, patch: Partial<HubNotification>): NotificationStateResult {
    this.guard(method)
    if (!this.items.has(id)) return { ok: false, reason: 'not_found' }
    this.update(id, patch)
    if (this.lostAnswer) throw this.lostAnswer
    return { ok: true, notification: this.items.get(id)! }
  }
}
