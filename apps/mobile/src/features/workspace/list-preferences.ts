// Adapted from T3 Code apps/mobile/src/persistence/mobile-preferences.ts (MIT, see UPSTREAM.md).
import { z } from 'zod'
import type { KeyValueStore } from '../../platform/ports'
import type { PullRequestListFilter } from '../prs/pull-request-directory'
import {
  DEFAULT_PULL_REQUEST_LIST_CONTROLS,
  type PullRequestInvolvement,
  type PullRequestListControls,
  type PullRequestListFilters,
  type PullRequestListSort,
} from '../prs/lib/pull-request-list'

/**
 * The list filters of the two workspace tabs, kept on the device for the next
 * launch (T3 Code #18476). A saved value is checked when it is read; a value
 * that does not match is dropped as a whole and the defaults apply. A saved
 * host or project is kept while its host is offline: it is resolved against
 * the paired hosts, not the connected ones, and it is never cleared because
 * a list has not loaded yet.
 */

export const THREAD_LIST_FILTERS_KEY = 'solus.mobile.threadListFilters'
export const PULL_REQUEST_LIST_FILTERS_KEY = 'solus.mobile.pullRequestListFilters'

/** The Chats tab's host and project filter. */
export interface ThreadListFilters {
  environmentId: string | null
  projectKey: string | null
}

const ThreadListFiltersSchema = z.object({
  environmentId: z.string().nullable(),
  projectKey: z.string().nullable(),
})

export const DEFAULT_THREAD_LIST_FILTERS: ThreadListFilters = { environmentId: null, projectKey: null }

/** The project a pull request list is narrowed to: a folder on one host. */
export interface PullRequestListProject {
  hostId: string
  projectPath: string
}

/** The Pull Requests tab's controls: the state the hosts list, and what the
 *  device narrows. The search text is not kept. */
export interface PullRequestListPreferences {
  state: PullRequestListFilter['state']
  /** Only this host; null for every host. */
  hostId: string | null
  project: PullRequestListProject | null
  involvement: PullRequestInvolvement
  filters: PullRequestListFilters
  sort: PullRequestListSort
}

const PullRequestListPreferencesSchema = z.object({
  state: z.enum(['open', 'closed', 'all']),
  hostId: z.string().nullable(),
  project: z.object({ hostId: z.string(), projectPath: z.string() }).nullable(),
  involvement: z.enum(['all', 'authored', 'reviewing', 'others']),
  filters: z.object({
    labels: z.array(z.array(z.string())).optional(),
    excludedLabels: z.array(z.string()).optional(),
    author: z.string().optional(),
    draft: z.enum(['only', 'hide']).optional(),
    review: z.enum(['approved', 'changes-requested', 'review-required', 'none']).optional(),
    checks: z.enum(['pending', 'passing', 'failing']).optional(),
  }),
  sort: z.enum(['updated', 'created', 'oldest']),
})

export const DEFAULT_PULL_REQUEST_LIST_PREFERENCES: PullRequestListPreferences = {
  state: 'open',
  hostId: null,
  project: null,
  involvement: DEFAULT_PULL_REQUEST_LIST_CONTROLS.involvement,
  filters: {},
  sort: DEFAULT_PULL_REQUEST_LIST_CONTROLS.sort,
}

function readSaved<T>(storage: KeyValueStore, key: string, schema: z.ZodType<T>, fallback: T): T {
  const raw = storage.getItem(key)
  if (!raw) return fallback
  try {
    const parsed = schema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

export function readThreadListFilters(storage: KeyValueStore): ThreadListFilters {
  return readSaved(storage, THREAD_LIST_FILTERS_KEY, ThreadListFiltersSchema, DEFAULT_THREAD_LIST_FILTERS)
}

export function readPullRequestListPreferences(storage: KeyValueStore): PullRequestListPreferences {
  return readSaved(storage, PULL_REQUEST_LIST_FILTERS_KEY, PullRequestListPreferencesSchema, DEFAULT_PULL_REQUEST_LIST_PREFERENCES)
}

/** The list for one host, as a host's "Open pull requests" asks. A project of
 *  another host no longer applies. */
export function pullRequestPreferencesForHost(preferences: PullRequestListPreferences, hostId: string): PullRequestListPreferences {
  return {
    ...preferences,
    hostId,
    project: preferences.project?.hostId === hostId ? preferences.project : null,
  }
}

/** What the saved preferences mean now: the hosts to read, the controls that
 *  narrow their rows, and the host and project the menus show as chosen. */
export interface PullRequestListScope {
  hostIds: string[]
  controls: PullRequestListControls
  hostId: string | null
  project: PullRequestListProject | null
}

/**
 * The saved preferences resolved with the hosts this device has paired. A
 * host that is no longer paired reads as every host; its project then no
 * longer applies.
 */
export function resolvePullRequestListScope(preferences: PullRequestListPreferences, pairedHostIds: readonly string[]): PullRequestListScope {
  const hostId = preferences.hostId !== null && pairedHostIds.includes(preferences.hostId) ? preferences.hostId : null
  const project = preferences.project && pairedHostIds.includes(preferences.project.hostId) && (hostId === null || hostId === preferences.project.hostId)
    ? preferences.project
    : null
  const scopeHostId = project?.hostId ?? hostId
  const controls: PullRequestListControls = { involvement: preferences.involvement, filters: preferences.filters, sort: preferences.sort }
  if (scopeHostId) controls.hostId = scopeHostId
  if (project) controls.projectPath = project.projectPath
  return { hostIds: scopeHostId ? [scopeHostId] : [...pairedHostIds], controls, hostId, project }
}

/** How many controls differ from the defaults, for the filter button. The
 *  host is not counted: it has its own menu. */
export function activePullRequestFilterCount(preferences: PullRequestListPreferences): number {
  const { filters } = preferences
  return Number(preferences.state !== 'open')
    + Number(preferences.involvement !== 'all')
    + Number(Boolean(filters.author))
    + (filters.labels?.flat().length ?? 0)
    + Number(Boolean(filters.draft))
    + Number(Boolean(filters.review))
    + Number(Boolean(filters.checks))
    + Number(preferences.project !== null)
}
