import { describe, expect, test } from 'bun:test'
import { oauthUplinkAccountSource } from '@solus/client-core/uplink-session'

const session = { accessToken: async () => 'account-token' }
const accountSource = (origin: string, fetchImpl: typeof fetch) => oauthUplinkAccountSource(origin, session, fetchImpl)

// docs/plans/project-model.md §6: a member's cloud work routes to the Cloud host
// when their machines are off, and a stopped Cloud host is started on Send. On the
// cloud-served web client the page's sign-in makes that call with an account-plane token.

describe('starting a managed host from the web client', () => {
  test('posts to the host start route on the serving origin and answers the lifecycle', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = []
    const source = accountSource('https://app.solus.test', (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method })
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer account-token')
      return new Response(JSON.stringify({ lifecycle: 'starting' }), { status: 200 })
    }) as typeof fetch)

    expect(await source.startManagedHost('host_123')).toBe('starting')
    expect(calls).toEqual([{ url: 'https://app.solus.test/v1/hosts/host_123/start', method: 'POST' }])
  })

  test('a refusal reads as no answer, never as a running host', async () => {
    const source = accountSource('https://app.solus.test', (async () => new Response('{}', { status: 403 })) as typeof fetch)
    expect(await source.startManagedHost('host_123')).toBeNull()
  })
})
