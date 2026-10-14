import { actorFor, ownerKeyOf } from '../../admission/actor'
import { recordScopeOf, scopeAdmits, type Principal } from '../../admission/principal'
import { onSessionViewChanged, type SessionViewChange } from '../../data/sessions/session-states'
import type { HostEventPublisher } from './host-event-publisher'

/**
 * Who hears `session.viewChanged` (docs/plans/session-archive.md): only the
 * connections of the person whose view changed, admitted to the session's
 * organization. Nobody else learns that a person archived or snoozed it.
 */
export function sessionViewRecipientClients(
  clientIds: readonly string[],
  principalOf: (clientId: string) => Principal | null | undefined,
  change: SessionViewChange,
): string[] {
  return clientIds.filter((clientId) => {
    const principal = principalOf(clientId)
    if (!principal || principal.kind === 'runner' || principal.kind === 'system') return false
    return ownerKeyOf(actorFor(principal)) === change.personKey && scopeAdmits(recordScopeOf(principal), change.organizationId)
  })
}

/** Send each change to its person's connections. Answers the unsubscribe. */
export function publishSessionViewChanges(
  events: HostEventPublisher,
  clientIds: () => readonly string[],
  principalOf: (clientId: string) => Principal | null | undefined,
): () => void {
  return onSessionViewChanged((change) => {
    const recipients = sessionViewRecipientClients(clientIds(), principalOf, change)
    if (recipients.length) void events.publish(recipients, 'session.viewChanged', { sessionId: change.sessionId, view: change.view })
  })
}
