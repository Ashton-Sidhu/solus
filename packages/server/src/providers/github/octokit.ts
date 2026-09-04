import { Octokit } from '@octokit/rest'
import { graphql as octokitGraphql } from '@octokit/graphql'
import { z } from 'zod'
import { createLogger } from '../../logger'
import { clearToken } from './token-store'
import type { GithubCredential } from './credentials'
import type { GitHubAuth } from './auth'

const log = createLogger('main', 'github-octokit')

type GraphQLParameters = NonNullable<Parameters<typeof octokitGraphql>[1]>

/** The query form of Octokit's GraphQL client. Solus never uses its
 *  endpoint-options form, so the 401 policy below wraps this one call shape. */
export type GraphQLClient = <ResponseData>(query: string, parameters?: GraphQLParameters) => Promise<ResponseData>

export interface GitHubClient {
  rest: Octokit
  graphql: GraphQLClient
  /** What every request from this client is signed with. */
  credential: GithubCredential
}

/** Thrown when GitHub rejects a credential with 401, so consumers can move to
 *  the next credential or surface "reconnect GitHub". */
export class GitHubReauthRequiredError extends Error {
  constructor() {
    super('Your GitHub authorization is no longer valid. Reconnect GitHub to continue.')
    this.name = 'GitHubReauthRequiredError'
  }
}

const unauthorizedSchema = z.object({ status: z.literal(401) })
const credentialAccessFailureSchema = z.object({ status: z.union([z.literal(403), z.literal(404)]) })
const graphqlCredentialAccessFailureSchema = z.object({
  errors: z.array(z.object({
    type: z.union([z.literal('FORBIDDEN'), z.literal('NOT_FOUND')]),
  })).nonempty(),
})
const githubFailureSchema = z.object({
  status: z.number().optional(),
  errors: z.array(z.object({ type: z.string() })).optional(),
})

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function failureFacts(error: unknown): { status: number | null; errorTypes: string[] } {
  const parsed = githubFailureSchema.safeParse(error)
  return parsed.success
    ? {
        status: parsed.data.status ?? null,
        errorTypes: parsed.data.errors?.map(({ type }) => type) ?? [],
      }
    : { status: null, errorTypes: [] }
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url.split('?')[0]
  }
}

function graphqlOperation(document: string): string {
  return /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(document)?.[1] ?? 'anonymous'
}

/** True when GitHub rejected this credential rather than the operation itself.
 * REST reports status 403/404. GraphQL returns HTTP 200 and puts FORBIDDEN or
 * repository-hiding NOT_FOUND in its errors array, so both shapes must advance
 * the same credential chain. */
export function isGithubCredentialAccessFailure<Failure>(error: Failure): boolean {
  return error instanceof GitHubReauthRequiredError
    || credentialAccessFailureSchema.safeParse(error).success
    || graphqlCredentialAccessFailureSchema.safeParse(error).success
}

// One client per token for the process lifetime: concurrent reads share one
// instance, and a token that GitHub rejects is dropped so the next request
// rebuilds against whatever credential replaces it.
const clientsByToken = new Map<string, GitHubClient>()

/** REST + GraphQL clients signed with one credential. */
export function clientFor(credential: GithubCredential): GitHubClient {
  const cached = clientsByToken.get(credential.token)
  if (cached) return cached
  const client = createClient(credential)
  clientsByToken.set(credential.token, client)
  return client
}

/** The client for the account this host is connected as. */
export async function buildClient(auth: GitHubAuth): Promise<GitHubClient> {
  return clientFor({ source: 'host', token: await auth.getAccessToken() })
}

/**
 * A 401 from any call means the credential was revoked or expired. The host's
 * own token is cleared so the connection reads as broken; a delegated or `gh`
 * credential is only forgotten here, because clearing the host's token over
 * someone else's expiry would break the host owner's connection.
 */
function createClient(credential: GithubCredential): GitHubClient {
  const rejected = (): never => {
    clientsByToken.delete(credential.token)
    if (credential.source === 'host') {
      log.warn('github_unauthorized_token_cleared')
      clearToken()
    } else {
      log.warn('github_unauthorized_credential', { source: credential.source })
    }
    throw new GitHubReauthRequiredError()
  }

  const rest = new Octokit({ auth: credential.token, userAgent: 'Solus' })
  rest.hook.before('request', (options) => {
    log.info('github_rest_request_started', {
      source: credential.source,
      method: options.method,
      path: requestPath(options.url),
    })
  })
  rest.hook.error('request', (error) => {
    const facts = failureFacts(error)
    log.warn('github_rest_request_failed', {
      source: credential.source,
      status: facts.status,
      error: errorMessage(error),
    })
    if (unauthorizedSchema.safeParse(error).success) rejected()
    throw error
  })

  const query = octokitGraphql.defaults({
    headers: { authorization: `Bearer ${credential.token}`, 'user-agent': 'Solus' },
  })
  const graphql: GraphQLClient = async <ResponseData>(
    document: string,
    parameters?: GraphQLParameters,
  ): Promise<ResponseData> => {
    const operation = graphqlOperation(document)
    log.info('github_graphql_request_started', { source: credential.source, operation })
    try {
      return await query<ResponseData>(document, parameters)
    } catch (error) {
      const facts = failureFacts(error)
      log.warn('github_graphql_request_failed', {
        source: credential.source,
        operation,
        status: facts.status,
        errorTypes: facts.errorTypes,
        error: errorMessage(error),
      })
      if (unauthorizedSchema.safeParse(error).success) rejected()
      throw error
    }
  }

  return { rest, graphql, credential }
}
