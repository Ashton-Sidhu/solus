import { z } from 'zod'
import { isSolusToolEnabled } from '@solus/contracts/agent-tools'
import { typeSafeApiKey } from '../../../typesafe/credentials'
import { getHostConfig } from '../../../host/settings'
import type { AgentId, NormalizedEvent } from '@solus/contracts/types'

export interface AgentToolResult {
  ok: boolean
  text: string
  /** One image the agent sees directly, not as a host file path. PNG only and
   *  bounded (`MAX_AGENT_TOOL_IMAGE_BYTES`); both provider adapters send it. */
  image?: AgentToolImage
}

export interface AgentToolImage {
  mimeType: 'image/png'
  /** Base64 of the PNG bytes. */
  data: string
}

/** Larger images are refused: providers reject oversized tool results. */
export const MAX_AGENT_TOOL_IMAGE_BYTES = 5 * 1024 * 1024

/** A tool-result image, or null when the bytes are too large to send. */
export function agentToolImage(png: Uint8Array): AgentToolImage | null {
  if (png.byteLength > MAX_AGENT_TOOL_IMAGE_BYTES) return null
  return { mimeType: 'image/png', data: Buffer.from(png).toString('base64') }
}

export interface AgentToolContext {
  provider: AgentId
  cwd: string
  /** The provider's thread id — the currency of durable rows (session links,
   *  comment provenance, the session index). */
  sessionId: () => string | undefined
  /** Solus's own session id — the key the SessionRuntime holds per-session state
   *  under, e.g. a dispatched session's foreign task snapshot. */
  solusSessionId: () => string | undefined
  abortSignal: AbortSignal
  parentToolUseId: () => string | undefined
  emit: (event: NormalizedEvent) => void
}

type ZodFieldMap = Parameters<typeof z.object>[0]

export interface AgentTool<TFields extends ZodFieldMap = ZodFieldMap> {
  name: string
  description: string
  inputFields: TFields
  requiresApproval: boolean
  /** Keep this tool's description in every prompt. Both provider adapters defer
   *  other tool descriptions behind tool search, and a tool whose description
   *  carries guidance the agent needs before it decides to call anything —
   *  render_artifact's fence rule, create_work's embed rule — is useless as a
   *  bare name. Tool-specific guidance must be available before that choice. */
  alwaysLoad?: boolean
  execute(
    input: z.output<z.ZodObject<TFields>>,
    context: AgentToolContext,
  ): Promise<AgentToolResult>
}

export function assertUniqueAgentTools(tools: AgentTool[]): void {
  const names = new Set<string>()
  for (const agentTool of tools) {
    if (names.has(agentTool.name)) {
      throw new Error(`Duplicate agent tool name: ${agentTool.name}`)
    }
    names.add(agentTool.name)
  }
}

export async function executeAgentTool<Input>(
  agentTool: AgentTool,
  input: Input,
  context: AgentToolContext,
): Promise<AgentToolResult> {
  if (agentTool.name === 'ask_jev' && !typeSafeApiKey()) {
    return { ok: false, text: 'Ask Jev is disabled. Add a TypeSafe API key in Settings → Tools on this host.' }
  }
  if (!isSolusToolEnabled(agentTool.name, getHostConfig().config.solusTools)) {
    return { ok: false, text: `${agentTool.name} is disabled in Settings → Tools on this host.` }
  }
  const parsed = z.object(agentTool.inputFields).safeParse(input)
  if (!parsed.success) {
    return { ok: false, text: `Invalid arguments for ${agentTool.name}: ${z.prettifyError(parsed.error)}` }
  }
  return agentTool.execute(parsed.data, context)
}

/** Apply host choices when a provider builds its tool catalog. Execution rechecks them. */
export function enabledAgentTools(tools: AgentTool[]): AgentTool[] {
  const { solusTools } = getHostConfig().config
  return tools.filter((tool) => (tool.name !== 'ask_jev' || !!typeSafeApiKey()) && isSolusToolEnabled(tool.name, solusTools))
}
