import type { Integration, IntegrationConnection } from '@solus/contracts/integration-types'
import { ANY_ORGANIZATION } from '../admission/principal'
import { createLogger } from '../logger'
import type { IntegrationConnectionStore, IntegrationSecrets } from './connection-store'
import type { IntegrationStore } from './integration-store'
import type { IntegrationConnectionEvents, IntegrationOAuth } from './oauth'
import { readServerIdentity } from './server-identity'

const log = createLogger('integrations', 'connections.ts')

/** What the gateway asks for one call (docs/plans/mcp-integrations.md §4.1 rules 3 and 4). */
export interface IntegrationCredentials {
  /** The Authorization header value for this integration and person, refreshed when due; null when there is no usable connection. Never throws for "not connected". */
  authorizationFor(integrationId: string, credentialUserId: string | null): Promise<string | null>
  /** The server refused the credential (401/403): record `needs-sign-in` and publish the change. */
  markNeedsSignIn(integrationId: string, credentialUserId: string | null, message: string): void
  /** The person's own connection row, for `connection_status`; never another person's. */
  statusFor?(integrationId: string, credentialUserId: string | null): IntegrationConnection | null
}

export interface IntegrationConnectionsDeps {
  store: IntegrationConnectionStore
  integrations: Pick<IntegrationStore, 'get'>
  secrets: IntegrationSecrets
  oauth: IntegrationOAuth
  events: IntegrationConnectionEvents
  fetch?: typeof fetch
}

/** A pasted key as its header: the whole key after the scheme the probe saw. */
function keyAuthorization(integration: Integration, key: string): string {
  return integration.auth.kind === 'bearer' && integration.auth.scheme === 'basic' ? `Basic ${key}` : `Bearer ${key}`
}

/**
 * Each person's connections to the host's integrations (§4): the credential the
 * gateway sends, pasted keys, and disconnect. OAuth sign-in itself is
 * `IntegrationOAuth`'s.
 */
export class IntegrationConnections implements IntegrationCredentials {
  constructor(private readonly deps: IntegrationConnectionsDeps) {}

  async authorizationFor(integrationId: string, credentialUserId: string | null): Promise<string | null> {
    const integration = this.deps.integrations.get(integrationId, ANY_ORGANIZATION)
    if (!integration || integration.auth.kind === 'none') return null
    // A refused credential waits for the person to sign in again.
    if (this.deps.store.get(integrationId, credentialUserId)?.status === 'needs-sign-in') return null
    if (integration.auth.kind === 'bearer') {
      const key = this.deps.secrets.token(integrationId, credentialUserId)
      return key ? keyAuthorization(integration, key.accessToken) : null
    }
    try {
      const token = await this.deps.oauth.refreshIfDue(integrationId, credentialUserId)
      return token ? `Bearer ${token.accessToken}` : null
    } catch (error) {
      log.warn('integration_authorization_failed', { integrationId, error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  markNeedsSignIn(integrationId: string, credentialUserId: string | null, message: string): void {
    const connection = this.deps.store.upsert(integrationId, credentialUserId, { status: 'needs-sign-in', error: message })
    this.deps.events.connectionChanged(credentialUserId, { integrationId, connection })
    log.info('integration_needs_sign_in', { integrationId, credentialUserId })
  }

  statusFor(integrationId: string, credentialUserId: string | null): IntegrationConnection | null {
    return this.deps.store.get(integrationId, credentialUserId)
  }

  /** An anonymous integration needs no sign-in: the person's row says so. */
  connectAnonymous(integration: Integration, credentialUserId: string | null): IntegrationConnection {
    const connection = this.deps.store.upsert(integration.id, credentialUserId, { status: 'connected', error: null })
    this.deps.events.connectionChanged(credentialUserId, { integrationId: integration.id, connection })
    return connection
  }

  /** A `bearer` integration's key, kept only after the server accepted it. Throws a plain message. */
  async submitKey(integration: Integration, credentialUserId: string | null, key: string): Promise<IntegrationConnection> {
    if (integration.auth.kind !== 'bearer') throw new Error('This integration does not take an API key.')
    const identity = await readServerIdentity(integration.url, keyAuthorization(integration, key), this.deps.fetch)
    this.deps.secrets.saveToken(integration.id, credentialUserId, { accessToken: key, tokenType: 'api-key' })
    const connection = this.deps.store.upsert(integration.id, credentialUserId, {
      status: 'connected',
      label: identity.label,
      info: identity.label ? { displayName: identity.label } : null,
      error: null,
    })
    this.deps.events.connectionChanged(credentialUserId, { integrationId: integration.id, connection })
    log.info('integration_key_connected', { integrationId: integration.id, credentialUserId })
    return connection
  }

  /** Removes the person's token and row; revokes an OAuth token when the server names a revocation endpoint. */
  async disconnect(integration: Integration, credentialUserId: string | null): Promise<boolean> {
    const token = this.deps.secrets.token(integration.id, credentialUserId)
    this.deps.secrets.removeToken(integration.id, credentialUserId)
    const removed = this.deps.store.remove(integration.id, credentialUserId)
    this.deps.events.connectionChanged(credentialUserId, { integrationId: integration.id, connection: null })
    if (token && integration.auth.kind === 'oauth') await this.deps.oauth.revoke(integration, token)
    log.info('integration_disconnected', { integrationId: integration.id, credentialUserId })
    return removed || token !== null
  }

  /** The integration was removed: every person's row and token, and the host's client for it. */
  removeAllFor(integrationId: string): void {
    for (const credentialUserId of this.deps.store.removeAllFor(integrationId)) this.deps.secrets.removeToken(integrationId, credentialUserId)
    this.deps.secrets.removeClient(integrationId)
  }
}
