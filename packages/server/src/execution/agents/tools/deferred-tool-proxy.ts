/**
 * Deferred-proxy MCP tool exposure for harnesses that freeze their tool list
 * per session and do not support `anthropic/alwaysLoad` (such as Antigravity).
 *
 * Scoring and the 8 KB inline result budget adapt T3 Code (`pingdotgg/t3code`,
 * `apps/server/src/mcp/McpToolExposure.ts` and `McpHttpServer.ts`), MIT:
 *
 *   MIT License. Copyright (c) 2026 T3 Tools Inc.
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions: The above copyright
 *   notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
 *   WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
 */
import { z } from 'zod'
import { ToolSchema } from '@modelcontextprotocol/core'
import type { CallToolRequest, Tool } from '@modelcontextprotocol/server'
import { advertisedInputSchema, type AgentTool } from './agent-tool'

type ProxyToolInput = CallToolRequest['params']['arguments']

export const TOOL_SEARCH = 'tool_search'
export const TOOL_CALL = 'tool_call'

const MAX_SEARCH_RESULTS = 20
// Antigravity caps inline MCP tool results around 10 KB; stay under it so schemas never truncate.
export const MAX_PROXY_RESULT_BYTES = 8_000
const MAX_QUERY_LENGTH = 500

export interface DeferredToolSearchEntry {
  name: string
  description: string
  inputSchema?: z.core.JSONSchema.JSONSchema
}

const toolSearchInputSchema = z.object({ query: z.string().max(MAX_QUERY_LENGTH) })
const toolCallInputSchema = z.object({
  name: z.string().trim().min(1),
  arguments: z.record(z.string(), z.json()).optional(),
})

export function parseToolSearchQuery(input: ProxyToolInput): string | null {
  const parsed = toolSearchInputSchema.safeParse(input)
  return parsed.success ? parsed.data.query : null
}

export type ParsedToolCallProxy =
  | { ok: true; name: string; arguments: Record<string, z.core.util.JSONType> }
  | { ok: false; error: string }

export function parseToolCallProxy(input: ProxyToolInput): ParsedToolCallProxy {
  const parsed = toolCallInputSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'tool_call requires `name` (string) and optional `arguments` (JSON object).' }
  const { name } = parsed.data
  if (name === TOOL_CALL || name === TOOL_SEARCH) return { ok: false, error: `Cannot invoke '${name}' via ${TOOL_CALL}.` }
  return { ok: true, name, arguments: parsed.data.arguments ?? {} }
}

/** The `tools/list` descriptors for a deferred-proxy session: `alwaysLoad` tools plus `tool_search` and `tool_call`. */
export function listedProxyTools(tools: AgentTool[], formatTool: (tool: AgentTool) => Tool): Tool[] {
  const direct = tools.filter((tool) => tool.alwaysLoad)
  const hasDeferred = tools.some((tool) => !tool.alwaysLoad)
  if (!hasDeferred) return tools.map((tool) => formatTool(tool))
  return [
    ...direct.map((tool) => formatTool(tool)),
    ToolSchema.parse({
      name: TOOL_SEARCH,
      description: 'Find Solus and installed MCP server tools not listed directly, then run them with tool_call. Search by tool name, MCP server name (for example `paper`), or purpose (sessions, tasks, works, browser, pull requests, automations). Exact tool names return their input schema.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Tool name, MCP server name, or keywords.' },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    }),
    ToolSchema.parse({
      name: TOOL_CALL,
      description: 'Invoke any Solus or installed MCP server tool by exact name (find names and schemas with tool_search first).',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact tool name returned by tool_search.' },
          arguments: { type: 'object', description: 'JSON arguments object for that tool.' },
        },
        required: ['name'],
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    }),
  ]
}

/** Stable key of the tool names `tools/list` publishes for a run: changes only when the listed catalog changes. */
export function listedToolNamesKey(tools: readonly AgentTool[], deferProxy: boolean): string {
  if (tools.length === 0) return ''
  if (!deferProxy) return tools.map((tool) => tool.name).sort().join('\0')
  const names = tools.filter((tool) => tool.alwaysLoad).map((tool) => tool.name)
  if (tools.some((tool) => !tool.alwaysLoad)) names.push(TOOL_SEARCH, TOOL_CALL)
  return names.sort().join('\0')
}

function scoreTool(tool: Pick<AgentTool, 'name' | 'description'>, trimmedQuery: string, terms: readonly string[]): number {
  const name = tool.name.toLowerCase()
  const description = tool.description.toLowerCase()
  let total = 0
  if (trimmedQuery && name === trimmedQuery) total += 100
  if (trimmedQuery && name.startsWith(`${trimmedQuery}__`)) total += 20
  for (const term of terms) {
    if (name === term) total += 50
    else if (name.includes(term)) total += 3
    else if (description.includes(term)) total += 1
  }
  return total
}

function utf8Bytes(value: { tools: DeferredToolSearchEntry[] }): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/** Searches enabled tools by query and packs matching schemas within the 8 KB inline result budget. */
export function searchDeferredTools(tools: readonly AgentTool[], query: string): DeferredToolSearchEntry[] {
  const trimmed = query.trim().toLowerCase()
  const terms = trimmed.split(/[^a-z0-9]+/u).filter(Boolean)
  const candidates = tools.filter((tool) => tool.name !== TOOL_SEARCH && tool.name !== TOOL_CALL)
  const matched = terms.length === 0
    ? candidates.slice(0, MAX_SEARCH_RESULTS)
    : candidates
        .map((tool) => ({ tool, score: scoreTool(tool, trimmed, terms) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
        .slice(0, MAX_SEARCH_RESULTS)
        .map((entry) => entry.tool)

  const results: DeferredToolSearchEntry[] = []
  for (const tool of matched) {
    const withSchema: DeferredToolSearchEntry = {
      name: tool.name,
      description: tool.description,
      inputSchema: { ...advertisedInputSchema(tool), type: 'object' },
    }
    if (utf8Bytes({ tools: [...results, withSchema] }) <= MAX_PROXY_RESULT_BYTES) {
      results.push(withSchema)
      continue
    }
    const compact: DeferredToolSearchEntry = { name: tool.name, description: tool.description }
    if (utf8Bytes({ tools: [...results, compact] }) <= MAX_PROXY_RESULT_BYTES) {
      results.push(compact)
      continue
    }
    if (results.length === 0) {
      results.push({
        name: tool.name,
        description: `${tool.description.slice(0, 200)} (Truncated: exceeds response budget.)`,
      })
    }
    break
  }
  return results
}
