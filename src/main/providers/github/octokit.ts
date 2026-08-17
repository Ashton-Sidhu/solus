import { Octokit } from '@octokit/rest'
import { graphql as octokitGraphql } from '@octokit/graphql'
import { createLogger } from '../../logger'
import { clearToken } from './token-store'
import type { GitHubAuth } from './auth'

const log = createLogger('main', 'github-octokit')

export type GraphQLClient = typeof octokitGraphql

export interface GitHubClient {
  rest: Octokit
  graphql: GraphQLClient
}

/** Thrown after a 401 clears the stored token, so consumers can surface "reconnect GitHub". */
export class GitHubReauthRequiredError extends Error {
  constructor() {
    super('Your GitHub authorization is no longer valid. Reconnect GitHub to continue.')
    this.name = 'GitHubReauthRequiredError'
  }
}

// Each provider method calls buildClient(), so a single Activity load built 4-5
// Octokit instances for the same token. Memoize the client per token: concurrent
// reads share one instance, and it's rebuilt only when the token changes (or a
// 401 invalidates it). Module-scoped because the token is global, not per-auth.
let cachedClient: { token: string; client: GitHubClient } | null = null

/**
 * Build (or reuse) REST + GraphQL clients authenticated as the connected user. A
 * 401 from any call means the token was revoked or expired: we clear it and
 * throw GitHubReauthRequiredError rather than leaking a raw Octokit error, so
 * the consuming layer can prompt a reconnect.
 */
export async function buildClient(auth: GitHubAuth): Promise<GitHubClient> {
  const token = await auth.getAccessToken()
  if (cachedClient && cachedClient.token === token) return cachedClient.client

  const client = createClient(token, () => {
    log.warn('github_unauthorized_token_cleared')
    clearToken()
    // Drop the now-invalid client so the next call rebuilds against a fresh token.
    cachedClient = null
  })
  cachedClient = { token, client }
  return client
}

/**
 * A client for a credential Solus holds on someone else's behalf — a paired
 * device's delegated token. Deliberately uncached and, more importantly, it
 * does not `clearToken()` on a 401: that would wipe the *host owner's*
 * credential because a dispatching device's token had expired.
 */
export function buildDelegatedClient(token: string): GitHubClient {
  return createClient(token, () => log.warn('github_unauthorized_delegated_credential'))
}

function createClient(token: string, onUnauthorized: () => void): GitHubClient {
  const rest = new Octokit({ auth: token, userAgent: 'Solus' })
  rest.hook.error('request', (error) => {
    // SAFETY: Octokit's request-error hook supplies RequestError values with a numeric status.
    if ((error as { status?: number }).status === 401) {
      onUnauthorized()
      throw new GitHubReauthRequiredError()
    }
    throw error
  })

  const graphql = octokitGraphql.defaults({
    headers: { authorization: `Bearer ${token}`, 'user-agent': 'Solus' },
  })

  return { rest, graphql }
}
