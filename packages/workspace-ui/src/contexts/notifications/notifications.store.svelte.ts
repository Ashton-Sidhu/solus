import { subscribeAllHosts } from '@solus/client-core/host-events'
import { localApi } from '@solus/client-core/local-api'
import { serverConnections } from '@solus/client-core/server-connections'
import { onServerRemoving } from '@solus/client-core/server-registry'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  attentionNotificationDedupKey,
  notificationEventForAttentionKind,
  notificationEventForSoundTrigger,
  notificationSessionRoute,
  payloadForAttentionEntry,
  shouldDeliverNotification,
  type AppNoticeEvent,
  type ClientNotificationRequest,
  type NotificationPreferences,
  type NotificationSoundLog,
  type NotificationSoundTrigger,
} from '@solus/contracts/notification-types'
import type { AttentionEntry, AttentionKind } from '@solus/contracts/attention-types'
import type { Component } from 'svelte'
import notificationSrc from '../../../../../resources/notification.mp3'
import SessionStatusGlyph from '../../components/session/SessionStatusGlyph.svelte'
import { attentionStateForKind } from '../../lib/sessionUtils'
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
  /** Read on every delivery, so a switch flipped in Settings applies at once. */
  preferences(): NotificationPreferences
}

const notificationAudio = new Audio(notificationSrc)
notificationAudio.volume = 1.0

/** The one condition delivery turns on. In front: the toast. In the
 *  background — hidden, minimized, or another app has focus: the sound and
 *  the system alert. Settings present the channels under those two headings. */
function isSolusInFront(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus()
}

/** The one place a notification is decided. Every channel — sound, toast,
 * system alert — passes through the same event and channel switches. */
class NotificationsStore {
  private activity = new BackgroundActivityTracker()
  private updateBadge: (sessionKeys: string[]) => void = () => {}
  private generation = 0
  private readonly snapshotRevisions = new Map<string, number>()
  private tracker = new AttentionNotificationTracker()
  private stopCurrent: (() => void) | null = null
  /** Reactive so an effect that asks `wants` before `start` re-runs once the
   *  shell has supplied the preferences. */
  private deps = $state.raw<NotificationManagerDependencies | null>(null)

  /** Whether an app notice (a toast raised outside a session) may be shown.
   *  Singleton stores read this; they have no settings context of their own.
   *  Before `start`, the defaults answer, and every notice is on. */
  wants(event: AppNoticeEvent): boolean {
    return (this.deps?.preferences() ?? DEFAULT_NOTIFICATION_PREFERENCES).events[event]
  }

  /** Plays the sound for a session event while the window is hidden. */
  async playSound(sessionId: string, agentSessionId: string | null, trigger: NotificationSoundTrigger): Promise<void> {
    const preferences = this.deps?.preferences()
    if (!preferences || !shouldDeliverNotification(preferences, 'sound', notificationEventForSoundTrigger(trigger))) return
    // The shell knows when its window is hidden to the tray; the document
    // knows when another app is in front. Either is the background.
    if ((await localApi.isVisible()) && isSolusInFront()) return
    const row: NotificationSoundLog = {
      event: 'notification_sound_play_requested',
      sessionId,
      agentSessionId,
      trigger,
    }
    console.info('[Solus][NotificationSound]', row)
    localApi.logNotificationSound?.(row)
    notificationAudio.currentTime = 0
    notificationAudio.play().catch((error) => {
      const failure: NotificationSoundLog = {
        event: 'notification_sound_play_failed',
        sessionId,
        agentSessionId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      }
      console.warn('[Solus][NotificationSound]', failure)
      localApi.logNotificationSound?.(failure)
    })
  }

  start(deps: NotificationManagerDependencies): () => void {
    this.stop()
    this.deps = deps
    this.generation += 1
    this.updateBadge = createActivityBadge()
    const acknowledge = () => { this.activity.acknowledge(); this.updateBadge([]) }
    const onFocus = () => { if (isSolusInFront()) acknowledge() }
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
      if (this.deps === deps) this.deps = null
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
    const preferences = deps.preferences()
    const inFront = isSolusInFront()
    const activity = this.activity.applySnapshot(serverId, entries, deps.isSessionFocused)
    if (inFront) this.activity.acknowledge()
    this.updateBadge(this.activity.sessionKeys)
    if (preferences.channels.toast && inFront) {
      for (const candidate of activity) {
        if (!shouldDeliverNotification(preferences, 'toast', notificationEventForAttentionKind(candidate.entry.kind))) continue
        const host = deps.hostDisplay(serverId)
        const payload = payloadForAttentionEntry(candidate.entry, host.isPrimary ? {} : { hostLabel: host.label })
        toasts.show({
          id: `activity:${serverId}:${candidate.entry.sessionId}`,
          message: payload.title,
          description: payload.body,
          icon: attentionToastIcon(candidate.entry.kind),
          action: { label: 'Open session', onAction: () => {
            deps.openRoute(notificationSessionRoute(candidate.entry.sessionId, serverId))
            requestInputFocus()
          } },
        })
      }
    }
    // Applied even in front so the tracker records what it has seen; a session
    // that needs you while Solus is in front is the toast's to announce.
    const candidates = this.tracker.applySnapshot(serverId, entries, deps.isSessionFocused)
    if (inFront) return
    for (const candidate of candidates) {
      if (!shouldDeliverNotification(preferences, 'system', notificationEventForAttentionKind(candidate.entry.kind))) continue
      void this.deliver(candidate.serverId, candidate.entry, deps).catch(() => {})
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

/** The sidebar's status glyph for an attention kind, bound as a prop-less
 *  component because Sonner mounts a toast icon without props. */
function attentionToastIcon(kind: AttentionKind): Component {
  const attention = attentionStateForKind(kind)
  return (internals) => SessionStatusGlyph(internals, { attention })
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
