import { format } from 'sql-formatter'

/**
 * Make agent-generated SQL readable before it enters the editor.
 *
 * Formatting is presentation only. If the formatter does not understand a
 * SQLite construct that the host accepted, keep the original statement so a
 * cosmetic step never prevents the query from running.
 */
export function formatGeneratedSql(sql: string): string {
  try {
    return format(sql, {
      language: 'sqlite',
      keywordCase: 'lower',
      tabWidth: 2,
    }).trim()
  } catch {
    return sql
  }
}
