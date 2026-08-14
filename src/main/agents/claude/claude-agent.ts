import { homedir } from 'os'
import { Options, PermissionMode, query } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeTurnNormalizer, isAbortSeamResult, isTaskNotificationResult } from './claude-event-normalizer'
import { TurnInputChannel } from './claude-turn-input'
import { createLogger } from '../../logger'
import { findOnPath, warmCliPath } from '../../cli-env'
import { SOLUS_PLUGINS_DIR } from '../plugins'
import { parseClaudeUsageReport } from './claude-usage'
import type { ClaudeUsageWindows } from './claude-usage'
import type { AgentSlashCommand, ContextUsage, NormalizedEvent, ReasoningEffort } from '../../../shared/types'
import type { ResultEvent } from '../../../shared/claude-types'
import { z } from 'zod'

const log = createLogger('ClaudeAgent', 'claude-agent.ts')
const contextUsageReportSchema = z.object({
  totalTokens: z.number(),
  maxTokens: z.number().optional(),
  isAutoCompactEnabled: z.boolean().optional(),
  autoCompactThreshold: z.number().optional(),
})
const streamingTextEventSchema = z.object({
  type: z.literal('stream_event'),
  event: z.object({ type: z.literal('content_block_delta') }),
})
const initMessageSchema = z.object({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
})

/**
 * The SDK's own accounting of the window it is about to send: exact totals, the
 * real limit for this model (not the profile's guess), and the threshold it will
 * auto-compact at. Reported per turn because all three move — a compaction drops
 * the total, and the threshold follows whatever the CLI is configured with.
 * Returns null when the CLI predates the control request, leaving the meter on
 * the per-message figures the normalizer derives.
 */
async function readContextUsage(
  cquery: { getContextUsage(): Promise<any> },
): Promise<ContextUsage | null> {
  try {
    const parsed = contextUsageReportSchema.safeParse(await cquery.getContextUsage())
    if (!parsed.success) return null
    const report = parsed.data
    return {
      usedTokens: report.totalTokens,
      windowTokens: report.maxTokens,
      compactAtTokens: report.isAutoCompactEnabled && report.autoCompactThreshold !== undefined
        ? report.autoCompactThreshold
        : undefined,
    }
  } catch (e) {
    log.warn('context_usage_read_failed', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

function logRawClaudeEvent<T>(sessionId: string | null, msg: T): void {
  if (isNormalStreamingTextEvent(msg)) return

  log.debug('raw_provider_event', {
    provider: 'claude-code',
    sessionId,
    event: msg,
  })
}

function isNormalStreamingTextEvent<T>(msg: T): boolean {
  return streamingTextEventSchema.safeParse(msg).success
}

export const UI_TO_SDK_PERMISSION_MODE = {
  ask: 'default',
  auto: 'acceptEdits',
  plan: 'plan',
} satisfies Record<'ask' | 'auto' | 'plan', PermissionMode>

export const SAFE_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS',
  'TodoRead', 'TodoWrite',
  'Agent', 'Task', 'TaskOutput',
  'Notebook',
  'WebSearch', 'WebFetch',
]

// Resolved off the boot path: the synchronous alternative (`which` through an
// interactive login shell) stalls the main process for up to several seconds at
// import. Until the warm PATH resolves, runs pass `undefined` and the SDK falls
// back to its bundled CLI — the same state as a machine with no global install.
let claudeExecutablePath: string | undefined
void warmCliPath().then((path) => {
  claudeExecutablePath = findOnPath('claude', path) ?? undefined
  if (claudeExecutablePath) log.info('claude_executable_found', { path: claudeExecutablePath })
  else log.warn('claude_executable_not_found')
}).catch(() => {
  log.warn('claude_executable_not_found')
})

export type CanUseTool = (toolName: string, input: any, options?: { toolUseID?: string }) => Promise<any>

export interface ClaudeRunOptions {
  /** A plain string for a one-shot turn (background/utility runs), or a
   *  TurnInputChannel (streaming input mode) for session turns, whose stream is
   *  held open across the turn so it can be steered while the agent loop runs. */
  prompt: string | TurnInputChannel
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
  /** Persists the turn and returns the authoritative net session paths. */
  onTurnComplete?: (sessionId: string, opts: { partial: boolean; userMessagePreview: string; editedFiles: string[] }) => Promise<string[] | null>
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

export interface ClaudeRunExecution {
  events: AsyncIterable<NormalizedEvent>
  result: Promise<ClaudeRunResult>
}

const autoAllow: CanUseTool = async (_toolName, input) => ({ behavior: 'allow', updatedInput: input })

/**
 * Session-agnostic wrapper around the Claude Agent SDK. Consumers get a stream
 * of normalized events plus a result promise — no EventEmitter, no IpcContext,
 * no permission UI. Usable for background tasks (title/summary generation)
 * and composed into `ClaudeBackend` for session-tied runs.
 */
export class ClaudeAgent {
  run(opts: ClaudeRunOptions): ClaudeRunExecution {
    const abortController = opts.abortController ?? new AbortController()
    const sdkPermissionMode = UI_TO_SDK_PERMISSION_MODE[opts.permissionMode ?? 'auto']

    const systemPrompt: Options['systemPrompt'] = {
      type: 'preset',
      preset: 'claude_code',
    }
    if (opts.systemPromptAppend) systemPrompt.append = opts.systemPromptAppend

    const claudeOptions: Options = {
      allowedTools: [...(opts.allowedTools ?? SAFE_TOOLS)],
      cwd: opts.cwd,
      systemPrompt,
      plugins: [{type: 'local', path: SOLUS_PLUGINS_DIR}],
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxBudgetUsd,
      additionalDirectories: opts.additionalDirectories,
      model: opts.model ?? undefined,
      abortController,
      includePartialMessages: true,
      settingSources: ['user', 'project'],
      canUseTool: opts.canUseTool ?? autoAllow,
      pathToClaudeCodeExecutable: claudeExecutablePath,
      permissionMode: sdkPermissionMode,
      fastMode: opts.fastMode ?? false,
      enableFileCheckpointing: opts.enableFileCheckpointing ?? false,
      persistSession: opts.persistSession ?? true,
      extraArgs: { 'replay-user-messages': null },
      env: {...process.env, CLAUDE_CODE_ENABLE_TASKS: '0' },
    }
    if (opts.mcpServers) claudeOptions.mcpServers = opts.mcpServers
    if (!opts.disableReasoning) claudeOptions.effort = opts.reasoningEffort ?? 'high'

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

    const input = opts.prompt instanceof TurnInputChannel ? opts.prompt : null
    const promptInput = opts.prompt instanceof TurnInputChannel ? opts.prompt.stream : opts.prompt
    const userMessagePreview = (input?.previewText ?? String(opts.prompt)).slice(0, 200)

    const events = (async function* (): AsyncGenerator<NormalizedEvent> {
      // A turn is over once its result lands, but the SDK keeps the query open
      // while backgrounded sub-agents finish. Closing the input stream is what
      // ends the query, so hold it open until nothing is still in flight —
      // otherwise those tasks get cut off mid-run.
      let sawResult = false
      // Tracked by id, not counted: a task settles twice (`task_updated` and
      // `task_notification` both normalize to `background_task_settled`), so a
      // counter drains ahead of the real work and closes the stream mid-turn.
      const backgroundTasks = new Set<string>()
      try {
        const cquery = query({ prompt: promptInput, options: claudeOptions })

        for await (const msg of cquery) {
          const initMessage = initMessageSchema.safeParse(msg)
          if (initMessage.success) {
            const newSid = initMessage.data.session_id
            const firstSeen = state.sessionId !== newSid
            state.sessionId = newSid
            if (firstSeen && opts.onSessionInit) {
              try { await opts.onSessionInit(newSid) }
              catch (e) { log.warn('on_session_init_failed', { error: e instanceof Error ? e.message : String(e) }) }
            }
          }

          logRawClaudeEvent(state.sessionId, msg)

          const normalized = normalizer.push(msg)
          for (const evt of normalized) {
            if (evt.type === 'background_task_started') backgroundTasks.add(evt.taskId)
            else if (evt.type === 'background_task_settled') backgroundTasks.delete(evt.taskId)
          }
          // An aborted request is reported as a result before the SDK restarts
          // its loop on the same query. Closing the input there would pull the
          // stream out from under the restart, and `canUseTool` rides that same
          // stream — every later permission request would fail with
          // "AbortError: Stream closed".
          // SAFETY: The SDK message type discriminant identifies its result contract.
          const resultMessage = msg.type === 'result' ? msg as ResultEvent : null
          if (resultMessage && !isAbortSeamResult(resultMessage) && !isTaskNotificationResult(resultMessage)) {
            sawResult = true
            // A background task keeps the SDK query and its input loop alive, so
            // Enter must still be able to steer the main agent while that task is
            // running. With no background work, refuse input during the snapshot
            // gap: `input.close()` below can lag and nothing would read it again.
            if (backgroundTasks.size === 0) input?.seal()
            const contextUsage = await readContextUsage(cquery)
            if (contextUsage) yield { type: 'usage', context: contextUsage }
            if (state.sessionId && opts.onTurnComplete) {
              try {
                const changedFiles = await opts.onTurnComplete(state.sessionId, {
                  partial: false,
                  userMessagePreview,
                  editedFiles: normalizer.editedFiles,
                })
                if (changedFiles) yield { type: 'session_changed_files_updated', paths: changedFiles }
              }
              catch (e) { log.warn('on_turn_complete_failed', { error: e instanceof Error ? e.message : String(e) }) }
            }
          }
          // Close only at a result. A settling background task is not an end: the
          // SDK restarts its loop to hand the notification to the main agent, and
          // `canUseTool` rides this stream, so closing on the settle made every
          // permission request in that continuation — AskUserQuestion above all —
          // fail with "AbortError: Stream closed". That continuation reports its
          // own result, which is where the last task in flight gets to close.
          if (msg.type === 'result' && sawResult && backgroundTasks.size === 0) input?.close()
          for (const evt of normalized) yield evt
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
            try {
              const changedFiles = await opts.onTurnComplete(state.sessionId, {
                partial: true,
                userMessagePreview,
                editedFiles: normalizer.editedFiles,
              })
              if (changedFiles) yield { type: 'session_changed_files_updated', paths: changedFiles }
            }
            catch (e) { log.warn('on_turn_complete_abort_failed', { error: e instanceof Error ? e.message : String(e) }) }
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
      } finally {
        // An aborted or failed turn never reaches the result path above; release
        // the stream so the query can't be left waiting on input that never comes.
        input?.close()
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
      yield* []
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

  /**
   * Read the subscription quota windows by running `/usage` headless. The slash
   * command costs $0 and zero turns — it never reaches the model — so this is
   * cheap enough to poll. Returns null when the report doesn't parse.
   */
  async readUsageReport(): Promise<ClaudeUsageWindows | null> {
    const usageQuery = query({
      prompt: '/usage',
      options: {
        // Quota is account-wide, so this deliberately runs outside any project:
        // no project settings, no session file, nothing to leak into a transcript.
        cwd: homedir(),
        settingSources: [],
        pathToClaudeCodeExecutable: claudeExecutablePath,
        extraArgs: { 'no-session-persistence': null },
        env: { ...process.env, CLAUDE_CODE_ENABLE_TASKS: '0' },
      },
    })
    for await (const message of usageQuery) {
      if (message.type !== 'result') continue
      if (message.subtype !== 'success') return null
      const windows = parseClaudeUsageReport(message.result)
      // A half-read report is the signature of a wording change, and the
      // missing window silently disappears from the panel. Keep the text that
      // defeated the parser so the next occurrence is diagnosable.
      if (!windows?.fiveHour || !windows?.weekly) {
        log.warn('usage_report_partially_parsed', {
          hasFiveHour: !!windows?.fiveHour,
          hasWeekly: !!windows?.weekly,
          report: message.result,
        })
      }
      return windows
    }
    return null
  }

  async rewindFiles(sessionId: string, checkpointId: string, projectPath: string): Promise<void> {
    const rewindQuery = query({
      prompt: '',
      options: {
        enableFileCheckpointing: true,
        resume: sessionId,
        cwd: projectPath,
        pathToClaudeCodeExecutable: claudeExecutablePath,
        extraArgs: { 'replay-user-messages': null },
        permissionMode: 'acceptEdits',
      },
    })
    for await (const _ of rewindQuery) {
      await rewindQuery.rewindFiles(checkpointId)
      break
    }
  }
}
