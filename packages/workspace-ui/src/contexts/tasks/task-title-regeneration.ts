import type { Task } from '@solus/contracts/task-types'

/** A task description is the stable source for a new name. Tasks without one
 * still need the action, so their current name is the only useful fallback. */
export function taskTitleRegenerationInput(task: Pick<Task, 'body' | 'title'>): string {
  return task.body.trim() || task.title.trim()
}
