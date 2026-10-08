import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { ConnectionProvider, ConnectionReason } from '@solus/contracts/connections'

/**
 * The one place the renderer knows that an agent is waiting on a connection.
 *
 * It owns the *interrupt*, not the credential: each provider keeps its own
 * store for status and connecting, and this only decides whether a card is up,
 * for which conversation, and about which account. No token passes through it.
 */

/** An account Solus knows by name: GitHub, Atlassian, Cloudflare, Google. */
export interface AccountConnectRequest {
  kind: 'account'
  accountConnectionsUrl?: string
  serverId: string
  sessionId: string
  provider: ConnectionProvider
  reason: ConnectionReason
}

/** The caller's own sign-in to an integration (docs/plans/mcp-integrations.md §4.1 rule 2). */
export interface IntegrationConnectRequest {
  kind: 'integration'
  serverId: string
  sessionId: string
  integrationId: string
  integrationName: string
}

export type ConnectRequest = AccountConnectRequest | IntegrationConnectRequest

export class ConnectRequestStore {
  /** One at a time. A second request replaces the first: two cards stacked at
   *  the tail of a transcript is noise, and the agent asks again if it still
   *  needs the other one. */
  request = $state<ConnectRequest | null>(null)

  visibleFor(serverId: string | undefined, sessionId: string): boolean {
    const request = this.request
    return request !== null && request.serverId === serverId && request.sessionId === sessionId
  }

  dismiss(): void {
    this.request = null
  }

  /**
   * Called once at boot. An agent can need an account before any surface that
   * would show its status has been opened, so this is heard app-wide rather
   * than by the card.
   */
  listen(): () => void {
    const stopAccounts = subscribeAllHosts('connection.connectNeeded', (serverId, event) => {
      this.request = {
        kind: 'account',
        serverId,
        accountConnectionsUrl: event.accountConnectionsUrl,
        sessionId: event.sessionId,
        provider: event.provider,
        reason: event.reason,
      }
    })
    const stopIntegrations = subscribeAllHosts('integration.connectNeeded', (serverId, event) => {
      this.request = {
        kind: 'integration',
        serverId,
        sessionId: event.sessionId,
        integrationId: event.integrationId,
        integrationName: event.integrationName,
      }
    })
    return () => {
      stopAccounts()
      stopIntegrations()
    }
  }
}

export const connectRequestStore = new ConnectRequestStore()
