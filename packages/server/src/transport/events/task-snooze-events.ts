import { actorFor, ownerKeyOf } from '../../admission/actor'
import { recordScopeOf, scopeAdmits, type Principal } from '../../admission/principal'
import { onTaskSnoozesChanged, type TaskSnoozesChange } from '../../data/tasks/task-snoozes'
import type { HostEventPublisher } from './host-event-publisher'

/**
 * Who hears `tasks.snoozesChanged` (docs/task-snooze.md): only the connections
 * of the person whose snoozes changed, admitted to the task's organization. The
 * payload names nothing, so no other person learns that a task was snoozed.
 */
export function taskSnoozeRecipientClients(
  clientIds: readonly string[],
  principalOf: (clientId: string) => Principal | null | undefined,
  change: TaskSnoozesChange,
): string[] {
  return clientIds.filter((clientId) => {
    const principal = principalOf(clientId)
    if (!principal || principal.kind === 'runner' || principal.kind === 'system') return false
    return ownerKeyOf(actorFor(principal)) === change.personKey && scopeAdmits(recordScopeOf(principal), change.organizationId)
  })
}

/** Send each committed change to its person's connections. Answers the unsubscribe. */
export function publishTaskSnoozeChanges(
  events: HostEventPublisher,
  clientIds: () => readonly string[],
  principalOf: (clientId: string) => Principal | null | undefined,
): () => void {
  return onTaskSnoozesChanged((change) => {
    const recipients = taskSnoozeRecipientClients(clientIds(), principalOf, change)
    if (recipients.length) void events.publish(recipients, 'tasks.snoozesChanged', {})
  })
}
