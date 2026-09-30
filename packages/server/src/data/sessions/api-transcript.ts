import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import type { WorkspacePageQuery, WorkspaceTranscriptPage, WorkspaceTranscriptPart } from '@solus/contracts/solus-api'
import type { WorkspaceRequestContext } from '../../admission/workspace-credentials'
import { SolusApiError } from '../../admission/workspace-error'
import { getDatabase } from '../../db/database'
import { apiScope } from '../workspace/context'
import { readCursor, writeCursor, type PageCursor } from '../workspace/page'
import { scopeClause } from '../scope'
import { sessionTranscripts } from './transcript-schema'
import { resolveSessionLineageById } from './session-lineage'

/** Text leaves the database in chunks of this many code points; at most 16 chunks make one page. */
const chunkSize = 16_384
const partRow = z.object({ sequence: z.number(), revision: z.string(), message_id: z.string(), role: z.string(),
  timestamp: z.number(), content: z.string(), content_length: z.number(), tool_name: z.string().nullable(), parent_tool_use_id: z.string().nullable() })

interface TextSource {
  table: SQL; predicate: SQL; sequence: SQL; revision: SQL; messageId: SQL; role: SQL;
  timestamp: SQL; content: SQL; toolName: SQL; parentToolUseId: SQL
}
async function transcriptSource(context: WorkspaceRequestContext, sessionId: string): Promise<TextSource> {
  const db = getDatabase()
  const scope = apiScope(context)
  const mirrored = await db.get(sql`SELECT position FROM ${sessionTranscripts} WHERE session_id = ${sessionId} AND ${scopeClause(scope)} LIMIT 1`)
  if (mirrored || db.engine === 'postgres') {
    const field = (name: string): SQL => db.engine === 'postgres' ? sql`message::jsonb->>${name}` : sql`json_extract(message, ${'$.' + name})`
    return {
      table: sql`${sessionTranscripts}`, predicate: sql`session_id = ${sessionId} AND ${scopeClause(scope)}`,
      sequence: sql`position`, revision: sql`CAST(updated_at AS TEXT)`,
      messageId: sql`COALESCE(${field('messageId')}, CAST(position AS TEXT))`,
      role: field('role'), timestamp: sql`CAST(${field('timestamp')} AS BIGINT)`,
      content: sql`COALESCE(${field('content')}, '')`, toolName: field('toolName'), parentToolUseId: field('parentToolUseId'),
    }
  }
  const lineage = resolveSessionLineageById(sessionId)
  const ids = [...new Set([sessionId, ...lineage?.members.flatMap(member => member.providerSessionId ? [member.providerSessionId] : []) ?? []])]
  return {
    table: sql`session_messages`, predicate: sql`session_id IN (${sql.join(ids.map(id => sql`${id}`), sql`, `)})`,
    sequence: sql`id`, revision: sql`CAST(id AS TEXT)`, messageId: sql`COALESCE(uuid, CAST(id AS TEXT))`,
    role: sql`role`, timestamp: sql`ts`, content: sql`text`, toolName: sql`NULL`, parentToolUseId: sql`NULL`,
  }
}

/** Text is sliced in SQL, in Unicode code points, before it crosses the database boundary. */
export async function readApiTranscript(context: WorkspaceRequestContext, sessionId: string, query: WorkspacePageQuery): Promise<WorkspaceTranscriptPage> {
  const db = getDatabase()
  const { table, predicate, sequence, revision, messageId, role, timestamp, content, toolName, parentToolUseId } = await transcriptSource(context, sessionId)
  const after = readCursor(query.cursor)
  const offset = after?.offset ?? 0
  const lower = after ? (offset ? sql`${sequence} >= ${after.time}` : sql`${sequence} > ${after.time}`) : sql`1 = 1`
  const start = after && offset ? sql`CASE WHEN ${sequence} = ${after.time} THEN ${offset} ELSE 0 END` : sql`0`
  const rows = partRow.array().parse(await db.all(sql`
    SELECT ${sequence} AS sequence, ${revision} AS revision, ${messageId} AS message_id,
      ${role} AS role, ${timestamp} AS timestamp, SUBSTR(${content}, (${start}) + 1, ${chunkSize}) AS content,
      LENGTH(${content}) AS content_length, ${toolName} AS tool_name, ${parentToolUseId} AS parent_tool_use_id
    FROM ${table} WHERE ${predicate} AND ${lower}
    ORDER BY ${sequence} LIMIT ${Math.min(query.limit, 16) + 1}
  `))
  if (after && offset && (rows[0]?.sequence !== after.time || rows[0]?.revision !== after.id)) {
    throw new SolusApiError(400, 'INVALID_CURSOR', 'The message changed. Start a new transcript read.')
  }
  const { items, next } = transcriptParts(rows.slice(0, Math.min(query.limit, 16)), after)
  const more = next && (next.offset !== undefined || rows.length > items.length)
  return { items, nextCursor: more && items.length ? writeCursor(next) : null }
}

function transcriptParts(rows: z.infer<typeof partRow>[], after: PageCursor | undefined) {
  const offset = after?.offset ?? 0
  const items: WorkspaceTranscriptPart[] = []
  let next = after
  for (const row of rows) {
    const contentOffset = after?.time === row.sequence ? offset : 0
    const end = contentOffset + Array.from(row.content).length
    const role = row.role === 'user' || row.role === 'assistant' || row.role === 'system' ? row.role : 'tool'
    const part: WorkspaceTranscriptPart = { messageId: row.message_id, role, timestamp: new Date(row.timestamp).toISOString(),
      content: row.content, contentOffset, isLastPart: end >= row.content_length, toolName: row.tool_name, parentToolUseId: row.parent_tool_use_id }
    items.push(part)
    next = { time: row.sequence, id: row.revision, offset: part.isLastPart ? undefined : end }
    if (!part.isLastPart) break
  }
  return { items, next }
}
