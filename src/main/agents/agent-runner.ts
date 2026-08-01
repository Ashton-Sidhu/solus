import type { AgentBackend, RunHandle } from './agent-backend'
import type { AgentTool } from './tools/agent-tool'
import { assertUniqueAgentTools } from './tools/agent-tool'
import type {
  AgentId,
  NormalizedEvent,
  PromptOptions,
  ReasoningEffort,
} from '../../shared/types'

export interface AgentRunRequest {
  provider: AgentId
  prompt: string
  cwd: string
  tools: AgentTool[]
  model?: string | null
  reasoningEffort?: ReasoningEffort
  permissionMode: 'ask' | 'auto' | 'plan'
  persistence: 'session' | 'ephemeral'
  /** Background utility runs must never park on an interaction no surface can answer. */
  unattended?: boolean
  sessionId?: string | null
  forkSession?: boolean
  additionalDirectories?: string[]
  imageAttachments?: PromptOptions['imageAttachments']
  contextWindow?: number | null
  fastMode?: boolean
  systemPrompt?: string
  maxTurns?: number
  maxBudgetUsd?: number
  timeoutMs?: number
  onEvent?: (event: NormalizedEvent) => void
}

/** ControlPlane-owned state needed to preserve a durable session lifecycle.
 * It is deliberately separate from AgentRunRequest. */
export interface AgentRunSessionState {
  changedFiles: string[]
}

export interface AgentRunResult {
  sessionId: string | null
  output: string
  toolCallCount: number
  permissionDenials: Array<{ tool_name: string; tool_use_id: string }>
  exitCode: number | null
  signal: string | null
}

export interface AgentRun {
  sessionId: Promise<string | null>
  done: Promise<AgentRunResult>
  cancel(): void
  handle: RunHandle
}

export interface AgentDispatcher {
  runAgent(request: AgentRunRequest): AgentRun
}

export class AgentRunner {
  constructor(private readonly backends: Map<AgentId, AgentBackend>) {}

  run(request: AgentRunRequest, sessionState?: AgentRunSessionState): AgentRun {
    assertUniqueAgentTools(request.tools)
    const backend = this.backends.get(request.provider)
    if (!backend) throw new Error(`Unknown agent provider: ${request.provider}`)

    let handle!: RunHandle
    let exitCode: number | null = null
    let signal: string | null = null
    let streamedText = ''
    let settled = false
    let sessionSettled = false
    let resolveSession!: (sessionId: string | null) => void
    let rejectSession!: (error: Error) => void
    const sessionId = new Promise<string | null>((resolve, reject) => {
      resolveSession = resolve
      rejectSession = reject
    })
    void sessionId.catch(() => {})

    const belongsToRun = (eventSessionId: string | null): boolean =>
      !!handle && (
        eventSessionId === handle.sessionId ||
        (!eventSessionId && !handle.sessionId)
      )

    const onNormalized = (eventSessionId: string | null, event: NormalizedEvent) => {
      if (!belongsToRun(eventSessionId)) return
      if (event.type === 'text_chunk' && !event.parentToolUseId) streamedText += event.text
      if (event.type === 'task_complete' && event.result) handle.resultText = event.result
      if (event.type === 'session_init' && !sessionSettled) {
        sessionSettled = true
        resolveSession(event.sessionId)
      }
      request.onEvent?.(event)
    }
    const onExit = (eventSessionId: string | null, code: number | null, runSignal: string | null) => {
      if (!belongsToRun(eventSessionId)) return
      exitCode = code
      signal = runSignal
    }
    backend.on('normalized', onNormalized)
    backend.on('exit', onExit)

    try {
      handle = backend.startRun(request, sessionState)
    } catch (error) {
      backend.off('normalized', onNormalized)
      backend.off('exit', onExit)
      throw error
    }

    if (handle.sessionId && !sessionSettled) {
      sessionSettled = true
      resolveSession(handle.sessionId)
    }

    let timeout: ReturnType<typeof setTimeout> | undefined
    let rejectTimeout!: (error: Error) => void
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject
    })
    if (request.timeoutMs) {
      timeout = setTimeout(() => {
        rejectTimeout(new Error(`Agent run timed out after ${request.timeoutMs}ms`))
        cancel()
      }, request.timeoutMs)
      ;(timeout as unknown as { unref?: () => void }).unref?.()
    }

    const cancel = () => {
      if (settled || handle.abortController.signal.aborted) return
      if (handle.sessionId) {
        if (!backend.cancelSession(handle.sessionId)) handle.abortController.abort()
      } else {
        handle.abortController.abort()
      }
    }

    const completion = request.timeoutMs
      ? Promise.race([handle.runPromise, timeoutPromise])
      : handle.runPromise
    const done = completion.then<AgentRunResult>(() => ({
      sessionId: handle.sessionId,
      output: handle.resultText ?? streamedText,
      toolCallCount: handle.toolCallCount,
      permissionDenials: handle.permissionDenials,
      exitCode,
      signal,
    })).finally(() => {
      settled = true
      if (timeout) clearTimeout(timeout)
      backend.off('normalized', onNormalized)
      backend.off('exit', onExit)
      if (!sessionSettled) {
        sessionSettled = true
        if (handle.sessionId) resolveSession(handle.sessionId)
        else rejectSession(new Error(handle.abortController.signal.aborted ? 'Interrupted' : 'Agent run completed before session initialization'))
      }
    })
    void done.catch(() => {})

    return { sessionId, done, cancel, handle }
  }
}
