import { sql } from 'drizzle-orm'
import type { SessionCloudScope, SessionRepositoryCard, SessionRepositoryFacts, ListMySessionsResponse } from '@solus/contracts/session-repositories'
import type { Db } from '../../db/database'
import { storageRepositoryName } from '../storage-repository-name'
import { sessionRepositories } from './schema'

export interface SessionRepositoryRow {
  cloud_scope: string; session_id: string; owner_user_id: string; repository: string; storage_scope: string
  head: string | null; synced_turn: number; last_run_host_id: string | null; running_host_id: string | null
  title: string | null; provider: SessionRepositoryCard['provider'] | null; model: string | null
  repository_key: string | null; branch: string | null; last_activity_at: number
}

/** The name of a session repository in cloud storage. A host names its local copy with `sessionRepositoryName` (`sync/sessions/session-repository.ts`); the two names differ. */
export function cloudSessionRepositoryName(scope: SessionCloudScope, sessionId: string): string {
  return storageRepositoryName('session', scope, sessionId)
}

export async function readSessionRepository(db: Db, scope: SessionCloudScope, sessionId: string): Promise<SessionRepositoryRow | undefined> {
  return db.get(sql`SELECT * FROM ${sessionRepositories} WHERE cloud_scope = ${scope} AND session_id = ${sessionId}`)
}

export async function createSessionRepository(db: Db, scope: SessionCloudScope, sessionId: string, ownerUserId: string, storageScope: string): Promise<SessionRepositoryRow> {
  const repository = cloudSessionRepositoryName(scope, sessionId)
  await db.run(sql`INSERT INTO ${sessionRepositories} (cloud_scope, session_id, owner_user_id, repository, storage_scope)
    VALUES (${scope}, ${sessionId}, ${ownerUserId}, ${repository}, ${storageScope}) ON CONFLICT (cloud_scope, session_id) DO NOTHING`)
  return (await readSessionRepository(db, scope, sessionId))!
}

export function sessionRepositoryFacts(row: SessionRepositoryRow): SessionRepositoryFacts {
  return { head: row.head, syncedTurn: row.synced_turn, lastRunHostId: row.last_run_host_id, runningHostId: row.running_host_id }
}

export async function listPersonalSessionRepositories(db: Db, ownerUserId: string): Promise<ListMySessionsResponse> {
  const rows = await db.all<SessionRepositoryRow>(sql`SELECT * FROM ${sessionRepositories} WHERE cloud_scope = ${`person:${ownerUserId}`} AND owner_user_id = ${ownerUserId} AND head IS NOT NULL ORDER BY last_activity_at DESC`)
  return { items: rows.filter(row => row.provider !== null).map(row => ({
    sessionId: row.session_id, ...sessionRepositoryFacts(row), title: row.title, provider: row.provider!, model: row.model,
    repositoryKey: row.repository_key, branch: row.branch, lastActivityAt: row.last_activity_at,
  })) }
}
