import { appendFile, mkdir, stat } from 'fs/promises'
import { dirname, join } from 'path'
import { createLogger } from '../../logger'
import { linkTaskSession } from '../../data/tasks/task-attachments'
import { taskIdForSession } from '../../data/tasks/task-sessions'
import { loadTask } from '../../data/tasks/task-store'
import { formatTaskContext } from '../../data/tasks/task-context'
import { DEFAULT_EXECUTION_PREFERENCES, type ExecutionPreferences } from '@solus/contracts/settings'
import { ANY_ORGANIZATION, LOCAL_ORGANIZATION_ID } from '../../admission/principal'
import { attributionOf } from '../../admission/actor'
import { hostAttribution } from '../../data/stored-attribution'
import { setForeignTaskSnapshot } from '../../data/tasks/foreign-tasks'
import type { TaskSnapshot } from '@solus/contracts/task-types'
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
    return titledTask(options.taskId)
  }
  try {
    const taskId = await taskIdForSession(ANY_ORGANIZATION, run.sessionId)
    return taskId ? await titledTask(taskId) : null
  } catch {
    return null
  }
}

/** The id of a task, and its title when this host has a copy of it. */
async function titledTask(taskId: string): Promise<{ id: string; title?: string }> {
  const task = await loadTask(taskId).catch(() => null)
  return task ? { id: taskId, title: task.title } : { id: taskId }
}

export async function linkPreparedTask(run: SessionRunRequest, sessionId: string): Promise<void> {
  const taskId = run.options.taskId
  if (!taskId) return
  // A shipped snapshot marks the task as foreign: another host holds its
  // attachments, and the dispatching client writes this link there itself.
  if (run.options.taskSnapshot) return
  try {
    // The link takes the organization of the session; Local is for a session with no record yet.
    await linkTaskSession(LOCAL_ORGANIZATION_ID, taskId, sessionId, 'working', {
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

 */
export async function taskSystemContext(
  taskId: string,
  shipped: TaskSnapshot | null,
  sessionId: string,
  preferences: ExecutionPreferences | undefined,
): Promise<string> {
  const lifecyclePolicy = preferences?.agentTaskLifecyclePolicy ?? DEFAULT_EXECUTION_PREFERENCES.agentTaskLifecyclePolicy
  if (shipped && shipped.details.task.id === taskId) {
    setForeignTaskSnapshot(sessionId, shipped)
    return formatTaskContext(shipped.details.task, lifecyclePolicy)
  }
  setForeignTaskSnapshot(sessionId, null)
  try {
    const task = await loadTask(taskId)
    if (!task) throw new Error('this host has no copy of the task')
    return formatTaskContext(task, lifecyclePolicy)
  } catch (err) {
    // The host has no copy when the provider did not answer the read at the
    // bind. The id and the contract still reach the agent; read_task asks the
    // provider again and says what failed.
    log.warn('task_context_injection_failed', { taskId, sessionId, shippedSnapshot: !!shipped, error: String(err) })
    return formatTaskContext({ id: taskId }, lifecyclePolicy)
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
