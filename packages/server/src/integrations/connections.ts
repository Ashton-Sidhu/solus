import type { Integration, IntegrationConnection } from '@solus/contracts/integration-types'
import type { UploadMaterial, VaultConnection } from '@solus/contracts/vault'
import { ANY_ORGANIZATION } from '../admission/principal'
import { createLogger } from '../logger'
import type { ProfileIntegrationOwner } from '../execution/seats/agent-profile'
import { mcpCredentialRef, type AccountCredentialRead, type Vault } from '../vault/vault'
import type { IntegrationClients, IntegrationConnectionStore } from './connection-store'
import type { IntegrationStore } from './integration-store'
import { discoverAddressOf, type IntegrationConnectionEvents, type IntegrationOAuth } from './oauth'
import { readServerIdentity } from './server-identity'

const log = createLogger('integrations', 'connections.ts')

/** What the gateway asks for one call (docs/plans/mcp-integrations.md §4.1 rules 3 and 4). */
export interface IntegrationCredentials {
  /** The Authorization header value for this integration and person, refreshed when due; null when there is no usable connection. Never throws for "not connected". */
  authorizationFor(integrationId: string, personKey: string): Promise<string | null>
  /** The server refused the credential (401/403): record `needs-sign-in` and publish the change. */
  markNeedsSignIn(integrationId: string, personKey: string, message: string): void
  /** The person's own connection row, for `connection_status`; never another person's. */
  statusFor?(integrationId: string, personKey: string): IntegrationConnection | null
}

export interface IntegrationConnectionsDeps {
  store: IntegrationConnectionStore
  integrations: Pick<IntegrationStore, 'get' | 'list'>
  /** Where each person's credential is, on this host or in their account (docs/plans/access-model.md §2.6). */
  vault: Pick<Vault, 'read' | 'save' | 'remove' | 'upload' | 'forget'>
  clients: Pick<IntegrationClients, 'removeClient'>
  oauth: IntegrationOAuth
  events: IntegrationConnectionEvents
  fetch?: typeof fetch
}

/** What a reconcile did, by slug: moved into the account, adopted from it, or left on the host. */
export interface ReconcileOutcome {
  uploaded: string[]
  adopted: string[]
  kept: string[]
}

/** A pasted key as its header: the whole key after the scheme the probe saw. */
function keyAuthorization(integration: Integration, key: string): string {
  return integration.auth.kind === 'bearer' && integration.auth.scheme === 'basic' ? `Basic ${key}` : `Bearer ${key}`
}

/**
 * Each person's connections to the host's integrations (§4): the credential the
 * gateway sends, pasted keys, and disconnect. OAuth sign-in itself is
 * `IntegrationOAuth`'s. Where the credential is, on this host or in the
 * person's account (plans/020 §5), is the vault's choice.
 */
export class IntegrationConnections implements IntegrationCredentials {
  constructor(private readonly deps: IntegrationConnectionsDeps) {}

  async authorizationFor(integrationId: string, personKey: string): Promise<string | null> {
    const integration = this.deps.integrations.get(integrationId, ANY_ORGANIZATION)
    if (!integration || integration.auth.kind === 'none') return null
    const connection = this.deps.store.get(integrationId, personKey)
    // A refused credential waits for the person to sign in again.
    if (connection?.status === 'needs-sign-in') return null
    const credential = await this.deps.vault.read(personKey, mcpCredentialRef(integration))
    if (!credential) return null
    if (credential.location === 'account') return this.accountAuthorization(integration.id, personKey, credential.read)
    if (integration.auth.kind === 'bearer') return keyAuthorization(integration, credential.token.accessToken)
    try {
      const token = await this.deps.oauth.refreshIfDue(integrationId, personKey, credential.token)
      return token ? `Bearer ${token.accessToken}` : null
    } catch (error) {
      log.warn('integration_authorization_failed', { integrationId, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /**
   * A connection in the account (plans/020 §5.2): its delivered authorization, or
   * the cached one while the cloud does not answer. When the cloud does not answer
   * and the cache ran out, the row says `cloud-unreachable`, never `needs-sign-in`.
   * When no Solus sign-in lets this host ask (the delegation could not be
   * derived), it says `needs-solus-sign-in`: the cloud was not asked, so it was
   * not unreachable. A person with no row here was never seen connected: a failed
   * read leaves them with none, rather than a status for a connection they may not have.
   */
  private accountAuthorization(integrationId: string, personKey: string, read: AccountCredentialRead): string | null {
    if (read.kind !== 'ok' && read.kind !== 'cached' && !this.deps.store.get(integrationId, personKey)) return null
    switch (read.kind) {
      case 'ok':
        this.recover(integrationId, personKey)
        return read.delivery.authorization
      case 'cached':
        return read.delivery.authorization
      case 'not-connected':
      case 'reconnect-required':
        this.record(integrationId, personKey, 'needs-sign-in', 'Sign in to this server again.')
        return null
      case 'no-executor':
        this.record(integrationId, personKey, 'needs-solus-sign-in', 'Sign in to Solus so this host can use your account connections.')
        return null
      case 'unreachable':
        this.record(integrationId, personKey, 'cloud-unreachable', 'Solus Cloud is unreachable, so this connection cannot be used right now.')
        return null
    }
  }

  /**
   * The person's delegation was made: their `cloud` rows that waited on it (no sign-in,
   * or no answer) are read again, so a row says what is true now, not at its last call.
   */
  async recheckCloud(personKey: string): Promise<void> {
    for (const connection of this.deps.store.list(personKey)) {
      if (connection.source !== 'cloud' || (connection.status !== 'cloud-unreachable' && connection.status !== 'needs-solus-sign-in')) continue
      await this.authorizationFor(connection.integrationId, personKey)
    }
  }

  markNeedsSignIn(integrationId: string, personKey: string, message: string): void {
    const integration = this.deps.integrations.get(integrationId, ANY_ORGANIZATION)
    if (integration) this.deps.vault.forget(personKey, mcpCredentialRef(integration))
    this.record(integrationId, personKey, 'needs-sign-in', message)
    log.info('integration_needs_sign_in', { integrationId, personKey })
  }

  statusFor(integrationId: string, personKey: string): IntegrationConnection | null {
    return this.deps.store.get(integrationId, personKey)
  }

  /** An anonymous integration needs no sign-in: the person's row says so. */
  connectAnonymous(integration: Integration, personKey: string): IntegrationConnection {
    const connection = this.deps.store.upsert(integration.id, personKey, { status: 'connected', error: null })
    this.deps.events.connectionChanged(personKey, { integrationId: integration.id, connection })
    return connection
  }

  /** A `bearer` integration's key, kept only after the server accepted it. Throws a plain message. */
  async submitKey(integration: Integration, personKey: string, key: string): Promise<IntegrationConnection> {
    if (integration.auth.kind !== 'bearer') throw new Error('This integration does not take an API key.')
    const identity = await readServerIdentity(integration.url, keyAuthorization(integration, key), this.deps.fetch)
    this.deps.vault.save(personKey, mcpCredentialRef(integration), { accessToken: key, tokenType: 'api-key' })
    const connection = this.deps.store.upsert(integration.id, personKey, {
      status: 'connected',
      source: 'host',
      label: identity.label,
      info: identity.label ? { displayName: identity.label } : null,
      error: null,
    })
    this.deps.events.connectionChanged(personKey, { integrationId: integration.id, connection })
    log.info('integration_key_connected', { integrationId: integration.id, personKey })
    return connection
  }

  /** Removes the person's token and row; revokes an OAuth token when the server names a revocation endpoint. */
  async disconnect(integration: Integration, personKey: string): Promise<boolean> {
    const token = this.deps.vault.remove(personKey, mcpCredentialRef(integration))
    const removed = this.deps.store.remove(integration.id, personKey)
    this.deps.events.connectionChanged(personKey, { integrationId: integration.id, connection: null })
    if (token && integration.auth.kind === 'oauth') await this.deps.oauth.revoke(integration, token)
    log.info('integration_disconnected', { integrationId: integration.id, personKey })
    return removed || token !== null
  }

  /** The integration was removed: every person's row and credential here, and the host's client for it. */
  removeAllFor(integration: Integration): void {
    for (const personKey of this.deps.store.removeAllFor(integration.id)) this.deps.vault.remove(personKey, mcpCredentialRef(integration))
    this.deps.clients.removeClient(integration.id)
  }

  // ── The reconcile (plans/020 §5.4) ──

  /**
   * After a pull, for every integration the person sees here, shared or their own,
   * with the statuses of their account vault (`VaultConnection`, MCP refs only):
   * a connection the account holds and this host does not use yet is read from
   * the account from now on, which is how a sign-in at the cloud reaches this
   * host. A connection that still lives on this host moves into their account.
   * When the cloud holds none, the host uploads its credential and drops its copy
   * once the cloud confirms. When the cloud holds one, or the upload finds one,
   * the cloud wins: the host revokes its own token and reads from the account
   * from then on. When the cloud is unreachable, nothing is deleted; the next
   * pull tries again.
   */
  async reconcile(owner: ProfileIntegrationOwner, cloudConnections: VaultConnection[]): Promise<ReconcileOutcome> {
    const outcome: ReconcileOutcome = { uploaded: [], adopted: [], kept: [] }
    const held = new Map(cloudConnections.flatMap((connection) => connection.ref.kind === 'mcp' ? [[connection.ref.serverUrl, connection] as const] : []))
    const user = owner.ownerKey
    for (const integration of this.deps.integrations.list(owner.organizationId, owner.ownerKey)) {
      if (integration.auth.kind === 'none') continue
      const connection = this.deps.store.get(integration.id, user)
      if (connection?.source === 'cloud') continue
      const cloudHeld = held.get(integration.url)
      if (cloudHeld?.status === 'connected' && connection?.status !== 'connected') {
        await this.adoptCloud(integration, user, { revokeLocal: true, label: cloudHeld.label })
        outcome.adopted.push(integration.slug)
        continue
      }
      if (!connection || connection.status !== 'connected') continue
      if (cloudHeld) {
        await this.adoptCloud(integration, user, { revokeLocal: true, label: cloudHeld.label })
        outcome.adopted.push(integration.slug)
        continue
      }
      const credential = await this.exportable(integration, user)
      if (!credential) {
        outcome.kept.push(integration.slug)
        continue
      }
      const result = await this.deps.vault.upload(user, mcpCredentialRef(integration), credential, connection.label)
      if (result.kind === 'uploaded') {
        // The cloud holds this very token now: one refresher, so the host's copy goes without a revocation.
        await this.adoptCloud(integration, user, { revokeLocal: false, label: connection.label })
        outcome.uploaded.push(integration.slug)
      } else if (result.kind === 'held') {
        await this.adoptCloud(integration, user, { revokeLocal: true, label: connection.label })
        outcome.adopted.push(integration.slug)
      } else {
        log.info('integration_connection_kept_on_host', { integrationId: integration.id, reason: result.kind })
        outcome.kept.push(integration.slug)
      }
    }
    if (outcome.uploaded.length || outcome.adopted.length) log.info('integration_connections_reconciled', { personKey: user, ...outcome })
    return outcome
  }

  /**
   * What this host holds for a person and integration, as the account vault
   * takes it: the key, or the OAuth token with the client that received it and
   * the endpoints the cloud needs to refresh and revoke. Null when the host holds
   * nothing, or an OAuth token it cannot refresh anyway.
   */
  private async exportable(integration: Integration, personKey: string): Promise<UploadMaterial | null> {
    const credential = await this.deps.vault.read(personKey, mcpCredentialRef(integration))
    if (credential?.location !== 'host') return null
    const token = credential.token
    if (integration.auth.kind === 'bearer') return { kind: 'key', key: token.accessToken, scheme: integration.auth.scheme }
    const discover = discoverAddressOf(integration)
    if (!token.refreshToken || !discover) return null
    try {
      const tokenEndpoint = (await this.deps.oauth.tokenEndpointOf(integration)).href
      return { kind: 'oauth', token, client: this.deps.oauth.clientForToken(integration.id, token), tokenEndpoint, discover }
    } catch (error) {
      log.warn('integration_export_failed', { integrationId: integration.id, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /**
   * The cloud holds this connection now: the host's copy goes, revoked at the
   * server when the cloud did not take this very token, and the row reads from
   * the account from here on.
   */
  private async adoptCloud(integration: Integration, personKey: string, options: { revokeLocal: boolean; label: string | null }): Promise<void> {
    const token = this.deps.vault.remove(personKey, mcpCredentialRef(integration))
    if (token && options.revokeLocal && integration.auth.kind === 'oauth') await this.deps.oauth.revoke(integration, token)
    const connection = this.deps.store.upsert(integration.id, personKey, { status: 'connected', source: 'cloud', label: options.label, error: null })
    this.deps.events.connectionChanged(personKey, { integrationId: integration.id, connection })
    log.info('integration_connection_adopted_cloud', { integrationId: integration.id, personKey, revoked: Boolean(token && options.revokeLocal) })
  }

  /** A `cloud` row whose read worked again: back to `connected`. */
  private recover(integrationId: string, personKey: string): void {
    const connection = this.deps.store.get(integrationId, personKey)
    if (!connection || connection.status === 'connected') return
    this.record(integrationId, personKey, 'connected', null)
  }

  private record(integrationId: string, personKey: string, status: IntegrationConnection['status'], error: string | null): void {
    const connection = this.deps.store.upsert(integrationId, personKey, { status, error })
    this.deps.events.connectionChanged(personKey, { integrationId, connection })
  }
}
