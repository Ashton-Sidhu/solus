import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { historyPageIsFull, startsHistoryTurn, type SessionHistoryPage, type WireSessionLoadMessage, type SessionMessageWindow, type SessionMessageWindowRequest } from '@solus/contracts/session-history'
import { activitySchema, type Activity } from '@solus/contracts/activity'
import { LINEAGE_SWITCH_ID_PREFIX } from '../activity/activity'
import { getDatabase } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { sessionTranscripts } from './transcript-schema'

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
  sourceSessionId: z.string().optional(),
  sourceProvider: agentIdSchema.optional(),
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
  activity: activitySchema.optional(),
  compaction: z.object({
    trigger: z.enum(['manual', 'auto']).optional(),
    preTokens: z.number().optional(),
    postTokens: z.number().optional(),
  }).optional(),
  timestamp: z.number(),
  questionAnswer: z.object({
    questionId: z.string(),
    questions: z.array(z.object({
      id: z.string().optional(), header: z.string().optional(), question: z.string(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional(), preview: z.string().optional() })),
      multiSelect: z.boolean(),
    })),
    answers: z.record(z.string(), z.string()),
  }).optional(),
  questionResult: z.string().optional(),
  toolInputKey: z.string().optional(),
  report: z.string().optional(),
  status: z.enum(['ok', 'error']).optional(),
  errorHead: z.string().optional(),
  contentBytes: z.number().optional(),
  agentConversationResult: z.object({ sessionId: z.string().optional(), messageId: z.string().optional(), provider: z.enum(['claude-code', 'codex', 'opencode']).optional(), serverId: z.string().optional() }).optional(),
  artifactWorkRef: z.object({ workId: z.string(), title: z.string(), contentVersion: z.number().int().optional() }).optional(),
  workUpdateSucceeded: z.boolean().optional(),
})

const rowSchema = z.object({ position: z.number(), message: z.string() })

/** A handoff divider a runner mirrored before plan 012 stage 6 drew it as activity. */
const legacySwitchSchema = z.object({
  messageId: z.string().optional(),
  timestamp: z.number(),
  agentChangedToProvider: agentIdSchema,
  agentChangedFromProvider: agentIdSchema.optional(),
  agentChangedToModel: z.string().optional(),
  agentChangedFromModel: z.string().optional(),
})

function messagesOf(sessionId: string, rows: Array<z.infer<typeof rowSchema>>): WireSessionLoadMessage[] {
  return rows.map((row) => {
    const stored: unknown = JSON.parse(row.message)
    const message = messageSchema.parse(stored)
    const legacy = message.activity ? null : legacySwitchSchema.safeParse(stored).data
    if (legacy) message.activity = legacySwitch(sessionId, legacy)
    return message
  })
}

function legacySwitch(sessionId: string, legacy: z.infer<typeof legacySwitchSchema>): Activity {
  const activity: Activity = {
    id: legacy.messageId ?? `${LINEAGE_SWITCH_ID_PREFIX}${sessionId}:${legacy.timestamp}`,
    subject: { kind: 'session', id: sessionId },
    at: legacy.timestamp,
    by: { kind: 'system' },
    kind: 'agent_switched',
    provider: legacy.agentChangedToProvider,
  }
  if (legacy.agentChangedFromProvider) activity.fromProvider = legacy.agentChangedFromProvider
  if (legacy.agentChangedToModel) activity.model = legacy.agentChangedToModel
  if (legacy.agentChangedFromModel) activity.fromModel = legacy.agentChangedFromModel
  return activity
}

/** The whole transcript, or its last `limit` rows. */
export async function readTranscript(scope: RecordScope, sessionId: string, limit?: number): Promise<WireSessionLoadMessage[]> {
  const db = getDatabase()
  if (limit && limit > 0) {
    const rows = rowSchema.array().parse(await db.all(sql`
      SELECT position, message FROM ${sessionTranscripts}
      WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
      ORDER BY position DESC LIMIT ${limit}
    `))
    return messagesOf(sessionId, rows.reverse())
  }
  return messagesOf(sessionId, rowSchema.array().parse(await db.all(sql`
    SELECT position, message FROM ${sessionTranscripts}
    WHERE ${scopeClause(scope)} AND session_id = ${sessionId}
    ORDER BY position
  `)))
}

/** Resolve a portable search target in the mirrored copy, even while its runner is offline. */
export async function readTranscriptMessageWindow(scope: RecordScope, request: SessionMessageWindowRequest): Promise<SessionMessageWindow> {
  const db = getDatabase()
  const field = (name: 'role' | 'toolName' | 'parentToolUseId' | 'messageId' | 'sourceSessionId' | 'content' | 'timestamp') => db.engine === 'postgres'
    ? sql`message::jsonb->>${name}` : sql`json_extract(message, ${'$.' + name})`
  const visible = sql`${scopeClause(scope)} AND session_id = ${request.sessionId}
    AND ${field('role')} IN ('user', 'assistant') AND ${field('toolName')} IS NULL AND ${field('parentToolUseId')} IS NULL`
  const target = request.target
  const identity = !target ? sql`position = ${request.messageId}` : sql`
    COALESCE(${field('sourceSessionId')}, session_id) = ${target.sourceSessionId} AND ${target.messageId
      ? sql`${field('messageId')} = ${target.messageId}`
      : sql`${field('role')} = ${target.role} AND CAST(${field('timestamp')} AS BIGINT) = ${target.timestamp}
        AND substr(${field('content')}, 1, length(${target.text})) = ${target.text}`}`
  const hit = rowSchema.array().parse(await db.all(sql`SELECT position, message FROM ${sessionTranscripts} WHERE ${visible} AND ${identity} LIMIT 1`))[0]
  if (!hit) return { messages: [], hiddenBefore: 0, hiddenAfter: 0 }
  const radius = Math.min(5, Math.max(0, Math.trunc(request.radius ?? 1)))
  const [before, after, counts] = await Promise.all([
    db.all(sql`SELECT position, message FROM ${sessionTranscripts} WHERE ${visible} AND position < ${hit.position} ORDER BY position DESC LIMIT ${radius}`),
    db.all(sql`SELECT position, message FROM ${sessionTranscripts} WHERE ${visible} AND position > ${hit.position} ORDER BY position LIMIT ${radius}`),
    db.all(sql`SELECT COUNT(CASE WHEN position < ${hit.position} THEN 1 END) AS before_count,
      COUNT(CASE WHEN position > ${hit.position} THEN 1 END) AS after_count FROM ${sessionTranscripts} WHERE ${visible}`),
  ])
  const count = z.object({ before_count: z.coerce.number(), after_count: z.coerce.number() }).parse(counts[0])
  const rows = [...rowSchema.array().parse(before).reverse(), hit, ...rowSchema.array().parse(after)]
  return {
    hitMessageId: hit.position,
    hiddenBefore: count.before_count - before.length, hiddenAfter: count.after_count - after.length,
    messages: rows.map(row => {
      const message = messageSchema.parse(JSON.parse(row.message))
      return { messageId: row.position, role: z.enum(['user', 'assistant']).parse(message.role), ts: message.timestamp, text: message.content }
    }),
  }
}

function positionOf(cursor: string): number {
  const position = Number(cursor)
  if (!Number.isSafeInteger(position) || position < 0) throw new Error('Invalid history cursor')
  return position
}

const PAGE_SCAN_ROWS = 500

/** The newest `turnLimit` user turns, or the `turnLimit` turns before the
 * cursor, within the page's row and byte budget; `before` names the next older
 * page, or null at the start. Rows are read newest-first in bounded chunks
 * until the page's first turn starts or the budget runs out. */
export async function readTranscriptPage(scope: RecordScope, sessionId: string, turnLimit: number, before?: string): Promise<SessionHistoryPage> {
  const db = getDatabase()
  const page: Array<z.infer<typeof rowSchema>> = []
  let bound = before === undefined ? undefined : positionOf(before)
  let turns = 0
  let bytes = 0
  for (;;) {
    // The cursor clause is left out for the newest chunk: `position` is a
    // 32-bit integer on Postgres, so no sentinel value stands in for "no bound".
    const olderThan = bound === undefined ? sql`` : sql`AND position < ${bound}`
    const rows = rowSchema.array().parse(await db.all(sql`
      SELECT position, message FROM ${sessionTranscripts}
      WHERE ${scopeClause(scope)} AND session_id = ${sessionId} ${olderThan}
      ORDER BY position DESC LIMIT ${PAGE_SCAN_ROWS}
    `))
    for (const row of rows) {
      page.push(row)
      bytes += Buffer.byteLength(row.message)
      const turnsComplete = startsHistoryTurn(messageSchema.parse(JSON.parse(row.message))) && ++turns >= turnLimit
      if (turnsComplete || historyPageIsFull(page.length, bytes)) {
        const first = page.at(-1)!
        const older = await db.all(sql`
          SELECT position FROM ${sessionTranscripts}
          WHERE ${scopeClause(scope)} AND session_id = ${sessionId} AND position < ${first.position}
          LIMIT 1
        `)
        return { messages: messagesOf(sessionId, page.reverse()), before: older.length > 0 ? String(first.position) : null }
      }
    }
    if (rows.length < PAGE_SCAN_ROWS) return { messages: messagesOf(sessionId, page.reverse()), before: null }
    bound = rows[rows.length - 1].position
  }
}
