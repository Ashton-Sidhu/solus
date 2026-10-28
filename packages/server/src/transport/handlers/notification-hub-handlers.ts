import { NOTIFICATION_HUB_VERSION } from '@solus/contracts/notification-hub'
import { isHostOwner, type Principal } from '../../admission/principal'
import { notificationReaderFor } from '../../data/notifications/access'
import { recordSharedSessions } from '../../data/notifications/shared-sessions'
import {
  countNotifications, listNotifications, setNotificationArchived, setNotificationRead, type NotificationReader,
} from '../../data/notifications/store'
import type { ShareManager } from '../../sharing/share-manager'
import type { SolusServer } from '../server'

/**
 * The notifications hub over IPC and WebSocket (plans/015-notifications-hub.md §3).
 * The same handlers serve a host and the Solus API: the recipient is the
 * admitted person and the scope is their record scope, so no call names a user
 * and no read spans an organization the principal is not admitted to.
 */
export function registerNotificationHubHandlers(server: SolusServer, deps: { shares?: ShareManager } = {}): void {
  const readerFor = (principal: Principal): NotificationReader => {
    const reader = notificationReaderFor(principal, async (resource) => {
      if (!deps.shares) return isHostOwner(principal)
      return await deps.shares.roleFor(principal, resource) !== 'none'
    })
    if (!reader) throw new Error('Only a person has notifications.')
    return reader
  }

  server.register('notificationsCapability', () => ({ version: NOTIFICATION_HUB_VERSION }))
  // The reader's session shares are written as they read (docs/plans/shared-with-you.md §4.4).
  server.register('notificationsList', async ([request], ctx) => {
    const reader = readerFor(ctx.principal)
    await recordSharedSessions(reader)
    return listNotifications(reader, request ?? {})
  })
  server.register('notificationsCount', async (_args, ctx) => {
    const reader = readerFor(ctx.principal)
    await recordSharedSessions(reader)
    return countNotifications(reader)
  })
  server.register('notificationsSetRead', ([request], ctx) => setNotificationRead(readerFor(ctx.principal), request))
  server.register('notificationsSetArchived', ([request], ctx) => setNotificationArchived(readerFor(ctx.principal), request))
}
