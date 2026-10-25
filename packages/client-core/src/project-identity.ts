import { hostPathBaseName } from '@solus/contracts/host-path'
import { localProjectKey } from '@solus/contracts/repository-key'
import { remoteDispatchRepositoryKey } from '@solus/contracts/types'

/**
 * How every client lists projects (docs/plans/project-model.md §1, §5). A
 * project is a repository with every checkout of it on any host; a folder with
 * no hosted remote is its own local-only project, keyed by its host and path.
 * Every project selector — desktop, web and mobile — groups checkouts and
 * names projects here, so one project is one row with one name everywhere:
 * its plain name, never qualified by its owner or its host.
 */

/** What a list knows about one checkout. */
export interface CheckoutFacts {
  serverId: string
  path: string
  /** Null or absent while the host has not named a repository. */
  repositoryKey?: string | null
}

/** The project a checkout belongs to: its repository, or itself when it has
 *  none. A remote-dispatch checkout names its repository in its path. */
export function projectKeyOf(checkout: CheckoutFacts): string {
  return checkout.repositoryKey
    || remoteDispatchRepositoryKey(checkout.path)
    || localProjectKey(checkout.serverId, checkout.path)
}

export interface ProjectGroup<Checkout> {
  key: string
  checkouts: Checkout[]
}

/** Checkouts grouped into projects, each project where its first checkout was. */
export function groupByProject<Checkout>(
  checkouts: Iterable<Checkout>,
  factsOf: (checkout: Checkout) => CheckoutFacts,
): ProjectGroup<Checkout>[] {
  const groups = new Map<string, ProjectGroup<Checkout>>()
  for (const checkout of checkouts) {
    const key = projectKeyOf(factsOf(checkout))
    const group = groups.get(key)
    if (group) group.checkouts.push(checkout)
    else groups.set(key, { key, checkouts: [checkout] })
  }
  return [...groups.values()]
}

/** The host and folder a local-only project key names, or null for any other key.
 *  The path starts at the first colon that a POSIX, `~`, drive, or UNC path
 *  follows; a repository key has no colon. */
export function localProjectParts(projectKey: string): CheckoutFacts | null {
  const at = projectKey.search(/:(?:[/~]|[A-Za-z]:(?:[\\/]|$)|\\\\)/)
  if (at <= 0) return null
  return { serverId: projectKey.slice(0, at), path: projectKey.slice(at + 1) }
}

/** The name of a project nothing better names: the last segment of its
 *  repository or folder. */
export function projectKeyLabel(projectKey: string): string {
  const path = localProjectParts(projectKey)?.path ?? projectKey
  return hostPathBaseName(path) || path
}
