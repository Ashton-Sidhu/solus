import { z } from 'zod'
import { integrationSlug, type CatalogEntry, type Integration, type IntegrationCreateRequest } from '@solus/contracts/integration-types'
import { SetupHandoff, setupNeedOfUndetermined } from '@solus/contracts/integrations/setup-handoff'
import { ANY_ORGANIZATION, INTERNAL_PRINCIPAL, type Principal } from '../admission/principal'
import { workspaceToolAuthority } from '../admission/workspace-tool-authority'
import { reportIntegrationConnection } from '../connections/connection-tools'
import type { AgentTool, AgentToolResult } from '../execution/agents/tools/agent-tool'
import { createLogger } from '../logger'
import { currentPersonKey } from '../vault/acting-scope'
import { CATALOG_UNAVAILABLE_MESSAGE, IntegrationCatalogUnavailableError, type IntegrationCatalog } from './catalog'
import { IntegrationProbeRefusedError } from './integration-create'
import { integrationGateway } from './integration-tools'

const log = createLogger('integrations', 'connect-integration-tool.ts')

/** Catalog matches offered when the name is not exact (docs/plans/mcp-integrations.md §13.2). */
const MATCH_LIMIT = 5

interface ConnectIntegrationDeps {
  catalog: Pick<IntegrationCatalog, 'list'>
  /** `createIntegration` with the host's store, events, and profile bound. */
  create(principal: Principal, owner: string, request: IntegrationCreateRequest): Promise<Integration>
}

let deps: ConnectIntegrationDeps | null = null

/** Installed once at boot, beside the integration handlers; null leaves the tool unavailable. */
export function installConnectIntegrationTool(next: ConnectIntegrationDeps | null): void {
  deps = next
}

const argsSchema = z.object({ service: z.string().trim().min(1).max(200) })

function sameName(name: string, service: string): boolean {
  return name.toLowerCase() === service.toLowerCase()
}

/** The service as the person named it: an exact name, slug, or catalog entry id. Never a partial match. */
function isExactEntry(entry: CatalogEntry, service: string): boolean {
  return entry.id === service || entry.slug === service || sameName(entry.name, service)
}

function isInstalledService(integration: Integration, service: string): boolean {
  return integration.slug === integrationSlug(service) || sameName(integration.name, service)
}

/**
 * Connect the acting person to a service by name (docs/plans/mcp-integrations.md
 * §13.2): their installed integration if they have one, else the one catalog
 * entry the name matches exactly, which it adds for them. Either way the end is
 * the connect card; the person signs in there, never in the conversation.
 */
async function connectIntegration(service: string, sessionId: string | undefined): Promise<AgentToolResult> {
  const personKey = currentPersonKey()
  const gateway = integrationGateway()
  if (personKey === null) return { ok: false, text: 'An integration belongs to a person, and this turn acts for none.' }
  if (!gateway || !deps) return { ok: false, text: 'Integrations are not available on this host.' }

  const installed = gateway.store.list(ANY_ORGANIZATION, personKey)
  const named = installed.find((integration) => isInstalledService(integration, service))
  if (named) return reportIntegrationConnection(named, sessionId)

  let entries: CatalogEntry[]
  try {
    // Every match: an exact entry ranked below popular partial ones must still be found.
    entries = (await deps.catalog.list({ query: service })).entries
  } catch (error) {
    if (error instanceof IntegrationCatalogUnavailableError) return { ok: false, text: `${CATALOG_UNAVAILABLE_MESSAGE} The user can add a server by its URL in Settings → MCP.` }
    throw error
  }
  const exact = entries.filter((entry) => isExactEntry(entry, service))
  const chosen = exact.length === 1 ? exact[0] : null
  if (!chosen) {
    if (!entries.length) return { ok: false, text: `No integration in the catalog matches '${service}'. The user can add a server by its URL in Settings → MCP.` }
    return {
      ok: true,
      text: JSON.stringify({
        matches: entries.slice(0, MATCH_LIMIT).map((entry) => ({ service: entry.id, name: entry.name, domain: entry.domain, description: entry.description })),
        note: 'No exact match. Ask the user which one they mean, then call connect_integration again with its `service` value.',
      }),
    }
  }

  // The same server under another name is still the one they have.
  const sameServer = installed.find((integration) => integration.url === chosen.url)
  if (sameServer) return reportIntegrationConnection(sameServer, sessionId)

  try {
    const integration = await deps.create(workspaceToolAuthority() ?? INTERNAL_PRINCIPAL, personKey, { name: chosen.name, url: chosen.url })
    log.info('integration_added_by_agent', { integrationId: integration.id, sessionId })
    return reportIntegrationConnection(integration, sessionId, { added: true })
  } catch (error) {
    // A refused probe or a store refusal: the message is written for the person.
    const text = `${chosen.name} could not be added: ${error instanceof Error ? error.message : String(error)}`
    const need = error instanceof IntegrationProbeRefusedError ? setupNeedOfUndetermined(error.reason) : null
    return { ok: false, text: need ? `${text}\n\n${new SetupHandoff(need, chosen).steps}` : text }
  }
}

export const connectIntegrationAgentTool: AgentTool = {
  name: 'connect_integration',
  description:
    'Connect the user to an external service by name, such as "Linear" or "Notion", when they ask to use it and no tool for it is available. Uses their integration when they have one, else adds the one catalog entry the name matches exactly, then asks the user to sign in with a card in the conversation. When the name is not exact it returns catalog matches; ask the user which one and call again with its `service` value. Never ask for a token, key, or password in the conversation. A newly added integration\'s tools are available from the user\'s next message.',
  inputFields: {
    service: z.string().describe('The service name, an integration slug, or a `service` value from earlier matches.'),
  } as const,
  // It can add a server to the person's integrations.
  requiresApproval: true,
  execute: async (input, context) => {
    const args = argsSchema.safeParse(input)
    if (!args.success) return { ok: false, text: '`service` must be a non-empty name.' }
    return connectIntegration(args.data.service, context.sessionId())
  },
}
