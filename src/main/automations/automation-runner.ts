import { homedir } from 'node:os'
import { join } from 'node:path'
import { createWorktree } from '../git/worktree-manager'
import { createLogger } from '../logger'
import { startRun, attachRunSession, finishRun } from './automations-store'
import { composeAutomationPrompt } from './compose-prompt'
import type { Automation, AutomationRun, AgentId, GitCheckout, ReasoningEffort } from '../../shared/types'

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

/** Starts an isolated automation through the normal ControlPlane session
 *  lifecycle. Resolves at session_init with a completion promise that continues
 *  tracking the same backend run. */
export type AutomationBackgroundSessionDispatcher = (opts: {
  prompt: string
  automationId: string
  automationName: string
  provider: AgentId
  modelId: string | null
  reasoningEffort: ReasoningEffort
  cwd: string
  gitContext?: GitCheckout | null
  abortSignal?: AbortSignal
}) => Promise<{ agentSessionId: string; done: Promise<{ output?: string }> }>

let backgroundSessionDispatcher: AutomationBackgroundSessionDispatcher | null = null
export function setAutomationBackgroundSessionDispatcher(dispatcher: AutomationBackgroundSessionDispatcher): void {
  backgroundSessionDispatcher = dispatcher
}

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
 * tasks, artifacts, create_session) EXCEPT the automation
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
  let agentSessionId: string | undefined
  let branch: string | undefined

  try {
    // Session-bound ("heartbeat") automation: dispatch the prompt into the live
    // chat thread it was created in, preserving conversation context, instead of
    // a headless one-shot. The agent's reply streams into that session's UI; we
    // only record that the run was handed off (its output lives in the thread).
    if (action.sessionId) {
      if (!sessionDispatcher) throw new Error('In-session automations require the app to be running with an active control plane.')
      agentSessionId = action.sessionId
      await attachRunSession(automation.id, runId, action.sessionId)
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
    const cwd = expandHome(action.cwd)
    let gitContext: GitCheckout | null = null
    if (action.useWorktree) {
      gitContext = await createWorktree(cwd, action.prompt)
      if (!gitContext.branch) throw new Error('Created automation worktree has no branch')
      branch = gitContext.branch
    }

    // Expand any plan/work references into context blocks. Files (@) and skills
    // (/) stay inline in the prompt — the provider resolves those natively.
    const prompt = prependAutomationRunContext(await composeAutomationPrompt(action), run)

    if (!backgroundSessionDispatcher) {
      throw new Error('Isolated automations require the app to be running with an active control plane.')
    }
    const session = await backgroundSessionDispatcher({
      prompt,
      automationId: automation.id,
      automationName: automation.name,
      provider: action.agentProvider,
      modelId: action.modelId,
      reasoningEffort: action.reasoningEffort,
      cwd,
      gitContext,
      abortSignal: entry.abort.signal,
    })
    agentSessionId = session.agentSessionId
    await attachRunSession(automation.id, runId, agentSessionId, branch, gitContext?.worktreePath)
    const { output } = await session.done

    // A cancelled run that still resolved is terminal as 'cancelled', not a
    // partial success.
    if (entry.cancelled) {
      await finishRun(automation.id, runId, { status: 'cancelled', output, agentSessionId, branch })
      log.info(`Automation ${automation.id} run ${runId} cancelled`)
      return
    }

    await finishRun(automation.id, runId, {
      status: 'succeeded',
      output,
      agentSessionId,
      branch,
    })
    log.info(`Automation ${automation.id} run ${runId} succeeded (session ${agentSessionId})`)
  } catch (err: any) {
    if (entry.cancelled) {
      await finishRun(automation.id, runId, { status: 'cancelled', agentSessionId, branch })
      log.info(`Automation ${automation.id} run ${runId} cancelled`)
      return
    }
    await finishRun(automation.id, runId, {
      status: 'failed',
      agentSessionId,
      branch,
      error: String(err?.message ?? err),
    })
    log.error(`Automation ${automation.id} run ${runId} failed: ${String(err)}`)
  }
}
