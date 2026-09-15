import { subscribeAllHosts } from '@solus/client-core/host-events'
import { localApi } from '@solus/client-core/local-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { onServerRemoving } from '@solus/client-core/server-registry'
import {
  attentionNotificationDedupKey,
  notificationSessionRoute,
  payloadForAttentionEntry,
  type ClientNotificationRequest,
} from '@solus/contracts/notification-types'
import type { AttentionEntry } from '@solus/contracts/attention-types'
import { toasts } from '../../lib/toasts'
import { requestInputFocus } from '../../lib/inputFocus'
import { createActivityBadge } from './activity-badge'
import { BackgroundActivityTracker, AttentionNotificationTracker } from './notifications-core'

export interface NotificationHostDisplay {
  label: string
  installationId?: string
  isPrimary: boolean
}

export interface NotificationManagerDependencies {
  hostDisplay(serverId: string): NotificationHostDisplay
  isSessionFocused(serverId: string, sessionId: string): boolean
  openRoute(route: string): void
  nativeNotificationsEnabled(): boolean
  backgroundActivityToastsEnabled(): boolean
}

class NotificationsStore {
  private activity = new BackgroundActivityTracker()
  private updateBadge: (sessionKeys: string[]) => void = () => {}
  private generation = 0
  private readonly snapshotRevisions = new Map<string, number>()
  private tracker = new AttentionNotificationTracker()
  private stopCurrent: (() => void) | null = null

  start(deps: NotificationManagerDependencies): () => void {
    this.stop()
    this.generation += 1
    this.updateBadge = createActivityBadge()
    const acknowledge = () => { this.activity.acknowledge(); this.updateBadge([]) }
    const onFocus = () => { if (document.visibilityState === 'visible' && document.hasFocus()) acknowledge() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const stopAcknowledged = localApi.onActivityAcknowledged?.(acknowledge)
    const stopEvents = subscribeAllHosts('attention.snapshotChanged', (serverId, { entries }) => {
      this.snapshotRevisions.set(serverId, (this.snapshotRevisions.get(serverId) ?? 0) + 1)
      this.consumeSnapshot(serverId, entries, deps)
    })
    const stopStatus = serverConnections.onStatusChange((serverId, status) => {
      if (status === 'connected') void this.seedHost(serverId, deps)
      else {
        this.snapshotRevisions.set(serverId, (this.snapshotRevisions.get(serverId) ?? 0) + 1)
        this.tracker.prepareForReconnect(serverId)
        this.activity.prepareForReconnect(serverId)
      }
    })
    const stopRemoval = onServerRemoving((server) => {
      this.snapshotRevisions.set(server.id, (this.snapshotRevisions.get(server.id) ?? 0) + 1)
      this.tracker.dropHost(server.id)
      this.activity.dropHost(server.id)
      this.updateBadge(this.activity.sessionKeys)
    })
    const pushDelivered = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      const detail: { serverId?: string; entryKey?: string } | undefined = event.detail
      if (detail?.serverId && detail.entryKey) {
        this.tracker.markPushDelivered(detail.serverId, detail.entryKey)
      }
    }
    window.addEventListener('solus:push-received', pushDelivered)

    for (const serverId of serverConnections.connectedServerIds()) void this.seedHost(serverId, deps)

    const stop = () => {
      this.generation += 1
      stopAcknowledged?.()
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      this.updateBadge([])
      this.activity = new BackgroundActivityTracker()
      stopEvents()
      stopStatus()
      stopRemoval()
      window.removeEventListener('solus:push-received', pushDelivered)
      this.tracker = new AttentionNotificationTracker()
      if (this.stopCurrent === stop) this.stopCurrent = null
    }
    this.stopCurrent = stop
    return stop
  }

  stop(): void {
    this.stopCurrent?.()
  }

  private async seedHost(serverId: string, deps: NotificationManagerDependencies): Promise<void> {
    const generation = this.generation
    const revision = this.snapshotRevisions.get(serverId) ?? 0
    try {
      const entries = await serverConnections.apiFor(serverId).listAttention()
      if (generation === this.generation && revision === (this.snapshotRevisions.get(serverId) ?? 0) && serverConnections.connectedServerIds().includes(serverId)) {
        this.consumeSnapshot(serverId, entries, deps)
      }
    } catch {}
  }

  private consumeSnapshot(
    serverId: string,
    entries: AttentionEntry[],
    deps: NotificationManagerDependencies,
  ): void {
    const activity = this.activity.applySnapshot(serverId, entries, deps.isSessionFocused)
    if (document.visibilityState === 'visible' && document.hasFocus()) this.activity.acknowledge()
    this.updateBadge(this.activity.sessionKeys)
    if (deps.backgroundActivityToastsEnabled() && document.visibilityState === 'visible' && document.hasFocus()) {
      for (const candidate of activity) {
        const host = deps.hostDisplay(serverId)
        const payload = payloadForAttentionEntry(candidate.entry, host.isPrimary ? {} : { hostLabel: host.label })
        toasts.show({
          id: `activity:${serverId}:${candidate.entry.sessionId}`,
          message: payload.title,
          description: payload.body,
          action: { label: 'Open session', onAction: () => {
            deps.openRoute(notificationSessionRoute(candidate.entry.sessionId, serverId))
            requestInputFocus()
          } },
        })
      }
    }
    const candidates = this.tracker.applySnapshot(serverId, entries, deps.isSessionFocused)
    if (deps.nativeNotificationsEnabled()) {
      for (const candidate of candidates) void this.deliver(candidate.serverId, candidate.entry, deps).catch(() => {})
    }
  }

  private async deliver(
    serverId: string,
    entry: AttentionEntry,
    deps: NotificationManagerDependencies,
  ): Promise<void> {
    const host = deps.hostDisplay(serverId)
    const hostId = host.installationId ?? serverId
    const payloadOptions: NonNullable<Parameters<typeof payloadForAttentionEntry>[1]> = {}
    if (host.installationId) payloadOptions.installationId = host.installationId
    if (!host.isPrimary) payloadOptions.hostLabel = host.label
    const payload = payloadForAttentionEntry(entry, payloadOptions)
    const route = notificationSessionRoute(entry.sessionId, serverId)
    const request: ClientNotificationRequest = {
      ...payload,
      route,
      dedupKey: attentionNotificationDedupKey(hostId, entry),
    }

    let displayed = false
    if (localApi.showNotification !== undefined) {
      displayed = await localApi.showNotification(request)
    } else {
      displayed = await showBrowserNotification(request, () => deps.openRoute(route))
    }
    if (displayed) await markSeenByServiceWorkers(request.dedupKey)
  }
}

async function markSeenByServiceWorkers(dedupKey: string): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    for (const registration of registrations) {
      registration.active?.postMessage({ type: 'solus:attention-seen', dedupKey })
    }
  } catch {}
}

async function showBrowserNotification(
  request: ClientNotificationRequest,
  onClick: () => void,
): Promise<boolean> {
  if (!globalThis.Notification || globalThis.Notification.permission !== 'granted') return false
  try {
    const notification = new globalThis.Notification(request.title, {
      body: request.body,
      tag: request.dedupKey,
      data: request,
    })
    notification.onclick = () => {
      window.focus()
      notification.close()
      onClick()
    }
    return true
  } catch {
    if (!('serviceWorker' in navigator)) return false
    try {
      const registration = await navigator.serviceWorker.ready
      await registration.showNotification(request.title, {
        body: request.body,
        tag: request.dedupKey,
        data: request,
      })
      return true
    } catch {
      return false
    }
  }
}

export const notificationsStore = new NotificationsStore()
