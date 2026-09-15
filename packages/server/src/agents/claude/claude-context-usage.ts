import type { ContextUsageCategory, ContextUsageDetailItem, ContextUsageGroup } from '@solus/contracts/types'

/**
 * The shape `getContextUsage()` reports, narrowed to the fields the breakdown
 * uses. Every detail array is optional: a CLI older than the field simply omits
 * it, and the group it would have filled is left out rather than shown empty.
 */
export interface ClaudeContextUsageReport {
  categories?: { name: string; tokens: number; isDeferred?: boolean }[]
  systemPromptSections?: { name: string; tokens: number }[]
  systemTools?: { name: string; tokens: number }[]
  mcpTools?: { name: string; tokens: number; serverName?: string }[]
  memoryFiles?: { path: string; tokens: number; type?: string }[]
  agents?: { agentType: string; tokens: number; source?: string }[]
  skills?: { skillFrontmatter?: { name: string; tokens: number; source?: string }[] }
}

/**
 * The most items any one group sends. A group is a diagnosis aid — the user is
 * looking for what is eating the window — so the largest few answer the
 * question and a pathological MCP config with hundreds of tools cannot turn a
 * per-turn event into a payload nobody reads. The group total stays the sum of
 * every item, so trimming the list never understates the group.
 */
const MAX_GROUP_ITEMS = 50

/** `mcp__<server>__<tool>` → `<tool>`. The server is already the detail column. */
function bareToolName(wireName: string): string {
  const parts = wireName.split('__')
  // Anything else is not the MCP wire format; leave it exactly as reported.
  if (parts.length < 3 || parts[0] !== 'mcp') return wireName
  return parts.slice(2).join('__') || wireName
}

/**
 * Memory files arrive as absolute paths. The last two segments identify the
 * file (`solus/CLAUDE.md`) without the home prefix, which a narrow popover
 * would truncate away from the left — taking the identifying part with it.
 */
function shortPath(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean)
  return segments.slice(-2).join('/') || path
}

function toGroup(label: string, rows: ContextUsageDetailItem[]): ContextUsageGroup | null {
  const kept = rows.filter((row) => row.name.trim().length > 0 && row.tokens > 0)
  if (kept.length === 0) return null
  // Total before the cap: the header must describe the whole group.
  const tokens = kept.reduce((sum, row) => sum + row.tokens, 0)
  const items = [...kept].sort((a, b) => b.tokens - a.tokens).slice(0, MAX_GROUP_ITEMS)
  return { label, tokens, items }
}

/** The two halves of the breakdown, each absent when the provider reports none. */
export interface ContextBreakdown {
  categories?: ContextUsageCategory[]
  groups?: ContextUsageGroup[]
}

/**
 * Translate the provider's `/context` report into the wire contract: the
 * category rows the meter lists, and the per-item groups behind them.
 *
 * `messageBreakdown` is deliberately not carried. It totals every API call in
 * the session, so it reads larger than the resident "Messages" category beside
 * it and the two would contradict each other in the same popover.
 */
export function toContextBreakdown(report: ClaudeContextUsageReport): ContextBreakdown {
  const categories: ContextUsageCategory[] = []
  for (const row of report.categories ?? []) {
    if (row.name.trim().length === 0 || row.tokens <= 0) continue
    const category: ContextUsageCategory = {
      name: row.name,
      tokens: Math.max(0, Math.round(row.tokens)),
    }
    if (row.isDeferred) category.deferred = true
    categories.push(category)
  }

  const groups = [
    toGroup('System prompt', (report.systemPromptSections ?? [])
      .map((row) => ({ name: row.name, tokens: row.tokens }))),
    toGroup('System tools', (report.systemTools ?? [])
      .map((row) => ({ name: row.name, tokens: row.tokens }))),
    toGroup('MCP tools', (report.mcpTools ?? [])
      .map((row) => ({ name: bareToolName(row.name), tokens: row.tokens, detail: row.serverName }))),
    toGroup('Memory files', (report.memoryFiles ?? [])
      .map((row) => ({ name: shortPath(row.path), tokens: row.tokens, detail: row.type }))),
    toGroup('Skills', (report.skills?.skillFrontmatter ?? [])
      .map((row) => ({ name: row.name, tokens: row.tokens, detail: row.source }))),
    toGroup('Agents', (report.agents ?? [])
      .map((row) => ({ name: row.agentType, tokens: row.tokens, detail: row.source }))),
  ].filter((group): group is ContextUsageGroup => group !== null)

  const breakdown: ContextBreakdown = {}
  if (categories.length > 0) breakdown.categories = categories
  if (groups.length > 0) breakdown.groups = groups
  return breakdown
}
