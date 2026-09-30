import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { base64ToBytes, bytesToBase64 } from '@solus/contracts/work-live'
import { getDatabase } from '../db/database'
import { workLiveDocs } from '../data/works/schema'

/**
 * The stored live doc of one work: its Yjs state and the last push each client
 * key applied, in one row, so an acknowledged push and its receipt are durable
 * together (docs/plans/work-review-and-live-editing.md, phase 3b).
 */
export interface StoredLiveDoc {
  state: Uint8Array
  clientSeqs: Map<string, number>
}

export interface LoadedLiveDoc extends StoredLiveDoc {
  organizationId: string
}

const rowSchema = z.object({ state: z.string(), client_seqs: z.string().nullable(), organization_id: z.string() })
const seqsSchema = z.record(z.string(), z.number().int())

export async function loadLiveDoc(workId: string): Promise<LoadedLiveDoc | null> {
  const row = rowSchema.nullish().parse(await getDatabase().get(sql`
    SELECT state, client_seqs, organization_id FROM ${workLiveDocs} WHERE work_id = ${workId}
  `))
  if (!row) return null
  const seqs = row.client_seqs ? seqsSchema.safeParse(JSON.parse(row.client_seqs)) : null
  return { state: base64ToBytes(row.state), clientSeqs: new Map(Object.entries(seqs?.success ? seqs.data : {})), organizationId: row.organization_id }
}

export async function hasLiveDoc(workId: string): Promise<boolean> {
  return !!(await getDatabase().get(sql`SELECT work_id FROM ${workLiveDocs} WHERE work_id = ${workId}`))
}

export async function saveLiveDoc(organizationId: string, workId: string, doc: StoredLiveDoc): Promise<void> {
  const state = bytesToBase64(doc.state)
  const seqs = JSON.stringify(Object.fromEntries(doc.clientSeqs))
  const now = Date.now()
  await getDatabase().run(sql`
    INSERT INTO ${workLiveDocs} (work_id, state, client_seqs, updated_at, organization_id)
    VALUES (${workId}, ${state}, ${seqs}, ${now}, ${organizationId})
    ON CONFLICT (work_id) DO UPDATE SET state = excluded.state, client_seqs = excluded.client_seqs, updated_at = excluded.updated_at
  `)
}
