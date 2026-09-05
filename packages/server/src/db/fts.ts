/** Turn free-text into an FTS5 MATCH expression: every token quoted (so FTS5
 *  operators the user typed are literals) and ANDed together. Returns '' for a
 *  blank query — callers treat that as "no results".
 *
 *  `prefixLastToken` treats the final token as a prefix: a picker searching as
 *  the user types must find "authentication" from "auth", or nothing appears
 *  until the whole word is spelled. */
export function sanitizeFtsQuery(
  query: string,
  options: { prefixLastToken?: boolean } = {},
): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
  if (options.prefixLastToken && tokens.length) tokens[tokens.length - 1] += '*'
  return tokens.join(' ')
}
