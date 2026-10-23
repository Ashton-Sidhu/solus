import { firstPartyClientById, type FirstPartyClientId } from '../first-party-clients'
import type { Integration, IntegrationConnection, IntegrationProbeResult } from '../integration-types'
import { SetupHandoff, setupNeedOfUndetermined, type IntegrationSetupNeed, type IntegrationSetupTarget } from './setup-handoff'

/** What a sign-in rule reads of an integration: how it signs in, and where its tokens go. */
export type IntegrationSignInSource = Pick<Integration, 'auth' | 'url'>

/**
 * How one integration signs in (docs/plans/mcp-integrations.md §4, §13): the
 * answers the host and every client share, so a rule is written once. A
 * client subclasses it for its own wording; the record itself stays the plain
 * object that crosses the wire.
 */
export class IntegrationSignIn {
  constructor(protected readonly integration: IntegrationSignInSource) {}

  /** The setup a probe of `url` calls for, before any record exists; null when Solus can connect or a retry is the answer. */
  static setupNeedOfProbe(result: IntegrationProbeResult, url: string): IntegrationSetupNeed | null {
    if (result.outcome === 'undetermined') return setupNeedOfUndetermined(result.reason)
    return new IntegrationSignIn({ auth: result.auth, url }).setupNeed
  }

  /** Only a server with sign-in has a per-person connection. */
  get needsConnection(): boolean {
    return this.integration.auth.kind !== 'none'
  }

  /** Every OAuth server can take a client the person enters. */
  get takesOAuthClient(): boolean {
    return this.integration.auth.kind === 'oauth'
  }

  /**
   * The Solus app that signs in for this server (§13.1): none when the owner
   * saved a client of their own, and none when the address is not one the
   * app may serve, so a stored record is checked again on every read.
   */
  get firstParty(): FirstPartyClientId | null {
    const { auth, url } = this.integration
    if (auth.kind !== 'oauth' || auth.clientId || !auth.firstParty) return null
    return firstPartyClientById(auth.firstParty).serves(url) ? auth.firstParty : null
  }

  /** The person's Solus GitHub connection is the credential: there is no sign-in of its own. */
  get usesSolusGithub(): boolean {
    return this.firstParty === 'github'
  }

  /**
   * True when sign-in cannot start until the owner enters an OAuth client: the
   * server registers none on request, the owner saved none, and no Solus app
   * signs in for it.
   */
  get needsOwnerClient(): boolean {
    const { auth } = this.integration
    return auth.kind === 'oauth' && auth.registration === 'client-required' && !auth.clientId && !this.firstParty
  }

  /** Whether "Add another account" applies (§13.3): an OAuth server, unless its credential is the person's one Solus GitHub connection. */
  get acceptsAnotherAccount(): boolean {
    return this.takesOAuthClient && !this.usesSolusGithub
  }

  /** What runs right after Add: nothing, a sign-in, or the owner's OAuth client form. */
  get afterAdd(): 'ready' | 'connect' | 'oauth-client' {
    if (!this.needsConnection) return 'ready'
    return this.needsOwnerClient ? 'oauth-client' : 'connect'
  }

  /** The setup "Set up with an agent" finds (§13.4), or null when Solus can connect by itself. */
  get setupNeed(): IntegrationSetupNeed | null {
    if (this.integration.auth.kind === 'bearer') return 'api-key'
    return this.needsOwnerClient ? 'oauth-client' : null
  }

  /** Where OAuth discovery starts, for a server that signs in, or offers to, with OAuth. */
  get discoverAddress(): string | undefined {
    const { auth } = this.integration
    if (auth.kind === 'oauth') return auth.discover
    return auth.kind === 'none' ? auth.oauth?.discover : undefined
  }

  /** The setup still needed by a person with this connection: nothing once they are connected. */
  setupNeedFor(connection: Pick<IntegrationConnection, 'status'> | null | undefined): IntegrationSetupNeed | null {
    return connection?.status === 'connected' ? null : this.setupNeed
  }

  /**
   * "Set up with an agent" for a person with this connection, or null when
   * nothing is left to set up. The callback address goes into the steps only
   * when an OAuth client is what they create.
   */
  setupHandoffFor(connection: Pick<IntegrationConnection, 'status'> | null | undefined, target: Omit<IntegrationSetupTarget, 'url'>): SetupHandoff | null {
    const need = this.setupNeedFor(connection)
    if (!need) return null
    const callbackUrl = need === 'oauth-client' ? target.callbackUrl : undefined
    return new SetupHandoff(need, { ...target, url: this.integration.url, callbackUrl })
  }

  /** The host lists tools only for a server without sign-in, or one the person is connected to. */
  canListTools(connection: Pick<IntegrationConnection, 'status'> | null | undefined): boolean {
    return !this.needsConnection || connection?.status === 'connected'
  }
}
