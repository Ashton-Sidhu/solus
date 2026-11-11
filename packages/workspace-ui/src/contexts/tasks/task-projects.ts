// Which tasks a project shows, and what one client knows about a task from
// more than one host. Pure: the stores read these from `$derived`.
//
// A task belongs to no project by itself. A project lists task sources, and a
// task is in the project when one of its placements names one of those sources
// (docs/plans/provider-owned-tasks.md §4.2).

import type {
  TaskPlacement,
  TaskProjectSources,
  TaskSessionLink,
  TaskSidebarPrLink,
  TaskSourceState,
} from '@solus/contracts/task-types'

/** The tasks that one of `sourceKeys` lists, in their given order. */
export function tasksInSources<T extends { placements: readonly TaskPlacement[] }>(
  tasks: readonly T[],
  sourceKeys: ReadonlySet<string>,
): T[] {
  if (sourceKeys.size === 0) return []
  return tasks.filter((task) => task.placements.some((placement) => sourceKeys.has(placement.sourceKey)))
}

/**
 * The sources of one project, each once, from the answers of its checkouts.
 *
 * Two checkouts of one repository can list the same source, and each host
 * reports its own read of it. The read that the provider answered most
 * recently is the one a person wants to see.
 */
export function mergeProjectSources(answers: readonly TaskProjectSources[]): TaskSourceState[] {
  const bySourceKey = new Map<string, TaskSourceState>()
  for (const answer of answers) {
    for (const source of answer.sources) {
      const held = bySourceKey.get(source.sourceKey)
      if (!held || (source.fetchedAt ?? 0) > (held.fetchedAt ?? 0)) bySourceKey.set(source.sourceKey, source)
    }
  }
  return [...bySourceKey.values()]
}

/**
 * One list of session links from the lists that each host holds for a task.
 *
 * The project host and the organization's Solus API can both hold a link to
 * the same session. The first host in `hostOrder` wins, so a link does not
 * change when a second host answers later. The newest link is first.
 */
export function mergeSessionLinks(
  linksByHost: ReadonlyMap<string, readonly TaskSessionLink[]>,
  hostOrder: readonly string[],
): TaskSessionLink[] {
  const bySessionId = new Map<string, TaskSessionLink>()
  for (const serverId of orderedHosts(linksByHost, hostOrder)) {
    for (const link of linksByHost.get(serverId) ?? []) {
      if (!bySessionId.has(link.sessionId)) bySessionId.set(link.sessionId, link)
    }
  }
  return [...bySessionId.values()].sort((a, b) => b.linkedAt - a.linkedAt)
}

/** The host that holds the link to a session, or undefined. An unlink must go
 *  to that host: another host does not know the link. */
export function hostOfSessionLink(
  linksByHost: ReadonlyMap<string, readonly TaskSessionLink[]>,
  hostOrder: readonly string[],
  sessionId: string,
): string | undefined {
  return orderedHosts(linksByHost, hostOrder)
    .find((serverId) => linksByHost.get(serverId)?.some((link) => link.sessionId === sessionId))
}

/** One list of pull request links from the lists that each host holds. A pull
 *  request is one repository scope and one number. */
export function mergePrLinks(
  linksByHost: ReadonlyMap<string, readonly TaskSidebarPrLink[]>,
  hostOrder: readonly string[],
): TaskSidebarPrLink[] {
  const byIdentity = new Map<string, TaskSidebarPrLink>()
  for (const serverId of orderedHosts(linksByHost, hostOrder)) {
    for (const link of linksByHost.get(serverId) ?? []) {
      const identity = `${link.targetScope ?? ''}#${link.number}`
      if (!byIdentity.has(identity)) byIdentity.set(identity, link)
    }
  }
  return [...byIdentity.values()]
}

function orderedHosts(byHost: ReadonlyMap<string, unknown>, hostOrder: readonly string[]): string[] {
  const rank = (serverId: string) => {
    const index = hostOrder.indexOf(serverId)
    return index === -1 ? hostOrder.length : index
  }
  return [...byHost.keys()].sort((a, b) => rank(a) - rank(b))
}
