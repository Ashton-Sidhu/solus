import { SOLUS_TOOL_GROUPS, isSolusToolEnabled, type SolusToolPreferences } from '@solus/contracts/agent-tools'

export function matchingToolGroups(query: string) {
  const search = query.trim().toLowerCase().replaceAll('_', ' ')
  return SOLUS_TOOL_GROUPS.map((group) => ({
    ...group,
    visibleTools: group.tools.filter((name) =>
      `${name === 'ask_jev' ? 'typesafe api key' : ''} ${group.label} solus tools ${name.replaceAll('_', ' ')}`.toLowerCase().includes(search)),
  })).filter((group) => group.visibleTools.length > 0)
}

export function groupEnabled(tools: readonly string[], preferences: SolusToolPreferences): boolean {
  return tools.every((name) => isSolusToolEnabled(name, preferences))
}

export function groupPatch(tools: readonly string[], enabled: boolean): SolusToolPreferences {
  return Object.fromEntries(tools.map((name) => [name, enabled]))
}

/** The row description for a collapsed group: how many of its tools an agent can call. */
export function groupSummary(tools: readonly string[], preferences: SolusToolPreferences | null | undefined): string {
  const total = tools.length
  const noun = total === 1 ? 'tool' : 'tools'
  if (!preferences) return `${total} ${noun}`
  const enabled = tools.filter((name) => isSolusToolEnabled(name, preferences)).length
  if (enabled === total) return `All ${total} ${noun} on`
  if (enabled === 0) return `All ${total} ${noun} off`
  return `${enabled} of ${total} ${noun} on`
}

export function toolLabel(name: string): string {
  const words = name.replaceAll('_', ' ')
  return words[0].toUpperCase() + words.slice(1)
}
