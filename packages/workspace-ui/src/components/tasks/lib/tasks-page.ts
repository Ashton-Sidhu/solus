// Pure helpers for the Tasks page: what the search matches, and what the page
// says about the task sources it shows.
import type { Task, TaskSourceState } from '@solus/contracts/task-types'
import { sourceHealthNote } from '../sources/lib/task-source-setup'

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

/** One line for each source that the page must say something about: a source
 *  that cannot be read, or one that holds more tasks than the host read. */
export interface SourceNotice {
  sourceKey: string
  tone: 'warning' | 'failure'
  text: string
}

export function sourceNotices(sources: readonly TaskSourceState[]): SourceNotice[] {
  return sources.flatMap((source) => {
    const note = sourceHealthNote(source)
    if (!note) return []
    return [{ sourceKey: source.sourceKey, tone: note.tone, text: `${source.label}: ${note.label}. ${note.message}` }]
  })
}
