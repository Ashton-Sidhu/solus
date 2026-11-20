const count = (value: number, one: string, many: string) => `${value.toLocaleString('en-US')} ${value === 1 ? one : many}`

/**
 * The count at the foot of the `@` menu: what the menu shows. Files the search
 * found, then the MCP resources that match; nothing of a kind it shows none of,
 * so a menu of resources alone never says "0 files". Null files: the search has
 * not answered yet.
 */
export function atMenuFooter(fileTotal: number | null, resourceCount: number): string {
  const parts: string[] = []
  if (fileTotal) parts.push(count(fileTotal, 'file', 'files'))
  if (resourceCount) parts.push(count(resourceCount, 'resource', 'resources'))
  return parts.join(' · ')
}
