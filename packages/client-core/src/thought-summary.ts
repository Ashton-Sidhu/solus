// Adapted from T3 Code's work-log/presentation.ts (MIT).
/** A compact thought uses its opening title, or its first sentence in plain text. */
export function thoughtSummary(markdown: string): string {
  const source = markdown.slice(0, 8192)
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(source)?.[1]
  const text = (heading ?? source)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, '')
    .replace(/`+|\*\*|~~/g, '')
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
  const end = heading === undefined ? /[.?!]["'”’)]?(?=\s)|[。！？]["'”’）」』]?/.exec(text) : null
  return (end ? text.slice(0, end.index + end[0].length) : text).slice(0, 2048)
}
