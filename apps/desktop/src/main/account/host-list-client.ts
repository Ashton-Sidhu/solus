import { hostListCloudRequests, type HostListCloudRequests } from '@solus/client-core/host-list-requests'
import type { CloudRequester } from './uplink-client'

/**
 * The account host list calls (plans/031 D7), made by main because main holds the
 * account session, as the agent profile calls are (`agent-profile-client.ts`). The
 * renderer receives decoded results through three narrow IPC methods.
 */
export function desktopHostListRequests(client: CloudRequester & { readonly isSignedIn: boolean }): HostListCloudRequests {
  return hostListCloudRequests(async (request) => {
    if (!client.isSignedIn) return 'signed-out'
    return client.cloudRequest(request.path, {
      method: request.method,
      headers: request.body ? { 'content-type': 'application/json' } : {},
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
  })
}
