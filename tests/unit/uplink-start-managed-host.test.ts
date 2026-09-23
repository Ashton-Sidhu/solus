import { describe, expect, test } from 'bun:test'
import { cookieUplinkAccountSource } from '@solus/client-core/uplink-session'

// docs/plans/project-model.md §6: a member's cloud work routes to the Cloud host
// when their machines are off, and a stopped Cloud host is started on Send. On the
// cloud-served web client the account cookie makes that call.

describe('starting a managed host from the web client', () => {
  test('posts to the host start route on the serving origin and answers the lifecycle', async () => {
    const calls: Array<{ url: string; method: string | undefined }> = []
    const source = cookieUplinkAccountSource('https://app.solus.test', async (input, init) => {
      calls.push({ url: String(input), method: init?.method })
      return new Response(JSON.stringify({ lifecycle: 'starting' }), { status: 200 })
    })

    expect(await source.startManagedHost('host_123')).toBe('starting')
    expect(calls).toEqual([{ url: 'https://app.solus.test/v1/hosts/host_123/start', method: 'POST' }])
  })

  test('a refusal reads as no answer, never as a running host', async () => {
    const source = cookieUplinkAccountSource('https://app.solus.test', async () => new Response('{}', { status: 403 }))
    expect(await source.startManagedHost('host_123')).toBeNull()
  })
})
