import { z } from 'zod'
import { mcpAppToolMetadataSchema } from '@solus/contracts/mcp-apps'
import { ACCOUNT_INPUT, integrationToolName, type Integration, type IntegrationToolSummary } from '@solus/contracts/integration-types'
import { ownerKeyOf, type Actor } from '../admission/actor'
import { recordScopeOf } from '../admission/principal'
import { createLogger } from '../logger'
import { resolveHomePath } from '../platform/paths'
import { resolveProjectKey } from '../project-config/project-config'
import type { AgentTool } from '../execution/agents/tools/agent-tool'
import type { IntegrationGateway, UpstreamTool } from './gateway'
import { mayRunCommands, type CommandStarter } from './command-admission'
import { resourceAgentTools } from './resource-tools'

const log = createLogger('integrations', 'integration-tools.ts')

const DESCRIPTION_MAX_LENGTH = 1000
/** The longest "Returns JSON" line a description gains (docs/plans/mcp-first-class.md §6). */
const RETURNS_LINE_MAX_LENGTH = 500

let gateway: IntegrationGateway | null = null

/** Installed once at boot; the integrations' tools join a run only after it. */
export function setIntegrationGateway(next: IntegrationGateway | null): void {
  gateway = next
}

export function integrationGateway(): IntegrationGateway | null {
  return gateway
}

/** Names already reported as taken, so a collision is logged once. */
const reportedCollisions = new Set<string>()

/** How long a run waits for one server's tool list before it starts without that server. */
export const RUN_LIST_TIMEOUT_MS = 10_000

/** A server's tools for a run, or null when it did not list them in time; the list goes on and the next run reads it. */
async function toolsForRun(source: IntegrationGateway, integration: Integration, personKey: string | null): Promise<UpstreamTool[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), RUN_LIST_TIMEOUT_MS) })
  try {
    const tools = await Promise.race([source.toolsFor(integration.id, personKey), late])
    if (!tools) log.warn('integration_tools_late', { integrationId: integration.id, personKey })
    return tools
  } catch (error) {
    log.warn('integration_tools_unavailable', { integrationId: integration.id, personKey, error: error instanceof Error ? error.message : String(error) })
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The agent tools of a run (§5.2.1): every integration the run's person owns
 * in their scope (docs/plans/access-model.md, D3), listed
 * with that person's connection, less the tools the owner turned off (§6.1).
 * A server that does not list its tools in time adds none to this run.
 */
export interface IntegrationInstruction { name: string; slug: string; text: string }

/**
 * Whether an integration joins this run. One from a project joins only the runs
 * of that project, a worktree of it included (docs/plans/mcp-first-class.md
 * §8.4); a chat has no project. A command joins only the runs of a person who
 * still holds `host.admin`, because it runs as code on the host (§7.2, §7.8).
 */
function joinsRun(integration: Integration, actor: Actor, projectKey: () => string | null): boolean {
  if (integration.kind === 'stdio' && !mayRunCommands(actor.principal)) return false
  return integration.projectKey === undefined || integration.projectKey === projectKey()
}

/** The integrations that join a run of `actor` in `projectPath`, the run's working directory, whose project key a project integration must match. */
export function runIntegrations(source: Pick<IntegrationGateway, 'store'>, actor: Actor, projectPath?: string | null): Integration[] {
  // The key asks git for the project root, so it is read only when a project integration needs it.
  let projectKey: string | null | undefined
  const runProjectKey = () => (projectKey ??= projectPath ? resolveProjectKey(resolveHomePath(projectPath)) : null)
  return source.store.list(recordScopeOf(actor.principal), ownerKeyOf(actor)).filter((integration) => joinsRun(integration, actor, runProjectKey))
}

export async function integrationToolbox(actor: Actor, projectPath?: string | null): Promise<{ tools: AgentTool[]; instructions: IntegrationInstruction[] }> {
  const current = gateway
  if (!current) return { tools: [], instructions: [] }
  const personKey = ownerKeyOf(actor)
  const integrations = runIntegrations(current, actor, projectPath)
  const listed = await Promise.all(integrations.map((integration) => toolsForRun(current, integration, personKey)))
  const tools: AgentTool[] = []
  const included = new Set<string>()
  const names = new Set<string>()
  integrations.forEach((integration, index) => {
    const disabled = new Set(integration.disabledTools)
    for (const upstream of listed[index] ?? []) {
      if (disabled.has(upstream.name)) continue
      // An MCP App tool whose `visibility` leaves out `model` is for the app alone.
      const appMetadata = mcpAppToolMetadataSchema.safeParse(upstream._meta)
      if (appMetadata.success && appMetadata.data.ui?.visibility && !appMetadata.data.ui.visibility.includes('model')) continue
      const agentTool = upstreamToolToAgentTool(integration, upstream, current, current.accountChoices(integration.id, personKey), actor.principal)
      if (names.has(agentTool.name)) {
        if (!reportedCollisions.has(agentTool.name)) {
          reportedCollisions.add(agentTool.name)
          log.warn('integration_tool_name_taken', { integrationId: integration.id, tool: upstream.name, name: agentTool.name })
        }
        continue
      }
      names.add(agentTool.name)
      tools.push(agentTool)
      included.add(integration.id)
    }
  })
  // A server that listed in time gives its facts: its instructions when its tools joined, and whether it has resources (§11.2).
  const listedIntegrations = integrations.filter((_integration, index) => listed[index] !== null)
  const facts = await Promise.all(listedIntegrations.map((integration) => current.factsFor(integration.id, personKey)))
  const instructions: IntegrationInstruction[] = []
  listedIntegrations.forEach((integration, index) => {
    const text = facts[index].instructions
    if (text && included.has(integration.id)) instructions.push({ name: integration.name, slug: integration.slug, text })
  })
  const resourceServers = listedIntegrations.filter((_integration, index) => facts[index].capabilities.resources)
  for (const resourceTool of resourceAgentTools(resourceServers, current, actor.principal)) {
    if (names.has(resourceTool.name)) continue
    names.add(resourceTool.name)
    tools.push(resourceTool)
  }
  return { tools, instructions }
}

/** One upstream tool as a Solus agent tool that calls it through the gateway. */
export function upstreamToolToAgentTool(
  integration: Pick<Integration, 'id' | 'name' | 'slug'>,
  upstream: UpstreamTool,
  calls: Pick<IntegrationGateway, 'call'>,
  /** The labels of the person's accounts when there are several (§13.3); the tool then takes `solus_account`. */
  accounts: string[] = [],
  /** Who the run acts for: a command's process starts only for them (`commandStartRefusal`). */
  starter: CommandStarter = null,
): AgentTool {
  const fields = inputFieldsFor(upstream.inputSchema)
  const readOnly = toolSummary(upstream).readOnly
  const accountField = accounts.length > 1
    ? { [ACCOUNT_INPUT]: z.enum(accounts).optional().describe(readOnly ? `Which ${integration.name} account. Leave out to read from every account.` : `Which ${integration.name} account. Required: the user has several.`) }
    : {}
  const agentTool: AgentTool = {
    name: integrationToolName(integration.slug, upstream.name),
    description: descriptionOf(integration.name, upstream),
    inputFields: { ...(fields ?? {}), ...accountField },
    alwaysLoad: false,
    requiresApproval: toolSummary(upstream).destructive,
    execute: (input, context) => calls.call(integration.id, upstream.name, input, context, starter),
  }
  if (!fields) agentTool.passthroughInput = true
  return agentTool
}

/** The server's description under the integration's name, and the shape of the data it returns when that is short. */
function descriptionOf(integrationName: string, upstream: UpstreamTool): string {
  const description = `${integrationName}: ${upstream.description ?? upstream.title ?? upstream.name}`
  const { $schema: _dialect, ...outputSchema } = upstream.outputSchema ?? {}
  const returns = upstream.outputSchema ? `Returns JSON: \`${JSON.stringify(outputSchema)}\`` : ''
  if (!returns || returns.length > RETURNS_LINE_MAX_LENGTH) return description.slice(0, DESCRIPTION_MAX_LENGTH)
  return `${description.slice(0, DESCRIPTION_MAX_LENGTH - returns.length - 1)}\n${returns}`
}

/** The Zod fields of an object JSON Schema, or null when it does not convert or is not an object. */
export function inputFieldsFor(inputSchema: UpstreamTool['inputSchema']): AgentTool['inputFields'] | null {
  try {
    // SAFETY: `inputSchema` is the server's JSON Schema; `fromJSONSchema` validates what it reads and throws on what it cannot.
    const schema = z.fromJSONSchema(inputSchema as Parameters<typeof z.fromJSONSchema>[0])
    // oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- Zod names an object schema's fields `shape`.
    return schema instanceof z.ZodObject ? schema.shape : null
  } catch {
    return null
  }
}

/** What a person sees of an upstream tool: its name, text, and the server's two hints. */
export function toolSummary(tool: UpstreamTool): IntegrationToolSummary {
  const summary: IntegrationToolSummary = {
    name: tool.name,
    description: tool.description ?? '',
    readOnly: tool.annotations?.readOnlyHint === true,
    destructive: tool.annotations?.destructiveHint === true,
  }
  if (tool.title) summary.title = tool.title
  return summary
}
