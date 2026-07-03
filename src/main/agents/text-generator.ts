import { ClaudeAgent } from './claude/claude-agent'
import { getCodexAppServerClient } from './codex/codex-agent'
import { approvalPolicyFor, sandboxPolicyFor } from './codex/codex-utils'
import { MODEL_PROFILES, type AgentId, type ReasoningEffort } from '../../shared/types'
import type { JsonRpcNotification } from './codex/codex-event-normalizer'

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
  timeoutMs?: number
  maxTurns?: number
}

export class TextGenerator {
  private claude = new ClaudeAgent()
  private codex = getCodexAppServerClient()

  async generate(options: TextGenerationOptions): Promise<string> {
    if (options.provider === 'codex') return this.generateWithCodex(options)
    return this.generateWithClaude(options)
  }

  private async generateWithClaude(options: TextGenerationOptions): Promise<string> {
    const reasoningEffort = options.reasoningEffort ?? 'low'
    // Honor timeoutMs (the Codex path does too). Without this a hung one-shot run
    // blocks callers forever — e.g. worktree branch-name generation, which runs
    // before `git worktree add`, would leave the session stuck in "Starting…".
    const abortController = new AbortController()
    const timer = setTimeout(() => abortController.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const { text } = await this.claude.runOneShot({
        prompt: options.prompt,
        cwd: options.cwd,
        model: options.model ?? undefined,
        reasoningEffort,
        disableReasoning: options.disableReasoning || reasoningEffort === 'none',
        fastMode: options.fastMode ?? false,
        permissionMode: 'auto',
        additionalDirectories: options.additionalDirs ?? [],
        allowedTools: [],
        systemPromptAppend: options.systemPrompt,
        maxTurns: options.maxTurns,
        persistSession: false,
        abortController,
      })
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  private async generateWithCodex(options: TextGenerationOptions): Promise<string> {
    const model = this.resolveCodexModel(options.model ?? null)
    const reasoningEffort = options.reasoningEffort ?? 'low'
    const systemPrompt = options.systemPrompt ?? null
    const disableReasoning = options.disableReasoning || reasoningEffort === 'none'
    const reasoningParams = disableReasoning ? {} : { reasoning_effort: reasoningEffort }
    const response = await this.codex.request<{ thread: { id: string } }>('thread/start', {
      model,
      cwd: options.cwd,
      approvalPolicy: approvalPolicyFor('plan'),
      baseInstructions: systemPrompt,
      developerInstructions: systemPrompt,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      ephemeral: true,
      ...reasoningParams,
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const threadId = response.thread.id
    let turnId: string | null = null
    let text = ''

    const completed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for text generation'))
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

      const onNotification = (message: JsonRpcNotification) => {
        const params = message.params
        if (params?.threadId !== threadId && params?.thread?.id !== threadId) return

        if (message.method === 'item/agentMessage/delta' && typeof params?.delta === 'string') {
          text += params.delta
        }

        if (message.method === 'item/completed' && params?.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
          text = params.item.text
        }

        if (message.method === 'turn/completed' && (!turnId || params?.turnId === turnId || params?.turn?.id === turnId)) {
          cleanup()
          const status = params?.turn?.status
          if (status === 'failed') {
            reject(new Error(errorMessageFromTurn(params?.turn) ?? 'Text generation failed'))
          } else {
            resolve(text)
          }
        }
      }

      const cleanup = () => {
        clearTimeout(timer)
        this.codex.off('notification', onNotification)
      }

      this.codex.on('notification', onNotification)
    })

    const turn = await this.codex.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: options.prompt, text_elements: [] }],
      cwd: options.cwd,
      approvalPolicy: approvalPolicyFor('plan'),
      sandboxPolicy: sandboxPolicyFor('plan'),
      model,
      ...reasoningParams,
      collaborationMode: {
        mode: 'default',
        settings: {
          model,
          ...reasoningParams,
          fast_mode: options.fastMode ?? false,
          developer_instructions: systemPrompt,
        },
      },
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    turnId = turn.turn.id

    return completed
  }

  private resolveCodexModel(model: string | null | undefined): string {
    const profiles = MODEL_PROFILES.codex ?? {}
    if (model && profiles[model]) return model
    return Object.entries(profiles).find(([, profile]) => profile.isDefault)?.[0] ?? model ?? 'gpt-5.1-codex'
  }
}

function errorMessageFromTurn(turn: any): string | null {
  const error = turn?.error
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string') return error.message
  return null
}
