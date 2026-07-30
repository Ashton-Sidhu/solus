import type { AgentDispatcher } from './agent-runner'
import { buildSystemPrompt } from './system-hint'
import { isWorkspacePath } from '../workspace'
import type { AgentId, ReasoningEffort } from '../../shared/types'

const DEFAULT_TIMEOUT_MS = 120_000

export interface TextGenerationOptions {
  prompt: string
  cwd: string
  provider: AgentId
  model?: string | null
  reasoningEffort?: ReasoningEffort
  disableReasoning?: boolean
  fastMode?: boolean
  systemPrompt?: string
  additionalDirs?: string[]
  abortSignal?: AbortSignal
  timeoutMs?: number
  maxTurns?: number
}

export class TextGenerator {
  constructor(private readonly dispatcher: AgentDispatcher) {}

  async generate(options: TextGenerationOptions): Promise<string> {
    const reasoningEffort = options.reasoningEffort ?? 'low'
    const baseSystemPrompt = buildSystemPrompt({
      agent: options.provider === 'codex' ? 'codex' : 'claude',
      general: isWorkspacePath(options.cwd),
    })
    const systemPrompt = [baseSystemPrompt, options.systemPrompt].filter(Boolean).join('\n\n')
    const run = this.dispatcher.runAgent({
      provider: options.provider,
      prompt: options.prompt,
      cwd: options.cwd,
      tools: [],
      model: options.model,
      reasoningEffort: options.disableReasoning ? 'none' : reasoningEffort,
      permissionMode: options.provider === 'codex' ? 'plan' : 'auto',
      persistence: 'ephemeral',
      additionalDirectories: options.additionalDirs,
      fastMode: options.fastMode,
      systemPrompt,
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    const cancel = () => run.cancel()
    if (options.abortSignal) {
      if (options.abortSignal.aborted) cancel()
      else options.abortSignal.addEventListener('abort', cancel, { once: true })
    }
    try {
      return (await run.done).output
    } finally {
      options.abortSignal?.removeEventListener('abort', cancel)
    }
  }
}
