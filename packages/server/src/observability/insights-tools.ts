import { z } from 'zod'
import type { AgentTool } from '../agents/tools/agent-tool'
import { runGuardedSql } from './sql-guard'

/** Agent tool responses share the model context, so keep exploratory listings
 * bounded below the Insights client limit. Aggregate queries are unaffected. */
export const AGENT_INSIGHTS_ROW_CAP = 500

const queryInsightsFields = {
  sql: z.string().trim().min(1).describe(
    'One read-only SQLite SELECT or WITH statement. Query turns for one row per agent turn, events for operations within turns, internal_events for Solus operations, or spans for raw cross-kind data.',
  ),
} as const

const QUERY_INSIGHTS_DESCRIPTION = [
  'Run a read-only SQLite query against the current Solus Insights database.',
  'Use this whenever an insights question needs database facts instead of estimates.',
  'The main views are `turns` (one row per user-to-agent turn), `events` (one row per observed operation; filter by `kind`), and `internal_events` (Solus operations). `spans` is the raw fact table. Times are epoch milliseconds and durations are milliseconds.',
  "To discover columns, query `pragma_table_info`, for example: SELECT name, type FROM pragma_table_info('turns').",
  'Only one SELECT or WITH statement is accepted. Writes, ATTACH, and PRAGMA statements are rejected. Results are JSON with columns, rows, rowCount, and truncated; at most 500 rows are returned.',
].join('\n')

export const queryInsightsAgentTool: AgentTool<typeof queryInsightsFields> = {
  name: 'query_insights',
  description: QUERY_INSIGHTS_DESCRIPTION,
  inputFields: queryInsightsFields,
  requiresApproval: false,
  execute: async ({ sql }) => {
    try {
      const result = runGuardedSql(sql, AGENT_INSIGHTS_ROW_CAP + 1)
      const truncated = result.rows.length > AGENT_INSIGHTS_ROW_CAP
      const rows = truncated ? result.rows.slice(0, AGENT_INSIGHTS_ROW_CAP) : result.rows
      return {
        ok: true,
        text: JSON.stringify({
          columns: result.columns,
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
