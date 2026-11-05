import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/database'
import { workStorage, workStorageBodies, workRevisions, works, workLiveDocs } from '../../data/works/schema'
import { workColumns, REVISION_COLUMNS, workRowSchema, workFromRow, revisionRowSchema, revisionSummaryFromRow } from '../../data/works/work-rows'
import { workArchiveOperationSchema, type WorkArchiveOperation, type WorkArchiveTransport, type WorkArchiveBody } from '../../data/works/git-work-storage'
import { documentContentHash } from '../../docs/content-hash'

const mappingSchema = z.object({
  work_id: z.string(), organization_id: z.string(), repository: z.string(), commit_id: z.string().nullable(),
  generation: z.number(), archived_generation: z.number(), deleted: z.number(), operation: z.string().nullable(),
  claim_id: z.string().nullable(), claim_until: z.number().nullable(),
})
const blobSchema = z.object({ content_hash: z.string(), content: z.string().nullable() })
const LEASE_MS = 5 * 60_000
const RETRY_MS = 10_000

interface ClaimedWork {
  workId: string
  organizationId: string
  repository: string
  claimId: string
  deleted: boolean
  operation: WorkArchiveOperation | null
  bodies: WorkArchiveBody[]
}

/** Durable batches and checked claims make restart and a lost push response safe. */
export class WorkArchiveWriter {
  constructor(private readonly database: () => Db, private readonly transport: WorkArchiveTransport,
    private readonly now: () => number = Date.now,
    private readonly flushLive: (workId: string) => Promise<void> = async () => {},
    private readonly provider: 'local-git' | 'cloudflare-artifacts' = 'cloudflare-artifacts') {}

  private readonly inFlight = new Set<Promise<void>>()

  async idle(): Promise<void> {
    await Promise.allSettled(this.inFlight)
  }

  async flush(workId: string): Promise<void> {
    const operation = this.run(workId)
    this.inFlight.add(operation)
    try { await operation } finally { this.inFlight.delete(operation) }
  }

  private async run(workId: string): Promise<void> {
    await this.flushLive(workId)
    const claimed = await this.claim(workId)
    if (!claimed) return
    try {
      if (claimed.deleted) {
        await this.transport.remove(claimed.repository)
        await this.database().transaction(async db => {
          await db.run(sql`DELETE FROM ${workStorage} WHERE work_id = ${workId} AND claim_id = ${claimed.claimId} AND deleted = 1`)
        })
        return
      }
      if (!claimed.operation) throw new Error('The archive operation is missing.')
      const commit = await this.transport.push(claimed.repository, claimed.operation, claimed.bodies)
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('The archive returned an invalid commit.')
      await this.complete(claimed, commit)
    } catch {
      // Remote errors may contain request details. Keep only a safe error in domain state.
      await this.database().run(sql`UPDATE ${workStorage} SET claim_id = NULL, claim_until = NULL,
        error = 'Git archive synchronization failed; the durable write will be retried.', due_at = ${this.now() + RETRY_MS}
        WHERE work_id = ${workId} AND claim_id = ${claimed.claimId}`)
      throw new Error('Git archive synchronization failed; the work remains saved and pending.')
    }
  }

  /** Publication requires a fully accepted snapshot, not just a draft receipt. */
  async drain(workId: string): Promise<void> {
    for (let pass = 0; pass < 20; pass++) {
      await this.flush(workId)
      const row = mappingSchema.nullish().parse(await this.database().get(sql`SELECT * FROM ${workStorage} WHERE work_id = ${workId} AND provider = ${this.provider}`))
      if (!row || (row.deleted === 0 && row.generation === row.archived_generation)) return
      if (row.claim_id) throw new Error('This work is already syncing; retry publication.')
    }
    throw new Error('This work is changing while publishing; retry after the edits stop.')
  }

  async runDue(): Promise<void> {
    const ids = z.object({ work_id: z.string() }).array().parse(await this.database().all(sql`
      SELECT work_id FROM ${workStorage} WHERE provider = ${this.provider}
        AND due_at <= ${this.now()} AND (claim_until IS NULL OR claim_until <= ${this.now()})
      ORDER BY due_at LIMIT 20`))
    // Bound native Git concurrency: this process runs one batch at a time.
    for (const row of ids) {
      try { await this.flush(row.work_id) } catch { /* Error and retry deadline are durable. */ }
    }
  }

  private async claim(workId: string): Promise<ClaimedWork | null> {
    const claimId = randomUUID()
    const now = this.now()
    return this.database().transaction(async db => {
      // Same lock order as Work mutations: work first, then its storage mapping.
      await db.get(sql`SELECT id FROM ${works} WHERE id = ${workId} ${db.engine === 'postgres' ? sql`FOR UPDATE` : sql``}`)
      const claimed = await db.run(sql`UPDATE ${workStorage} SET claim_id = ${claimId}, claim_until = ${now + LEASE_MS}
        WHERE work_id = ${workId} AND provider = ${this.provider}
          AND (generation > archived_generation OR deleted = 1)
          AND (claim_until IS NULL OR claim_until <= ${now})`)
      if (claimed.changes !== 1) return null
      const mapping = mappingSchema.parse(await db.get(sql`SELECT * FROM ${workStorage} WHERE work_id = ${workId}`))
      if (mapping.deleted) return { workId, organizationId: mapping.organization_id, repository: mapping.repository, claimId, deleted: true, operation: null, bodies: [] }
      let operation = mapping.operation ? workArchiveOperationSchema.parse(JSON.parse(mapping.operation)) : null
      if (!operation) {
        const live = z.object({ needs_projection: z.number() }).nullish().parse(await db.get(sql`SELECT needs_projection FROM ${workLiveDocs}
          WHERE work_id = ${workId} AND organization_id = ${mapping.organization_id}`))
        if (live?.needs_projection) {
          // A live receipt committed after flushLive. Do not archive its generation with an older body.
          await db.run(sql`UPDATE ${workStorage} SET claim_id = NULL, claim_until = NULL, due_at = ${now}
            WHERE work_id = ${workId} AND claim_id = ${claimId}`)
          return null
        }
        // The work row is locked for a consistent body/metadata/revision snapshot.
        const row = workRowSchema.parse(await db.get(sql`SELECT ${workColumns(db.engine)} FROM ${works}
          WHERE id = ${workId} AND organization_id = ${mapping.organization_id} ${db.engine === 'postgres' ? sql`FOR UPDATE` : sql``}`))
        const { content: _projection, ...work } = workFromRow(row)
        const revisions = revisionRowSchema.array().parse(await db.all(sql`SELECT ${REVISION_COLUMNS} FROM ${workRevisions} WHERE work_id = ${workId} ORDER BY rev`)).map(revisionSummaryFromRow)
        const required = new Set([work.contentHash, ...revisions.map(revision => revision.contentHash)])
        const pending = blobSchema.array().parse(await db.all(sql`SELECT content_hash, content FROM ${workStorageBodies} WHERE work_id = ${workId} AND commit_id IS NULL`)).filter(body => required.has(body.content_hash))
        operation = workArchiveOperationSchema.parse({
          manifest: { schemaVersion: 1, operationId: randomUUID(), generation: mapping.generation, work,
            previousRevisionId: row.previous_revision_id, revisions },
          expectedCommit: mapping.commit_id, hashes: pending.map(body => body.content_hash), capturedAt: new Date(now).toISOString(),
        })
        await db.run(sql`UPDATE ${workStorage} SET operation = ${JSON.stringify(operation)} WHERE work_id = ${workId} AND claim_id = ${claimId}`)
      }
      const bodies: WorkArchiveBody[] = []
      for (const hash of operation.hashes) {
        const body = blobSchema.parse(await db.get(sql`SELECT content_hash, content FROM ${workStorageBodies} WHERE work_id = ${workId} AND content_hash = ${hash}`))
        if (body.content === null || documentContentHash(body.content) !== hash) throw new Error('A pending archive body is missing or corrupt.')
        bodies.push({ hash, content: body.content })
      }
      return { workId, organizationId: mapping.organization_id, repository: mapping.repository, claimId, deleted: false, operation, bodies }
    })
  }

  private async complete(claimed: ClaimedWork, commit: string): Promise<void> {
    const operation = claimed.operation!
    await this.database().transaction(async db => {
      await db.get(sql`SELECT id FROM ${works} WHERE id = ${claimed.workId} ${db.engine === 'postgres' ? sql`FOR UPDATE` : sql``}`)
      const updated = await db.run(sql`UPDATE ${workStorage} SET commit_id = ${commit},
        archived_generation = ${operation.manifest.generation}, operation = NULL, claim_id = NULL, claim_until = NULL, error = NULL,
        dirty_since = CASE WHEN generation = ${operation.manifest.generation} THEN NULL ELSE dirty_since END,
        due_at = CASE WHEN generation = ${operation.manifest.generation} AND deleted = 0 THEN NULL ELSE CAST(${this.now()} AS BIGINT) END
        WHERE work_id = ${claimed.workId} AND claim_id = ${claimed.claimId}`)
      if (updated.changes !== 1) throw new Error('The archive claim was replaced; reconciliation is required.')
      for (const body of claimed.bodies) {
        await db.run(sql`UPDATE ${workStorageBodies} SET content = NULL, commit_id = ${commit}
          WHERE work_id = ${claimed.workId} AND content_hash = ${body.hash} AND commit_id IS NULL`)
        await db.run(sql`UPDATE ${workRevisions} SET content = NULL WHERE work_id = ${claimed.workId}
          AND organization_id = ${claimed.organizationId} AND content_hash = ${body.hash}`)
      }
      await db.run(sql`DELETE FROM ${workStorageBodies} WHERE work_id = ${claimed.workId} AND commit_id IS NULL
        AND content_hash NOT IN (SELECT content_hash FROM ${works} WHERE id = ${claimed.workId}
          UNION SELECT content_hash FROM ${workRevisions} WHERE work_id = ${claimed.workId})`)
    })
  }
}
