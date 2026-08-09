import { execSync } from 'child_process'
import { homedir } from 'os'
import { Options, PermissionMode, query } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeTurnNormalizer, isAbortSeamResult, isTaskNotificationResult } from './claude-event-normalizer'
import { TurnInputChannel } from './claude-turn-input'
import { createLogger } from '../../logger'
import { getCliEnv } from '../../cli-env'
import { SOLUS_PLUGINS_DIR } from '../plugins'
import { parseClaudeUsageReport } from './claude-usage'
import type { ClaudeUsageWindows } from './claude-usage'
import type { AgentSlashCommand, ContextUsage, NormalizedEvent, ReasoningEffort } from '../../../shared/types'
import type { ResultEvent } from '../../../shared/claude-types'

const log = createLogger('ClaudeAgent', 'claude-agent.ts')

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
    const report = await cquery.getContextUsage()
    if (typeof report?.totalTokens !== 'number') return null
    return {
      usedTokens: report.totalTokens,
      windowTokens: typeof report.maxTokens === 'number' ? report.maxTokens : undefined,
      compactAtTokens: report.isAutoCompactEnabled && typeof report.autoCompactThreshold === 'number'
        ? report.autoCompactThreshold
        : undefined,
    }
  } catch (e) {
    log.warn('context_usage_read_failed', { error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

function logRawClaudeEvent(sessionId: string | null, msg: unknown): void {
  if (isNormalStreamingTextEvent(msg)) return

  log.debug('raw_provider_event', {
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
  log.info('claude_executable_found', { path: claudeExecutablePath })
} catch {
  log.warn('claude_executable_not_found')
}

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
          if (msg.type === 'system' && 'subtype' in msg && msg.subtype === 'init') {
            const newSid = (msg as any).session_id as string
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
          if (
            msg.type === 'result'
            && !isAbortSeamResult(msg as unknown as ResultEvent)
            && !isTaskNotificationResult(msg as unknown as ResultEvent)
          ) {
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
      } as Options,
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
