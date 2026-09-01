import { subscribeAllHosts } from '@solus/client-core/host-events'
import type { ConnectionProvider, ConnectionReason } from '@solus/contracts/connections'

/**
 * The one place the renderer knows that an agent is waiting on a connection.
 *
 * It owns the *interrupt*, not the credential: each provider keeps its own
 * store for status and connecting, and this only decides whether a card is up,
 * for which conversation, and about which account. No token passes through it.
 */

export interface ConnectRequest {
  serverId: string
  sessionId: string
  provider: ConnectionProvider
  reason: ConnectionReason
}

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
    return subscribeAllHosts('connection.connectNeeded', (serverId, event) => {
      this.request = {
        serverId,
        sessionId: event.sessionId,
        provider: event.provider,
        reason: event.reason,
      }
    })
  }
}

export const connectRequestStore = new ConnectRequestStore()
