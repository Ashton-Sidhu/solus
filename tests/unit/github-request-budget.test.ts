import { afterEach, describe, expect, test } from 'bun:test'
import { clientFor } from '@solus/server/providers/github/octokit'
import { GitHubRateLimitedError } from '@solus/server/providers/github/rate-limit'
import { asBackgroundWork, RequestBudget, withRequestSlot } from '@solus/server/providers/github/request-budget'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const RESET_SECONDS = Math.floor(Date.now() / 1000) + 3600

function quotaHeaders(resource: string, remaining: number, reset = RESET_SECONDS): Headers {
  return new Headers({
    'x-ratelimit-resource': resource,
    'x-ratelimit-limit': '5000',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(reset),
  })
}

interface SentRequest {
  url: string
  ifNoneMatch: string | null
}

/** Answer every request from `answer`, and record what was sent. */
function serveGitHub(answer: (request: SentRequest) => Response): SentRequest[] {
  const sent: SentRequest[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const request = { url: String(input), ifNoneMatch: headers.get('if-none-match') }
    sent.push(request)
    return answer(request)
  }) as typeof fetch
  return sent
}

describe('GitHub request budget', () => {
  test('background work stops before it spends the last tenth of a quota; a person still gets through', () => {
    const budget = new RequestBudget()
    budget.observe(quotaHeaders('graphql', 499))

    expect(() => budget.admit('graphql')).not.toThrow()
    return asBackgroundWork(async () => {
      expect(() => budget.admit('graphql')).toThrow(GitHubRateLimitedError)
      // Another resource has its own quota.
      expect(() => budget.admit('core')).not.toThrow()
    })
  })

  test('the reserve is only held until the quota resets', () => {
    let now = Date.now()
    const budget = new RequestBudget(() => now)
    budget.observe(quotaHeaders('core', 10))
    now = RESET_SECONDS * 1000 + 1
    return asBackgroundWork(async () => {
      expect(() => budget.admit('core')).not.toThrow()
    })
  })

  test('a late answer from an older window does not hide a spent quota', () => {
    const budget = new RequestBudget()
    budget.observe(quotaHeaders('core', 10))
    budget.observe(quotaHeaders('core', 4000))
    budget.observe(quotaHeaders('core', 4000, RESET_SECONDS - 3600))
    return asBackgroundWork(async () => {
      expect(() => budget.admit('core')).toThrow(GitHubRateLimitedError)
    })
  })

  test('at most eight requests are in flight at once', async () => {
    let inFlight = 0
    let most = 0
    const releases: Array<() => void> = []
    const sends = Array.from({ length: 12 }, () => withRequestSlot(async () => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise<void>((resolve) => releases.push(resolve))
      inFlight--
    }))
    while (releases.length < 8) await Promise.resolve()
    expect(most).toBe(8)
    while (releases.length) {
      releases.shift()?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    await Promise.all(sends)
    expect(most).toBe(8)
  })
})

describe('GitHub client', () => {
  test('a repeated REST read is revalidated, and a 304 returns the remembered answer', async () => {
    const sent = serveGitHub(({ ifNoneMatch }) => ifNoneMatch === '"v1"'
      ? new Response(null, { status: 304, headers: quotaHeaders('core', 4000) })
      : Response.json([{ number: 7 }], { headers: { etag: '"v1"', ...Object.fromEntries(quotaHeaders('core', 4001)) } }))
    const { rest } = clientFor({ source: 'gh-cli', token: 'conditional-token' })

    const first = await rest.pulls.list({ owner: 'solus', repo: 'app' })
    first.data[0].number = 99
    const second = await rest.pulls.list({ owner: 'solus', repo: 'app' })

    expect(sent.map(({ ifNoneMatch }) => ifNoneMatch)).toEqual([null, '"v1"'])
    expect(second.data.map(({ number }) => number)).toEqual([7])
  })

  test('a PR sync tick does not send GraphQL once the quota is nearly spent', async () => {
    const sent = serveGitHub(() => Response.json({ data: { viewer: { login: 'octo' } } }, { headers: quotaHeaders('graphql', 100) }))
    const { graphql } = clientFor({ source: 'gh-cli', token: 'reserve-token' })

    await graphql('query Viewer { viewer { login } }')
    await expect(asBackgroundWork(() => graphql('query Viewer { viewer { login } }'))).rejects.toBeInstanceOf(GitHubRateLimitedError)
    await graphql('query Viewer { viewer { login } }')

    expect(sent).toHaveLength(2)
  })
})
