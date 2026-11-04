import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { attributionSchema } from '@solus/contracts/user'
import { workExternalLinkSchema } from '../../docs/schema'
import type { Db } from '../../db/database'
import { workRevisions, works, workStorage, workStorageBodies } from './schema'
import { DatabaseWorkStorage } from './database-work-storage'
import { verifyWorkBody, type WorkBodyAddress, type WorkStorageAdapter } from './work-storage'

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const revisionSchema = z.object({
  workId: z.string(), revisionId: z.number().int().positive(),
  reason: z.enum(['baseline', 'checkpoint', 'agent', 'upstream', 'review', 'restore']),
  sourceContentVersion: z.number().int().positive().nullable(),
  author: attributionSchema.nullable(), contentHash: hashSchema, capturedAt: z.string(),
})
export const workArchiveManifestSchema = z.object({
  schemaVersion: z.literal(1), operationId: z.string(), generation: z.number().int().positive(),
  work: z.object({
    id: z.string(), organizationId: z.string(), title: z.string(), preview: z.string(),
    type: z.enum(['doc', 'slides', 'artifact']), createdAt: z.string(), updatedAt: z.string(),
    sessionId: z.string().optional(), sessionIds: z.array(z.string()).optional(),
    agentProvider: z.enum(['claude-code', 'codex', 'opencode']), cwd: z.string(), pinned: z.boolean().optional(),
    mirroredDoc: workExternalLinkSchema.optional(),
    contentVersion: z.number().int().positive(), contentHash: hashSchema, contentAuthor: attributionSchema.nullable(),
  }),
  previousRevisionId: z.number().int().positive().nullable(), revisions: z.array(revisionSchema),
})
export const workArchiveOperationSchema = z.object({
  manifest: workArchiveManifestSchema, expectedCommit: z.string().nullable(),
  hashes: z.array(hashSchema), capturedAt: z.string(),
})
export type WorkArchiveManifest = z.infer<typeof workArchiveManifestSchema>
export type WorkArchiveOperation = z.infer<typeof workArchiveOperationSchema>
export interface WorkArchiveBody { hash: string; content: string }

/** A scoped server dependency; tokens and Git details never reach Work or its callers. */
export interface WorkArchiveTransport {
  read(repository: string, commit: string, hash: string): Promise<string>
  push(repository: string, operation: WorkArchiveOperation, bodies: readonly WorkArchiveBody[]): Promise<string>
  remove(repository: string): Promise<void>
}

const bodySchema = z.object({ content: z.string().nullable(), commit_id: z.string().nullable(), repository: z.string(), organization_id: z.string() })
export const ARCHIVE_IDLE_MS = 3_000
export const ARCHIVE_MAX_MS = 30_000

/** Database bodies are draft/projection storage. Immutable accepted bodies are read from Git. */
export class GitWorkStorage implements WorkStorageAdapter {
  private readonly projection = new DatabaseWorkStorage()
  constructor(private readonly transport: WorkArchiveTransport,
    private readonly drain: (workId: string) => Promise<void>, private readonly now: () => number = Date.now, readonly storageScope = 'cloudflare-artifacts',
    readonly provider: 'local-git' | 'cloudflare-artifacts' = 'cloudflare-artifacts') {}

  async read(db: Db, address: WorkBodyAddress, projection: string | null): Promise<string> {
    if (projection !== null) return verifyWorkBody(address, projection)
    const body = bodySchema.nullish().parse(await db.get(sql`
      SELECT b.content, b.commit_id, s.repository, s.organization_id
      FROM ${workStorageBodies} b JOIN ${workStorage} s ON s.work_id = b.work_id
      WHERE b.work_id = ${address.workId} AND b.content_hash = ${address.contentHash} AND s.deleted = 0
    `))
    if (!body || body.organization_id !== address.organizationId) throw new Error('The archived work body is not available in this organization.')
    if (body.content !== null) return verifyWorkBody(address, body.content)
    if (!body.commit_id) throw new Error('The work body has not been archived.')
    return verifyWorkBody(address, await this.transport.read(body.repository, body.commit_id, address.contentHash))
  }

  async capture(db: Db, address: WorkBodyAddress, content: string): Promise<void> {
    await this.projection.capture(db, address, content)
    await db.run(sql`INSERT INTO ${workStorageBodies} (work_id, content_hash, content)
      VALUES (${address.workId}, ${address.contentHash}, ${content}) ON CONFLICT(work_id, content_hash) DO NOTHING`)
    if (address.revisionId !== null) {
      await db.run(sql`UPDATE ${workRevisions} SET content = NULL WHERE work_id = ${address.workId}
        AND organization_id = ${address.organizationId} AND rev = ${address.revisionId}
        AND EXISTS (SELECT 1 FROM ${workStorageBodies} WHERE work_id = ${address.workId} AND content_hash = ${address.contentHash} AND commit_id IS NOT NULL)`)
    }
    // Coalesce ordinary drafts without removing a frozen batch or an immutable checkpoint.
    const pending = z.object({ operation: z.string().nullable() }).parse(await db.get(sql`SELECT operation FROM ${workStorage}
      WHERE work_id = ${address.workId} AND organization_id = ${address.organizationId}`))
    const frozen = pending.operation ? workArchiveOperationSchema.parse(JSON.parse(pending.operation)).hashes : []
    await db.run(sql`DELETE FROM ${workStorageBodies} WHERE work_id = ${address.workId} AND commit_id IS NULL
      AND content_hash NOT IN (SELECT content_hash FROM ${works} WHERE id = ${address.workId}
        UNION SELECT content_hash FROM ${workRevisions} WHERE work_id = ${address.workId})
      ${frozen.length ? sql`AND content_hash NOT IN (${sql.join(frozen.map(hash => sql`${hash}`), sql`, `)})` : sql``}`)
    await this.changed(db, address.organizationId, address.workId, address.revisionId !== null)
  }

  async changed(db: Db, organizationId: string, workId: string, immediate: boolean): Promise<void> {
    const now = this.now()
    const idleAt = now + ARCHIVE_IDLE_MS
    const result = await db.run(sql`UPDATE ${workStorage} SET generation = generation + 1,
      dirty_since = COALESCE(dirty_since, ${now}),
      due_at = CASE WHEN ${immediate ? 1 : 0} = 1 OR (due_at IS NOT NULL AND due_at <= ${now}) THEN ${now}
        WHEN COALESCE(dirty_since, ${now}) + ${ARCHIVE_MAX_MS} < ${idleAt} THEN COALESCE(dirty_since, ${now}) + ${ARCHIVE_MAX_MS}
        ELSE ${idleAt} END
      WHERE work_id = ${workId} AND organization_id = ${organizationId} AND deleted = 0`)
    if (result.changes !== 1) throw new Error('The Git work storage mapping is missing.')
  }

  async remove(db: Db, organizationId: string, workId: string): Promise<void> {
    await db.run(sql`UPDATE ${workStorage} SET deleted = 1, generation = generation + 1, due_at = ${this.now()}
      WHERE work_id = ${workId} AND organization_id = ${organizationId}`)
  }

  async flush(workId: string): Promise<void> {
    try { await this.drain(workId) } catch { throw new Error('This work is saved but not yet archived in Git. Retry publication.') }
  }
}
