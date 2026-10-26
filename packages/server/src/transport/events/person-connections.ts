import { actorFor, ownerKeyOf } from '../../admission/actor'
import { recordScopeOf, scopeAdmits, type Principal } from '../../admission/principal'

/**
 * The connected clients of one person. Every event or request meant for a person
 * alone (their snoozes, their session views, their integration sign-ins, an agent
 * asking for their settings) goes to these clients and no other person's.
 */
export class PersonConnections {
  constructor(
    private readonly clientIds: () => readonly string[],
    /** A client with no principal is no one's. */
    private readonly principalOf: (clientId: string) => Principal | null | undefined,
  ) {}

  /** This client is the person's. With an organization, it must also be admitted to it. */
  includes(clientId: string, personKey: string, organizationId?: string): boolean {
    const principal = this.principalOf(clientId)
    if (!principal || principal.kind === 'runner' || principal.kind === 'system') return false
    if (ownerKeyOf(actorFor(principal)) !== personKey) return false
    return organizationId === undefined || scopeAdmits(recordScopeOf(principal), organizationId)
  }

  of(personKey: string, organizationId?: string): string[] {
    return this.clientIds().filter((clientId) => this.includes(clientId, personKey, organizationId))
  }
}
