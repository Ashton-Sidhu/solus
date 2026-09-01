import { Camera, GitPullRequest, ListChecks } from '@lucide/svelte'
import type { BrowserEvidenceOptions, BrowserEvidenceTarget } from '@solus/contracts/browser-types'
import type { Task } from '@solus/contracts/task-types'

/**
 * What the capture button offers, and what each choice means.
 *
 * The rule is that nothing is offered that cannot work: a pull request row
 * appears only where the host found one for this page's branch, and a task row
 * only for tasks that belong to the project the page is serving. An action that
 * fails after it was offered is worse than an action that was never there.
 */

/** Lucide icon component, typed off a real icon — same pattern as `page-nav.ts`. */
type EvidenceIcon = typeof Camera

export interface EvidenceChoice {
  id: string
  label: string
  detail?: string
  /** The glyph that says at a glance what kind of destination this is. */
  icon: EvidenceIcon
  /** Absent means "capture it and keep it", the destination-free option. */
  target?: BrowserEvidenceTarget
}

/** Tasks worth filing against: this project's, still being worked. A done task
 *  is not where the evidence for the current change belongs. */
export function attachableTasks(tasks: Task[], worktreePath: string | undefined): Task[] {
  const open = tasks.filter((task) => task.status === 'todo' || task.status === 'in_progress' || task.status === 'in_review')
  if (!worktreePath) return open
  // A worktree lives under its project, so the project key is a prefix of the
  // page's own path whenever the two belong together.
  const scoped = open.filter((task) => !!task.projectKey && worktreePath.startsWith(task.projectKey))
  return scoped.length ? scoped : open
}

export function evidenceChoices(
  options: BrowserEvidenceOptions,
  tasks: Task[],
  cwd: string | undefined,
): EvidenceChoice[] {
  // "Capture only" leads: it is the one choice that always works and never goes
  // stale, so it is the reliable default the eye lands on first. The filing
  // destinations follow it.
  const choices: EvidenceChoice[] = [
    { id: 'store', label: 'Capture only', detail: 'Keeps the image without filing it', icon: Camera },
  ]
  const checkout = options.worktreePath ?? cwd
  if (options.pullRequest && checkout) {
    choices.push({
      id: `pr-${options.pullRequest.number}`,
      label: `Attach to pull request #${options.pullRequest.number}`,
      detail: options.branch,
      icon: GitPullRequest,
      target: { kind: 'pr', number: options.pullRequest.number, cwd: checkout },
    })
  }
  for (const task of attachableTasks(tasks, options.worktreePath)) {
    choices.push({
      id: `task-${task.id}`,
      label: `Attach to ${task.title}`,
      detail: task.status.replace('_', ' '),
      icon: ListChecks,
      target: { kind: 'task', taskId: task.id },
    })
  }
  return choices
}
