import { sql } from 'drizzle-orm'
import { z } from 'zod'
import { sessionExecutionSchema, type SessionExecution } from '@solus/contracts/session-execution'
import type { SessionSubagentExecution } from '@solus/contracts/session-digest'
import { getDatabase, type Db } from '../../db/database'
import type { RecordScope } from '../../admission/principal'
import { scopeClause } from '../scope'
import { session, sessionExecutions } from './schema'

const rowSchema = z.object({ session_id: z.string(), tool_id: z.string(), execution: z.string() })

export async function readSessionExecutions(scope: RecordScope, ids: readonly string[], subagents = false) {
  const result = new Map<string, { execution?: SessionExecution; subagents: SessionSubagentExecution[] }>()
  if (ids.length === 0) return result
  const rows = rowSchema.array().parse(await getDatabase().all(sql`
    SELECT session_id, tool_id, execution FROM ${sessionExecutions}
    WHERE ${scopeClause(scope)} AND session_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
      ${subagents ? sql`` : sql`AND tool_id = ''`}
  `))
  for (const row of rows) {
    const execution = sessionExecutionSchema.parse(JSON.parse(row.execution))
    let group = result.get(row.session_id)
    if (!group) {
      group = { subagents: [] }
      result.set(row.session_id, group)
    }
    if (row.tool_id) group.subagents.push({ toolId: row.tool_id, execution })
    else group.execution = execution
  }
  return result
}

export async function readSessionExecution(organizationId: string, sessionId: string, toolId: string): Promise<SessionExecution | null> {
  const row = z.object({ execution: z.string() }).nullish().parse(await getDatabase().get(sql`
    SELECT execution FROM ${sessionExecutions}
    WHERE session_id = ${sessionId} AND tool_id = ${toolId} AND organization_id = ${organizationId}
  `))
  return row ? sessionExecutionSchema.parse(JSON.parse(row.execution)) : null
}

/** The runner advances a revision. Copies can arrive twice or out of order. */
export async function writeSessionExecution(
  organizationId: string, sessionId: string, toolId: string, execution: SessionExecution, db: Db = getDatabase(),
): Promise<boolean> {
  const result = await db.run(sql`
    INSERT INTO ${sessionExecutions}(session_id, tool_id, organization_id, revision, execution)
    SELECT ${sessionId}, ${toolId}, organization_id, ${execution.revision}, ${JSON.stringify(execution)}
    FROM ${session} WHERE session_id = ${sessionId} AND organization_id = ${organizationId}
    ON CONFLICT (session_id, tool_id) DO UPDATE SET revision = excluded.revision, execution = excluded.execution
    WHERE ${sessionExecutions}.organization_id = excluded.organization_id AND ${sessionExecutions}.revision < excluded.revision
  `)
  return result.changes > 0
}

/** On boot, only this runner can settle work it left open. */
export async function interruptOwnSessionExecutions(at: number): Promise<void> {
  const rows = rowSchema.extend({ organization_id: z.string() }).array().parse(await getDatabase().all(sql`
    SELECT saved.session_id, saved.tool_id, saved.organization_id, saved.execution
    FROM ${sessionExecutions} saved JOIN ${session} owner ON owner.session_id = saved.session_id
    WHERE owner.runner_host_id IS NULL
  `))
  for (const row of rows) {
    const saved = sessionExecutionSchema.parse(JSON.parse(row.execution))
    if (!saved.current) continue
    await writeSessionExecution(row.organization_id, row.session_id, row.tool_id, {
      revision: saved.revision + 1,
      current: null,
      lastTurn: { runId: saved.current.runId, startedAt: saved.current.startedAt, endedAt: at, outcome: 'interrupted' },
      hasPendingQuestion: saved.hasPendingQuestion,
    })
  }
}
