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
import { AttentionNotificationTracker } from './notifications-core'

export interface NotificationHostDisplay {
  label: string
  installationId?: string
  isPrimary: boolean
}

export interface NotificationManagerDependencies {
  hostDisplay(serverId: string): NotificationHostDisplay
  isSessionFocused(serverId: string, sessionId: string): boolean
  openRoute(route: string): void
}

class NotificationsStore {
  private tracker = new AttentionNotificationTracker()
  private stopCurrent: (() => void) | null = null

  start(deps: NotificationManagerDependencies): () => void {
    this.stop()
    const stopEvents = subscribeAllHosts('attention.snapshotChanged', (serverId, { entries }) => {
      this.consumeSnapshot(serverId, entries, deps)
    })
    const stopStatus = serverConnections.onStatusChange((serverId, status) => {
      if (status === 'connected') void this.seedHost(serverId, deps)
      else this.tracker.prepareForReconnect(serverId)
    })
    const stopRemoval = onServerRemoving((server) => this.tracker.dropHost(server.id))
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
    try {
      const entries = await serverConnections.apiFor(serverId).listAttention()
      this.consumeSnapshot(serverId, entries, deps)
    } catch {}
  }

  private consumeSnapshot(
    serverId: string,
    entries: AttentionEntry[],
    deps: NotificationManagerDependencies,
  ): void {
    const candidates = this.tracker.applySnapshot(serverId, entries, deps.isSessionFocused)
    for (const candidate of candidates) void this.deliver(candidate.serverId, candidate.entry, deps)
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
