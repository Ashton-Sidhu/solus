import { isRepositoryKey, localProjectKey } from '@solus/contracts/repository-key'

/**
 * How every client lists projects (docs/plans/project-model.md §1, §5). A
 * project is a repository with every checkout of it on any host; a folder with
 * no hosted remote is its own local-only project, keyed by its host and path.
 * Every project selector — desktop, web and mobile — groups checkouts and
 * names projects here, so one project is one row with one name everywhere.
 */

/** What a list knows about one checkout. */
export interface CheckoutFacts {
  serverId: string
  path: string
  /** Null or absent while the host has not named a repository. */
  repositoryKey?: string | null
}

/** The project a checkout belongs to: its repository, or itself when it has none. */
export function projectKeyOf(checkout: CheckoutFacts): string {
  return checkout.repositoryKey || localProjectKey(checkout.serverId, checkout.path)
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

/** The host and folder a local-only project key names, or null for any other key. */
export function localProjectParts(projectKey: string): CheckoutFacts | null {
  const at = projectKey.search(/:[/~]/)
  if (at <= 0) return null
  return { serverId: projectKey.slice(0, at), path: projectKey.slice(at + 1) }
}

/** The name of a project nothing better names: the last segment of its
 *  repository or folder. */
export function projectKeyLabel(projectKey: string): string {
  const path = localProjectParts(projectKey)?.path ?? projectKey
  return path.replace(/\/+$/, '').split('/').at(-1) || path
}

/**
 * The labels a list shows, one per project, in order. A name two projects in
 * the list share is told apart: a repository by its owner (`acme/web`, or its
 * whole key when that is still shared), a local-only folder by its host.
 */
export function distinctProjectLabels(
  projects: readonly { key: string; label: string }[],
  hostLabelFor: (serverId: string) => string,
): string[] {
  const shared = repeated(projects.map((project) => project.label))
  const labels = projects.map((project) => {
    if (!shared.has(fold(project.label))) return project.label
    if (isRepositoryKey(project.key)) return project.key.split('/').slice(1).join('/') || project.key
    const local = localProjectParts(project.key)
    return local ? `${project.label} · ${hostLabelFor(local.serverId)}` : project.label
  })
  const stillShared = repeated(labels)
  return labels.map((label, index) => {
    const { key } = projects[index]!
    return stillShared.has(fold(label)) && isRepositoryKey(key) ? key : label
  })
}

function fold(label: string): string {
  return label.toLocaleLowerCase()
}

function repeated(labels: readonly string[]): Set<string> {
  const seen = new Set<string>()
  const twice = new Set<string>()
  for (const label of labels) {
    const folded = fold(label)
    if (seen.has(folded)) twice.add(folded)
    seen.add(folded)
  }
  return twice
}
