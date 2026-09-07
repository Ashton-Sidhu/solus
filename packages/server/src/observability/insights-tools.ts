import { z } from 'zod'
import type { AgentTool } from '../agents/tools/agent-tool'
import { runGuardedSql } from './sql-guard'

/** Agent tool responses share the model context, so keep exploratory listings
 * bounded below the Insights client limit. Aggregate queries are unaffected. */
export const AGENT_INSIGHTS_ROW_CAP = 500

const queryInsightsFields = {
  sql: z.string().trim().min(1).describe(
    'One read-only SQLite SELECT or WITH statement. Query turns for one row per agent turn, events for operations within turns, internal_events for Solus operations, log_events for structured logs attached to spans, or spans for raw cross-kind data.',
  ),
} as const

const QUERY_INSIGHTS_DESCRIPTION = [
  'Run a read-only SQLite query against the current Solus Insights database.',
  'Use this whenever an insights question needs database facts instead of estimates.',
  'The main views are `turns` (one row per user-to-agent turn), `events` (one row per observed operation; filter by `kind`), `internal_events` (Solus operations), and `log_events` (structured logs correlated by trace_id and span_id). `spans` is the raw span fact table. Times are epoch milliseconds and durations are milliseconds.',
  "To discover columns, query `pragma_table_info`, for example: SELECT name, type FROM pragma_table_info('turns').",
  'Only one SELECT or WITH statement is accepted. Writes, ATTACH, and PRAGMA statements are rejected. Results are JSON with columns, rows, rowCount, and truncated; at most 500 rows are returned.',
].join('\n')

// Declared as a plain AgentTool, like every other tool in the toolbox, and its
// input parsed here. Pinning the generic to this tool's own field shape made it
// the one member of `solusToolbox` that no group type could hold, so any array
// or record built from the toolbox failed to typecheck against `AgentTool`.
export const queryInsightsAgentTool: AgentTool = {
  name: 'query_insights',
  description: QUERY_INSIGHTS_DESCRIPTION,
  inputFields: queryInsightsFields,
  requiresApproval: false,
  execute: async (input) => {
    const parsed = z.object(queryInsightsFields).safeParse(input)
    if (!parsed.success) {
      return { ok: false, text: 'query_insights requires `sql`: one read-only SELECT or WITH statement.' }
    }
    const { sql } = parsed.data
    try {
      const result = runGuardedSql(sql, AGENT_INSIGHTS_ROW_CAP + 1)
      const truncated = result.rows.length > AGENT_INSIGHTS_ROW_CAP
      const rows = truncated ? result.rows.slice(0, AGENT_INSIGHTS_ROW_CAP) : result.rows
      return {
        ok: true,
        text: JSON.stringify({
          columns: result.columns.map((column) => column.name),
          rows,
          rowCount: rows.length,
          truncated,
        }),
      }
    } catch (error) {
      return {
        ok: false,
        text: error instanceof Error ? error.message : String(error),
      }
    }
  },
}
