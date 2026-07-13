import { z } from 'zod'
import { tool } from '@anthropic-ai/claude-agent-sdk'
import { runCodexOneShot } from './codex-oneshot'
import { createLogger } from '../../logger'

const log = createLogger('CodexSubagent', 'codex-subagent-tool.ts')

// Keys deliberately line up with SubagentCard's parsedInput
// (description / prompt / model / reasoning_effort) so the card's chips render.
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
  model: z.string().optional().describe("Codex model id (e.g. 'gpt-5.5'). Omit for the default."),
  reasoning_effort: z
    .enum(['none', 'low', 'medium', 'high', 'xhigh'])
    .optional()
    .describe("Codex reasoning effort. Defaults to 'high'."),
  read_only: z
    .boolean()
    .optional()
    .describe(
      'Run under the read-only sandbox — the subagent can explore but not write. Use for research/review tasks.',
    ),
}

const CODEX_SUBAGENT_DESC =
  "Delegate a task to a Codex subagent that runs headlessly in this session's working directory and returns its final answer. Runs unattended (no permission prompts); set read_only for tasks that must not modify files. The result is the subagent's final text — it has no memory between calls."

export interface CodexSubagentDeps {
  cwd: string
  /** The parent run's abort signal — stopping the session interrupts the Codex turn. */
  abortSignal: AbortSignal
}

export function codexSubagentSdkTool(deps: CodexSubagentDeps) {
  return tool('codex_subagent', CODEX_SUBAGENT_DESC, codexSubagentShape, async (args) => {
    try {
      const { text, sessionId, toolCallCount } = await runCodexOneShot({
        prompt: args.prompt,
        cwd: deps.cwd,
        model: args.model ?? null, // unknown ids fall back to the default inside runCodexOneShot
        reasoningEffort: args.reasoning_effort,
        abortSignal: deps.abortSignal,
        readOnly: args.read_only === true,
        solusTools: true, // automation tools already excluded (fork-bomb guard)
        ephemeral: false
      })
      log.info(`codex subagent ${sessionId} finished (${toolCallCount} tool calls)`)
      return { content: [{ type: 'text' as const, text: text || '(Codex subagent returned no text.)' }] }
    } catch (err: any) {
      log.error(`codex subagent failed: ${String(err)}`)
      return {
        content: [{ type: 'text' as const, text: `Codex subagent failed: ${String(err?.message ?? err)}` }],
        isError: true as const,
      }
    }
  })
}
