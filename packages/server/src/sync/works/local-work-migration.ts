import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Db } from '../../db/database'
import { works, workRevisions, workStorage } from '../../data/works/schema'
import { initializeWorkStorage, verifyWorkBody } from '../../data/works/work-storage'
import type { GitWorkStorage } from '../../data/works/git-work-storage'

const bodySchema = z.object({ content: z.string().nullable(), content_hash: z.string() })
const workSchema = bodySchema.extend({ id: z.string(), organization_id: z.string() })
const revisionSchema = bodySchema.extend({ rev: z.number() })

/** Adopt a bounded number of legacy local records. Git acceptance clears history bodies later. */
export async function migrateLocalWorkHistory(database: () => Db, adapter: GitWorkStorage): Promise<void> {
  const candidates = z.object({ id: z.string() }).array().parse(await database().all(sql`
    SELECT w.id FROM ${works} w LEFT JOIN ${workStorage} s ON w.id = s.work_id
    WHERE w.organization_id = 'local' AND (s.provider IS NULL OR s.provider = 'database')
    ORDER BY w.id LIMIT 5`))
  for (const candidate of candidates) {
    await database().transaction(async db => {
      const work = workSchema.nullish().parse(await db.get(sql`SELECT id, organization_id, content, content_hash FROM ${works}
        WHERE id = ${candidate.id} AND organization_id = 'local' ${db.engine === 'postgres' ? sql`FOR UPDATE` : sql``}`))
      if (!work) return
      const mapping = z.object({ provider: z.string() }).nullish().parse(await db.get(sql`SELECT provider FROM ${workStorage} WHERE work_id = ${work.id}`))
      if (mapping && mapping.provider !== 'database') return
      await db.run(sql`DELETE FROM ${workStorage} WHERE work_id = ${work.id} AND provider = 'database'`)
      await initializeWorkStorage(db, work.organization_id, work.id)
      const address = { organizationId: work.organization_id, workId: work.id, contentHash: work.content_hash, revisionId: null }
      await adapter.capture(db, address, verifyWorkBody(address, work.content ?? ''))
      const revisions = revisionSchema.array().parse(await db.all(sql`SELECT rev, content, content_hash FROM ${workRevisions} WHERE work_id = ${work.id}`))
      for (const revision of revisions) {
        const revisionAddress = { ...address, revisionId: revision.rev, contentHash: revision.content_hash }
        await adapter.capture(db, revisionAddress, verifyWorkBody(revisionAddress, revision.content ?? ''))
      }
    })
  }
}
