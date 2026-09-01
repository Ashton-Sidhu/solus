import { Notification } from 'electron'
import type { ClientNotificationRequest } from '../shared/notification-types'

const DEDUP_TTL_MS = 5 * 60_000
const shownAtByKey = new Map<string, number>()

/** Native shell display primitive. Attention transitions are owned by the
 * renderer manager; main only validates, deduplicates across mounted windows,
 * displays, and routes clicks back to the renderer. */
export function showDesktopNotification(
  input: unknown,
  onClick: (route: string) => void,
): boolean {
  if (!Notification.isSupported() || !isClientNotificationRequest(input)) return false

  const now = Date.now()
  for (const [key, shownAt] of shownAtByKey) {
    if (now - shownAt >= DEDUP_TTL_MS) shownAtByKey.delete(key)
  }
  if (shownAtByKey.has(input.dedupKey)) return false
  shownAtByKey.set(input.dedupKey, now)

  const notification = new Notification({ title: input.title, body: input.body })
  notification.on('click', () => onClick(input.route))
  notification.show()
  return true
}

function isClientNotificationRequest(input: unknown): input is ClientNotificationRequest {
  if (!input || typeof input !== 'object') return false
  const value = input as Partial<ClientNotificationRequest>
  return typeof value.title === 'string'
    && typeof value.body === 'string'
    && typeof value.sessionId === 'string'
    && typeof value.kind === 'string'
    && typeof value.entryKey === 'string'
    && typeof value.route === 'string'
    && typeof value.dedupKey === 'string'
}
