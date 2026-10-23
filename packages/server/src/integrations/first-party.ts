import { firstPartyClientFor, type AuthorizationServerEndpoints, type FirstPartyClientId } from '@solus/contracts/first-party-clients'
import type { OAuthClient } from '@solus/contracts/integrations/oauth-protocol'
import { GOOGLE_CLIENT_ID } from '../google/client-id'
import { GOOGLE_CLIENT_SECRET } from '../google/client-secret'
import { GITHUB_CLIENT_ID } from '../providers/github/client-id'

/**
 * This build's first-party clients (docs/plans/mcp-integrations.md §13.1). A
 * build without a client's ID (a development build) has none, and the person
 * enters their own client as before.
 */
export function hasFirstPartyClient(id: FirstPartyClientId): boolean {
  return id === 'github' ? GITHUB_CLIENT_ID !== '' : GOOGLE_CLIENT_ID !== '' && GOOGLE_CLIENT_SECRET !== ''
}

/** The first-party client an authorization server's endpoints name for the server at `url`, when this build has it and may serve that server. */
export function firstPartyFor(server: AuthorizationServerEndpoints, url: string): FirstPartyClientId | undefined {
  const client = firstPartyClientFor(server)
  return client && hasFirstPartyClient(client.id) && client.serves(url) ? client.id : undefined
}

/**
 * The OAuth client a first-party sign-in runs with. Only Google's goes through
 * the integration's OAuth flow: a Google desktop app's secret is not
 * confidential and ships with the build, as the Google connection's does
 * (`google/client-secret.ts`). GitHub's credential is the person's Solus
 * GitHub connection, so it has no client here.
 */
export function firstPartyOAuthClient(id: FirstPartyClientId): OAuthClient | null {
  if (id !== 'google' || !hasFirstPartyClient('google')) return null
  return { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, tokenEndpointAuthMethod: 'client_secret_post', redirectUris: [] }
}
