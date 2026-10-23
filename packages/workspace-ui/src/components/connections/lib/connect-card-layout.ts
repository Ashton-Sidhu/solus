import type { ConnectionsStatus, IntegrationConnectFlow } from '../../settings/integrations.store.svelte'

export interface IntegrationConnectFacts {
  connectionsStatus: ConnectionsStatus | undefined
  /** The caller has a connection record, so its status has something to say. */
  hasConnection: boolean
  flow: IntegrationConnectFlow | null
  /** The server cannot start a sign-in until an OAuth client is entered. */
  needsClient: boolean
}

/**
 * The card is one line — title, Not now, Connect — when Connect is all there
 * is to do: nothing to report, no sign-in running, and no client to enter.
 * A body under that line would hold only the button.
 */
export function connectsInOneLine(facts: IntegrationConnectFacts): boolean {
  return facts.connectionsStatus === 'loaded' && !facts.hasConnection && !facts.flow && !facts.needsClient
}
