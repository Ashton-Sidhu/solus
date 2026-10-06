import { appendFile, mkdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { createLogger } from '../../logger'
import { taskWithAttempts } from '../../data/tasks/task-sessions'
import { Task } from '../../data/tasks/task'
import { formatTaskContext } from '../../data/tasks/task-context'
import { DEFAULT_EXECUTION_PREFERENCES, type ExecutionPreferences } from '@solus/contracts/settings'
import { ANY_ORGANIZATION } from '../../admission/principal'
import { attributionOf } from '../../admission/actor'
import { hostAttribution } from '../../data/stored-attribution'
import { setForeignTaskSnapshot } from '../../data/tasks/foreign-tasks'
import type { TaskSessionLink, TaskSessionRole, TaskSnapshot } from '@solus/contracts/task-types'
import type { AgentId, PromptOptions, SessionRunInput } from '@solus/contracts/types'
import { solusDir } from '../../platform/paths'
import type { SessionRunRequest } from '../session-runtime'

const log = createLogger('SessionRuntime', 'run-task-context.ts')

const IS_DEV_MODE = Boolean(process.env.ELECTRON_RENDERER_URL)

const NEW_SESSION_PROMPTS_CSV = join(solusDir(), 'new-session-prompts.csv')

const NEW_SESSION_PROMPTS_CSV_HEADER = 'input_prompt,model,agent_provider,reasoning_level\n'

function csvCell(value: string | null | undefined): string {
  const text = value ?? ''
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

/**
 * The task the turn ran under, id and title, for telemetry.
 *
 * Only a first dispatch carries a task in its options; every later turn in
 * the same session resumes a provider conversation and arrives with none. It
 * is still the same task's work, so the session's own binding answers for it
 * — otherwise the great majority of turns record no task at all and "how much
 * did this task cost" cannot be asked.
 *
 * The id survives a title that cannot be read: a task shipped from another
 * host without a snapshot is still the id every span should carry. A missing
 * task never blocks the turn.
 */
export async function taskOfTurn(
  run: SessionRunRequest,
): Promise<{ id: string; title?: string } | null> {
  const { options } = run
  if (options.taskSnapshot) {
    const task = options.taskSnapshot.details.task
    return { id: task.id, title: task.title }
  }
  if (options.taskId) {
    try {
      return { id: options.taskId, title: (await Task.byId(ANY_ORGANIZATION, options.taskId)).title }
    } catch {
      return { id: options.taskId }
    }
  }
  const agentSessionId = run.input.agentSessionId
  if (!agentSessionId) return null
  try {
    const task = await Task.forSession(ANY_ORGANIZATION, agentSessionId)
    return task ? { id: task.id, title: task.title } : null
  } catch {
    return null
  }
}

export async function linkPreparedTask(run: SessionRunRequest, sessionId: string): Promise<void> {
  const taskId = run.options.taskId
  if (!taskId) return
  // A shipped snapshot marks the task as foreign — its row lives on another
  // host, where the dispatching client writes this link itself.
  if (run.options.taskSnapshot) return
  try {
    await (await Task.byId(ANY_ORGANIZATION, taskId)).linkSession(sessionId, run.options.taskRole ?? 'working', {
      originSessionId: sessionId,
      // A run with no actor is the host's own: its person started it.
      startedBy: run.actor ? attributionOf(run.actor) : hostAttribution(),
    })
  } catch (err) {
    log.error('task_session_link_failed', { taskId, sessionId, error: String(err) })
  }
}

/**
 * The packet appended to the run's system prompt: the task's id and title and
 * the work contract. The agent reads the task itself with `read_task`. When
 * the task is foreign, the snapshot the dispatching client shipped is held
 * for the session so `read_task` (and op overlays) answer from it.
 *
 * The session's role decides whether the lead contract is appended. On the
 * first prompt the link is not written yet, so the role rides the prompt;
 * on every later turn the session's own link answers.
 */
export async function taskSystemContext(
  taskId: string,
  shipped: TaskSnapshot | null,
  sessionId: string,
  promptRole: 'lead' | undefined,
  preferences: ExecutionPreferences | undefined,
): Promise<string> {
  // The person's lead and lifecycle preferences.
  const lifecyclePolicy = preferences?.agentTaskLifecyclePolicy ?? DEFAULT_EXECUTION_PREFERENCES.agentTaskLifecyclePolicy
  const lead = {
    leadInstructions: preferences?.leadInstructions ?? DEFAULT_EXECUTION_PREFERENCES.leadInstructions,
    workerModel: preferences?.workerModel ?? DEFAULT_EXECUTION_PREFERENCES.workerModel,
  }
  const roleOf = (sessions: readonly TaskSessionLink[]): TaskSessionRole =>
    promptRole ?? sessions.find((link) => link.sessionId === sessionId)?.role ?? 'working'
  if (shipped && shipped.details.task.id === taskId) {
    setForeignTaskSnapshot(sessionId, shipped)
    return formatTaskContext(shipped.details.task, lifecyclePolicy, roleOf(shipped.sessions), lead)
  }
  setForeignTaskSnapshot(sessionId, null)
  try {
    const local = await taskWithAttempts(ANY_ORGANIZATION, taskId)
    if (!local) throw new Error('task not found')
    return formatTaskContext(local.task, lifecyclePolicy, roleOf(local.attempts), lead)
  } catch (err) {
    // On a dispatch this once failed silently — the task's row lives on
    // another host. A taskId this host cannot read now always names a defect:
    // either the snapshot was not shipped or the local row is gone. The id
    // and the contract still reach the agent; read_task will say what failed.
    log.warn('task_context_injection_failed', { taskId, sessionId, shippedSnapshot: !!shipped, error: String(err) })
    return formatTaskContext({ id: taskId }, lifecyclePolicy, promptRole ?? 'working', lead)
  }
}

export async function logNewSessionPrompt(input: SessionRunInput, options: PromptOptions, provider: AgentId): Promise<void> {
  if (!IS_DEV_MODE) return

  try {
    const row = [
      options.displayPrompt ?? options.prompt,
      input.model,
      provider,
      input.reasoningEffort,
    ].map(csvCell).join(',')

    await mkdir(dirname(NEW_SESSION_PROMPTS_CSV), { recursive: true })
    let prefix = ''
    try {
      const existing = await stat(NEW_SESSION_PROMPTS_CSV)
      if (existing.size === 0) prefix = NEW_SESSION_PROMPTS_CSV_HEADER
    } catch {
      prefix = NEW_SESSION_PROMPTS_CSV_HEADER
    }
    await appendFile(NEW_SESSION_PROMPTS_CSV, `${prefix}${row}\n`, 'utf8')
  } catch (err) {
    log.warn('new_session_prompt_csv_failed', { error: String(err) })
  }
}
