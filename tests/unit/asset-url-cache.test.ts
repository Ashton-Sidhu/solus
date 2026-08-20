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
})
