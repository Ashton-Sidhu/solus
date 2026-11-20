import { z } from 'zod'
import type { Integration } from '@solus/contracts/integration-types'
import type { AgentTool, AgentToolResult } from '../execution/agents/tools/agent-tool'
import { currentPersonKey } from '../vault/acting-scope'
import type { CommandStarter } from './command-admission'
import type { IntegrationGateway } from './gateway'
import { readAsContent } from './resource-lists'
import { agentResultOf } from './result-content'
import { ConnectionRequiredError, errorText } from './upstream-session'

/**
 * The agent's MCP resource tools (docs/plans/mcp-first-class.md §11.2). They
 * join a run when one of its integrations declares `resources`, and they reach
 * only those integrations, by slug. A read changes nothing, so they need no
 * approval. F2 adds `watch_integration_resource`.
 */

/** Entries in one page of `list_integration_resources`. */
const PAGE_SIZE = 100

type ResourceServer = Pick<Integration, 'id' | 'name' | 'slug' | 'auth'>

/** What `list_integration_resources` answers: one page, and the servers that could not list. */
interface ListAnswer {
  resources: ListedEntry[]
  nextCursor?: string
  unavailable?: string[]
  note?: string
}

/** One entry of the list the agent reads: a resource has a `uri`, a template a `uriTemplate`. */
interface ListedEntry {
  server: string
  uri?: string
  uriTemplate?: string
  name: string
  title?: string
  description?: string
  mimeType?: string
  size?: number
}

export function resourceAgentTools(servers: ResourceServer[], gateway: Pick<IntegrationGateway, 'resourcesFor' | 'readResource' | 'connectionRequired'>, starter: CommandStarter): AgentTool[] {
  if (!servers.length) return []
  const slugs = servers.map((server) => server.slug).join(', ')
  const named = (slug: string) => servers.find((server) => server.slug === slug)
  const unknown = (slug: string): AgentToolResult => ({ ok: false, text: `No MCP server of this run is named ${slug}. Servers with resources: ${slugs}.` })

  const list: AgentTool = {
    name: 'list_integration_resources',
    description: `List the resources and resource templates of the user's MCP servers: URI, name, type, and size, by server. Servers with resources: ${slugs}. Read one with read_integration_resource.`,
    inputFields: {
      server: z.string().optional().describe('One server, by its name in the list above. Leave out for every server.'),
      cursor: z.string().optional().describe('The `nextCursor` of the previous page.'),
    },
    alwaysLoad: false,
    requiresApproval: false,
    execute: async (input, context) => {
      const chosen = input.server ? named(input.server) : undefined
      if (input.server && !chosen) return unknown(input.server)
      const personKey = currentPersonKey()
      const entries: ListedEntry[] = []
      const failures: string[] = []
      for (const server of chosen ? [chosen] : servers) {
        try {
          const lists = await gateway.resourcesFor(server.id, personKey, starter)
          for (const resource of lists.resources) entries.push({ server: server.slug, ...resource })
          for (const template of lists.templates) entries.push({ server: server.slug, ...template })
        } catch (error) {
          if (error instanceof ConnectionRequiredError) {
            if (chosen) return gateway.connectionRequired(server, context)
            failures.push(`${server.slug}: not connected`)
          } else failures.push(`${server.slug}: ${errorText(error)}`)
        }
      }
      const start = Math.max(0, Number.parseInt(input.cursor ?? '0', 10) || 0)
      const page = entries.slice(start, start + PAGE_SIZE)
      const answer: ListAnswer = { resources: page }
      if (start + PAGE_SIZE < entries.length) answer.nextCursor = String(start + PAGE_SIZE)
      if (failures.length) answer.unavailable = failures
      if (entries.some((entry) => entry.uriTemplate)) answer.note = 'A `uriTemplate` is not readable as it is: fill in its {variables} to make a URI.'
      return { ok: true, text: JSON.stringify(answer) }
    },
  }

  const read: AgentTool = {
    name: 'read_integration_resource',
    description: `Read one resource of the user's MCP servers by its URI, as the user. Use the server that listed it or that a resource link named. Servers with resources: ${slugs}.`,
    inputFields: {
      server: z.string().describe('The server, by its name in the list above.'),
      uri: z.string().min(1).max(2048).describe('The resource URI.'),
    },
    alwaysLoad: false,
    requiresApproval: false,
    execute: async (input, context) => {
      const server = named(input.server)
      if (!server) return unknown(input.server)
      try {
        const result = await gateway.readResource(server.id, input.uri, starter, { signal: context.abortSignal })
        // The server's text is data: it reaches the agent under the server's name (§3 rule 3).
        const mapped = await agentResultOf(readAsContent(result), { tool: 'read_integration_resource' })
        return { ...mapped, text: `${server.name} resource ${input.uri}:\n\n${mapped.text}` }
      } catch (error) {
        if (error instanceof ConnectionRequiredError) return gateway.connectionRequired(server, context)
        if (context.abortSignal.aborted) return { ok: false, text: `The ${server.name} read was stopped.` }
        return { ok: false, text: `${server.name} could not read ${input.uri}: ${errorText(error)}` }
      }
    },
  }

  return [list, read]
}
