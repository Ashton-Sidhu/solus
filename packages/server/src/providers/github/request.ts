import { createLogger, type Logger } from '../../logger'
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
  requestLogger: Logger = log,
): Promise<Result> {
  if (clients.length === 0) {
    requestLogger.error('github_request_failed', {
      operation,
      host,
      attemptedSources: [],
      reason: 'no_credentials',
      error: 'GitHub is not connected',
    })
    throw new Error('GitHub is not connected')
  }
  let rejected: Error | null = null
  for (let index = 0; index < clients.length; index++) {
    const client = clients[index]
    requestLogger.info('github_request_attempt_started', {
      operation,
      host,
      source: client.credential.source,
      attempt: index + 1,
      attemptCount: clients.length,
    })
    try {
      return await run(client)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!isGithubCredentialAccessFailure(error)) {
        requestLogger.error('github_request_failed', {
          operation,
          host,
          source: client.credential.source,
          attemptedSources: clients.slice(0, index + 1).map(({ credential }) => credential.source),
          reason: 'operation_failed',
          error: message,
        })
        throw error
      }
      const next = clients[index + 1]
      requestLogger.warn('github_credential_rejected', {
        operation,
        host,
        source: client.credential.source,
        nextSource: next?.credential.source ?? null,
        error: message,
      })
      rejected = error instanceof Error ? error : new Error(String(error))
      if (next) {
        requestLogger.info('github_credential_fallback_started', {
          operation,
          host,
          failedSource: client.credential.source,
          nextSource: next.credential.source,
        })
      } else {
        requestLogger.error('github_request_failed', {
          operation,
          host,
          source: client.credential.source,
          attemptedSources: clients.map(({ credential }) => credential.source),
          reason: 'credentials_rejected',
          error: message,
        })
      }
    }
  }
  throw rejected ?? new Error('GitHub is not connected')
}
