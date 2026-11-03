import type { InsightFilter } from './visibility'

/** Registered low-cardinality columns `metricsDistinctValues` may enumerate,
 *  with the condition each reads under. `tool` scopes to tool_call spans so
 *  unrelated span names never pollute it. A turn's dimensions are read from
 *  turn roots only: every child repeats its root's values, so the root rows
 *  give the same set from a fraction of the rows (plans/028 A4). */
const DISTINCT_COLUMNS = {
  tool: { expression: 'name', where: "kind = 'tool_call'" },
  model: { expression: 'model', where: "kind = 'turn' AND model IS NOT NULL" },
  provider: { expression: 'provider', where: "kind = 'turn' AND provider IS NOT NULL" },
  status: { expression: 'status', where: '1 = 1' },
  service: { expression: 'service', where: '1 = 1' },
  kind: { expression: 'kind', where: '1 = 1' },
  origin: { expression: 'origin', where: "kind = 'turn' AND origin IS NOT NULL" },
  user_email: { expression: 'user_email', where: "kind = 'turn' AND user_email IS NOT NULL" },
  organization_id: { expression: 'organization_id', where: "kind = 'turn' AND organization_id IS NOT NULL" },
} as const

/** The distinct values of a registered column among the spans the reader may
 *  see, or undefined for a column the registry does not serve. */
export function distinctValuesSql(column: string, visible: InsightFilter): InsightFilter | undefined {
  if (!Object.hasOwn(DISTINCT_COLUMNS, column)) return undefined
  // SAFETY: the guard above accepted only keys `DISTINCT_COLUMNS` declares.
  const { expression, where } = DISTINCT_COLUMNS[column as keyof typeof DISTINCT_COLUMNS]
  return {
    sql: `SELECT DISTINCT ${expression} AS value FROM spans WHERE ${where} AND (${visible.sql}) ORDER BY ${expression} LIMIT 200`,
    params: visible.params,
  }
}
