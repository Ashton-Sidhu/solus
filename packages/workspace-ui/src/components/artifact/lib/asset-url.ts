import { hostKey } from '@solus/client-core/host-key'
import type { HostApi } from '@solus/client-core/host-api'
import type { IpcContext } from '@solus/contracts/types'

export const ASSET_URL_REFRESH_WINDOW_MS = 60_000

interface CachedAssetUrl {
  url: string
  expiresAt: number
}

export interface SignedAssetUrlRequest {
  serverId: string
  path?: string
  assetId?: string
  name?: string
  origin: string
  api: Pick<HostApi, 'assetCreateUrl'>
  ctx?: IpcContext
}

export class AssetUrlCache {
  private readonly entries = new Map<string, CachedAssetUrl>()

  async resolve(request: SignedAssetUrlRequest, now = Date.now()): Promise<string> {
    const sourceKey = request.assetId
      ? `asset:${request.assetId}:${request.name ?? ''}`
      : `path:${request.path ?? ''}`
    const key = hostKey(request.serverId, sourceKey)
    const cached = this.entries.get(key)
    if (cached && cached.expiresAt - now > ASSET_URL_REFRESH_WINDOW_MS) return cached.url

    const minted = await request.api.assetCreateUrl(
      request.ctx,
      request.assetId ? { assetId: request.assetId, name: request.name } : { path: request.path },
    )
    const url = new URL(minted.relativeUrl, `${request.origin.replace(/\/+$/, '')}/`).toString()
    this.entries.set(key, { url, expiresAt: minted.expiresAt })
    return url
  }

  clear(): void {
    this.entries.clear()
  }
}

export const assetUrlCache = new AssetUrlCache()

export function localArtifactProtocolUrl(path: string): string {
  return `solus-artifact://local/?p=${encodeURIComponent(path)}`
}
