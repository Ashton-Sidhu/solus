import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { MCP_TASK_STATUSES, type McpTaskStatus } from '@solus/contracts/integrations/mcp-task'
import { firstRow, rows, runSql } from './sql'

/**
 * The host table `mcp_task` (docs/plans/mcp-first-class.md §12.2). A row is
 * open until `delivered_at` is set: the end went to the agent, or nothing is
 * to be sent (the person cancelled, the session is gone). A restart reads the
 * open rows again (§12.4).
 */
export interface McpTaskRow {
  id: string
  organizationId: string
  sessionId: string
  integrationId: string
  personKey: string
  accountId: string
  tool: string
  /** The server's task id. It can act as a bearer token: it never leaves the host. */
  upstreamTaskId: string
  status: McpTaskStatus
  statusMessage: string | null
  traceparent: string | null
  createdAt: number
  updatedAt: number
  expiresAt: number
  deliveredAt: number | null
}

const rowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  session_id: z.string(),
  integration_id: z.string(),
  user_id: z.string(),
  account_id: z.string(),
  tool: z.string(),
  upstream_task_id: z.string(),
  status: z.enum(MCP_TASK_STATUSES),
  status_message: z.string().nullable(),
  traceparent: z.string().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  expires_at: z.number(),
  delivered_at: z.number().nullable(),
}).transform((row): McpTaskRow => ({
  id: row.id,
  organizationId: row.organization_id,
  sessionId: row.session_id,
  integrationId: row.integration_id,
  personKey: row.user_id,
  accountId: row.account_id,
  tool: row.tool,
  upstreamTaskId: row.upstream_task_id,
  status: row.status,
  statusMessage: row.status_message,
  traceparent: row.traceparent,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  expiresAt: row.expires_at,
  deliveredAt: row.delivered_at,
}))

export class McpTaskStore {
  insert(row: McpTaskRow): void {
    runSql(sql`
      INSERT INTO mcp_task (id, organization_id, session_id, integration_id, user_id, account_id, tool, upstream_task_id,
        status, status_message, traceparent, created_at, updated_at, expires_at, delivered_at)
      VALUES (${row.id}, ${row.organizationId}, ${row.sessionId}, ${row.integrationId}, ${row.personKey}, ${row.accountId}, ${row.tool}, ${row.upstreamTaskId},
        ${row.status}, ${row.statusMessage}, ${row.traceparent}, ${row.createdAt}, ${row.updatedAt}, ${row.expiresAt}, ${row.deliveredAt})
    `)
  }

  get(id: string): McpTaskRow | null {
    return firstRow(sql`SELECT * FROM mcp_task WHERE id = ${id}`, rowSchema)
  }

  /** A session's rows that are open, or that changed at `since` or later, the oldest first. */
  listForSession(sessionId: string, since: number): McpTaskRow[] {
    return rows(sql`
      SELECT * FROM mcp_task WHERE session_id = ${sessionId} AND (delivered_at IS NULL OR updated_at >= ${since})
      ORDER BY created_at
    `, rowSchema)
  }

  /** Every open row: the work of a restart (§12.4). */
  open(): McpTaskRow[] {
    return rows(sql`SELECT * FROM mcp_task WHERE delivered_at IS NULL ORDER BY created_at`, rowSchema)
  }

  update(id: string, change: { status: McpTaskStatus; statusMessage: string | null; updatedAt: number; expiresAt?: number }): void {
    runSql(sql`
      UPDATE mcp_task SET status = ${change.status}, status_message = ${change.statusMessage}, updated_at = ${change.updatedAt}
      ${change.expiresAt === undefined ? sql`` : sql`, expires_at = ${change.expiresAt}`}
      WHERE id = ${id}
    `)
  }

  /**
   * Claims the one delivery of a row: true for the first caller only. One
   * statement, so a second claim, after a restart or from a second path, is
   * refused by the database (§12.4).
   */
  claimDelivery(id: string, at: number): boolean {
    return runSql(sql`UPDATE mcp_task SET delivered_at = ${at} WHERE id = ${id} AND delivered_at IS NULL`) > 0
  }

  /** Rows that ended more than `before` ago are only history: the list stops showing them. */
  prune(before: number): void {
    runSql(sql`DELETE FROM mcp_task WHERE delivered_at IS NOT NULL AND updated_at < ${before}`)
  }
}
