import { z } from 'zod'
import { resolveHomePath } from '../../../platform/paths'
import { buildSystemPrompt } from '../system-hint'
import { instructionsFor } from '../run-input'
import { sessionSettings } from '../../sessions/session-settings'
import { MODEL_PROFILES } from '@solus/contracts/types'
import type { AgentDispatcher } from '../agent-runner'
import type { SeatResolver, TurnSeat } from '../../seats/seat-manager'
import type { AgentTool } from '../tools/agent-tool'
import { solusToolbox } from '../tools/solus-toolbox'
import { isSubagentTranscriptEvent, parentSubagentEvent } from '../subagent-events'
import { SPAN_SERVICES } from '../../../data/insights/registries'
import { resolveSubagentModel } from '../subagent-model'
import { subagentResult } from '../subagent-result'

export const CLAUDE_SUBAGENT_TOOL_NAME = 'claude_subagent'

const claudeProfiles = MODEL_PROFILES['claude-code'] ?? {}
const DEFAULT_CLAUDE_MODEL =
  ['claude-sonnet-5-5', 'claude-sonnet-5'].find((modelId) => modelId in claudeProfiles) ??
  Object.entries(claudeProfiles).find(([, profile]) => profile.isDefault)?.[0] ??
  Object.keys(claudeProfiles)[0] ??
  'claude-sonnet-5'

const claudeSubagentFields = {
  prompt: z
    .string()
    .refine((prompt) => prompt.trim().length > 0, 'Prompt must not be empty.')
    .describe(
      'The complete, self-contained task for the Claude subagent. Include all context it needs — it cannot see this conversation.',
    ),
  description: z
    .string()
    .optional()
    .describe('Short (3-8 word) summary of the task, shown on the subagent card.'),
  model: z
    .string()
    .optional()
    .describe(
      `Claude model id from list_agent_targets. Defaults to '${DEFAULT_CLAUDE_MODEL}'. Unsupported explicit models are refused.`,
    ),
  reasoning_effort: z
    .enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    .optional()
    .describe(
      "Match to task difficulty: 'low' for mechanical edits and lookups, 'medium' for typical coding tasks, 'high'+ only for hard debugging or design. Omit to use the model's default.",
    ),
}
const claudeSubagentInputSchema = z.object(claudeSubagentFields)

const CLAUDE_SUBAGENT_DESC =
  "Use this for temporary work on Claude from another provider. Runs headlessly in this session's working directory and returns one final answer. No task fields, separate Solus conversation, or memory between calls. Runs unattended (no permission prompts). Use the built-in subagent tool for supported work on your current provider."

/** `seatFor` is the turn author's own provider login, which the subagent uses. */
export function createClaudeSubagentAgentTool(dispatcher: AgentDispatcher, seatFor?: SeatResolver): AgentTool {
  return {
    name: CLAUDE_SUBAGENT_TOOL_NAME,
    description: CLAUDE_SUBAGENT_DESC,
    inputFields: claudeSubagentFields,
    requiresApproval: false,
    alwaysLoad: true,
    execute: async (rawArgs, context) => {
      // The session whose turn starts the subagent: its person's instructions apply.
      const parentSessionId = context.sessionId()
      const args = claudeSubagentInputSchema.parse(rawArgs)
      const modelInput = resolveSubagentModel('claude-code', args.model, DEFAULT_CLAUDE_MODEL, args.reasoning_effort)
      if ('error' in modelInput) return { ok: false, text: modelInput.error }
      const { model, reasoningEffort } = modelInput
      const parentToolUseId = context.parentToolUseId()
      let seat: TurnSeat | undefined
      try {
        seat = await seatFor?.('claude-code') ?? undefined
      } catch (error) {
        return { ok: false, text: `Claude subagent failed: ${error instanceof Error ? error.message : String(error)}` }
      }
      const run = dispatcher.runAgent({
        provider: 'claude-code',
        prompt: args.prompt,
        cwd: resolveHomePath(context.cwd),
        tools: [
          ...Object.values(solusToolbox.works),
          ...Object.values(solusToolbox.docs),
          ...Object.values(solusToolbox.artifact),
          ...Object.values(solusToolbox.connections),
          ...Object.values(solusToolbox.insights),
          ...Object.values(solusToolbox.intelligence),
          ...Object.values(solusToolbox.browser),
          ...Object.values(solusToolbox.devices),
          ...Object.values(solusToolbox.sessions),
          ...Object.values(solusToolbox.tasks),
        ],
        model,
        reasoningEffort,
        permissionMode: 'full-access',
        persistence: 'ephemeral',
        seat,
        service: SPAN_SERVICES.subagents,
        unattended: true,
        systemPrompt: buildSystemPrompt(instructionsFor(sessionSettings(parentSessionId)?.preferences, model)) || undefined,
        onEvent: (event) => {
          if (!parentToolUseId || !isSubagentTranscriptEvent(event)) return
          context.emit(parentSubagentEvent(event, parentToolUseId))
        },
      })
      const cancel = () => run.cancel()
      if (context.abortSignal.aborted) cancel()
      else context.abortSignal.addEventListener('abort', cancel, { once: true })
      try {
        const result = await run.done
        return subagentResult(result, 'Claude', context.abortSignal.aborted)
      } catch (error) {
        return { ok: false, text: `Claude subagent failed: ${String(error)}` }
      } finally {
        context.abortSignal.removeEventListener('abort', cancel)
      }
    },
  }
}
