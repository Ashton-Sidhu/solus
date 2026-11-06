import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { ConnectionProvider, ConnectionReason } from '@solus/contracts/connections'
import type { Integration } from '@solus/contracts/integration-types'

/**
 * The one place the renderer knows that an agent is waiting on a connection.
 *
 * It owns the *interrupt*, not the credential: each provider keeps its own
 * store for status and connecting, and this only decides which cards are up,
 * for which conversation, and about which accounts. No token passes through it.
 */

/** An account Solus knows by name: GitHub, Atlassian, Google. */
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

/** A server that is not in the catalog: the person enters its address, then it is an integration request. */
export interface CustomServerConnectRequest {
  kind: 'custom-server'
  serverId: string
  sessionId: string
  name?: string
  url?: string
}

export type ConnectRequest = AccountConnectRequest | IntegrationConnectRequest | CustomServerConnectRequest

/** The service a request asks for. A second ask for the same service in a session is the same request. */
export function connectRequestKey(request: ConnectRequest): string {
  if (request.kind === 'custom-server') return 'custom-server'
  return request.kind === 'integration' ? `integration:${request.integrationId}` : `account:${request.provider}`
}

function sameSession(request: ConnectRequest, serverId: string | undefined, sessionId: string): boolean {
  return request.serverId === serverId && request.sessionId === sessionId
}

export class ConnectRequestStore {
  /** Every open request, in the order the agents asked. A turn that needs
   *  several services gets one group card that lists each of them; a repeated
   *  ask for a service already listed replaces its row in place. */
  requests = $state<ConnectRequest[]>([])

  requestsFor(serverId: string | undefined, sessionId: string): ConnectRequest[] {
    return this.requests.filter((request) => sameSession(request, serverId, sessionId))
  }

  visibleFor(serverId: string | undefined, sessionId: string): boolean {
    return this.requests.some((request) => sameSession(request, serverId, sessionId))
  }

  /** Retires the card of one conversation. */
  dismiss(serverId: string | undefined, sessionId: string): void {
    for (let index = this.requests.length - 1; index >= 0; index--) {
      if (sameSession(this.requests[index], serverId, sessionId)) this.requests.splice(index, 1)
    }
  }

  /** The address was added: the row goes on as that server's sign-in. */
  customServerAdded(request: CustomServerConnectRequest, integration: Pick<Integration, 'id' | 'name'>): void {
    const index = this.requests.findIndex((open) => open.kind === 'custom-server' && sameSession(open, request.serverId, request.sessionId))
    if (index === -1) return
    this.requests[index] = { kind: 'integration', serverId: request.serverId, sessionId: request.sessionId, integrationId: integration.id, integrationName: integration.name }
  }

  private add(request: ConnectRequest): void {
    const key = connectRequestKey(request)
    const index = this.requests.findIndex(
      (open) => sameSession(open, request.serverId, request.sessionId) && connectRequestKey(open) === key,
    )
    if (index === -1) this.requests.push(request)
    else this.requests[index] = request
  }

  /**
   * Called once at boot. An agent can need an account before any surface that
   * would show its status has been opened, so this is heard app-wide rather
   * than by the card.
   */
  listen(): () => void {
    const stopAccounts = subscribeAllHosts('connection.connectNeeded', (serverId, event) => {
      this.add({
        kind: 'account',
        serverId,
        accountConnectionsUrl: event.accountConnectionsUrl,
        sessionId: event.sessionId,
        provider: event.provider,
        reason: event.reason,
      })
    })
    const stopIntegrations = subscribeAllHosts('integration.connectNeeded', (serverId, event) => {
      this.add({
        kind: 'integration',
        serverId,
        sessionId: event.sessionId,
        integrationId: event.integrationId,
        integrationName: event.integrationName,
      })
    })
    const stopCustomServers = subscribeAllHosts('integration.customServerNeeded', (serverId, event) => {
      this.add({ kind: 'custom-server', serverId, ...event })
    })
    return () => {
      stopAccounts()
      stopIntegrations()
      stopCustomServers()
    }
  }
}

export const connectRequestStore = new ConnectRequestStore()
