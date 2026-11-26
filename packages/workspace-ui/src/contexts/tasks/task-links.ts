// What one client knows about a task from more than one host. Pure: the
// stores read these from `$derived`.

import type { IssueSessionLink, IssueSidebarPrLink } from '@solus/contracts/task-types'

/**
 * One list of session links from the lists that each host holds for a task.
 *
 * The task host and the organization's Solus API can both hold a link to
 * the same session. The first host in `hostOrder` wins, so a link does not
 * change when a second host answers later. The newest link is first.
 */
export function mergeSessionLinks(
  linksByHost: ReadonlyMap<string, readonly IssueSessionLink[]>,
  hostOrder: readonly string[],
): IssueSessionLink[] {
  const bySessionId = new Map<string, IssueSessionLink>()
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
  linksByHost: ReadonlyMap<string, readonly IssueSessionLink[]>,
  hostOrder: readonly string[],
  sessionId: string,
): string | undefined {
  return orderedHosts(linksByHost, hostOrder)
    .find((serverId) => linksByHost.get(serverId)?.some((link) => link.sessionId === sessionId))
}

/** One list of pull request links from the lists that each host holds. A pull
 *  request is one repository scope and one number. */
export function mergePrLinks(
  linksByHost: ReadonlyMap<string, readonly IssueSidebarPrLink[]>,
  hostOrder: readonly string[],
): IssueSidebarPrLink[] {
  const byIdentity = new Map<string, IssueSidebarPrLink>()
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
