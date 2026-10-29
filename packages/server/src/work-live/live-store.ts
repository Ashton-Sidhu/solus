import { attributionSchema, type Attribution } from '@solus/contracts/user'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { base64ToBytes, bytesToBase64 } from '@solus/contracts/work-live'
import { getDatabase } from '../db/database'
import { storageForWork } from '../data/works/work-storage'
import { workLiveDocs } from '../data/works/schema'

/**
 * The stored live doc of one work: its Yjs state and the last push each client
 * key applied, in one row (docs/plans/work-review-and-live-editing.md, phase
 * 3b). The host writes it when edits pause and when the room closes, not on
 * each push: the clients' device copies hold anything newer.
 */
export interface StoredLiveDoc {
  state: Uint8Array
  clientSeqs: Map<string, number>
  lastAuthor?: Attribution | null
  bodyVersion?: number
  needsProjection?: boolean
}

export interface LoadedLiveDoc extends StoredLiveDoc {
  organizationId: string
}

const rowSchema = z.object({ state: z.string(), client_seqs: z.string().nullable(), organization_id: z.string(), last_author: z.string().nullable(), body_version: z.number().nullable(), needs_projection: z.number() })
const seqsSchema = z.record(z.string(), z.number().int())

export async function loadLiveDoc(workId: string): Promise<LoadedLiveDoc | null> {
  const row = rowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT state, client_seqs, organization_id, last_author, body_version, needs_projection FROM ${workLiveDocs} WHERE work_id = ${workId}
  `))
  if (!row) return null
  const seqs = row.client_seqs ? seqsSchema.safeParse(JSON.parse(row.client_seqs)) : null
  return { state: base64ToBytes(row.state), clientSeqs: new Map(Object.entries(seqs?.success ? seqs.data : {})), organizationId: row.organization_id, lastAuthor: row.last_author ? attributionSchema.parse(JSON.parse(row.last_author)) : null, bodyVersion: row.body_version ?? undefined, needsProjection: row.needs_projection === 1 }
}

export async function hasLiveDoc(workId: string): Promise<boolean> {
  return !!(await getDatabase().get(sql`SELECT work_id FROM ${workLiveDocs} WHERE work_id = ${workId}`))
}

export async function saveLiveDoc(organizationId: string, workId: string, doc: StoredLiveDoc): Promise<void> {
  const state = bytesToBase64(doc.state)
  const seqs = JSON.stringify(Object.fromEntries(doc.clientSeqs))
  const now = Date.now()
  const author = doc.lastAuthor ? JSON.stringify(doc.lastAuthor) : null
  await getDatabase().transaction(async db => {
    await db.run(sql`
      INSERT INTO ${workLiveDocs} (work_id, state, client_seqs, updated_at, organization_id, last_author, body_version, needs_projection)
      VALUES (${workId}, ${state}, ${seqs}, ${now}, ${organizationId}, ${author}, ${doc.bodyVersion ?? null}, ${doc.needsProjection ? 1 : 0})
      ON CONFLICT (work_id) DO UPDATE SET state = excluded.state, client_seqs = excluded.client_seqs, updated_at = excluded.updated_at,
      last_author = CASE WHEN ${doc.lastAuthor !== undefined ? 1 : 0} = 1 THEN excluded.last_author ELSE work_live_docs.last_author END,
      body_version = CASE WHEN ${doc.bodyVersion !== undefined ? 1 : 0} = 1 THEN excluded.body_version ELSE work_live_docs.body_version END,
      needs_projection = CASE WHEN ${doc.needsProjection !== undefined ? 1 : 0} = 1 THEN excluded.needs_projection ELSE work_live_docs.needs_projection END
    `)
    await (await storageForWork(db, organizationId, workId)).changed(db, organizationId, workId, false)
  })
}
