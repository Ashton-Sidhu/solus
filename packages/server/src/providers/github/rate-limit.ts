import { z } from 'zod'

/**
 * GitHub refused a request because the account's quota is spent. This is not
 * a credential failure: the next credential is often the same account through
 * `gh`, and it shares the quota. `retryAt` is when GitHub says to try again,
 * in epoch milliseconds, or null when it did not say.
 */
export class GitHubRateLimitedError extends Error {
  constructor(readonly retryAt: number | null) {
    super(retryAt === null
      ? 'GitHub rate limit reached. Try again later.'
      : `GitHub rate limit reached. Try again after ${new Date(retryAt).toISOString()}.`)
    this.name = 'GitHubRateLimitedError'
  }
}

const headerValueSchema = z.union([z.string(), z.number()]).optional()
const rateLimitHeadersSchema = z.object({
  'retry-after': headerValueSchema,
  'x-ratelimit-remaining': headerValueSchema,
  'x-ratelimit-reset': headerValueSchema,
})
type RateLimitHeaders = z.output<typeof rateLimitHeadersSchema>

/** A REST response (or a GraphQL HTTP failure) with its headers. */
const httpFailureSchema = z.object({
  status: z.union([z.literal(403), z.literal(429)]),
  response: z.object({ headers: rateLimitHeadersSchema }),
})
/** A GraphQL answer: HTTP 200 with the limit in its errors array. */
const graphqlFailureSchema = z.object({
  errors: z.array(z.object({ type: z.string().optional() })),
  headers: rateLimitHeadersSchema.optional(),
})

function retryAtOf(headers: RateLimitHeaders, now: number): number | null {
  const retryAfter = Number(headers['retry-after'])
  if (headers['retry-after'] !== undefined && Number.isFinite(retryAfter)) return now + retryAfter * 1000
  const reset = Number(headers['x-ratelimit-reset'])
  if (headers['x-ratelimit-reset'] !== undefined && Number.isFinite(reset) && reset > 0) return reset * 1000
  return null
}

/**
 * The rate limit this failure reports, or null when it is another failure.
 * REST and secondary limits are a 403 or 429 with `x-ratelimit-remaining: 0`
 * or `retry-after`; a 403 without them is about the credential. GraphQL
 * reports its primary limit as a `RATE_LIMITED` error.
 */
export function githubRateLimitOf<Failure>(error: Failure, now = Date.now()): GitHubRateLimitedError | null {
  if (error instanceof GitHubRateLimitedError) return error
  const http = httpFailureSchema.safeParse(error)
  if (http.success) {
    const headers = http.data.response.headers
    const spent = headers['x-ratelimit-remaining'] !== undefined && Number(headers['x-ratelimit-remaining']) === 0
    return spent || headers['retry-after'] !== undefined ? new GitHubRateLimitedError(retryAtOf(headers, now)) : null
  }
  const graphql = graphqlFailureSchema.safeParse(error)
  if (graphql.success && graphql.data.errors.some(({ type }) => type === 'RATE_LIMITED')) {
    return new GitHubRateLimitedError(retryAtOf(graphql.data.headers ?? {}, now))
  }
  return null
}
