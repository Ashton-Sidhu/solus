import type { Prompt, RunConfig, SessionSpec, TaskTarget } from '../../../shared/types'
import { inheritRunConfig } from './run-config'
import { uuid } from '../../../shared/uuid'
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
  run = $state<RunConfig>() as RunConfig
  task = $state<TaskTarget>({ kind: 'new' })

  /**
   * @param defaults where a session starts when there is nothing to carry over.
   * @param inherit  the run config of the session this draft was opened from.
   *   `null` is the whole meaning of "start fresh" — there is no separate flag,
   *   because starting fresh *is* having nothing to inherit.
   * @param worktreeEnabled the app-level preference for starting new sessions
   *   in their own worktree. It is a setting, not a property of any run, so it
   *   is handed in rather than read back off one.
   */
  constructor(defaults: RunConfig, inherit?: RunConfig | null, worktreeEnabled = false) {
    this.run = inheritRunConfig(defaults, inherit, { worktreeEnabled })
  }

  /** The plain, serializable shape — what persists and what dispatch consumes. */
  get spec(): SessionSpec {
    return { prompt: this.prompt, run: this.run, task: this.task }
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
 * `rootTaskId` is the task the session on screen belongs to — the default,
 * since a session started from inside a task is usually more of that task.
 */
export function requestedTaskTarget(
  options: { freshTask?: boolean; withoutTask?: boolean; taskId?: string },
  rootTaskId: string | null,
): TaskTarget {
  if (options.withoutTask) return { kind: 'none' }
  if (options.taskId) return { kind: 'existing', taskId: options.taskId }
  if (!options.freshTask && rootTaskId) return { kind: 'existing', taskId: rootTaskId }
  return { kind: 'new' }
}

/** The task named, when the target names an existing one. */
export function existingTaskId(task: TaskTarget): string | null {
  return task.kind === 'existing' ? task.taskId : null
}

/** The task a newly minted one will hang under, when it has a parent. */
export function parentTaskId(task: TaskTarget): string | null {
  return task.kind === 'new' ? task.parentTaskId ?? null : null
}

/** Read the three fields a persisted tab still stores back into a target. */
export function taskTargetFrom(fields: {
  pendingTaskId?: string | null
  pendingParentTaskId?: string | null
  taskCreationDisabled?: boolean
}): TaskTarget {
  if (fields.pendingTaskId) return { kind: 'existing', taskId: fields.pendingTaskId }
  if (fields.taskCreationDisabled) return { kind: 'none' }
  return fields.pendingParentTaskId
    ? { kind: 'new', parentTaskId: fields.pendingParentTaskId }
    : { kind: 'new' }
}

/** The pre-`TaskTarget` encoding, for the persisted tab fields that still carry it. */
export function taskTargetFields(task: TaskTarget): {
  pendingTaskId: string | null
  pendingParentTaskId: string | null
  taskCreationDisabled: boolean
} {
  return {
    pendingTaskId: task.kind === 'existing' ? task.taskId : null,
    pendingParentTaskId: task.kind === 'new' ? task.parentTaskId ?? null : null,
    taskCreationDisabled: task.kind === 'none',
  }
}
