import { agentProfileCloudRequests, type AgentProfileCloudRequests } from '@solus/client-core/agent-profile-requests'
import type { CloudRequester } from './uplink-client'

/**
 * The account agent profile calls (plans/020-agent-profile.md §3), made by main
 * because main holds the account session, as the settings calls are
 * (`settings-client.ts`). The renderer receives decoded results through three
 * narrow IPC methods, never the token and never a general authenticated fetch.
 */
export function desktopAgentProfileRequests(client: CloudRequester & { readonly isSignedIn: boolean }): AgentProfileCloudRequests {
  return agentProfileCloudRequests(async (request) => {
    if (!client.isSignedIn) return 'signed-out'
    return client.cloudRequest(request.path, {
      method: request.method,
      headers: request.body ? { 'content-type': 'application/json' } : {},
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
  })
}
