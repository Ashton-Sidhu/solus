import { z } from 'zod'

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

const INTEGRATION_AGENT_TOOLS = new Set(['list_integration_resources', 'read_integration_resource', 'watch_integration_resource', 'connect_integration'])

const integrationInputSchema = z.object({
  server: z.string().optional(),
  uri: z.string().optional(),
  watching: z.boolean().optional(),
  service: z.string().optional(),
  custom: z.boolean().optional(),
})

function integrationInput(input: string | null | undefined): z.infer<typeof integrationInputSchema> {
  if (!input) return {}
  try {
    return integrationInputSchema.safeParse(JSON.parse(input)).data ?? {}
  } catch {
    return {}
  }
}

/**
 * A Solus agent tool of the MCP program as the person reads it, server first
 * as the other MCP rows: "linear · read issue://ENG-412", "linear · list
 * resources", "linear · watch issue://ENG-412", "Connect Notion". Without its
 * input (a running call has none yet) it names the action alone. Null for any
 * other tool. Desktop, web, and mobile share it.
 */
export function integrationAgentToolLabel(name: string, input?: string | null): string | null {
  const bare = name.startsWith('mcp__solus__') ? name.slice('mcp__solus__'.length) : name
  if (!INTEGRATION_AGENT_TOOLS.has(bare)) return null
  const { server, uri, watching, service, custom } = integrationInput(input)
  const onServer = (action: string) => (server ? `${server} · ${action}` : action[0].toUpperCase() + action.slice(1))
  switch (bare) {
    case 'list_integration_resources':
      return onServer('list resources')
    case 'read_integration_resource':
      return onServer(uri ? `read ${uri}` : 'read resource')
    case 'watch_integration_resource':
      return onServer(`${watching === false ? 'stop watching' : 'watch'} ${uri ?? 'resource'}`)
    default:
      return service ? `Connect ${service}` : custom ? 'Connect a server' : 'Connect a service'
  }
}

/** The MCP server a call went to, as the outputs strip names it: "elevenlabs". Null when no server is known. */
export function toolServerName(name: string, input?: string | null): string | null {
  if (integrationAgentToolLabel(name)) return integrationInput(input).server ?? null
  const label = mcpToolLabel(name)
  return label ? label.slice(0, label.indexOf(' · ')) : null
}
