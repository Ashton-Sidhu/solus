import { actorFor } from '../admission/actor'
import { roleOf } from '../admission/access'
import type { Principal } from '../admission/principal'
import { onNotificationsChanged, type NotificationsChangedEvent } from '../data/notifications/store'
import type { HostEventPublisher } from '../transport/events/host-event-publisher'

/**
 * Who hears `notifications.changed` (plans/015-notifications-hub.md §3): only the
 * connections of the recipient, admitted to the organization the row is in: a
 * notification is a personal resource whose owner is its recipient
 * (docs/plans/access-model.md §2.3.1). The host itself has no feed. The
 * payload names nothing; the client reads its first page again, which applies
 * current resource access.
 */
export function notificationRecipientClients(
  clientIds: readonly string[],
  principalOf: (clientId: string) => Principal | null | undefined,
  change: NotificationsChangedEvent,
): string[] {
  return clientIds.filter((clientId) => {
    const principal = principalOf(clientId)
    if (!principal || principal.kind === 'system') return false
    return roleOf(actorFor(principal), { kind: 'notification', id: '', organizationId: change.organizationId, ownerKey: change.recipientKey, acl: [] }) !== 'none'
  })
}

/** Send each committed change to its recipient's connections. Answers the unsubscribe. */
export function publishNotificationChanges(
  events: HostEventPublisher,
  clientIds: () => readonly string[],
  principalOf: (clientId: string) => Principal | null | undefined,
): () => void {
  return onNotificationsChanged((change) => {
    const recipients = notificationRecipientClients(clientIds(), principalOf, change)
    if (recipients.length) void events.publish(recipients, 'notifications.changed', {})
  })
}
