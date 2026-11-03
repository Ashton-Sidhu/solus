import type { AgentDispatcher } from './agent-runner'
import { hostPolicies } from '../../host/policy/host-policy-store'
import type { AgentTool } from './tools/agent-tool'
import { buildSystemPrompt } from './system-hint'
import { instructionsFor } from './run-input'
import type { ExecutionPreferences } from '@solus/contracts/settings'
import type { AgentId, PromptOptions, ReasoningEffort } from '@solus/contracts/types'
import { SPAN_SERVICES, type SpanService } from '../../data/insights/registries'
import { resolveHomePath } from '../../platform/paths'
import type { TurnSeat } from '../seats/seat-manager'

const DEFAULT_TIMEOUT_MS = 120_000

export interface TextGenerationOptions {
  /** The organization whose work this text is for (`local` for personal work); its policies govern the run (plans/030 §6.3). */
  organizationId: string
  prompt: string
  cwd: string
  provider: AgentId
  model?: string | null
  reasoningEffort?: ReasoningEffort
  disableReasoning?: boolean
  fastMode?: boolean
  systemPrompt?: string
  additionalDirs?: string[]
  imageAttachments?: PromptOptions['imageAttachments']
  abortSignal?: AbortSignal
  timeoutMs?: number
  maxTurns?: number
  /** Run with only this caller's tools (`AgentRunRequest.bare`). */
  bare?: { webAccess: boolean }
  /** Capture tools for structured answers — the caller reads the arguments the
   *  model submits rather than scraping its prose. */
  tools?: AgentTool[]
  /** Background runs must never park on an interaction no surface can answer. */
  unattended?: boolean
  /** Span attribution for the ephemeral run; defaults to text generation. */
  service?: SpanService
  /** The member's own provider login; absent for the host's login. */
  seat?: TurnSeat
  /** The requester's preferences, whose instructions the run adds; absent adds none. */
  executionPreferences?: ExecutionPreferences
}

export class TextGenerator {
  constructor(private readonly dispatcher: AgentDispatcher) {}

  async generate(options: TextGenerationOptions): Promise<string> {
    const reasoningEffort = options.reasoningEffort ?? 'low'
    const userInstructions = buildSystemPrompt(instructionsFor(options.executionPreferences, options.model))
    const systemPrompt = [userInstructions, options.systemPrompt].filter(Boolean).join('\n\n')
    const run = this.dispatcher.runAgent({
      organizationId: options.organizationId,
      provider: options.provider,
      prompt: options.prompt,
      cwd: resolveHomePath(options.cwd),
      tools: options.tools ?? [],
      unattended: options.unattended,
      model: options.model,
      reasoningEffort: options.disableReasoning ? 'none' : reasoningEffort,
      // Under a policy ceiling the run uses the ceiling; it is unattended, so a tool that would ask is declined.
      permissionMode: hostPolicies().forWork(options.organizationId).clampMode(options.provider === 'codex' ? 'plan' : 'full-access'),
      persistence: 'ephemeral',
      service: options.service ?? SPAN_SERVICES.textGeneration,
      additionalDirectories: options.additionalDirs,
      imageAttachments: options.imageAttachments,
      fastMode: options.fastMode,
      systemPrompt,
      maxTurns: options.maxTurns,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      bare: options.bare,
      seat: options.seat,
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
