import { connectionsStore } from '../../../contexts'
import { atlassianStore } from '../../../contexts/atlassian/atlassian.store.svelte'
import type { ConnectRequest } from '../../../contexts/connections/connect-request.store.svelte'
import { integrationsStore } from '../../settings/integrations.store.svelte'

/**
 * Where one row of the connect card stands. `external` is a sign-in that ends
 * in the account's own connections page: Solus cannot see it finish, so the
 * person says when it is done with Continue.
 */
export type ConnectRequestStatus = 'pending' | 'connected' | 'external'

/** Reads the provider stores, so a `$derived` that calls it follows them. */
export function connectRequestStatus(request: ConnectRequest): ConnectRequestStatus {
  if (request.kind === 'integration') {
    // A server with no sign-in has no connection record, so its auth is the answer.
    const integration = integrationsStore.states.get(request.serverId)?.integrations?.find((item) => item.id === request.integrationId)
    if (integration?.auth.kind === 'none') return 'connected'
    return integrationsStore.connection(request.serverId, request.integrationId)?.status === 'connected' ? 'connected' : 'pending'
  }
  if (request.kind === 'custom-server') return 'pending'
  if (request.accountConnectionsUrl) return 'external'
  if (request.provider === 'atlassian') return atlassianStore.connected(request.serverId) ? 'connected' : 'pending'
  if (request.provider === 'github')
    return connectionsStore.providerLoaded && connectionsStore.providerStatus?.connected ? 'connected' : 'pending'
  return 'pending'
}
