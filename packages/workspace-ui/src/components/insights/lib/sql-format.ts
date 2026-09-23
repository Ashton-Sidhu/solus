import { formatDialect, sqlite } from 'sql-formatter'

/**
 * Make agent-generated SQL readable before it enters the editor.
 *
 * Formatting is presentation only. If the formatter does not understand a
 * SQLite construct that the host accepted, keep the original statement so a
 * cosmetic step never prevents the query from running.
 *
 * `formatDialect` with the one dialect Insights runs keeps the other database
 * dialects out of the bundle; `format` pulls in every dialect it can name.
 */
export function formatGeneratedSql(sql: string): string {
  try {
    return formatDialect(sql, {
      dialect: sqlite,
      keywordCase: 'lower',
      tabWidth: 2,
    }).trim()
  } catch {
    return sql
  }
}
