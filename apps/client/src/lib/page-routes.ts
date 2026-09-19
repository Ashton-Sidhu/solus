import type { ResourceRoute } from '@solus/workspace-ui/contexts/app/resource-routes'

/**
 * The page shell's routes on the account origin (docs/plans/cloud-service-model.md):
 * one organization's workspace, addressed by hash so the same bundle serves the
 * workspace at `/app/` and these pages beside it.
 *
 *   #/w/<orgId>/tasks                 the task board
 *   #/w/<orgId>/tasks/<taskId>        one task
 *   #/w/<orgId>/works                 the works list
 *   #/w/<orgId>/works/<workId>        one work
 *   #/w/<orgId>/sessions              the session records
 *   #/w/<orgId>/sessions/<sessionId>  one session: the record, read-only while its runner is offline
 *   #/w/<orgId>/connections           the person's Claude and Codex logins, kept in Solus cloud
 *
 * The share link `#/h/<hostId>/s/<secret>` is another door and is parsed before this one.
 */
export type PageRoute =
  | { organizationId: string; page: 'tasks' }
  | { organizationId: string; page: 'task'; taskId: string }
  | { organizationId: string; page: 'works' }
  | { organizationId: string; page: 'work'; workId: string }
  | { organizationId: string; page: 'sessions' }
  | { organizationId: string; page: 'session'; sessionId: string }
  | { organizationId: string; page: 'connections' }

export type PageRouteName = PageRoute['page']

/** The rail entry a route belongs under. */
export type PageSection = 'tasks' | 'works' | 'sessions' | 'connections'

// An id as `encodeURIComponent` writes it: the `%` of an escaped character included.
const ID = '[A-Za-z0-9_.:%-]+'
const FRAGMENT = new RegExp(`^#?/w/(${ID})(?:/(tasks|works|sessions|connections)(?:/(${ID}))?)?/?$`)

export function parsePageRouteFragment(hash: string): PageRoute | null {
  const match = FRAGMENT.exec(hash)
  if (!match) return null
  const organizationId = decodeURIComponent(match[1]!)
  const list = match[2] ?? 'tasks'
  const id = match[3] ? decodeURIComponent(match[3]) : null
  if (list === 'tasks') return id ? { organizationId, page: 'task', taskId: id } : { organizationId, page: 'tasks' }
  if (list === 'works') return id ? { organizationId, page: 'work', workId: id } : { organizationId, page: 'works' }
  if (list === 'connections') return id ? null : { organizationId, page: 'connections' }
  return id ? { organizationId, page: 'session', sessionId: id } : { organizationId, page: 'sessions' }
}

export function pageRouteFragment(route: PageRoute): string {
  const base = `#/w/${encodeURIComponent(route.organizationId)}`
  switch (route.page) {
    case 'tasks': return `${base}/tasks`
    case 'task': return `${base}/tasks/${encodeURIComponent(route.taskId)}`
    case 'works': return `${base}/works`
    case 'work': return `${base}/works/${encodeURIComponent(route.workId)}`
    case 'sessions': return `${base}/sessions`
    case 'session': return `${base}/sessions/${encodeURIComponent(route.sessionId)}`
    case 'connections': return `${base}/connections`
  }
}

/** The page a resource opens on, or null for a kind the page shell has no page for. */
export function pageRouteForResource(organizationId: string, route: ResourceRoute): PageRoute | null {
  switch (route.kind) {
    case 'task': return { organizationId, page: 'task', taskId: route.taskId }
    case 'work': return { organizationId, page: 'work', workId: route.workId }
    case 'session': return { organizationId, page: 'session', sessionId: route.sessionId }
    default: return null
  }
}

/** Which rail entry a route belongs under. */
export function pageRouteSection(route: PageRoute): PageSection {
  if (route.page === 'task' || route.page === 'tasks') return 'tasks'
  if (route.page === 'work' || route.page === 'works') return 'works'
  if (route.page === 'connections') return 'connections'
  return 'sessions'
}
