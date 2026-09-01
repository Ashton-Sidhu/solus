import type { DatabaseSync } from 'node:sqlite'
import { getDb } from '../db'

/**
 * Which assets have already been uploaded to which provider target.
 *
 * An upload is irreversible and the sync engine retries, so publishing must be
 * idempotent. The asset id is a SHA-256 digest of the bytes, so a recorded URL
 * is the same content by construction and can be reused without checking.
 */
export function publishedAssetUrl(
  assetId: string,
  provider: string,
  targetKey: string,
  db: DatabaseSync = getDb(),
): string | null {
  // SAFETY: the migration declares remote_url as a non-null TEXT column.
  const row = db.prepare(`
    SELECT remote_url FROM asset_publications
    WHERE asset_id = ? AND provider = ? AND target_key = ?
  `).get(assetId, provider, targetKey) as { remote_url: string } | undefined
  return row?.remote_url ?? null
}

export function recordAssetPublication(
  assetId: string,
  provider: string,
  targetKey: string,
  remoteUrl: string,
  db: DatabaseSync = getDb(),
): void {
  db.prepare(`
    INSERT OR REPLACE INTO asset_publications(asset_id, provider, target_key, remote_url, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(assetId, provider, targetKey, remoteUrl, Date.now())
}
