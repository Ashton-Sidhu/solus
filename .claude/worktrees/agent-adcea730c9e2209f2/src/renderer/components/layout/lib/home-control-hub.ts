import type { Automation, AutomationRun } from '../../../../shared/types'
import type { Task } from '../../../../shared/task-types'

// Pure selectors + formatting for the New Tab "control hub" — automation activity
// and task glance. Kept out of NewTabHome.svelte so the bucketing/sorting is easy
// to read and reuse across the hub's layout variants (per the renderer hierarchy
// rule: feature-private, non-reactive logic lives in a sibling lib).

/**
 * Automations worth a glance on the home: anything that has actually run (or is
 * running now), most-recent activity first. Answers "did my automations run, and
 * when?" — the gap the hub closes. Idle/never-run automations stay on the full
 * Automations page.
 */
export function recentAutomationActivity(items: Automation[], limit: number): Automation[] {
  return items
    .filter((a) => !!a.lastRunAt || a.lastRunStatus === 'running')
    .sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''))
    .slice(0, limit)
}

/** Newest run from an automation's (unordered) history, by start time. */
export function latestRun(runs: AutomationRun[] | undefined): AutomationRun | undefined {
  if (!runs || runs.length === 0) return undefined
  return [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
}

/** One-line preview of a run's result — the assistant output, or the error text
 *  on a failed run. Collapsed whitespace so it fits a single row. */
export function runPreview(run: AutomationRun | undefined): string {
  if (!run) return ''
  const raw = run.status === 'failed' ? run.error ?? run.output ?? '' : run.output ?? ''
  return raw.replace(/\s+/g, ' ').trim()
}

const STATUS_RANK: Record<Task['status'], number> = { in_progress: 0, open: 1, done: 2 }
const PRIORITY_RANK: Record<NonNullable<Task['priority']>, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
}

/** "What's next": in-progress before open, then by priority, then most-recently
 *  touched. Done tasks drop out — the hub is about pending work. */
export function nextTasks(tasks: Task[], limit: number): Task[] {
  return tasks
    .filter((t) => t.status !== 'done')
    .sort((a, b) => {
      const s = STATUS_RANK[a.status] - STATUS_RANK[b.status]
      if (s) return s
      const p = PRIORITY_RANK[a.priority ?? 'low'] - PRIORITY_RANK[b.priority ?? 'low']
      if (p) return p
      return b.updatedAt.localeCompare(a.updatedAt)
    })
    .slice(0, limit)
}

export function taskCounts(tasks: Task[]): { open: number; inProgress: number } {
  let open = 0
  let inProgress = 0
  for (const t of tasks) {
    if (t.status === 'open') open++
    else if (t.status === 'in_progress') inProgress++
  }
  return { open, inProgress }
}
