import { z } from 'zod'
import type { AgentDispatcher } from '../execution/agents/agent-runner'
import { TextGenerator } from '../execution/agents/text-generator'
import type { AgentTool } from '../execution/agents/tools/agent-tool'
import { createLogger } from '../logger'
import { resolveTextGenerationModel } from '../host/settings'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { AgentId } from '@solus/contracts/types'
import type { SeatResolver, TurnSeat } from '../execution/seats/seat-manager'
import { writingBackendFor } from '../execution/agents/writing-backend'

const log = createLogger('WorktreeName', 'worktree-name.ts')
const WORKTREE_NAME_TOOL = 'submit_worktree_name'

const worktreeNameSchema = z.object({
  name: z.string().min(1),
})

interface SubmittedWorktreeName {
  name: string | null
}

function worktreeNameTool(capture: (name: string) => void): AgentTool {
  return {
    name: WORKTREE_NAME_TOOL,
    description: 'Submit the short semantic name for the git worktree. This call is your whole answer.',
    inputFields: {
      name: z.string().describe('Three to six short words that name the concrete requested outcome.'),
    },
    requiresApproval: false,
    execute: async (args) => {
      const { name } = worktreeNameSchema.parse(args)
      capture(name)
      return { ok: true, text: `Named the worktree "${name}".` }
    },
  }
}

export async function generateWorktreeName(
  dispatcher: AgentDispatcher,
  promptText: string,
  cwd: string,
  abortSignal?: AbortSignal,
  seatFor?: SeatResolver,
  /** The person's preferences: their writing model names the worktree. */
  preferences?: ExecutionPreferences,
): Promise<string | null> {
  const prompt = promptText.trim()
  if (!prompt) return null
  const backend = await writingBackendFor(resolveTextGenerationModel(preferences), seatFor)
  if (!backend) return null
  return generateWorktreeNameWith(dispatcher, prompt, cwd, backend, abortSignal)
}

export async function generateWorktreeNameWith(
  dispatcher: AgentDispatcher,
  prompt: string,
  cwd: string,
  selection: { provider: AgentId; model: string; seat?: TurnSeat },
  abortSignal?: AbortSignal,
): Promise<string | null> {
  const submitted: SubmittedWorktreeName = { name: null }
  try {
    await new TextGenerator(dispatcher).generate({
      provider: selection.provider,
      model: selection.model,
      seat: selection.seat,
      reasoningEffort: 'low',
      cwd,
      prompt: [
        'Name a git worktree for the request below.',
        `Submit the name by calling ${WORKTREE_NAME_TOOL} exactly once. The tool call is your whole answer.`,
        'Use three to six short words that identify the concrete outcome.',
        'Do not use generic words such as task, worktree, implementation, or changes.',
        'Do not explain or write prose.',
        '',
        prompt,
      ].join('\n'),
      tools: [worktreeNameTool((name) => { submitted.name = name })],
      unattended: true,
      maxTurns: 2,
      timeoutMs: 30_000,
      abortSignal,
    })
  } catch (error) {
    if (abortSignal?.aborted) throw error
    log.warn('worktree_name_generation_failed', {
      provider: selection.provider,
      model: selection.model,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }

  const name = submitted.name?.trim() ?? ''
  log.info('worktree_name_generated', {
    provider: selection.provider,
    model: selection.model,
    named: !!name,
  })
  return name || null
}
