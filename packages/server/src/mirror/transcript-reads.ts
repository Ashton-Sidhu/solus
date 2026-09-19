import { sql } from 'drizzle-orm'
import { z } from 'zod'
import type { SessionHistoryPage, WireSessionLoadMessage } from '@solus/contracts/session-history'
import { getDatabase } from '../db/database'
import { sessionTranscripts } from './schema'

/**
 * The workspace service's history reads (docs/plans/cloud-service-model.md §6):
 * a member opening a session on the service gets the rows a runner mirrored,
 * in position order. The rows are already what a client may see (the runner
 * projected them before mirroring), so they are served as stored. A page
 * cursor is the position of the oldest row on the page, as text, so the client
 * can hand it back without knowing what it is.
 */

const agentIdSchema = z.enum(['claude-code', 'codex', 'opencode'])

/** A mirrored row as the runner projected it; every field the wire contract names, nothing else. */
const messageSchema: z.ZodType<WireSessionLoadMessage> = z.object({
  messageId: z.string().optional(),
  role: z.string(),
  content: z.string(),
  imageAttachments: z.array(z.object({ mimeType: z.string(), dataUrl: z.string() })).optional(),
  toolName: z.string().optional(),
  toolId: z.string().optional(),
  toolInput: z.string().optional(),
  toolStatus: z.enum(['running', 'completed', 'error']).optional(),
  isSubagent: z.boolean().optional(),
  subagentType: z.string().optional(),
  toolResultForId: z.string().optional(),
  planContent: z.string().optional(),
  planFilePath: z.string().optional(),
  planToolUseId: z.string().optional(),
  parentToolUseId: z.string().optional(),
  agentChangedTo: z.string().optional(),
  agentChangedFromModel: z.string().optional(),
  agentChangedToModel: z.string().optional(),
  agentChangedFromProvider: agentIdSchema.optional(),
  agentChangedToProvider: agentIdSchema.optional(),
  timestamp: z.number(),
  questionResult: z.string().optional(),
  toolInputKey: z.string().optional(),
  report: z.string().optional(),
  status: z.enum(['ok', 'error']).optional(),
  errorHead: z.string().optional(),
  contentBytes: z.number().optional(),
  agentConversationResult: z.object({ agentSessionId: z.string().optional(), watcherRegistered: z.boolean().optional() }).optional(),
  artifactWorkRef: z.object({ workId: z.string(), title: z.string() }).optional(),
  workUpdateSucceeded: z.boolean().optional(),
})

const rowSchema = z.object({ position: z.number(), message: z.string() })

function messagesOf(rows: Array<z.infer<typeof rowSchema>>): WireSessionLoadMessage[] {
  return rows.map((row) => messageSchema.parse(JSON.parse(row.message)))
}

/** The whole transcript, or its last `limit` rows. */
export async function readTranscript(organizationId: string, sessionId: string, limit?: number): Promise<WireSessionLoadMessage[]> {
  const db = getDatabase()
  if (limit && limit > 0) {
    const rows = rowSchema.array().parse(await db.all(sql`
      SELECT position, message FROM ${sessionTranscripts}
      WHERE organization_id = ${organizationId} AND session_id = ${sessionId}
      ORDER BY position DESC LIMIT ${limit}
    `))
    return messagesOf(rows.reverse())
  }
  return messagesOf(rowSchema.array().parse(await db.all(sql`
    SELECT position, message FROM ${sessionTranscripts}
    WHERE organization_id = ${organizationId} AND session_id = ${sessionId}
    ORDER BY position
  `)))
}

function positionOf(cursor: string): number {
  const position = Number(cursor)
  if (!Number.isSafeInteger(position) || position < 0) throw new Error('Invalid history cursor')
  return position
}

/** The newest `limit` rows, or the `limit` rows before the cursor; `before` names the next older page, or null at the start. */
export async function readTranscriptPage(organizationId: string, sessionId: string, limit: number, before?: string): Promise<SessionHistoryPage> {
  const db = getDatabase()
  // The cursor clause is left out for the newest page: `position` is a 32-bit
  // integer on Postgres, so no sentinel value stands in for "no bound".
  const olderThan = before === undefined ? sql`` : sql`AND position < ${positionOf(before)}`
  const rows = rowSchema.array().parse(await db.all(sql`
    SELECT position, message FROM ${sessionTranscripts}
    WHERE organization_id = ${organizationId} AND session_id = ${sessionId} ${olderThan}
    ORDER BY position DESC LIMIT ${limit + 1}
  `))
  const hasMore = rows.length > limit
  const page = rows.slice(0, limit).reverse()
  return {
    messages: messagesOf(page),
    before: hasMore && page.length > 0 ? String(page[0].position) : null,
  }
}
