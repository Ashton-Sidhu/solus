import { z } from 'zod'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { integrationToolName, type Integration, type IntegrationToolSummary } from '@solus/contracts/integration-types'
import type { RecordScope } from '../admission/principal'
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

/**
 * The agent tools of every integration in `scope` (§5.2.1), from the gateway's
 * cache. An integration whose tools are not listed yet adds none: the cache is
 * warmed at boot and on create.
 */
export function integrationAgentTools(scope: RecordScope): AgentTool[] {
  if (!gateway) return []
  const tools: AgentTool[] = []
  const names = new Set<string>()
  for (const integration of gateway.store.list(scope)) {
    for (const upstream of gateway.cachedUpstreamTools(integration.id) ?? []) {
      const agentTool = upstreamToolToAgentTool(integration, upstream, gateway)
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
  }
  return tools
}

/** One upstream tool as a Solus agent tool that calls it through the gateway. */
export function upstreamToolToAgentTool(
  integration: Pick<Integration, 'id' | 'name' | 'slug'>,
  upstream: UpstreamTool,
  calls: Pick<IntegrationGateway, 'call'>,
): AgentTool {
  const fields = inputFieldsFor(upstream.inputSchema)
  const agentTool: AgentTool = {
    name: integrationToolName(integration.slug, upstream.name),
    description: `${integration.name}: ${upstream.description ?? upstream.title ?? upstream.name}`.slice(0, DESCRIPTION_MAX_LENGTH),
    inputFields: fields ?? {},
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
