import { Notification } from 'electron'
import type { ClientNotificationRequest } from '@solus/contracts/notification-types'
import { z } from 'zod'
import { createLogger } from '@solus/server/logger'

const log = createLogger('main', 'desktop-notifications.ts')

const DEDUP_TTL_MS = 5 * 60_000
const shownAtByKey = new Map<string, number>()

/** Native shell display primitive. Attention transitions are owned by the
 * renderer manager; main only validates, deduplicates across mounted windows,
 * displays, and routes clicks back to the renderer. */
export function showDesktopNotification(
  input: ClientNotificationRequest,
  onClick: (route: string) => void,
): boolean {
  if (!Notification.isSupported()) return false

  const now = Date.now()
  for (const [key, shownAt] of shownAtByKey) {
    if (now - shownAt >= DEDUP_TTL_MS) shownAtByKey.delete(key)
  }
  if (shownAtByKey.has(input.dedupKey)) return false
  shownAtByKey.set(input.dedupKey, now)

  const notification = new Notification({ title: input.title, body: input.body })
  notification.on('click', () => onClick(input.route))
  log.info('desktop_notification_shown', {
    sessionId: input.sessionId,
    kind: input.kind,
    entryKey: input.entryKey,
  })
  notification.show()
  return true
}

export const clientNotificationRequestSchema = z.object({
  title: z.string(),
  body: z.string(),
  sessionId: z.string(),
  kind: z.enum(['question', 'needs_approval', 'failed', 'finished']),
  entryKey: z.string(),
  route: z.string(),
  dedupKey: z.string(),
})
