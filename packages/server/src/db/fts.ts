/** Turn free-text into an FTS5 MATCH expression: every token quoted (so FTS5
 *  operators the user typed are literals) and ANDed together. Returns '' for a
 *  blank query — callers treat that as "no results". */
export function sanitizeFtsQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(' ')
}
