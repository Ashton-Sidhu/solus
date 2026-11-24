import type { PersonHistoryEntry } from '@solus/contracts/person-history'
import type { RecentItem } from '@solus/client-core/recent-artifacts'
import { appHistoryKey, workHistoryKey } from '@solus/client-core/person-history'
import type { WorkspaceItem } from './workspace-items'
import type { WorkspaceAppItem } from './workspace-apps'

/** The Workspace page's "Recently viewed" row holds at most this many. */
export const WORKSPACE_RECENT_LIMIT = 12

/** One card of the row, with what opens it. */
export type WorkspaceRecentItem = RecentItem & { serverId: string } & (
  | { kind: 'work'; work: WorkspaceItem }
  | { kind: 'app'; app: WorkspaceAppItem }
)

export interface WorkspaceRecentSources {
  /** The person's history, newest open first. */
  history: readonly PersonHistoryEntry[]
  works: readonly WorkspaceItem[]
  apps: readonly WorkspaceAppItem[]
  /** The host that lists a work, or null. */
  workHostOf: (workId: string) => string | null
  /** The installation id of the host this client reaches as `serverId`: how every client names that machine. */
  machineIdOf: (serverId: string) => string
}

/**
 * The Workspace page's "Recently viewed" row (docs/workspace-page.md): the
 * works and apps the person opened, newest open first, from their history
 * (docs/plans/person-state.md). Only what this page lists shows: a work that
 * was deleted, or an app on a host this client does not reach, is left out.
 */
export function workspaceRecentItems(sources: WorkspaceRecentSources, limit = WORKSPACE_RECENT_LIMIT): WorkspaceRecentItem[] {
  const byKey = new Map<string, (openedAt: number) => WorkspaceRecentItem | null>()
  for (const work of sources.works) {
    byKey.set(workHistoryKey(work.id), (openedAt) => {
      const serverId = sources.workHostOf(work.id)
      if (!serverId) return null
      return {
        kind: 'work',
        work,
        serverId,
        pinned: work.pinned,
        activity: 'opened',
        at: openedAt,
        artifact: {
          kind: 'work',
          workId: work.id,
          title: work.title,
          workType: work.work.type,
          linkedAt: work.createdAt,
          pinned: work.pinned,
          updatedAt: work.timestamp,
          preview: work.work.preview,
        },
      }
    })
  }
  for (const app of sources.apps) {
    const machineId = sources.machineIdOf(app.serverId)
    byKey.set(appHistoryKey(machineId, app.appId), (openedAt) => ({
      kind: 'app',
      app,
      serverId: app.serverId,
      pinned: false,
      activity: 'opened',
      at: openedAt,
      artifact: { kind: 'app', hostId: machineId, appId: app.appId, slug: app.slug, title: app.title, linkedAt: 0 },
    }))
  }
  const row: WorkspaceRecentItem[] = []
  for (const entry of sources.history) {
    const item = byKey.get(entry.key)?.(entry.openedAt)
    if (item) row.push(item)
    if (row.length === limit) break
  }
  return row
}
