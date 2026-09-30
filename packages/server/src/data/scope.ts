import { sql, type SQL } from 'drizzle-orm'
import { isAnyOrganization, type RecordScope } from '../admission/principal'

/**
 * How a ported store renders a read scope (organization-scope §3): one
 * organization's rows, or every organization's when the caller reads the whole
 * disk. `column` names the table's `organization_id` when the query joins
 * several tables. A write never takes a scope; it names one organization.
 */
export function scopeClause(scope: RecordScope, column: SQL = sql`organization_id`): SQL {
  return isAnyOrganization(scope) ? sql`1 = 1` : sql`${column} = ${scope}`
}
