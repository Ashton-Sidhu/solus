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
  if (request.kind === 'integration')
    return integrationsStore.connection(request.serverId, request.integrationId)?.status === 'connected' ? 'connected' : 'pending'
  if (request.accountConnectionsUrl) return 'external'
  if (request.provider === 'atlassian') return atlassianStore.connected(request.serverId) ? 'connected' : 'pending'
  if (request.provider === 'github')
    return connectionsStore.providerLoaded && connectionsStore.providerStatus?.connected ? 'connected' : 'pending'
  return 'pending'
}
