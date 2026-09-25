import { describe, expect, test } from 'bun:test'
import { AssetUrlCache, type SignedAssetUrlRequest } from '@solus/workspace-ui/components/artifact/lib/asset-url'
import type { IpcContext } from '@solus/contracts/types'

describe('asset URL cache', () => {
  test('reuses a URL until it enters the refresh window', async () => {
    const cache = new AssetUrlCache()
    let mintCount = 0
    const api: SignedAssetUrlRequest['api'] = {
      assetCreateUrl: async () => {
        mintCount++
        return {
          relativeUrl: `/api/assets/token-${mintCount}`,
          expiresAt: mintCount === 1 ? 100_000 : 200_000,
        }
      },
    }
    const request: SignedAssetUrlRequest = {
      serverId: 'host-a',
      path: '/repo/image.png',
      origin: 'https://host.example/',
      api,
      // SAFETY: the cache forwards this opaque context and does not read session fields.
      ctx: { session: {} } as IpcContext,
    }

    expect(await cache.resolve(request, 1_000)).toBe('https://host.example/api/assets/token-1')
    expect(await cache.resolve(request, 20_000)).toBe('https://host.example/api/assets/token-1')
    expect(mintCount).toBe(1)
    expect(await cache.resolve(request, 50_000)).toBe('https://host.example/api/assets/token-2')
    expect(mintCount).toBe(2)
  })

  test('mints stored asset URLs without a session context', async () => {
    const cache = new AssetUrlCache()
    let receivedAssetId: string | undefined
    const api: SignedAssetUrlRequest['api'] = {
      assetCreateUrl: async (_ctx, request) => {
        receivedAssetId = request.assetId
        return { relativeUrl: '/api/assets/stored', expiresAt: 200_000 }
      },
    }
    const id = `${'a'.repeat(64)}.png`
    const url = await cache.resolve({
      serverId: 'host-a',
      assetId: id,
      origin: 'https://host.example',
      api,
    }, 1_000)

    expect(receivedAssetId).toBe(id)
    expect(url).toBe('https://host.example/api/assets/stored')
  })

  test('concurrent requests for one asset share a single mint', async () => {
    // WHY: every mounted row renders the project favicon in the same frame after
    // a reload. Without sharing, each row minted its own URL — dozens of
    // identical assetCreateUrl calls per reload.
    const cache = new AssetUrlCache()
    let mintCount = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const api: SignedAssetUrlRequest['api'] = {
      assetCreateUrl: async () => {
        mintCount++
        await gate
        return { relativeUrl: `/api/assets/token-${mintCount}`, expiresAt: 900_000 }
      },
    }
    const request: SignedAssetUrlRequest = { serverId: 'host-a', path: '/repo/favicon.svg', origin: 'https://host.example', api }

    const urls = Promise.all(Array.from({ length: 20 }, () => cache.resolve(request, 1_000)))
    release()

    expect(new Set(await urls)).toEqual(new Set(['https://host.example/api/assets/token-1']))
    expect(mintCount).toBe(1)
  })

  test('a failed mint is not shared with the next request', async () => {
    const cache = new AssetUrlCache()
    let mintCount = 0
    const api: SignedAssetUrlRequest['api'] = {
      assetCreateUrl: async () => {
        if (++mintCount === 1) throw new Error('host unavailable')
        return { relativeUrl: '/api/assets/token', expiresAt: 900_000 }
      },
    }
    const request: SignedAssetUrlRequest = { serverId: 'host-a', path: '/repo/favicon.svg', origin: 'https://host.example', api }

    await expect(cache.resolve(request, 1_000)).rejects.toThrow('host unavailable')
    expect(await cache.resolve(request, 2_000)).toBe('https://host.example/api/assets/token')
  })

  test('a refused URL is minted again even while the cache thinks it is fresh', async () => {
    // WHY: a video player retries after the host refuses its URL. Handing back
    // the same cached URL would fail the same way until the cache's own clock
    // caught up.
    const cache = new AssetUrlCache()
    let mintCount = 0
    const api: SignedAssetUrlRequest['api'] = {
      assetCreateUrl: async () => ({ relativeUrl: `/api/assets/token-${++mintCount}`, expiresAt: 900_000 }),
    }
    const request: SignedAssetUrlRequest = { serverId: 'host-a', assetId: `${'c'.repeat(64)}.mp4`, origin: 'https://host.example', api }

    await cache.resolve(request, 1_000)
    expect(await cache.resolve({ ...request, refresh: true }, 2_000)).toBe('https://host.example/api/assets/token-2')
    expect(await cache.resolve(request, 3_000)).toBe('https://host.example/api/assets/token-2')
  })
})
