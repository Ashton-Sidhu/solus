import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClaudeAgent, SAFE_TOOLS } from '../agents/claude/claude-agent'
import { runCodexOneShot } from '../agents/codex/codex-oneshot'
import { createSolusMcpServer } from '../folio/work-tools'
import { buildSystemPrompt } from '../agents/system-hint'
import { createWorktree } from '../git/worktree-manager'
import { isWorkspacePath } from '../workspace'
import { createLogger } from '../logger'
import { startRun, finishRun } from './automations-store'
import { composeAutomationPrompt } from './compose-prompt'
import type { Automation, AutomationRun, AgentId, ReasoningEffort } from '../../shared/types'

const log = createLogger('automations', 'automation-runner.ts')

/**
 * Dispatches an automation prompt into an existing chat session (in-thread,
 * full context). Injected by the server layer so the runner stays decoupled
 * from the ControlPlane. Null until wired (the headless path always works).
 */
export type AutomationSessionDispatcher = (opts: {
  agentSessionId: string
  prompt: string
  automationId: string
  automationName: string
  /** Run config used to resume the session when it isn't resident in memory
   *  (cold start from disk), taken from the automation's own action. */
  fallback?: { provider: AgentId; model: string | null; reasoningEffort: ReasoningEffort; cwd: string }
}) => Promise<void>

let sessionDispatcher: AutomationSessionDispatcher | null = null
export function setAutomationSessionDispatcher(dispatcher: AutomationSessionDispatcher): void {
  sessionDispatcher = dispatcher
}

// A single session-agnostic Claude agent drives every Claude-backed run.
// ClaudeAgent is explicitly designed for background tasks (no IpcContext, no
// permission UI). The Codex path uses runCodexOneShot, which talks to the
// shared app-server client directly.
const claudeAgent = new ClaudeAgent()

// In-flight runs keyed by runId. Each entry holds an aborter (provider-specific)
// and a `done` promise that settles once the run has been finalized in the store,
// so a caller can cancel and await the run reaching its terminal 'cancelled'
// state before reading it back.
interface ActiveRun {
  automationId: string
  abort: AbortController
  cancelled: boolean
  done: Promise<void>
}
const activeRuns = new Map<string, ActiveRun>()

// Automations that passed the overlap check but whose run record hasn't landed
// yet (startRun is async). Claimed synchronously so two near-simultaneous
// triggers can't both slip past hasActiveRun.
const pendingTriggers = new Set<string>()

/** Whether an automation has a run in flight. Used by the scheduler, the tools,
 *  and the RPC handler to refuse overlapping runs of the same automation. */
export function hasActiveRun(automationId: string): boolean {
  if (pendingTriggers.has(automationId)) return true
  for (const entry of activeRuns.values()) {
    if (entry.automationId === automationId) return true
  }
  return false
}

/** Expand a leading `~` — the default cwd when no project is active is the
 *  literal string '~', which Node would treat as a relative path. */
function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

function prependAutomationRunContext(prompt: string, run: AutomationRun): string {
  const header = [
    'This is an automation run.',
    `Automation run id: ${run.id}`,
    `Automation started at: ${run.startedAt}`,
  ].join('\n')

  return prompt ? `${header}\n\n${prompt}` : header
}

/**
 * Kick off an automation run. Records the run immediately (status 'running'),
 * executes the agent in the background, and returns the run handle so the caller
 * gets a runId without blocking. Results land in the store when the run settles
 * and are read back via the run-result tools.
 *
 * Recursion guard: the spawned run gets the full `solus` tool suite (works,
 * tasks, review ledger, artifacts, create_session) EXCEPT the automation
 * CRUD/run tools, on both providers — so an automation cannot create or trigger
 * more automations. This is the fork-bomb guard; everything else is available.
 */
export async function triggerAutomationRun(automation: Automation): Promise<AutomationRun> {
  // One run per automation at a time. Overlapping unattended runs of the same
  // automation would race on the same working directory; callers (scheduler,
  // tools, RPC) check hasActiveRun first — this throw is the backstop.
  if (hasActiveRun(automation.id)) {
    throw new Error(`Automation "${automation.name}" already has a run in progress.`)
  }
  pendingTriggers.add(automation.id)
  let run: AutomationRun
  try {
    run = await startRun(automation.id)
  } finally {
    pendingTriggers.delete(automation.id)
  }
  const entry: ActiveRun = {
    automationId: automation.id,
    abort: new AbortController(),
    cancelled: false,
    done: Promise.resolve(),
  }
  activeRuns.set(run.id, entry)
  entry.done = executeRun(automation, run, entry).finally(() => activeRuns.delete(run.id))
  return run
}

/**
 * Cancel any in-flight run(s) for an automation: abort the underlying agent and
 * wait for the run to be finalized as 'cancelled'. Returns false when nothing
 * was running. Resolving only after the run settles lets the caller refresh and
 * see the terminal status immediately.
 */
export async function cancelAutomationRun(automationId: string): Promise<boolean> {
  const entries = [...activeRuns.values()].filter((e) => e.automationId === automationId)
  if (entries.length === 0) return false
  for (const entry of entries) {
    entry.cancelled = true
    entry.abort.abort()
  }
  await Promise.all(entries.map((e) => e.done.catch(() => {})))
  return true
}

async function executeRun(automation: Automation, run: AutomationRun, entry: ActiveRun): Promise<void> {
  const { action } = automation
  const runId = run.id

  try {
    // Session-bound ("heartbeat") automation: dispatch the prompt into the live
    // chat thread it was created in, preserving conversation context, instead of
    // a headless one-shot. The agent's reply streams into that session's UI; we
    // only record that the run was handed off (its output lives in the thread).
    if (action.sessionId) {
      if (!sessionDispatcher) throw new Error('In-session automations require the app to be running with an active control plane.')
      const prompt = await composeAutomationPrompt(action)
      await sessionDispatcher({
        agentSessionId: action.sessionId,
        prompt,
        automationId: automation.id,
        automationName: automation.name,
        fallback: {
          provider: action.agentProvider,
          model: action.modelId,
          reasoningEffort: action.reasoningEffort,
          cwd: action.cwd,
        },
      })
      if (entry.cancelled) {
        await finishRun(automation.id, runId, { status: 'cancelled' })
        log.info(`Automation ${automation.id} run ${runId} cancelled`)
        return
      }
      // 'dispatched', not 'succeeded': the prompt was handed to the thread, but
      // the thread's turn owns the real outcome — don't claim a success we
      // never observed.
      await finishRun(automation.id, runId, { status: 'dispatched', output: `Dispatched into session ${action.sessionId}; the outcome lives in that chat thread.`, agentSessionId: action.sessionId })
      log.info(`Automation ${automation.id} run ${runId} dispatched into session ${action.sessionId}`)
      return
    }

    // When the automation opts into a worktree, branch off `cwd` and run there
    // so unattended changes land on an isolated branch instead of the working
    // directory. A failure here surfaces as a failed run rather than silently
    // mutating the user's tree. No model-backed namer is available in the
    // headless runner, so the branch name falls back to a prompt slug.
    let cwd = expandHome(action.cwd)
    let branch: string | undefined
    if (action.useWorktree) {
      const gitContext = await createWorktree(cwd, action.prompt)
      branch = gitContext.branch
      cwd = gitContext.worktreePath ?? cwd
    }

    // Expand any plan/work references into context blocks. Files (@) and skills
    // (/) stay inline in the prompt — the provider resolves those natively.
    const prompt = prependAutomationRunContext(await composeAutomationPrompt(action), run)

    // Automations run unattended → 'auto' permission semantics on both providers.
    const { text, sessionId } =
      action.agentProvider === 'codex'
        ? await runCodexOneShot({
            prompt,
            cwd,
            model: action.modelId,
            reasoningEffort: action.reasoningEffort,
            abortSignal: entry.abort.signal,
            // Full solus tool suite minus the automation tools (fork-bomb guard).
            solusTools: true,
          })
        : await runViaClaude(action, cwd, prompt, entry.abort)

    // A cancelled run that still returned (Claude resolves on SIGINT rather than
    // throwing) is terminal as 'cancelled', not a partial success.
    if (entry.cancelled) {
      await finishRun(automation.id, runId, { status: 'cancelled', output: text, agentSessionId: sessionId, branch })
      log.info(`Automation ${automation.id} run ${runId} cancelled`)
      return
    }

    await finishRun(automation.id, runId, {
      status: 'succeeded',
      output: text,
      agentSessionId: sessionId,
      branch,
    })
    log.info(`Automation ${automation.id} run ${runId} succeeded (session ${sessionId})`)
  } catch (err: any) {
    if (entry.cancelled) {
      await finishRun(automation.id, runId, { status: 'cancelled' })
      log.info(`Automation ${automation.id} run ${runId} cancelled`)
      return
    }
    await finishRun(automation.id, runId, {
      status: 'failed',
      error: String(err?.message ?? err),
    })
    log.error(`Automation ${automation.id} run ${runId} failed: ${String(err)}`)
  }
}

// The solus tools a headless run may call — the full suite minus the automation
// CRUD/run tools (which are never registered on the headless MCP server, per the
// fork-bomb guard in createSolusMcpServer). Reads, writes, and create_session all
// run unattended under 'auto' permissions.
const HEADLESS_SOLUS_TOOLS = [
  'mcp__solus__list_works',
  'mcp__solus__read_work',
  'mcp__solus__create_work',
  'mcp__solus__update_work',
  'mcp__solus__render_artifact',
  'mcp__solus__record_change',
  'mcp__solus__get_task',
  'mcp__solus__list_tasks',
  'mcp__solus__update_task_status',
  'mcp__solus__create_task',
  'mcp__solus__comment_task',
  'mcp__solus__link_task_session',
  'mcp__solus__create_session',
  'mcp__solus__list_sessions',
  'mcp__solus__read_session',
  'mcp__solus__prompt_session',
  'mcp__solus__stop_session',
  'mcp__solus__list_prs',
  'mcp__solus__read_pr',
  'mcp__solus__list_pr_threads',
  'mcp__solus__reply_pr_thread',
  'mcp__solus__resolve_pr_thread',
  'mcp__solus__submit_pr_review',
]

async function runViaClaude(action: Automation['action'], cwd: string, prompt: string, abortController: AbortController) {
  const general = isWorkspacePath(cwd)

  // The run's session id lands at session_init (before any tool runs); resolve it
  // lazily so create_work/record_change can stamp the correct origin session.
  let sessionId: string | null = null

  // Full solus suite (works, tasks, review ledger, artifacts, create_session)
  // minus automation tools. Callbacks are omitted — a headless run has no
  // conversation to stream cards into, and works persist to disk regardless.
  const solusServer = createSolusMcpServer({
    createCtx: {
      agentProvider: 'claude-code',
      cwd,
      sessionId: () => sessionId ?? undefined,
    },
    includeAutomationTools: false,
  })

  const { text, result } = await claudeAgent.runOneShot({
    prompt,
    cwd,
    model: action.modelId ?? undefined,
    reasoningEffort: action.reasoningEffort,
    permissionMode: 'auto',
    abortController,
    mcpServers: { solus: solusServer },
    allowedTools: [...SAFE_TOOLS, ...HEADLESS_SOLUS_TOOLS],
    onSessionInit: async (sid) => { sessionId = sid },
    systemPromptAppend: buildSystemPrompt({
      agent: 'claude',
      general,
    }),
  })
  return { text, sessionId: result.sessionId }
}
