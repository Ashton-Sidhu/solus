import type { TokenVerdict } from '../admission/access-tokens'
import type { HostAccess } from '../execution/orchestration/remote-hosts'
import { createLogger } from '../logger'
import { delegationScopesFor, type Delegations, type DelegationScope } from '../sync/delegations'

const log = createLogger('main', 'local-client')

/**
 * The door of the account client in this process: the desktop app's main process,
 * which holds the owner's sign-in (docs/adr/0001-standard-authentication.md §2.2 rule
 * 10, stage 6). It is an ordinary client of this host. It presents its access token
 * for this host, and the host makes its delegations from it with `Delegations.establish`,
 * as at the ticket door. The host never asks a client for a token.
 */
export interface LocalClient {
  /** The host id a token for this host names; null while the host is not linked. */
  hostId(): string | null
  /**
   * The client's access token for this host. The host verifies it as the ticket door
   * does, and holds a delegation for each scope the person works in here: `personal`
   * for the owner, and each organization the host stands in that the token admits.
   */
  presentToken(token: string): Promise<void>
  /** The client's grant ended: the delegations made from the tokens it presented end now. */
  signedOut(): void
  /**
   * What the signed-in client lets this host do on the owner's other hosts
   * (docs/plans/cross-host-sessions.md §5.1): its directory, and its tokens for those
   * hosts. Null on sign-out.
   */
  lendHostAccess(access: HostAccess | null): void
  /** Called when the host should get a token again: its link or its organizations changed, and a delegation is missing. */
  onTokenWanted(listener: () => void): () => void
}

export interface LocalClientDeps {
  hostId: () => string | null
  verify: (token: string) => Promise<TokenVerdict>
  /** Null where the process makes no delegations (the Solus API). */
  delegations: () => Pick<Delegations, 'establish' | 'has' | 'forgetGrant'> | null
  /** The organizations this host stands in. */
  organizationIds: () => string[]
  /** The delegations a token made are in place: work that waited for them may go on. */
  onEstablished: () => void
}

export class LocalClientDoor implements LocalClient {
  /** The grants of the tokens this client presented, so its sign-out ends only what they made. */
  private readonly presentedGrants = new Set<string>()
  private readonly wantedListeners = new Set<() => void>()
  private lentAccess: HostAccess | null = null

  constructor(private readonly deps: LocalClientDeps) {}

  hostId(): string | null {
    return this.deps.hostId()
  }

  async presentToken(token: string): Promise<void> {
    const delegations = this.deps.delegations()
    if (!delegations) return
    const verdict = await this.deps.verify(token)
    if (!verdict.ok) {
      log.info('local_client_token_rejected', { reason: verdict.reason })
      return
    }
    const claims = verdict.claims
    if (claims.act) {
      log.info('local_client_token_rejected', { reason: 'delegated-token' })
      return
    }
    this.presentedGrants.add(claims.grant_id)
    const scopes = new Map<string, DelegationScope>()
    for (const organizationId of [undefined, ...this.deps.organizationIds()]) {
      for (const scope of delegationScopesFor(claims, organizationId)) scopes.set(scope === 'personal' ? scope : scope.organizationId, scope)
    }
    await Promise.all([...scopes.values()].map((scope) => delegations.establish(token, scope).catch((error) => {
      log.info('delegation_not_established', { userId: claims.sub, scope: scope === 'personal' ? scope : scope.organizationId, error: error instanceof Error ? error.message : String(error) })
    })))
    this.deps.onEstablished()
  }

  signedOut(): void {
    const delegations = this.deps.delegations()
    for (const grantId of this.presentedGrants) delegations?.forgetGrant(grantId)
    this.presentedGrants.clear()
  }

  lendHostAccess(access: HostAccess | null): void {
    this.lentAccess = access
  }

  /** The access the signed-in client lent; null when no client is signed in. */
  hostAccess(): HostAccess | null {
    return this.lentAccess
  }

  onTokenWanted(listener: () => void): () => void {
    this.wantedListeners.add(listener)
    return () => { this.wantedListeners.delete(listener) }
  }

  /** The host's standing changed: ask the client again when the owner misses a delegation here. */
  standingChanged(ownerUserId: string | null): void {
    const delegations = this.deps.delegations()
    if (!ownerUserId || !delegations) return
    const scopes: DelegationScope[] = ['personal', ...this.deps.organizationIds().map((organizationId) => ({ organizationId }))]
    if (scopes.every((scope) => delegations.has(ownerUserId, scope))) return
    for (const listener of this.wantedListeners) listener()
  }
}
