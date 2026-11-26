/**
 * agy's subagents and swarm (docs/plans/antigravity-provider.md §5.2): a
 * subagent launch or a swarm worker shows as a subagent card, and the other
 * swarm calls get readable titles.
 *
 * The titles and inputs port T3 Code (`pingdotgg/t3code` commit b8ef0600,
 * `apps/server/src/provider/acp/AntigravityProtocol.ts` and
 * `apps/server/src/orchestration-v2/Adapters/AntigravityAdapterV2.ts`):
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
import type { AcpToolCall } from './acp-protocol'
import type { AcpToolPresentation } from './acp-turn-normalizer'

/** The subagent type a card of an Antigravity subagent names (`subagentType`). */
export const ANTIGRAVITY_SUBAGENT_TYPE = 'antigravity'

const SUBAGENT_TITLES = new Set([
  'Running start_subagent',
  'Run start_subagent?',
  'Running invoke_subagent',
  'Run invoke_subagent?',
  // agy 1.5 runs an approved call with this title.
  'Run invoke_subagent',
])

type SwarmTool = 'swarm' | 'post_message' | 'read_board' | 'swarm_wait'
const SWARM_TITLES = new Map<string, SwarmTool>()
for (const tool of ['swarm', 'post_message', 'read_board', 'swarm_wait'] as const) {
  for (const title of [`Running ${tool}`, `Run ${tool}?`, `Run ${tool}`]) SWARM_TITLES.set(title, tool)
}

const metaSchema = z.looseObject({
  is_mcp_tool_call: z.boolean().optional(),
  antigravity: z.looseObject({ swarm: z.looseObject({ tool: z.string().optional(), action: z.string().optional() }).optional() }).optional(),
})
const launchSchema = z.looseObject({ TypeName: z.string().optional(), Role: z.string().optional(), Prompt: z.string().optional() })
// agy 1.4 asks for several subagents in one call; agy 1.5 runs one per call with a flat input.
const launchesSchema = z.looseObject({ Subagents: z.array(launchSchema) })
const swarmInputSchema = z.looseObject({
  action: z.string().optional(),
  name: z.string().optional(),
  brief: z.string().optional(),
  model: z.string().optional(),
  title: z.string().optional(),
  op: z.string().optional(),
  channel: z.string().optional(),
  swarm: z.string().optional(),
  status: z.boolean().optional(),
  n: z.number().optional(),
  tasks: z.array(z.json()).optional(),
})
type SwarmInput = z.infer<typeof swarmInputSchema>

/** A subagent card's input, in the shape the client reads for Claude's Agent tool. */
interface SubagentInput {
  description: string
  prompt: string
  subagent_type?: string
}

function subagentCard(input: SubagentInput | null): AcpToolPresentation {
  const presentation: AcpToolPresentation = { toolName: 'Agent', isSubagent: true, subagentType: ANTIGRAVITY_SUBAGENT_TYPE }
  if (input) presentation.toolInput = JSON.stringify(input)
  return presentation
}

/** The launch's roles and prompts; null when this update does not carry them (only the permission request does). */
function launchInput(rawInput: AcpToolCall['rawInput']): SubagentInput | null {
  const several = launchesSchema.safeParse(rawInput)
  const one = launchSchema.safeParse(rawInput)
  const launches = several.success ? several.data.Subagents : one.success ? [one.data] : []
  const named = launches.filter((launch) => launch.Prompt || launch.Role)
  if (named.length === 0) return null
  if (named.length === 1) {
    const [launch] = named
    const input: SubagentInput = { description: launch!.Role || 'Subagent', prompt: launch!.Prompt ?? '' }
    if (launch!.TypeName) input.subagent_type = launch!.TypeName
    return input
  }
  return {
    description: named.map((launch) => launch.Role || 'Subagent').join(', '),
    prompt: named.map((launch) => `${launch.Role || 'Subagent'}: ${launch.Prompt ?? ''}`).join('\n\n'),
  }
}

const handle = (value: string | undefined) => value?.trim().replace(/^@/, '') ?? ''
const channel = (value: string | undefined) => value?.trim().replace(/^#/, '') ?? ''

function swarmAddTitle(input: SwarmInput): string {
  const name = handle(input.name)
  const count = Math.max(input.tasks?.length ?? 0, Number.isFinite(input.n) ? Math.trunc(input.n!) : 0)
  if (count > 1) return name ? `Add ${count} swarm workers (@${name}-1..${count})` : `Add ${count} swarm workers`
  return name ? `Add swarm worker @${name}` : 'Add swarm worker'
}

function swarmModelTitle(input: SwarmInput): string {
  const name = handle(input.name)
  const model = input.model?.trim() ?? ''
  if (name && model) return `Switch @${name} model to ${model}`
  return name ? `Switch swarm model for @${name}` : model ? `Switch swarm model to ${model}` : 'Switch swarm model'
}

function swarmChannelTitle(input: SwarmInput): string {
  const op = input.op?.trim() ?? ''
  if (op && channel(input.channel)) return `Swarm channel ${op} #${channel(input.channel)}`
  return op ? `Swarm channel ${op}` : 'Manage swarm channels'
}

function swarmTitle(action: string, input: SwarmInput): string {
  const name = handle(input.name)
  switch (action) {
    case 'kill': return name ? `Stop swarm worker @${name}` : 'Stop swarm worker'
    case 'status': return 'Check swarm status'
    case 'models': return 'List swarm models'
    case 'model': return swarmModelTitle(input)
    case 'title': return input.title?.trim() ? `Set swarm title "${input.title.trim()}"` : 'Set swarm title'
    case 'channel': return swarmChannelTitle(input)
    case 'join': return input.swarm?.trim() ? `Join swarm ${input.swarm.trim()}` : 'Join swarm'
    default: return 'Run swarm'
  }
}

function boardTitle(tool: Exclude<SwarmTool, 'swarm'>, input: SwarmInput): string {
  const target = channel(input.channel)
  if (tool === 'post_message') return target && target !== 'main' ? `Post to #${target}` : 'Post to swarm board'
  if (tool === 'swarm_wait') return 'Wait for swarm board'
  if (input.status === true) return 'Read swarm status'
  return target && target !== 'main' && target !== '*' ? `Read #${target}` : 'Read swarm board'
}

function swarmPresentation(tool: SwarmTool, action: string, rawInput: AcpToolCall['rawInput']): AcpToolPresentation {
  const input = swarmInputSchema.safeParse(rawInput).data ?? {}
  if (tool !== 'swarm') return { toolName: boardTitle(tool, input) }
  if (action !== 'add') return { toolName: swarmTitle(action, input) }
  const name = handle(input.name)
  return subagentCard({ description: name ? `@${name}` : swarmAddTitle(input), prompt: input.brief ?? swarmAddTitle(input) })
}

/**
 * The card of an agy subagent or swarm call; null for any other call. A call
 * of an MCP server with the same name is that server's own tool.
 */
type ToolMeta = z.infer<typeof metaSchema>

/** The swarm tool a call is: by its title, or by the tool agy names in `_meta`. */
function swarmToolOf(title: string, meta: ToolMeta | undefined): SwarmTool | undefined {
  const metaTool = meta?.antigravity?.swarm?.tool
  return SWARM_TITLES.get(title) ?? [...SWARM_TITLES.values()].find((tool) => tool === metaTool)
}

/**
 * The subagents a call launches, with the role and prompt each was given: a
 * subagent launch or a swarm worker. Empty for any other call, and for an update
 * that does not carry the launch's input.
 */
export function antigravityLaunches(toolCall: AcpToolCall): Array<{ role: string; prompt: string }> {
  const card = presentAntigravitySubagentTool(toolCall)
  if (!card?.isSubagent) return []
  const several = launchesSchema.safeParse(toolCall.rawInput)
  const one = launchSchema.safeParse(toolCall.rawInput)
  const launches = several.success ? several.data.Subagents : one.success ? [one.data] : []
  const subagents = launches.filter((launch) => launch.Prompt).map((launch) => ({ role: launch.Role ?? '', prompt: launch.Prompt! }))
  if (subagents.length) return subagents
  const swarm = swarmInputSchema.safeParse(toolCall.rawInput).data
  return swarm?.brief ? [{ role: handle(swarm.name), prompt: swarm.brief }] : []
}

export function presentAntigravitySubagentTool(toolCall: AcpToolCall): AcpToolPresentation | null {
  if (toolCall.kind && toolCall.kind !== 'other' && toolCall.kind !== 'read' && toolCall.kind !== 'think') return null
  const meta = metaSchema.safeParse(toolCall._meta).data
  if (meta?.is_mcp_tool_call) return null
  const title = toolCall.title?.trim() ?? ''
  const swarmTool = swarmToolOf(title, meta)
  if (swarmTool) {
    const action = meta?.antigravity?.swarm?.action ?? swarmInputSchema.safeParse(toolCall.rawInput).data?.action ?? ''
    return swarmPresentation(swarmTool, action.trim().toLowerCase(), toolCall.rawInput)
  }
  if (!SUBAGENT_TITLES.has(title) || (toolCall.kind && toolCall.kind !== 'other')) return null
  return subagentCard(launchInput(toolCall.rawInput))
}
