import { onSessionViewChanged } from '../../data/sessions/session-states'
import type { HostEventPublisher } from './host-event-publisher'
import type { PersonConnections } from './person-connections'

/**
 * Who hears `session.viewChanged` (docs/plans/session-archive.md): only the
 * connections of the person whose view changed, admitted to the session's
 * organization. Nobody else learns that a person archived or snoozed it.
 * Answers the unsubscribe.
 */
export function publishSessionViewChanges(events: HostEventPublisher, connections: PersonConnections): () => void {
  return onSessionViewChanged((change) => {
    const recipients = connections.of(change.personKey, change.organizationId)
    if (recipients.length) void events.publish(recipients, 'session.viewChanged', { sessionId: change.sessionId, view: change.view })
  })
}
