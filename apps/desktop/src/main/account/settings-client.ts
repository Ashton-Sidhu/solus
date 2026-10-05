import { settingsCloudRequests, type SettingsCloudRequests } from '@solus/client-core/settings-requests'
import type { CloudRequester } from './uplink-client'

/**
 * The account settings and organization settings calls (plans/018 §4), made by
 * main because main holds the account session. The renderer receives decoded
 * results through five narrow IPC methods, never the token and never a general
 * authenticated fetch.
 */
export function desktopSettingsRequests(client: CloudRequester & { readonly isSignedIn: boolean }): SettingsCloudRequests {
  return settingsCloudRequests(async (request) => {
    if (!client.isSignedIn) return 'signed-out'
    return client.cloudRequest(request.path, {
      method: request.method,
      headers: request.body ? { 'content-type': 'application/json' } : {},
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
  })
}
