import { getCodexAppServerClient, registerHeadlessThread, unregisterHeadlessThread } from './codex-agent'
import {
  CodexTurnNormalizer,
} from './codex-event-normalizer'
import type {
  CodexDynamicTool,
  CodexThreadReadResponse,
  CodexThreadStartParams,
  CodexThreadStartResponse,
  CodexTurnStartParams,
  CodexTurnStartResponse,
  JsonRpcNotification,
  JsonRpcRequest,
} from './codex-protocol'
import { classifyCodexSolusTool, executeCodexSolusTool, codexSolusToolSchemas } from './codex-solus-tools'
import {
  approvalPolicyFor,
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
import type { NormalizedEvent, ReasoningEffort } from '../../../shared/types'

const log = createLogger('CodexOneShot', 'codex-oneshot.ts')

const codexProfiles = MODEL_PROFILES['codex'] ?? {}
const DEFAULT_CODEX_MODEL =
  Object.entries(codexProfiles).find(([, p]) => p.isDefault)?.[0] ??
  Object.keys(codexProfiles)[0] ??
  'gpt-5-codex'

// Automations always run unattended, so the headless run uses the same
// semantics as the 'auto' permission mode in the interactive backend:
// approvals are never requested and the sandbox is unrestricted.
const PERMISSION = 'auto' as const

export interface CodexOneShotOptions {
  prompt: string
  cwd: string
  model?: string | null
  reasoningEffort?: ReasoningEffort
  /** Abort the in-flight turn (interrupts the app-server turn and rejects). */
  abortSignal?: AbortSignal
  ephemeral?: boolean
  /** Run under Codex's read-only sandbox (the same policy plan mode uses).
   *  Approvals stay 'never'; the run just cannot write anywhere. */
  readOnly?: boolean
  onThreadStart?: (threadId: string) => void
  /** Extra tools to register for this run, on top of any enabled by `solusTools`. */
  dynamicTools?: CodexDynamicTool[]
  /** Register the full solus tool suite (works, tasks, artifacts,
   *  create_session) and handle their calls in-process for this run's thread.
   *  The automation CRUD/run tools are intentionally excluded (fork-bomb guard).
   *  Off by default so callers that want no tools (or their own) are unaffected. */
  solusTools?: boolean
  /** Receives this run's normalized events as they arrive. Headless callers that
   *  render a live transcript can subscribe without consuming the shared client. */
  onEvent?: (event: NormalizedEvent) => void
}

function toolArgsOf(params: any): Record<string, unknown> {
  let raw: unknown = params?.arguments ?? params?.input ?? params?.args ?? {}
  if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch { raw = {} } }
  return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
}

/**
 * In-process dispatch for a headless run's solus tool calls. Routes through the
 * same shared executor the interactive backend uses (executeCodexSolusTool) but
 * runs every tool with 'auto' semantics — no permission gate, no UI callbacks
 * (works persist to disk regardless). Only handles `item/tool/call` requests for
 * our own thread; the interactive backend skips these threads
 * (isHeadlessCodexThread) so responses are never doubled. Automation tools are
 * never registered here (fork-bomb guard), so any such call is rejected.
 */
async function handleHeadlessToolCall(
  client: ReturnType<typeof getCodexAppServerClient>,
  threadId: string,
  cwd: string,
  msg: JsonRpcRequest,
): Promise<void> {
  if (msg.method !== 'item/tool/call') return
  const params: any = msg.params || {}
  if (params.threadId !== threadId) return

  const toolName = String(
    typeof params?.tool === 'string' ? params.tool : params?.tool?.name ?? params?.name ?? params?.toolName ?? '',
  )
  const respond = (r: { ok: boolean; text: string }) =>
    client.respond(msg.id, { success: r.ok, contentItems: [{ type: 'inputText', text: r.text }] })

  const cls = classifyCodexSolusTool(toolName)
  if (!cls || cls.kind === 'automation') {
    respond({ ok: false, text: `Unsupported dynamic tool: ${toolName || '(unnamed)'}` })
    return
  }
  try {
    respond(await executeCodexSolusTool(toolName, toolArgsOf(params), { cwd, sessionId: threadId, agentProvider: 'codex' }))
  } catch (err: any) {
    log.error(`headless tool ${toolName} failed: ${String(err)}`)
    respond({ ok: false, text: `Tool error: ${String(err?.message ?? err)}` })
  }
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
 * With `solusTools`, it registers the full solus tool suite MINUS the automation
 * CRUD/run tools (the fork-bomb guard) and dispatches those calls in-process for
 * its own thread — the interactive CodexBackend skips headless threads so the
 * two server-request listeners on the shared client never both respond.
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

  // 'plan' is the mode whose sandbox is read-only; approvals are 'never' in
  // both modes, so a readOnly run stays unattended.
  const sandboxMode = opts.readOnly ? 'plan' : PERMISSION

  const dynamicTools = [
    ...(opts.solusTools ? codexSolusToolSchemas({ includeAutomationTools: false }) : []),
    ...(opts.dynamicTools ?? []),
  ]

  const startParams: CodexThreadStartParams = {
    model,
    cwd: opts.cwd,
    approvalPolicy: approvalPolicyFor(PERMISSION),
    baseInstructions: null,
    developerInstructions,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
    reasoning_effort: reasoningEffort,
    ephemeral: opts.ephemeral,
    ...(dynamicTools.length ? { dynamicTools } : {}),
  }
  const start = await client.request<CodexThreadStartResponse>('thread/start', startParams)
  const threadId = start.thread.id
  opts.onThreadStart?.(threadId)

  // Own this thread's solus tool calls: mark it headless (so the interactive
  // backend skips it) and attach an in-process dispatcher. Detached on settle.
  let detachToolHandler: (() => void) | null = null
  if (opts.solusTools) {
    registerHeadlessThread(threadId)
    const onToolCall = (msg: JsonRpcRequest) => { void handleHeadlessToolCall(client, threadId, opts.cwd, msg) }
    client.on('server-request', onToolCall)
    detachToolHandler = () => {
      client.off('server-request', onToolCall)
      unregisterHeadlessThread(threadId)
    }
  }

  let turnId = ''
  let settled = false
  const normalizer = new CodexTurnNormalizer({
    planMode: false,
    assembledAgentMessages: !!opts.onEvent,
  })

  try {
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
      for (const evt of normalizer.push({ method: msg.method, params })) {
        opts.onEvent?.(evt)
        if (evt.type === 'task_complete') done()
        else if (evt.type === 'error' && evt.isError) done(new Error(evt.message || 'Codex turn failed'))
      }
    }

    const onExit = () => done(new Error('Codex app-server exited before the turn completed'))

    // Cancellation: interrupt the turn (best-effort — only possible once it has
    // started) and reject so the caller finalizes the run as cancelled.
    const onAbort = () => {
      normalizer.interrupt()
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

    const turnParams: CodexTurnStartParams = {
        threadId,
        input: [{ type: 'text', text: opts.prompt, text_elements: [] }],
        cwd: opts.cwd,
        approvalPolicy: approvalPolicyFor(PERMISSION),
        sandboxPolicy: sandboxPolicyFor(sandboxMode),
        model,
        reasoning_effort: reasoningEffort,
        collaborationMode: {
          mode: 'default',
          settings: { model, reasoning_effort: reasoningEffort, developer_instructions: developerInstructions },
        },
      }
    client
      .request<CodexTurnStartResponse>('turn/start', turnParams)
      .then((turn) => {
        turnId = turn.turn.id
      })
      .catch((err) => {
        log.error(`turn/start failed: ${String(err)}`)
        done(err instanceof Error ? err : new Error(String(err)))
      })
  })
  } finally {
    // The turn is done — no more tool calls can arrive for this thread.
    detachToolHandler?.()
  }

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
