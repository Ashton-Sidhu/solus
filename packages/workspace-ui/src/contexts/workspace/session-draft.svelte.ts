import type { PrReviewContext, Prompt, RunConfig, Session, SessionSpec, TaskTarget } from '@solus/contracts/types'
import type { ModelOptionsByProvider } from '@solus/contracts/settings'
import { inheritRunConfig } from './run-config'
import { uuid } from '@solus/contracts/uuid'
import { makePrompt } from './session.factories'

/**
 * A prompt being written that has no session and no tab.
 *
 * It owns the whole answer to "what happens when I hit send": the text, where it
 * will run, and what it will belong to. `createSession` reads those three and
 * makes a session — which is the only way one comes into existence from the UI,
 * and the reason nothing lists a draft until then.
 *
 * Everything here is mutated in place. Pointing a draft at another task is
 * `draft.task = …`; changing its project is `draft.run.workingDirectory = …`.
 * There is no rebuild, so nothing has to be carried across one.
 */
export class SessionDraft {
  readonly id: string = uuid()
  prompt = $state<Prompt>(makePrompt())
  run: RunConfig
  task = $state<TaskTarget>({ kind: 'none' })
  boundWorkId = $state<string | null>(null)
  prReview = $state<PrReviewContext | null>(null)

  /**
   * @param defaults where a session starts when there is nothing to carry over.
   * @param inherit  the run config of the session this draft was opened from.
   *   `null` is the whole meaning of "start fresh" — there is no separate flag,
   *   because starting fresh *is* having nothing to inherit.
   */
  constructor(defaults: RunConfig, inherit?: RunConfig | null, remembered: ModelOptionsByProvider = {}) {
    this.run = $state(inheritRunConfig(defaults, inherit, remembered))
  }

  /** The plain, serializable shape — what persists and what dispatch consumes. */
  get spec(): SessionSpec {
    return {
      prompt: this.prompt,
      run: this.run,
      task: this.task,
      boundWorkId: this.boundWorkId,
      prReview: this.prReview,
    }
  }

  /**
   * Nothing has been written yet. This is the whole rule for whether a draft is
   * a *thing the user has*: an empty one earns no row in the sidebar and is
   * dropped the moment its pane shows something else, because a draft with no
   * words in it is indistinguishable from the next one the ⌘N would open.
   */
  get isEmpty(): boolean {
    return !this.prompt.text.trim() && this.prompt.attachments.length === 0
  }
}

/**
 * Which task a draft opened from a given entry point files under.
 * `rootTaskId` is the task the session on screen belongs to: a session
 * started from inside a task is more of that task, unless the entry point
 * asks for a fresh one. A session with nothing to join has no task.
 */
export function requestedTaskTarget(
  options: { freshTask?: boolean; withoutTask?: boolean; taskId?: string; taskRole?: 'lead' },
  rootTaskId: string | null,
): TaskTarget {
  if (options.withoutTask) return { kind: 'none' }
  if (options.taskId) {
    return options.taskRole
      ? { kind: 'existing', taskId: options.taskId, role: options.taskRole }
      : { kind: 'existing', taskId: options.taskId }
  }
  if (!options.freshTask && rootTaskId) return { kind: 'existing', taskId: rootTaskId }
  return { kind: 'none' }
}

/** The task named, when the target names an existing one. */
export function existingTaskId(task: TaskTarget): string | null {
  return task.kind === 'existing' ? task.taskId : null
}

/** `lead` when the session is to be its task's lead; undefined for an attempt. */
export function taskRoleOf(task: TaskTarget): 'lead' | undefined {
  return task.kind === 'existing' ? task.role : undefined
}

/** Read the field a persisted tab stores back into a target. */
export function taskTargetFrom(fields: { pendingTaskId?: string | null }): TaskTarget {
  return fields.pendingTaskId ? { kind: 'existing', taskId: fields.pendingTaskId } : { kind: 'none' }
}

/**
 * The task a started session's prompts file under. The durable link is the
 * answer once there is one: the agent can move the session to another task
 * mid-turn, and the binding recorded at first dispatch would otherwise send
 * every later prompt back to the task the session left. Before the link
 * lands, the binding is all there is.
 */
export function ownedTaskId(tasksStore: { taskForSession(sessionId: string | null | undefined): { id: string } | null }, session: Session): string | undefined {
  return tasksStore.taskForSession(session.id)?.id
    ?? existingTaskId(session.task)
    ?? undefined
}
