import { createLogger } from '../../logger'
import { githubCredentialChain } from './credentials'
import { clientFor, isGithubCredentialAccessFailure, type GitHubClient } from './octokit'

const log = createLogger('main', 'github-provider')

/** REST and GraphQL clients in the one GitHub credential order. */
export async function githubClients(host: string, credentialCwd?: string): Promise<GitHubClient[]> {
  return (await githubCredentialChain(host, credentialCwd)).map(clientFor)
}

/**
 * Run one GitHub operation with the first credential GitHub accepts.
 *
 * A 401, 403, or repository-hiding 404 is about the credential, so the same
 * operation moves to the next account. Validation and domain failures remain
 * final. `gh auth` is the last credential in the chain, not a second transport.
 */
export async function runGithubRequest<Result>(
  operation: string,
  host: string,
  clients: GitHubClient[],
  run: (client: GitHubClient) => Promise<Result>,
): Promise<Result> {
  if (clients.length === 0) throw new Error('GitHub is not connected')
  let rejected: Error | null = null
  for (const client of clients) {
    try {
      return await run(client)
    } catch (error) {
      if (!isGithubCredentialAccessFailure(error)) throw error
      log.warn('github_credential_rejected', { operation, host, source: client.credential.source })
      rejected = error instanceof Error ? error : new Error(String(error))
    }
  }
  throw rejected ?? new Error('GitHub is not connected')
}
