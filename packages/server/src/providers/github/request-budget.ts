import { AsyncLocalStorage } from 'node:async_hooks'
import { GitHubRateLimitedError } from './rate-limit'

/** Background work leaves this share of an account's hourly quota for the
 *  requests a person waits on. */
const RESERVE_RATIO = 0.1
/** GitHub's secondary limits punish bursts of concurrent requests, so the
 *  process sends at most this many at a time, for every account. */
const CONCURRENT_REQUESTS = 8

const background = new AsyncLocalStorage<true>()

/** Run work that no person waits on, such as a PR sync tick. Its GitHub
 *  requests stop before they spend the reserve. */
export function asBackgroundWork<Result>(work: () => Promise<Result>): Promise<Result> {
  return background.run(true, work)
}

interface Quota {
  limit: number
  remaining: number
  /** Epoch milliseconds. */
  resetAt: number
}

/**
 * What one account has left of each GitHub quota, as its last answers said.
 * Every answer carries `x-ratelimit-*` headers for its resource (`core`,
 * `graphql`, `search`, ...), so the quota is known before it is spent, not
 * only after GitHub refuses a request.
 */
export class RequestBudget {
  private readonly quotas = new Map<string, Quota>()

  constructor(private readonly now: () => number = Date.now) {}

  /** `fetch` that records each answer's quota headers. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await globalThis.fetch(input, init)
    this.observe(response.headers)
    return response
  }

  observe(headers: Headers): void {
    const resource = headers.get('x-ratelimit-resource')
    const limit = Number(headers.get('x-ratelimit-limit'))
    const remaining = Number(headers.get('x-ratelimit-remaining'))
    const resetAt = Number(headers.get('x-ratelimit-reset')) * 1000
    if (!resource || !(limit > 0) || !Number.isFinite(remaining) || !(resetAt > 0)) return
    const known = this.quotas.get(resource)
    // Answers can arrive out of order: an older window, or a higher count from
    // the same window, is stale.
    if (known && (resetAt < known.resetAt || (resetAt === known.resetAt && remaining > known.remaining))) return
    this.quotas.set(resource, { limit, remaining, resetAt })
  }

  /** Refuse background work that would spend the reserve of `resource`,
   *  until the quota resets. A person's request is always sent. */
  admit(resource: string): void {
    if (!background.getStore()) return
    const quota = this.quotas.get(resource)
    if (!quota || quota.resetAt <= this.now()) return
    if (quota.remaining < quota.limit * RESERVE_RATIO) throw new GitHubRateLimitedError(quota.resetAt)
  }
}

/** The quota a REST path spends. */
export function restResourceOf(url: string): string {
  return /\/search\//.test(url) ? 'search' : 'core'
}

let activeRequests = 0
const waitingRequests: Array<() => void> = []

/** Send one request when fewer than `CONCURRENT_REQUESTS` are in flight. */
export async function withRequestSlot<Result>(send: () => Promise<Result>): Promise<Result> {
  // A finished request hands its slot to the next waiter, so the count only
  // changes when nobody waits.
  if (activeRequests >= CONCURRENT_REQUESTS) await new Promise<void>((resolve) => waitingRequests.push(resolve))
  else activeRequests++
  try {
    return await send()
  } finally {
    const next = waitingRequests.shift()
    if (next) next()
    else activeRequests--
  }
}
