import type { HostOwnerIdentity } from '@solus/contracts/uplink'
import type { HostRegistrationRequest } from '@solus/contracts/uplink'
import type { TokenVerdict } from '../admission/access-tokens'
import { createLogger } from '../logger'
import { delegateFromPresentedToken, type Delegations, type DelegationScope } from '../sync/delegations'

const log = createLogger('main', 'local-client')

/**
 * The door of the account client in this process: the desktop app's main process,
 * which holds the owner's sign-in (docs/adr/0001-standard-authentication.md §2.2 rule
 * 10, stage 6). It is an ordinary client of this host. It presents its access token
 * for this host, and the host makes its delegations from it with `Delegations.establish`,
 * as at the ticket door. The host never asks a client for a token. A host that is not
 * registered yet is registered by this client first (§2.2 rule 8): the client gets a
 * one-time ticket from the account plane with its own account token and hands it here.
 */
export interface LocalClient {
  /** The host id a token for this host names; null while the host is not registered. */
  hostId(): string | null
  /** Whether the signed-in client should register this host now: it is not registered, and nothing refused that. */
  needsRegistration(): boolean
  /** Registers this host with a ticket the client got with its own account token. The link is not touched. */
  register(request: HostRegistrationRequest): Promise<void>
  /**
   * The client's access token for this host. The host verifies it as the ticket door
   * does, and holds a delegation for each scope the person works in here: `personal`
   * for the owner, and each organization the host stands in that the token admits.
   */
  presentToken(token: string): Promise<void>
  /**
   * Who signed in (the OIDC identity of the client's sign-in), or null on sign-out. The
   * host's user is that account while signed in, and its local user after. It needs no
   * token and no link: the client is this process.
   */
  presentIdentity(owner: HostOwnerIdentity | null): void
  /** The client's grant ended: the delegations made from the tokens it presented end now. */
  signedOut(): void
  /**
   * Called when the host should get a token again: its registration or its organizations
   * changed, a delegation of the owner ended (another of their clients signed out), or a
   * call found the owner's delegation missing or refused. The listener resolves once it
   * presented, or could not.
   */
  onTokenWanted(listener: () => Promise<void> | void): () => void
}

export interface LocalClientDeps {
  hostId: () => string | null
  /** False where the process registers nothing (the Solus API). */
  needsRegistration: () => boolean
  register: (request: HostRegistrationRequest) => Promise<void>
  verify: (token: string) => Promise<TokenVerdict>
  /** Null where the process makes no delegations (the Solus API). */
  delegations: () => Pick<Delegations, 'establish' | 'has' | 'forgetGrant'> | null
  /** The organizations this host stands in. */
  organizationIds: () => string[]
  /** The delegations a token made are in place: work that waited for them may go on. */
  onEstablished: () => void
  /** The signed-in account, or null when none: the host's user follows it. */
  onOwnerIdentity: (owner: HostOwnerIdentity | null) => void
}

export class LocalClientDoor implements LocalClient {
  /** The grants of the tokens this client presented, so its sign-out ends only what they made. */
  private readonly presentedGrants = new Set<string>()
  private readonly wantedListeners = new Set<() => Promise<void> | void>()
  /** The ask a call is waiting on; calls that find the delegation missing at once share it. */
  private renewing: Promise<void> | null = null

  constructor(private readonly deps: LocalClientDeps) {}

  hostId(): string | null {
    return this.deps.hostId()
  }

  needsRegistration(): boolean {
    return this.deps.needsRegistration()
  }

  register(request: HostRegistrationRequest): Promise<void> {
    return this.deps.register(request)
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
    await delegateFromPresentedToken(verdict, token, [undefined, ...this.deps.organizationIds()], (subjectToken, scope) => delegations.establish(subjectToken, scope))
    this.deps.onEstablished()
  }

  presentIdentity(owner: HostOwnerIdentity | null): void {
    this.deps.onOwnerIdentity(owner)
  }

  signedOut(): void {
    const delegations = this.deps.delegations()
    for (const grantId of this.presentedGrants) delegations?.forgetGrant(grantId)
    this.presentedGrants.clear()
  }


  onTokenWanted(listener: () => Promise<void> | void): () => void {
    this.wantedListeners.add(listener)
    return () => { this.wantedListeners.delete(listener) }
  }

  /**
   * The host's registration was made, changed, or ended: ask the client again. A
   * registered host wants a token for its new id; one that lost its registration at
   * boot wants a new one (§2.2 rule 8).
   */
  registrationChanged(): void {
    for (const listener of this.wantedListeners) void listener()
  }

  /**
   * A call found the owner's delegation missing, or the account plane refused it: ask the
   * client for a token, and resolve once it presented or could not. The delegation is
   * derived from the sign-in, so the call goes on with it.
   */
  renew(): Promise<void> {
    if (this.renewing) return this.renewing
    const renewing: Promise<void> = Promise.allSettled([...this.wantedListeners].map(async (listener) => listener()))
      .then((outcomes) => {
        for (const outcome of outcomes) if (outcome.status === 'rejected') log.warn('local_client_renew_failed', { error: String(outcome.reason) })
      })
      .finally(() => { if (this.renewing === renewing) this.renewing = null })
    this.renewing = renewing
    return renewing
  }

  /** The host's standing changed: ask the client again when the owner misses a delegation here. */
  standingChanged(ownerUserId: string | null): void {
    const delegations = this.deps.delegations()
    if (!ownerUserId || !delegations) return
    const scopes: DelegationScope[] = ['personal', ...this.deps.organizationIds().map((organizationId) => ({ organizationId }))]
    if (scopes.every((scope) => delegations.has(ownerUserId, scope))) return
    for (const listener of this.wantedListeners) void listener()
  }
}
