import { describe, expect, test } from 'bun:test'
import { HostGrantCache } from '@solus/client-core/host-grant-cache'
import { FIRST_PARTY_ACCESS_TOKEN_TTL_SECONDS, type HostAccessTokenResponse } from '@solus/contracts/uplink'

const LIFE = FIRST_PARTY_ACCESS_TOKEN_TTL_SECONDS * 1000
const grant = (token = 'one', expiresAt = LIFE): HostAccessTokenResponse => ({ accessToken: token, hostId: 'host', expiresAt })

describe('account grant cache', () => {
  test('host and organization scopes never share credentials', async () => {
    const cache = new HostGrantCache(() => 0)
    let calls = 0
    const mint = async () => grant(String(++calls))
    expect((await cache.acquire('host', 'org-a', mint))?.accessToken).toBe('1')
    expect((await cache.acquire('host', 'org-b', mint))?.accessToken).toBe('2')
    expect((await cache.acquire('other-host', 'org-a', mint))?.accessToken).toBe('3')
    expect((await cache.acquire('host', 'org-a', mint))?.accessToken).toBe('1')
    expect(calls).toBe(3)
  })

  test('a response with a longer expiry cannot extend caching beyond eight hours', async () => {
    let now = 0
    let calls = 0
    const cache = new HostGrantCache(() => now)
    const mint = async () => { calls++; return grant('token', 2 * LIFE) }
    expect((await cache.acquire('host', undefined, mint))?.expiresAt).toBe(LIFE)
    now = LIFE
    await cache.acquire('host', undefined, mint)
    expect(calls).toBe(2)
  })

  test('clear drops an in-flight result without disturbing a new session request', async () => {
    const cache = new HostGrantCache(() => 0)
    let finish!: (value: HostAccessTokenResponse) => void
    const old = cache.acquire('host', undefined, () => new Promise((resolve) => { finish = resolve }))
    cache.clear()
    expect((await cache.acquire('host', undefined, async () => grant('new')))?.accessToken).toBe('new')
    finish(grant('old'))
    expect(await old).toBeNull()
    expect((await cache.acquire('host', undefined, async () => grant('wrong')))?.accessToken).toBe('new')
  })

  test('failed forced renewal never falls back to the refused token and can retry', async () => {
    const cache = new HostGrantCache(() => 0)
    await cache.acquire('host', undefined, async () => grant())
    await expect(cache.acquire('host', undefined, async () => { throw new Error('offline') }, { fresh: true })).rejects.toThrow('offline')
    expect((await cache.acquire('host', undefined, async () => grant('replacement')))?.accessToken).toBe('replacement')
  })

  test('concurrent callers share one mint and expired responses are not retained', async () => {
    const cache = new HostGrantCache(() => 0)
    let calls = 0
    const mint = async () => { calls++; return grant() }
    expect(await Promise.all([cache.acquire('host', undefined, mint), cache.acquire('host', undefined, mint)]))
      .toEqual([grant(), grant()])
    expect(calls).toBe(1)
    expect(await cache.acquire('host', undefined, async () => grant('expired', 0), { fresh: true })).toBeNull()
    expect((await cache.acquire('host', undefined, mint))?.accessToken).toBe('one')
    expect(calls).toBe(2)
  })
})
