import { app, BrowserWindow, Notification, type Tray } from 'electron'
import { attentionEntryKey, payloadForAttentionEntry } from './notifications/push-service'
import { countDesktopAttentionEntries, diffDesktopAttentionSnapshot } from './desktop-notifications-core'
import type { AttentionChangeListener, AttentionService } from './attention/attention-service'
import type { AttentionEntry } from '../shared/attention-types'

type BadgeTarget = 'dock' | 'tray' | 'none'

interface AttentionSource {
  list(): AttentionEntry[]
  onChange(listener: AttentionChangeListener): void
}

interface ListenerBackedAttentionSource extends AttentionSource {
  listener?: AttentionChangeListener | null
}

export interface DesktopAttentionNotificationsOptions {
  attention: AttentionService
  focusWindow: () => void
  getFocusedWindow?: () => BrowserWindow | null
  getTray?: () => Tray | null
  badgeTarget?: BadgeTarget
  isActiveAttention?: (entry: AttentionEntry) => boolean
}

export interface DesktopAttentionNotifications {
  syncBadge(): void
}

export function attachDesktopAttentionNotifications(
  options: DesktopAttentionNotificationsOptions,
): DesktopAttentionNotifications {
  const attention = options.attention as ListenerBackedAttentionSource
  const existingListener = attention.listener ?? null
  const getFocusedWindow = options.getFocusedWindow ?? (() => BrowserWindow.getFocusedWindow())
  const badgeTarget = options.badgeTarget ?? 'none'
  const isActiveAttention = options.isActiveAttention
  let previousKeys = new Set(options.attention.list().map(attentionEntryKey))

  const syncBadge = () => {
    setBadgeCount(
      countDesktopAttentionEntries(options.attention.list(), isActiveAttention),
      badgeTarget,
      options.getTray,
    )
  }

  options.attention.onChange((entries) => {
    existingListener?.(entries)

    const snapshot = diffDesktopAttentionSnapshot(previousKeys, entries, isActiveAttention)
    previousKeys = snapshot.nextKeys
    setBadgeCount(snapshot.badgeCount, badgeTarget, options.getTray)

    if (getFocusedWindow() !== null) return
    for (const entry of snapshot.created) {
      showAttentionNotification(entry, options.focusWindow)
    }
  })

  syncBadge()
  return { syncBadge }
}

function showAttentionNotification(entry: AttentionEntry, onClick: () => void): void {
  if (!Notification.isSupported()) return

  const payload = payloadForAttentionEntry(entry)
  const notification = new Notification({
    title: payload.title,
    body: entry.summary || payload.body,
  })
  notification.on('click', onClick)
  notification.show()
}

function setBadgeCount(count: number, badgeTarget: BadgeTarget, getTray?: () => Tray | null): void {
  const value = count > 0 ? String(count) : ''
  if (process.platform !== 'darwin') return

  if (badgeTarget === 'dock' && app.dock) {
    app.dock.setBadge(value)
    return
  }

  if (badgeTarget === 'tray') {
    getTray?.()?.setTitle(value)
  }
}
