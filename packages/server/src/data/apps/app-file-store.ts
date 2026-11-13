import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { APP_CALLER_KINDS, type AppCallerKind } from '@solus/contracts/apps'
import { getDatabase, type Db } from '../../db/database'
import { appFiles } from './schema'

/**
 * The records of app files (docs/plans/apps.md §4.3). A record names a file;
 * its bytes are in the app's `blobs/` folder, by the record's id.
 */

export interface AppFileRecord {
  id: string
  appId: string
  name: string
  mediaType: string
  size: number
  createdBy: AppCallerKind
  createdAt: number
}

const fileRowSchema = z.object({
  id: z.string(),
  app_id: z.string(),
  name: z.string(),
  media_type: z.string(),
  size: z.coerce.number(),
  caller_kind: z.enum(APP_CALLER_KINDS),
  created_at: z.coerce.number(),
})

function fileFromRow(row: z.infer<typeof fileRowSchema>): AppFileRecord {
  return { id: row.id, appId: row.app_id, name: row.name, mediaType: row.media_type, size: row.size, createdBy: row.caller_kind, createdAt: row.created_at }
}

export async function insertFile(record: AppFileRecord, db: Db = getDatabase()): Promise<void> {
  await db.run(sql`
    INSERT INTO ${appFiles} (id, app_id, name, media_type, size, caller_kind, created_at)
    VALUES (${record.id}, ${record.appId}, ${record.name}, ${record.mediaType}, ${record.size}, ${record.createdBy}, ${record.createdAt})
  `)
}

/** The files of an app, the newest first. */
export async function listFiles(appId: string, db: Db = getDatabase()): Promise<AppFileRecord[]> {
  const rows = await db.all(sql`SELECT * FROM ${appFiles} WHERE app_id = ${appId} ORDER BY created_at DESC, id DESC`)
  return z.array(fileRowSchema).parse(rows).map(fileFromRow)
}

export async function loadFile(appId: string, fileId: string, db: Db = getDatabase()): Promise<AppFileRecord | null> {
  const row = await db.get(sql`SELECT * FROM ${appFiles} WHERE app_id = ${appId} AND id = ${fileId}`)
  return row ? fileFromRow(fileRowSchema.parse(row)) : null
}

export async function countFiles(appId: string, db: Db = getDatabase()): Promise<number> {
  return z.object({ count: z.coerce.number() }).parse(await db.get(sql`SELECT COUNT(*) AS count FROM ${appFiles} WHERE app_id = ${appId}`)).count
}

export async function deleteFile(appId: string, fileId: string, db: Db = getDatabase()): Promise<boolean> {
  return (await db.run(sql`DELETE FROM ${appFiles} WHERE app_id = ${appId} AND id = ${fileId}`)).changes > 0
}
