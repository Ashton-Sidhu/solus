import { z } from 'zod'
import type { AgentDispatcher } from '../agent-runner'
import type { AgentTool } from '../tools/agent-tool'
import { solusToolbox } from '../tools/solus-toolbox'
import { buildSystemPrompt } from '../system-hint'
import { isWorkspacePath } from '../../workspace'
import { isSubagentTranscriptEvent, parentSubagentEvent } from '../subagent-events'

// Keys deliberately line up with the renderer's parseSubagentInput
// (description / prompt / model / reasoning_effort) so the card's row renders.
const codexSubagentShape = {
  prompt: z
    .string()
    .describe(
      'The complete, self-contained task for the Codex subagent. Include all context it needs — it cannot see this conversation.',
    ),
  description: z
    .string()
    .optional()
    .describe('Short (3-8 word) summary of the task, shown on the subagent card.'),
  model: z
    .string()
    .optional()
    .describe(
      "Codex model id. Defaults to 'gpt-5.6-terra' — right for most delegated tasks; pick 'gpt-5.6-sol' for genuinely hard debugging or design work.",
    ),
  reasoning_effort: z
    .enum(['none', 'low', 'medium', 'high', 'xhigh'])
    .optional()
    .describe(
      "Match to task difficulty: 'low' for mechanical edits and lookups, 'medium' for typical coding tasks, 'high'+ only for hard debugging or design. Omit to use the model's default.",
    ),
  read_only: z
    .boolean()
    .optional()
    .describe(
      'Run under the read-only sandbox — the subagent can explore but not write. Use for research/review tasks.',
    ),
}

const CODEX_SUBAGENT_DESC =
  "Delegate a task to a Codex subagent that runs headlessly in this session's working directory and returns its final answer. Runs unattended (no permission prompts); set read_only for tasks that must not modify files. The result is the subagent's final text — it has no memory between calls."

export function createCodexSubagentAgentTool(dispatcher: AgentDispatcher): AgentTool {
  return {
    name: 'codex_subagent',
    description: CODEX_SUBAGENT_DESC,
    inputShape: codexSubagentShape,
    requiresApproval: false,
    execute: async (args, context) => {
      const parentToolUseId = context.parentToolUseId()
      const run = dispatcher.runAgent({
        provider: 'codex',
        prompt: args.prompt,
        cwd: context.cwd,
        tools: [
          ...Object.values(solusToolbox.works),
          ...Object.values(solusToolbox.artifact),
          ...Object.values(solusToolbox.cloudflare),
          ...Object.values(solusToolbox.sessions),
          ...Object.values(solusToolbox.tasks),
          ...Object.values(solusToolbox.prs),
        ],
        model: args.model ?? 'gpt-5.6-terra',
        reasoningEffort: args.reasoning_effort,
        permissionMode: args.read_only === true ? 'plan' : 'auto',
        persistence: 'ephemeral',
        systemPrompt: buildSystemPrompt({
          agent: 'codex',
          general: isWorkspacePath(context.cwd),
          planMode: args.read_only === true,
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
            ? 'Codex subagent was interrupted.'
            : result.output || '(Codex subagent returned no text.)',
        }
      } catch (error) {
        return { ok: false, text: `Codex subagent failed: ${String(error)}` }
      } finally {
        context.abortSignal.removeEventListener('abort', cancel)
      }
    },
  }
}
