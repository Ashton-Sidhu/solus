import { execSync } from 'child_process'
import { Options, PermissionMode, query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeTurnNormalizer } from './claude-event-normalizer'
import { createLogger } from '../../logger'
import { getCliEnv } from '../../cli-env'
import { SOLUS_PLUGINS_DIR } from '../plugins'
import type { AgentSlashCommand, NormalizedEvent, ReasoningEffort } from '../../../shared/types'

const log = createLogger('ClaudeAgent', 'claude-agent.ts')

function logRawClaudeEvent(sessionId: string | null, msg: unknown): void {
  if (isNormalStreamingTextEvent(msg)) return

  log.debug('Raw provider event', {
    provider: 'claude-code',
    sessionId,
    event: msg as Record<string, unknown>,
  })
}

function isNormalStreamingTextEvent(msg: unknown): boolean {
  const event = (msg as any)?.event
  return (msg as any)?.type === 'stream_event' &&
    event?.type === 'content_block_delta'
}

export const UI_TO_SDK_PERMISSION_MODE: Record<'ask' | 'auto' | 'plan', PermissionMode> = {
  ask: 'default',
  auto: 'acceptEdits',
  plan: 'plan',
}

export const SAFE_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS',
  'TodoRead', 'TodoWrite',
  'Agent', 'Task', 'TaskOutput',
  'Notebook',
  'WebSearch', 'WebFetch',
]

let claudeExecutablePath: string | undefined
try {
  claudeExecutablePath = execSync('which claude', { encoding: 'utf8', env: getCliEnv() }).trim() || undefined
  log.info(`claude executable: ${claudeExecutablePath}`)
} catch {
  log.warn('claude executable not found via which — using SDK default')
}

export type CanUseTool = (toolName: string, input: any, options?: { toolUseID?: string }) => Promise<any>

export interface ClaudeRunOptions {
  /** A plain string for a single text turn, or an async stream of user messages
   *  (streaming input mode) when the turn carries real content blocks (e.g. images). */
  prompt: string | AsyncIterable<SDKUserMessage>
  cwd: string
  sessionId?: string | null
  model?: string | null
  reasoningEffort?: ReasoningEffort
  disableReasoning?: boolean
  fastMode?: boolean
  permissionMode?: 'ask' | 'auto' | 'plan'
  additionalDirectories?: string[]
  allowedTools?: string[]
  mcpServers?: Options['mcpServers']
  systemPromptAppend?: string
  maxTurns?: number
  maxBudgetUsd?: number
  canUseTool?: CanUseTool
  enableFileCheckpointing?: boolean
  persistSession?: boolean
  abortController?: AbortController
  /** Fires once when the SDK first reports a session id for this run. */
  onSessionInit?: (sessionId: string) => Promise<void>
  /** Fires after each `result` event and on abort. */
  onTurnComplete?: (sessionId: string, opts: { partial: boolean; userMessagePreview: string; editedFiles: string[] }) => Promise<void>
  /** When true, the SDK creates a new forked session branching from opts.sessionId. */
  forkSession?: boolean
}

export interface ClaudeRunResult {
  sessionId: string | null
  toolCallCount: number
  permissionDenials: Array<{ tool_name: string; tool_use_id: string }>
  exitCode: 0 | null
  signal: 'SIGINT' | null
}

const autoAllow: CanUseTool = async (_toolName, input) => ({ behavior: 'allow', updatedInput: input })

/**
 * Session-agnostic wrapper around the Claude Agent SDK. Consumers get a stream
 * of normalized events plus a result promise — no EventEmitter, no IpcContext,
 * no permission UI. Usable for background tasks (title/summary generation)
 * and composed into `ClaudeBackend` for session-tied runs.
 */
export class ClaudeAgent {
  run(opts: ClaudeRunOptions): {
    events: AsyncIterable<NormalizedEvent>
    result: Promise<ClaudeRunResult>
  } {
    const abortController = opts.abortController ?? new AbortController()
    const sdkPermissionMode = UI_TO_SDK_PERMISSION_MODE[opts.permissionMode ?? 'auto']

    const systemPrompt: Options['systemPrompt'] = {
      type: 'preset',
      preset: 'claude_code',
      ...(opts.systemPromptAppend ? { append: opts.systemPromptAppend } : {}),
    }

    const claudeOptions: Options = {
      allowedTools: [...(opts.allowedTools ?? SAFE_TOOLS)],
      cwd: opts.cwd,
      systemPrompt,
      plugins: [{type: 'local', path: SOLUS_PLUGINS_DIR}],
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      additionalDirectories: opts.additionalDirectories,
      ...(opts.mcpServers ? { mcpServers: opts.mcpServers } : {}),
      model: opts.model ?? undefined,
      abortController,
      includePartialMessages: true,
      settingSources: ['user', 'project'],
      canUseTool: opts.canUseTool ?? autoAllow,
      pathToClaudeCodeExecutable: claudeExecutablePath,
      permissionMode: sdkPermissionMode,
      ...(opts.disableReasoning ? {} : { effort: opts.reasoningEffort ?? 'high' }),
      fastMode: opts.fastMode ?? false,
      enableFileCheckpointing: opts.enableFileCheckpointing ?? false,
      persistSession: opts.persistSession ?? true,
      extraArgs: { 'replay-user-messages': null } as any,
      env: {...process.env, CLAUDE_CODE_ENABLE_TASKS: '0' },
    }

    if (opts.sessionId) {
      claudeOptions.resume = opts.sessionId
      if (opts.forkSession) {
        claudeOptions.forkSession = true
      }
    }

    const state = {
      sessionId: opts.sessionId ?? null,
    }
    const normalizer = new ClaudeTurnNormalizer()

    let resolveResult!: (v: ClaudeRunResult) => void
    let rejectResult!: (e: Error) => void
    const result = new Promise<ClaudeRunResult>((res, rej) => {
      resolveResult = res
      rejectResult = rej
    })

    const userMessagePreview = typeof opts.prompt === 'string' ? opts.prompt.slice(0, 200) : ''

    const events = (async function* (): AsyncGenerator<NormalizedEvent> {
      try {
        const cquery = query({ prompt: opts.prompt, options: claudeOptions })

        for await (const msg of cquery) {
          if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
            const newSid = (msg as any).session_id as string
            const firstSeen = state.sessionId !== newSid
            state.sessionId = newSid
            if (firstSeen && opts.onSessionInit) {
              try { await opts.onSessionInit(newSid) }
              catch (e) { log.warn(`onSessionInit failed: ${e}`) }
            }
          }

          logRawClaudeEvent(state.sessionId, msg)

          for (const evt of normalizer.push(msg)) {
            yield evt
          }

          if (msg.type === 'result' && state.sessionId && opts.onTurnComplete) {
            try { await opts.onTurnComplete(state.sessionId, { partial: false, userMessagePreview, editedFiles: normalizer.editedFiles }) }
            catch (e) { log.warn(`onTurnComplete failed: ${e}`) }
          }
        }

        resolveResult({
          sessionId: state.sessionId,
          toolCallCount: normalizer.summary.toolCallCount,
          permissionDenials: normalizer.summary.permissionDenials,
          exitCode: 0,
          signal: null,
        })
      } catch (err: any) {
        const isAbort = abortController.signal.aborted || err?.name === 'AbortError'
        if (isAbort) {
          normalizer.interrupt()
          if (state.sessionId && opts.onTurnComplete) {
            try { await opts.onTurnComplete(state.sessionId, { partial: true, userMessagePreview, editedFiles: normalizer.editedFiles }) }
            catch (e) { log.warn(`onTurnComplete (abort) failed: ${e}`) }
          }
          resolveResult({
            sessionId: state.sessionId,
            toolCallCount: normalizer.summary.toolCallCount,
            permissionDenials: normalizer.summary.permissionDenials,
            exitCode: null,
            signal: 'SIGINT',
          })
        } else {
          rejectResult(err instanceof Error ? err : new Error(String(err)))
        }
      }
    })()

    return { events, result }
  }

  /**
   * Fetch the slash commands the SDK reports at init (built-ins, custom, skills)
   * for a working directory. Opens a short-lived streaming query — the only mode
   * in which `supportedCommands()` is available — drives it to init, reads the
   * commands, then tears it down. No turn is ever sent.
   */
  async supportedCommands(opts: { cwd: string; model?: string | null }): Promise<AgentSlashCommand[]> {
    const abortController = new AbortController()
    // Streaming input mode (an async-iterable prompt) is required for
    // `supportedCommands()`. This input yields no turn — it just stays open
    // until we abort, so the subprocess lives long enough to report its init.
    async function* emptyInput(): AsyncGenerator<never> {
      await new Promise<void>((resolve) =>
        abortController.signal.addEventListener('abort', () => resolve(), { once: true }))
    }

    const cquery = query({
      prompt: emptyInput(),
      options: {
        cwd: opts.cwd,
        model: opts.model ?? undefined,
        abortController,
        settingSources: ['user', 'project'],
        pathToClaudeCodeExecutable: claudeExecutablePath,
        plugins: [{type: 'local', path: SOLUS_PLUGINS_DIR}],
        env: { ...process.env, CLAUDE_CODE_ENABLE_TASKS: '0' },
      },
    })
    // Drive the subprocess so the init handshake completes; messages are ignored.
    const drain = (async () => { try { for await (const _ of cquery) { /* until aborted */ } } catch { /* aborted */ } })()
    try {
      const commands = await cquery.supportedCommands()
      return commands.map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint || undefined,
        aliases: c.aliases,
      }))
    } finally {
      abortController.abort()
      await drain.catch(() => {})
    }
  }

  /** Convenience for non-streaming use — returns the final assistant text. */
  async runOneShot(opts: ClaudeRunOptions): Promise<{ text: string; result: ClaudeRunResult }> {
    const { events, result } = this.run(opts)
    let text = ''
    for await (const evt of events) {
      if (evt.type === 'text_chunk') text += evt.text
      else if (evt.type === 'task_complete' && evt.result) text = evt.result
    }
    return { text, result: await result }
  }

  async rewindFiles(sessionId: string, checkpointId: string, projectPath: string): Promise<void> {
    const rewindQuery = query({
      prompt: '',
      options: {
        enableFileCheckpointing: true,
        resume: sessionId,
        cwd: projectPath,
        pathToClaudeCodeExecutable: claudeExecutablePath,
        extraArgs: { 'replay-user-messages': null } as any,
        permissionMode: 'acceptEdits',
      } as Options,
    })
    for await (const _ of rewindQuery) {
      await rewindQuery.rewindFiles(checkpointId)
      break
    }
  }
}
