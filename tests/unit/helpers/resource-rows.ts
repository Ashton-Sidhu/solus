import { sql } from 'drizzle-orm'
import type { Db } from '@solus/server/db/database'

/**
 * One row of a shareable resource with its owner and organization
 * (docs/plans/access-model.md §2.2), and nothing else a role reads. A test that
 * asks for a role needs the resource to exist: a role is decided from its row.
 */
export async function seedResource(db: Db, kind: 'session' | 'work' | 'task', id: string, ownerKey: string, organizationId = 'local'): Promise<void> {
  switch (kind) {
    case 'session':
      await db.run(sql`
        INSERT INTO session_records (session_id, organization_id, owner_key, provider, project_path, created_at, last_activity_at)
        VALUES (${id}, ${organizationId}, ${ownerKey}, 'claude-code', '-tmp-project', 1, 1)
      `)
      return
    case 'work':
      await db.run(sql`
        INSERT INTO works (id, title, type, content, organization_id, owner_key, content_hash, created_at, updated_at)
        VALUES (${id}, ${id}, 'doc', '', ${organizationId}, ${ownerKey}, 'hash', 1, 1)
      `)
      return
    case 'task':
      await db.run(sql`
        INSERT INTO tasks (id, title, created_at, updated_at, organization_id, owner_key)
        VALUES (${id}, ${id}, 1, 1, ${organizationId}, ${ownerKey})
      `)
  }
}
