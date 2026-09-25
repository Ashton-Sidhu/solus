import { hostKey } from '@solus/client-core/host-key'
import type { HostApi } from '@solus/client-core/host-api'
import type { AssetCreateUrlResult } from '@solus/contracts/rpc'
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
  /** Mint a new URL even when the cached one has time left: the host refused
   *  it, so the cache's clock is not the one that counts. */
  refresh?: boolean
}

export interface SignedAssetFindRequest {
  serverId: string
  /** Host paths in preference order. */
  paths: string[]
  origin: string
  api: Pick<HostApi, 'assetFindUrl'>
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
    if (!request.refresh && cached && cached.expiresAt - now > ASSET_URL_REFRESH_WINDOW_MS) return cached.url

    const minted = await request.api.assetCreateUrl(
      request.ctx,
      request.assetId ? { assetId: request.assetId, name: request.name } : { path: request.path },
    )
    return this.remember(key, request.origin, minted)
  }

  /** The first candidate the host can serve, in one round trip, or null when
   *  none exists. */
  async find(request: SignedAssetFindRequest): Promise<{ path: string; url: string } | null> {
    const found = await request.api.assetFindUrl(request.ctx, { paths: request.paths })
    if (!found) return null
    const key = hostKey(request.serverId, `path:${found.path}`)
    return { path: found.path, url: this.remember(key, request.origin, found) }
  }

  private remember(key: string, origin: string, minted: AssetCreateUrlResult): string {
    const url = new URL(minted.relativeUrl, `${origin.replace(/\/+$/, '')}/`).toString()
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
