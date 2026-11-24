import { onPersonSettingsChanged } from '../../execution/person-settings'
import type { HostEventPublisher } from './host-event-publisher'
import type { PersonConnections } from './person-connections'

/**
 * Who hears `personalDocument.changed` (docs/plans/personal-settings-source.md):
 * only the connections of the person whose copy changed, whatever organization
 * each is admitted to. Their clients that show this host's copy read it again.
 * Answers the unsubscribe.
 */
export function publishPersonalDocumentChanges(events: HostEventPublisher, connections: PersonConnections): () => void {
  return onPersonSettingsChanged((personKey) => {
    const recipients = connections.of(personKey)
    if (recipients.length) void events.publish(recipients, 'personalDocument.changed', { kind: 'settings' })
  })
}
