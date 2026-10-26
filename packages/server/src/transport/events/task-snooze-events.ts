import { onTaskSnoozesChanged } from '../../data/tasks/task-snoozes'
import type { HostEventPublisher } from './host-event-publisher'
import type { PersonConnections } from './person-connections'

/**
 * Who hears `tasks.snoozesChanged` (docs/task-snooze.md): only the connections
 * of the person whose snoozes changed, admitted to the task's organization. The
 * payload names nothing, so no other person learns that a task was snoozed.
 * Answers the unsubscribe.
 */
export function publishTaskSnoozeChanges(events: HostEventPublisher, connections: PersonConnections): () => void {
  return onTaskSnoozesChanged((change) => {
    const recipients = connections.of(change.personKey, change.organizationId)
    if (recipients.length) void events.publish(recipients, 'tasks.snoozesChanged', {})
  })
}
