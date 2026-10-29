import { sql } from 'drizzle-orm'
import type { Db } from '../../db/database'
import { workRevisions, workStorage, works } from './schema'
import { useDefaultDatabaseWorkStorage, verifyWorkBody, type WorkBodyAddress, type WorkStorageAdapter } from './work-storage'

export class DatabaseWorkStorage implements WorkStorageAdapter {
  readonly provider = 'database' as const

  async read(_db: Db, address: WorkBodyAddress, projection: string | null): Promise<string> {
    // Legacy empty bodies were NULL. A nonempty body's hash still refuses a missing value.
    return verifyWorkBody(address, projection ?? '')
  }

  async capture(db: Db, address: WorkBodyAddress, content: string): Promise<void> {
    verifyWorkBody(address, content)
    const result = address.revisionId === null
      ? await db.run(sql`UPDATE ${works} SET content = ${content} WHERE id = ${address.workId} AND organization_id = ${address.organizationId}`)
      : await db.run(sql`UPDATE ${workRevisions} SET content = ${content} WHERE work_id = ${address.workId} AND rev = ${address.revisionId} AND organization_id = ${address.organizationId}`)
    // SQLite FTS triggers also contribute to Bun's change count.
    if (result.changes < 1) throw new Error('The work body has no matching storage record.')
  }

  async changed(_db: Db, _organizationId: string, _workId: string, _immediate: boolean): Promise<void> {
    // The caller's transaction already stores the complete body and metadata.
  }

  async remove(db: Db, organizationId: string, workId: string): Promise<void> {
    await db.run(sql`DELETE FROM ${workStorage} WHERE work_id = ${workId} AND organization_id = ${organizationId}`)
  }

  async flush(_workId: string): Promise<void> {
    // Database captures are already complete when their transaction commits.
  }
}

export const databaseWorkStorage = new DatabaseWorkStorage()
useDefaultDatabaseWorkStorage(databaseWorkStorage)
