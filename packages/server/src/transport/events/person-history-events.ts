import { onPersonHistoryChanged } from '../../data/personal-state/person-history'
import type { HostEventPublisher } from './host-event-publisher'
import type { PersonConnections } from './person-connections'

/**
 * Who hears `personHistory.changed` (docs/plans/person-state.md §4): only the
 * connections of the person whose history changed. The history is the
 * person's own, not an organization's, so every connection of theirs hears it,
 * whatever organization it is admitted to. Answers the unsubscribe.
 */
export function publishPersonHistoryChanges(events: HostEventPublisher, connections: PersonConnections): () => void {
  return onPersonHistoryChanged((change) => {
    const recipients = connections.of(change.personKey)
    if (recipients.length) void events.publish(recipients, 'personHistory.changed', { entries: change.entries })
  })
}
