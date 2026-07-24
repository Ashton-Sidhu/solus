import type { Automation, AutomationRun } from '../../../../shared/types'

// Pure selectors + formatting for the New Tab automation activity. Kept out of
// NewTabHome.svelte so the bucketing/sorting is easy to read and reuse across the
// hub's layout variants (per the renderer hierarchy rule: feature-private,
// non-reactive logic lives in a sibling lib).

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
