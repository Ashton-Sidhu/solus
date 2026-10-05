import type { HubNotification, NotificationResource } from '@solus/contracts/notification-hub'
import type { ShareResource } from '@solus/contracts/sharing'
import { actorFor, ownerKeyOf } from '../../admission/actor'
import type { Principal, RecordScope } from '../../admission/principal'
import type { NotificationReader } from './store'

/**
 * Who a hub read is for (plans/015-notifications-hub.md §3): the person the
 * admitted principal names, never a user id the client sent. A guest, a runner,
 * and the host itself have no personal hub. `mayOpenShared` is the caller's
 * current access to a work or a task; every row is checked with it before a page
 * or a count is cut. Pull requests, automations, and review jobs are host-wide
 * records: the read's organization scope is their access rule.
 */
export function notificationReaderFor(
  principal: Principal,
  scope: RecordScope,
  mayOpenShared: (resource: ShareResource) => Promise<boolean>,
): NotificationReader | null {
  if (principal.kind === 'guest' || principal.kind === 'runner' || principal.kind === 'system') return null
  const recipientKey = ownerKeyOf(actorFor(principal))
  if (!recipientKey) return null
  const checked = new Map<string, Promise<boolean>>()
  return {
    scope,
    recipientKey,
    mayOpen: (notification: HubNotification) => {
      const resource = sharedResourceOf(notification.resource)
      if (!resource) return Promise.resolve(true)
      const key = `${resource.kind}:${resource.id}`
      let open = checked.get(key)
      if (!open) {
        open = mayOpenShared(resource)
        checked.set(key, open)
      }
      return open
    },
  }
}

/** The shared record a notification opens, when it opens one. */
function sharedResourceOf(resource: NotificationResource): ShareResource | null {
  if (resource.kind === 'work') return { kind: 'work', id: resource.workId }
  if (resource.kind === 'task') return { kind: 'task', id: resource.taskId }
  return null
}
