import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDatabase, type Db } from '../db/database'
import { assetPublications } from './schema'

const remoteUrlRowSchema = z.object({ remote_url: z.string() })

/**
 * Which assets have already been uploaded to which provider target.
 *
 * An upload is irreversible and the sync engine retries, so publishing must be
 * idempotent. The asset id is a SHA-256 digest of the bytes, so a recorded URL
 * is the same content by construction and can be reused without checking.
 */
export async function publishedAssetUrl(
  assetId: string,
  provider: string,
  targetKey: string,
  db: Db = getDatabase(),
): Promise<string | null> {
  const row = remoteUrlRowSchema.nullish().parse(await db.get(sql`
    SELECT remote_url FROM ${assetPublications}
    WHERE asset_id = ${assetId} AND provider = ${provider} AND target_key = ${targetKey}
  `))
  return row?.remote_url ?? null
}

export async function recordAssetPublication(
  assetId: string,
  provider: string,
  targetKey: string,
  remoteUrl: string,
  db: Db = getDatabase(),
): Promise<void> {
  await db.run(sql`
    INSERT INTO ${assetPublications}(asset_id, provider, target_key, remote_url, created_at)
    VALUES (${assetId}, ${provider}, ${targetKey}, ${remoteUrl}, ${Date.now()})
    ON CONFLICT(asset_id, provider, target_key) DO UPDATE SET
      remote_url = excluded.remote_url,
      created_at = excluded.created_at
  `)
}
