// Pure helpers for the Tasks page: what the search matches, and what the page
// says about the task sources it shows.
import type { Task, TaskSourceState } from '@solus/contracts/task-types'
import { taskSourceProvider } from '@solus/contracts/task-sources'

/** Whether a task matches the text in the page's search box. */
export function matchesTaskQuery(task: Pick<Task, 'title' | 'reference' | 'labels'>, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${task.title} ${task.reference ?? ''} ${task.labels.join(' ')}`.toLowerCase().includes(needle)
}

/**
 * The tasks a search shows: the listed tasks that match, then the tasks that
 * only the provider found. A truncated source did not list every task, so a
 * match can come from the provider alone; a task that both have shows once.
 */
export function withProviderMatches<T extends { id: string }>(listed: readonly T[], providerMatches: readonly T[]): T[] {
  const ids = new Set(listed.map((task) => task.id))
  return [...listed, ...providerMatches.filter((task) => !ids.has(task.id))]
}

/**
 * The tasks that one of the person's sources lists now. The host keeps the
 * tasks of a source that the person removed until its next read, so the page
 * never shows a task only because the host still holds it.
 */
export function tasksOfSources<T extends Pick<Task, 'placements'>>(tasks: readonly T[], sourceKeys: ReadonlySet<string>): T[] {
  return tasks.filter((task) => task.placements.some((placement) => sourceKeys.has(placement.sourceKey)))
}

/** How many of the tasks each source lists, by source key. */
export function taskCountsBySource(tasks: readonly Pick<Task, 'placements'>[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const task of tasks) {
    for (const placement of task.placements) counts.set(placement.sourceKey, (counts.get(placement.sourceKey) ?? 0) + 1)
  }
  return counts
}

/** When the tasks on screen were last read, and whether they are an old copy. */
export interface SourcesSyncState {
  /** The oldest last read among the sources: the page is only as fresh as that. */
  syncedAt: number | null
  /** A source cannot be read now, so its tasks are the host's last copy. */
  fromCache: boolean
}

export function sourcesSyncState(sources: readonly Pick<TaskSourceState, 'fetchedAt' | 'health'>[]): SourcesSyncState {
  const readTimes = sources.flatMap((source) => (source.fetchedAt === undefined ? [] : [source.fetchedAt]))
  return {
    syncedAt: readTimes.length ? Math.min(...readTimes) : null,
    fromCache: sources.some((source) => source.health !== 'ok' && source.fetchedAt !== undefined),
  }
}

/**
 * What the page says when task sources cannot be read, in the form every list
 * page uses: when no task shows, the failure takes the page; when tasks show,
 * a toast says it (`PrListStates` does the same for pull requests). A missing
 * or weak connection is its own kind, because its repair is to connect the
 * provider, not to try again.
 */
export interface SourcesFailure {
  kind: 'github-auth' | 'jira-auth' | 'generic'
  title: string
  /** The sources and why, in words a person can read. */
  detail: string
  /** Changes when a source fails in a new way, so one failure is said one time. */
  key: string
}

const AUTH_HEALTHS = new Set<TaskSourceState['health']>(['not_connected', 'reconnect'])

export function sourcesFailure(sources: readonly TaskSourceState[]): SourcesFailure | null {
  const failed = sources.filter((source) => source.health !== 'ok')
  if (!failed.length) return null
  const authOf = (provider: 'github' | 'jira') =>
    failed.filter((source) => AUTH_HEALTHS.has(source.health) && taskSourceProvider(source.source) === provider)
  const kind = authOf('github').length ? 'github-auth' : authOf('jira').length ? 'jira-auth' : 'generic'
  const title = kind === 'github-auth'
    ? 'Connect GitHub to load tasks.'
    : kind === 'jira-auth' ? 'Connect Atlassian to load tasks.' : 'Couldn’t load tasks.'
  const [first] = failed
  const detail = failed.length === 1
    ? `${first.label}: ${first.message ?? 'the provider did not answer the last read.'}`
    : `${failed.length} task sources cannot be read: ${failed.map((source) => source.label).join(', ')}.`
  const key = failed.map((source) => `${source.sourceKey}:${source.health}`).sort().join('|')
  return { kind, title, detail, key }
}
