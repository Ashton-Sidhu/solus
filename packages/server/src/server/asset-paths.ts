import { join } from 'path'
import { dataDir } from '../platform/paths'

/** A stored asset id: the SHA-256 digest of its bytes plus a validated extension. */
export const ASSET_ID = /^[a-f0-9]{64}\.[a-z0-9][a-z0-9+_-]{0,15}$/

/**
 * Where one stored asset's bytes live.
 *
 * A leaf on purpose: a provider adapter reads asset bytes to upload them, and
 * routing that through the asset request surface would make the task layer and
 * the request handlers import each other.
 */
export function storedAssetPath(assetId: string, assetsDir = join(dataDir(), 'assets')): string {
  if (!ASSET_ID.test(assetId)) throw new Error('The asset id is invalid.')
  return join(assetsDir, assetId)
}
