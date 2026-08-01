import { z } from 'zod'
import { isWorkspacePath } from '../../workspace'
import { buildSystemPrompt } from '../system-hint'
import type { ReasoningEffort } from '../../../shared/types'
import { MODEL_PROFILES } from '../../../shared/types'
import type { AgentDispatcher } from '../agent-runner'
import type { AgentTool } from '../tools/agent-tool'
import { solusToolbox } from '../tools/solus-toolbox'
import { isSubagentTranscriptEvent, parentSubagentEvent } from '../subagent-events'

export const CLAUDE_SUBAGENT_TOOL_NAME = 'claude_subagent'

const claudeProfiles = MODEL_PROFILES['claude-code'] ?? {}
const DEFAULT_CLAUDE_MODEL =
  ('claude-sonnet-5' in claudeProfiles ? 'claude-sonnet-5' : undefined) ??
  Object.entries(claudeProfiles).find(([, profile]) => profile.isDefault)?.[0] ??
  Object.keys(claudeProfiles)[0] ??
  'claude-sonnet-5'

const claudeSubagentInputSchema = z.object({
  prompt: z
    .string()
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
      "Claude model id. Defaults to 'claude-sonnet-5' — right for most delegated tasks; pick 'claude-opus-5' for genuinely hard debugging or design work.",
    ),
  reasoning_effort: z
    .enum(['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    .optional()
    .describe(
      "Match to task difficulty: 'low' for mechanical edits and lookups, 'medium' for typical coding tasks, 'high'+ only for hard debugging or design. Omit to use the model's default.",
    ),
  read_only: z
    .boolean()
    .optional()
    .describe(
      'Run with write-capable tools denied — the subagent can explore but not modify files. Use for research/review tasks.',
    ),
})

const CLAUDE_SUBAGENT_DESC =
  "Delegate a task to a Claude subagent that runs headlessly in this session's working directory and returns its final answer. Runs unattended (no permission prompts); set read_only for tasks that must not modify files. The result is the subagent's final text — it has no memory between calls."

export function createClaudeSubagentAgentTool(dispatcher: AgentDispatcher): AgentTool {
  return {
    name: CLAUDE_SUBAGENT_TOOL_NAME,
    description: CLAUDE_SUBAGENT_DESC,
    inputShape: claudeSubagentInputSchema.shape,
    requiresApproval: false,
    execute: async (rawArgs, context) => {
      const args = claudeSubagentInputSchema.parse(rawArgs)
      const readOnly = args.read_only === true
      const model = args.model && claudeProfiles[args.model] ? args.model : DEFAULT_CLAUDE_MODEL
      const reasoningEffort = (
        args.reasoning_effort ?? claudeProfiles[model]?.defaultReasoningEffort ?? 'medium'
      ) as ReasoningEffort
      const parentToolUseId = context.parentToolUseId()
      const run = dispatcher.runAgent({
        provider: 'claude-code',
        prompt: args.prompt,
        cwd: context.cwd,
        tools: [
          ...Object.values(solusToolbox.works),
          ...Object.values(solusToolbox.artifact),
          ...Object.values(solusToolbox.sessions),
          ...Object.values(solusToolbox.tasks),
          ...Object.values(solusToolbox.prs),
        ],
        model,
        reasoningEffort,
        permissionMode: readOnly ? 'plan' : 'auto',
        persistence: 'ephemeral',
        unattended: true,
        systemPrompt: buildSystemPrompt({
          agent: 'claude',
          general: isWorkspacePath(context.cwd),
          planMode: readOnly,
          subagent: true,
        }),
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
        return {
          ok: result.signal !== 'SIGINT',
          text: result.signal === 'SIGINT'
            ? 'Claude subagent was interrupted.'
            : result.output || '(Claude subagent returned no text.)',
        }
      } catch (error) {
        return { ok: false, text: `Claude subagent failed: ${String(error)}` }
      } finally {
        context.abortSignal.removeEventListener('abort', cancel)
      }
    },
  }
}
