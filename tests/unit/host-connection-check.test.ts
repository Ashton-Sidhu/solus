import { describe, expect, test } from 'bun:test'
import { readAddress, runConnectionCheck } from '@solus/client-core/host-connection-check'
import type { HostRoute } from '@solus/contracts/host-routes'

// A browser hides a Cloudflare error page, because it has no CORS headers. The check
// must still tell "something answered" from "nothing answered", and mobile must keep
// the status (docs/plans/host-readiness.md).

const signal = () => new AbortController().signal
const response = (status: number) => new Response(null, { status })

/** A browser: an answer without CORS headers rejects, unless the read is `no-cors`. */
function browserFetch(answers: boolean): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    if (answers && init?.mode === 'no-cors') return new Response(null)
    throw new TypeError('Failed to fetch')
  }) as unknown as typeof fetch
}

describe('readAddress', () => {
  test('a client that reads the status keeps it', async () => {
    const fetchImpl = (async () => response(530)) as unknown as typeof fetch
    expect(await readAddress(fetchImpl, 'https://h.solus.sh/health', signal())).toEqual({ kind: 'status', status: 530 })
  })

  test('a browser that cannot read the answer still knows something answered', async () => {
    expect(await readAddress(browserFetch(true), 'https://h.solus.sh/health', signal())).toEqual({ kind: 'opaque' })
  })

  test('nothing at the address is no answer', async () => {
    expect(await readAddress(browserFetch(false), 'https://h.solus.sh/health', signal())).toEqual({ kind: 'no-answer' })
  })

  test('a read that ran out of time says so, and does not read again', async () => {
    const controller = new AbortController()
    let reads = 0
    const fetchImpl = (async () => {
      reads += 1
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch
    expect(await readAddress(fetchImpl, 'https://h.solus.sh/health', controller.signal)).toEqual({ kind: 'timeout' })
    expect(reads).toBe(1)
  })
})

describe('runConnectionCheck', () => {
  const routes: HostRoute[] = [{ kind: 'lan', url: 'http://10.0.0.2:4000' }, { kind: 'tunnel', url: 'https://h.solus.sh' }]

  test('a 200 is the host only when the saved identity says so', async () => {
    // WHY: a captive page answers 200 too. Only the identity check names the host.
    const fetchImpl = (async () => response(200)) as unknown as typeof fetch
    const check = await runConnectionCheck({
      routes,
      cloudUrl: 'https://app.solus.sh',
      fetchImpl,
      answersAsHost: async (url) => url === 'https://h.solus.sh',
      now: () => 7,
    })
    expect(check.at).toBe(7)
    expect(check.routes.map((route) => route.answer.kind)).toEqual(['unproven', 'host'])
  })

  test('reads the public OIDC document of Solus Cloud, and no cloud when none is known', async () => {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(url)
      return response(200)
    }) as unknown as typeof fetch
    const check = await runConnectionCheck({ routes: [], cloudUrl: 'https://app.solus.sh', fetchImpl, answersAsHost: async () => true })
    expect(urls).toEqual(['https://app.solus.sh/.well-known/openid-configuration'])
    expect(check.cloud).toEqual({ kind: 'status', status: 200 })
    expect((await runConnectionCheck({ routes: [], cloudUrl: null, fetchImpl, answersAsHost: async () => true })).cloud).toBeNull()
  })
})
