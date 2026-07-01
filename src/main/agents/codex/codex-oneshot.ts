import { getCodexAppServerClient } from './codex-agent'
import {
  normalizeCodexNotification,
  type CodexThreadStartResponse,
  type CodexTurnStartResponse,
  type JsonRpcNotification,
} from './codex-event-normalizer'
import {
  approvalPolicyFor,
  sandboxFor,
  sandboxPolicyFor,
  codexItemToMessage,
  toEpochMs,
  type CodexThreadSummary,
  type CodexTurnHistory,
} from './codex-utils'
import { buildSystemPrompt } from '../system-hint'
import { isWorkspacePath } from '../../workspace'
import { MODEL_PROFILES } from '../../../shared/types'
import { createLogger } from '../../logger'
import type { ReasoningEffort } from '../../../shared/types'

const log = createLogger('CodexOneShot', 'codex-oneshot.ts')

interface CodexThreadReadResponse {
  thread?: CodexThreadSummary & { turns?: CodexTurnHistory[] }
}

const codexProfiles = MODEL_PROFILES['codex'] ?? {}
const DEFAULT_CODEX_MODEL =
  Object.entries(codexProfiles).find(([, p]) => p.isDefault)?.[0] ??
  Object.keys(codexProfiles)[0] ??
  'gpt-5-codex'

// Automations always run unattended, so the headless run uses the same
// semantics as the 'auto' permission mode in the interactive backend:
// approvals are never requested and the sandbox is workspace-write.
const PERMISSION = 'auto' as const

/** A Codex dynamicTools JSON-schema descriptor (same shape work-tools use). */
export interface CodexDynamicTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface CodexOneShotOptions {
  prompt: string
  cwd: string
  model?: string | null
  reasoningEffort?: ReasoningEffort
  /** Abort the in-flight turn (interrupts the app-server turn and rejects). */
  abortSignal?: AbortSignal
  ephemeral?: boolean
  onThreadStart?: (threadId: string) => void
  /** Tools to register for this run. Without these the one-shot exposes no
   *  dynamic tools (the automation fork-bomb guard). */
  dynamicTools?: CodexDynamicTool[]
}

export interface CodexOneShotResult {
  text: string
  sessionId: string | null
  toolCallCount: number
}

/**
 * Session-agnostic, non-streaming Codex run for headless automations. Mirrors
 * `ClaudeAgent.runOneShot`: it starts a fresh thread, runs a single turn, and
 * resolves with the final assistant text once the turn completes.
 *
 * Like the Claude path it attaches NO dynamic tools, so an automation's run
 * cannot create or trigger more automations (the fork-bomb guard). With
 * approvalPolicy 'never' (auto) the regular CodexBackend handles any
 * server-request responses on the shared client, including approved dynamic
 * tools registered for this run.
 *
 * The app-server client is a shared singleton (the interactive backend uses it
 * too), so we cannot read text off the global notification firehose reliably —
 * delta notifications don't all carry a thread/turn id. Instead we only watch
 * for *our* turn to complete (turn/completed is routed by thread/turn id), then
 * read the finished thread back for the assistant text and tool-call count.
 */
export async function runCodexOneShot(opts: CodexOneShotOptions): Promise<CodexOneShotResult> {
  const client = getCodexAppServerClient()
  const model = opts.model && codexProfiles[opts.model] ? opts.model : DEFAULT_CODEX_MODEL
  const reasoningEffort = opts.reasoningEffort ?? 'high'
  const general = isWorkspacePath(opts.cwd)
  const developerInstructions = buildSystemPrompt({
    agent: 'codex',
    general,
  })

  const start = await client.request<CodexThreadStartResponse>('thread/start', {
    model,
    cwd: opts.cwd,
    approvalPolicy: approvalPolicyFor(PERMISSION),
    sandbox: sandboxFor(PERMISSION),
    baseInstructions: null,
    developerInstructions,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
    reasoning_effort: reasoningEffort,
    ephemeral: opts.ephemeral,
    ...(opts.dynamicTools?.length ? { dynamicTools: opts.dynamicTools } : {}),
  })
  const threadId = start.thread.id
  opts.onThreadStart?.(threadId)

  let turnId = ''
  let settled = false

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      client.off('notification', onNotification)
      client.off('exit', onExit)
      opts.abortSignal?.removeEventListener('abort', onAbort)
    }
    const done = (err?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve()
    }

    // Route by thread/turn id so a concurrent interactive session or automation
    // run on the same shared client never settles this turn.
    const isOurs = (params: any): boolean => {
      const tid = params?.threadId
      if (tid) return tid === threadId
      const tn = params?.turnId ?? params?.turn?.id
      return !!tn && !!turnId && tn === turnId
    }

    const onNotification = (msg: JsonRpcNotification) => {
      const params: any = msg.params || {}
      if (!isOurs(params)) return
      for (const evt of normalizeCodexNotification(msg.method, params)) {
        if (evt.type === 'task_complete') done()
        else if (evt.type === 'error' && evt.isError) done(new Error(evt.message || 'Codex turn failed'))
      }
    }

    const onExit = () => done(new Error('Codex app-server exited before the turn completed'))

    // Cancellation: interrupt the turn (best-effort — only possible once it has
    // started) and reject so the caller finalizes the run as cancelled.
    const onAbort = () => {
      if (turnId) {
        client.request('turn/interrupt', { threadId, turnId }).catch(() => {})
      }
      done(new Error('Automation run cancelled'))
    }

    client.on('notification', onNotification)
    client.once('exit', onExit)
    if (opts.abortSignal) {
      if (opts.abortSignal.aborted) onAbort()
      else opts.abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    client
      .request<CodexTurnStartResponse>('turn/start', {
        threadId,
        input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
        cwd: opts.cwd,
        approvalPolicy: approvalPolicyFor(PERMISSION),
        sandboxPolicy: sandboxPolicyFor(PERMISSION, opts.cwd, []),
        model,
        reasoning_effort: reasoningEffort,
        collaborationMode: {
          mode: 'default',
          settings: { model, reasoning_effort: reasoningEffort, developer_instructions: developerInstructions },
        },
      })
      .then((turn) => {
        turnId = turn.turn.id
      })
      .catch((err) => {
        log.error(`turn/start failed: ${String(err)}`)
        done(err instanceof Error ? err : new Error(String(err)))
      })
  })

  // Read the finished thread back for the assistant text and tool-call count.
  return { sessionId: threadId, ...(await readThreadOutcome(client, threadId)) }
}

/** Flatten the completed thread into the final assistant text + a tool-call count. */
async function readThreadOutcome(
  client: ReturnType<typeof getCodexAppServerClient>,
  threadId: string,
): Promise<{ text: string; toolCallCount: number }> {
  try {
    const response = await client.request<CodexThreadReadResponse>('thread/read', { threadId, includeTurns: true })
    const turns = response.thread?.turns ?? []
    const assistantText: string[] = []
    let toolCallCount = 0
    for (const turn of turns) {
      const timestamp = toEpochMs(turn.startedAt)
      for (const item of turn.items ?? []) {
        const msg = codexItemToMessage(item, timestamp)
        if (!msg) continue
        if (msg.role === 'assistant' && msg.content) assistantText.push(msg.content)
        else if (msg.role === 'tool') toolCallCount++
      }
    }
    return { text: assistantText.join('\n\n'), toolCallCount }
  } catch (err) {
    log.warn(`thread/read after completion failed: ${String(err)}`)
    return { text: '', toolCallCount: 0 }
  }
}
