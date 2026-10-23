import { z } from 'zod'
import { mcpAppToolMetadataSchema } from '@solus/contracts/mcp-apps'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { ACCOUNT_INPUT, integrationToolName, type Integration, type IntegrationToolSummary } from '@solus/contracts/integration-types'
import { ownerKeyOf, type Actor } from '../admission/actor'
import { recordScopeOf } from '../admission/principal'
import { createLogger } from '../logger'
import { agentToolImage, type AgentTool, type AgentToolResult } from '../execution/agents/tools/agent-tool'
import type { IntegrationGateway, UpstreamTool } from './gateway'

const log = createLogger('integrations', 'integration-tools.ts')

const DESCRIPTION_MAX_LENGTH = 1000

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
const RUN_LIST_TIMEOUT_MS = 10_000

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
export async function integrationAgentTools(actor: Actor): Promise<AgentTool[]> {
  const current = gateway
  if (!current) return []
  const personKey = ownerKeyOf(actor)
  const integrations = current.store.list(recordScopeOf(actor.principal), personKey)
  const listed = await Promise.all(integrations.map((integration) => toolsForRun(current, integration, personKey)))
  const tools: AgentTool[] = []
  const names = new Set<string>()
  integrations.forEach((integration, index) => {
    const disabled = new Set(integration.disabledTools)
    for (const upstream of listed[index] ?? []) {
      if (disabled.has(upstream.name)) continue
      // An MCP App tool whose `visibility` leaves out `model` is for the app alone.
      const appMetadata = mcpAppToolMetadataSchema.safeParse(upstream._meta)
      if (appMetadata.success && appMetadata.data.ui?.visibility && !appMetadata.data.ui.visibility.includes('model')) continue
      const agentTool = upstreamToolToAgentTool(integration, upstream, current, current.accountChoices(integration.id, personKey))
      if (names.has(agentTool.name)) {
        if (!reportedCollisions.has(agentTool.name)) {
          reportedCollisions.add(agentTool.name)
          log.warn('integration_tool_name_taken', { integrationId: integration.id, tool: upstream.name, name: agentTool.name })
        }
        continue
      }
      names.add(agentTool.name)
      tools.push(agentTool)
    }
  })
  return tools
}

/** One upstream tool as a Solus agent tool that calls it through the gateway. */
export function upstreamToolToAgentTool(
  integration: Pick<Integration, 'id' | 'name' | 'slug'>,
  upstream: UpstreamTool,
  calls: Pick<IntegrationGateway, 'call'>,
  /** The labels of the person's accounts when there are several (§13.3); the tool then takes `solus_account`. */
  accounts: string[] = [],
): AgentTool {
  const fields = inputFieldsFor(upstream.inputSchema)
  const readOnly = toolSummary(upstream).readOnly
  const accountField = accounts.length > 1
    ? { [ACCOUNT_INPUT]: z.enum(accounts).optional().describe(readOnly ? `Which ${integration.name} account. Leave out to read from every account.` : `Which ${integration.name} account. Required: the user has several.`) }
    : {}
  const agentTool: AgentTool = {
    name: integrationToolName(integration.slug, upstream.name),
    description: `${integration.name}: ${upstream.description ?? upstream.title ?? upstream.name}`.slice(0, DESCRIPTION_MAX_LENGTH),
    inputFields: { ...(fields ?? {}), ...accountField },
    alwaysLoad: false,
    requiresApproval: toolSummary(upstream).destructive,
    execute: (input, context) => calls.call(integration.id, upstream.name, input, context),
  }
  if (!fields) agentTool.passthroughInput = true
  return agentTool
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

/**
 * An MCP tool result as a Solus one: text parts joined with blank lines, the first
 * PNG image as the result image, `structuredContent` as JSON when there is no text.
 */
export function mapCallResult(result: CallToolResult | { toolResult: unknown }): AgentToolResult {
  if (!('content' in result)) return { ok: true, text: JSON.stringify(result.toolResult, null, 2) ?? '' }
  const texts: string[] = []
  let image: AgentToolResult['image']
  for (const part of result.content) {
    if (part.type === 'text') texts.push(part.text)
    else if (part.type === 'image') {
      const converted = !image && part.mimeType === 'image/png' ? agentToolImage(Buffer.from(part.data, 'base64')) : null
      if (converted) image = converted
      else texts.push(`[${part.mimeType} image not shown]`)
    } else if (part.type === 'resource_link') texts.push(`${part.name}: ${part.uri}`)
    else if (part.type === 'resource' && 'text' in part.resource) texts.push(part.resource.text)
  }
  if (!texts.length && result.structuredContent) texts.push(JSON.stringify(result.structuredContent, null, 2))
  const mapped: AgentToolResult = { ok: result.isError !== true, text: texts.join('\n\n') }
  if (image) mapped.image = image
  return mapped
}
