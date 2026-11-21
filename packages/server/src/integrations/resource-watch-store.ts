import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { RESOURCE_WATCH_END_REASONS, type ResourceWatchEndReason } from '@solus/contracts/integrations/resource-watch'
import { rows, runSql } from './sql'

/**
 * The host table `integration_resource_watch` (docs/plans/mcp-first-class.md
 * §11.5). A row is `live` until it ends; a restart of the host reads the live
 * rows again. `wakes` and `last_wake_at` keep the limits across a restart.
 */
export interface ResourceWatchRow {
  id: string
  organizationId: string
  sessionId: string
  integrationId: string
  personKey: string
  accountId: string
  uri: string
  name: string
  status: 'live' | 'ended'
  endReason: ResourceWatchEndReason | null
  statusMessage: string | null
  wakes: number
  lastWakeAt: number | null
  createdAt: number
  updatedAt: number
  expiresAt: number
}

const rowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  session_id: z.string(),
  integration_id: z.string(),
  user_id: z.string(),
  account_id: z.string(),
  uri: z.string(),
  name: z.string(),
  status: z.enum(['live', 'ended']),
  end_reason: z.enum(RESOURCE_WATCH_END_REASONS).nullable(),
  status_message: z.string().nullable(),
  wakes: z.number(),
  last_wake_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  expires_at: z.number(),
}).transform((row): ResourceWatchRow => ({
  id: row.id,
  organizationId: row.organization_id,
  sessionId: row.session_id,
  integrationId: row.integration_id,
  personKey: row.user_id,
  accountId: row.account_id,
  uri: row.uri,
  name: row.name,
  status: row.status,
  endReason: row.end_reason,
  statusMessage: row.status_message,
  wakes: row.wakes,
  lastWakeAt: row.last_wake_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
}))

export class ResourceWatchStore {
  insert(row: ResourceWatchRow): void {
    runSql(sql`
      INSERT INTO integration_resource_watch (id, organization_id, session_id, integration_id, user_id, account_id, uri, name,
        status, end_reason, status_message, wakes, last_wake_at, created_at, updated_at, expires_at)
      VALUES (${row.id}, ${row.organizationId}, ${row.sessionId}, ${row.integrationId}, ${row.personKey}, ${row.accountId}, ${row.uri}, ${row.name},
        ${row.status}, ${row.endReason}, ${row.statusMessage}, ${row.wakes}, ${row.lastWakeAt}, ${row.createdAt}, ${row.updatedAt}, ${row.expiresAt})
    `)
  }

  /** A session's rows that are live, or that changed at `since` or later, the oldest first. */
  listForSession(sessionId: string, since: number): ResourceWatchRow[] {
    return rows(sql`
      SELECT * FROM integration_resource_watch WHERE session_id = ${sessionId} AND (status = 'live' OR updated_at >= ${since})
      ORDER BY created_at
    `, rowSchema)
  }

  /** Every live row: the work of a restart. */
  live(): ResourceWatchRow[] {
    return rows(sql`SELECT * FROM integration_resource_watch WHERE status = 'live' ORDER BY created_at`, rowSchema)
  }

  /** One change started the agent. */
  woke(id: string, wakes: number, at: number): void {
    runSql(sql`UPDATE integration_resource_watch SET wakes = ${wakes}, last_wake_at = ${at}, updated_at = ${at} WHERE id = ${id}`)
  }

  note(id: string, statusMessage: string | null, at: number): void {
    runSql(sql`UPDATE integration_resource_watch SET status_message = ${statusMessage}, updated_at = ${at} WHERE id = ${id}`)
  }

  end(id: string, reason: ResourceWatchEndReason, statusMessage: string | null, at: number): void {
    runSql(sql`
      UPDATE integration_resource_watch SET status = 'ended', end_reason = ${reason}, status_message = ${statusMessage}, updated_at = ${at}
      WHERE id = ${id} AND status = 'live'
    `)
  }

  /** Ended rows older than `before` are only history: the list stops showing them. */
  prune(before: number): void {
    runSql(sql`DELETE FROM integration_resource_watch WHERE status = 'ended' AND updated_at < ${before}`)
  }
}
