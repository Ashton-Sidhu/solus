/**
 * An MCP tool as the person reads it, server then tool, as the MCP task and
 * app rows name it: `mcp__solus__linear__export_issues` (an MCP server of
 * Solus) and `mcp__linear__export_issues` (one the agent loads itself) →
 * "linear · export_issues". Null for a tool of another kind. Desktop, web,
 * and mobile share it.
 */
export function mcpToolLabel(name: string): string | null {
  const rest = name.startsWith('mcp__solus__') ? name.slice('mcp__solus__'.length) : name.startsWith('mcp__') ? name.slice('mcp__'.length) : null
  if (!rest) return null
  const split = rest.indexOf('__')
  if (split <= 0 || split + 2 >= rest.length) return null
  return `${rest.slice(0, split)} · ${rest.slice(split + 2)}`
}
